import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import { Database } from '../database/database';
import { fusePredictions, normalizePlate } from './fusion';
import { sha256 } from './registry';

type Row = Record<string, any>;
export interface WorkerOptions {
  dataDir: string;
  python: string;
  cacheDir: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}
export type Runner = (
  job: Row,
  folder: string,
  options: WorkerOptions,
  stage: (name: string) => Promise<void>,
) => Promise<Row>;
const id = () => randomUUID().replace(/-/g, '');

export function checkInterrupted(options: WorkerOptions) {
  if (options.signal?.aborted)
    throw Object.assign(new Error('Worker interrupted'), { code: 'WORKER_INTERRUPTED' });
}

export function workerOptions(): WorkerOptions {
  const dataDir = path.resolve(process.env.PLATE_DATA_DIR ?? 'data');
  const timeoutSeconds = Number(process.env.PLATE_JOB_TIMEOUT_SECONDS ?? 7200);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    throw new Error('Invalid job timeout');
  return {
    dataDir,
    cacheDir: path.resolve(process.env.PLATE_CACHE_DIR ?? path.join(dataDir, 'model-cache')),
    python: process.env.PLATE_PIPELINE_PYTHON ?? '',
    timeoutSeconds,
  };
}

export function safeStorage(root: string, key: string) {
  if (
    typeof key !== 'string' ||
    !key ||
    key.includes(':') ||
    path.isAbsolute(key) ||
    key.replace(/\\/g, '/').split('/').includes('..')
  )
    throw new Error('Invalid storage key');
  const file = path.resolve(root, key);
  const relative = path.relative(path.resolve(root), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Storage path is outside root');
  return file;
}

/**
 * Jobs the shared live host can run with its models: five-frame joint OCR on a scene
 * video. 'host' claims only those, 'process' only the others (they need their own process).
 */
export type JobRoute = 'host' | 'process';
const HOST_JOB = `(j.input_mode = 'scene' AND m.media_type = 'video'
  AND j.pipeline_snapshot->>'task' = 'recognize'
  AND j.pipeline_snapshot->'recognizer'->>'input_mode' = 'five_frame_joint')`;

export async function claim(database: Database, route?: JobRoute): Promise<Row | undefined> {
  const filter =
    route === 'host' ? `AND ${HOST_JOB}` : route === 'process' ? `AND NOT ${HOST_JOB}` : '';
  return database.transaction(async (client) => {
    const result = await client.query(`WITH candidate AS (
      SELECT j.id FROM recognition_jobs j JOIN media_assets m ON m.id = j.media_id
      WHERE j.status = 'queued' ${filter} ORDER BY j.created_at, j.id
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
    ) UPDATE recognition_jobs j SET status='running', stage='validating', started_at=now()
      FROM candidate c WHERE j.id=c.id RETURNING j.*`);
    const job = result.rows[0];
    if (!job) return undefined;
    const media = await client.query(
      'SELECT storage_key, sha256, media_type FROM media_assets WHERE id=$1',
      [job.media_id],
    );
    return { ...job, ...media.rows[0] };
  });
}

export async function recover(database: Database) {
  return database.query(`UPDATE recognition_jobs SET status='failed',stage='failed',finished_at=now(),
    error_code='WORKER_INTERRUPTED',error_message='Worker stopped before completion. Create another job to retry.' WHERE status='running'`);
}

export async function stopTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
  } else {
    // The Python supervisor receives SIGTERM and cleans its independent ML group.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** The pinned models, tracking code and interpreter must still be the ones the snapshot recorded. */
export async function verifySnapshot(snapshot: Row, options: WorkerOptions) {
  checkInterrupted(options);
  if (!options.python)
    throw Object.assign(new Error('ML interpreter is not configured'), {
      code: 'ENVIRONMENT_ERROR',
    });
  const task = snapshot?.task;
  // Removed v1 extraction jobs carry no pipeline task and cannot run any more.
  if (!['prepare', 'recognize'].includes(task))
    throw Object.assign(new Error('Unsupported pipeline snapshot'), { code: 'PIPELINE_FAILED' });
  for (const entry of [
    snapshot.detector,
    ...(task === 'prepare' ? [] : [snapshot.recognizer]),
    ...snapshot.code_files,
  ]) {
    if ((await sha256(entry.checkpoint ?? entry.path).catch(() => '')) !== entry.sha256)
      throw Object.assign(new Error('Checkpoint or source changed'), {
        code: 'CHECKPOINT_MISSING',
      });
    checkInterrupted(options);
  }
  if (path.resolve(options.python) !== path.resolve(snapshot.pipeline_python))
    throw Object.assign(new Error('ML interpreter changed'), { code: 'ENVIRONMENT_ERROR' });
}

/** Environment for every ML subprocess (recognition supervisor and live process). */
export function pythonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    HF_HUB_OFFLINE: '1',
    PYTHONPATH: [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}

/** The payload app.recognition.runner reads (subprocess or shared live host). */
export async function writeRecognitionInput(job: Row, folder: string, options: WorkerOptions) {
  const input = path.join(folder, 'recognition-input.json');
  await writeFile(
    input,
    JSON.stringify({
      id: job.id,
      job_kind: job.job_kind,
      input_mode: job.input_mode,
      pipeline_snapshot: job.pipeline_snapshot,
      media_type: job.media_type,
      input_path: job.input_path,
      output_dir: folder,
      data_dir: options.dataDir,
      device: job.pipeline_snapshot.device,
      cache_dir: options.cacheDir,
    }),
  );
  return input;
}

/** Forward stage changes the ML side writes to progress.json; returns a function that stops polling. */
export function followProgress(folder: string, stage: (name: string) => Promise<void>) {
  let checking = false;
  let last = '';
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    void readFile(path.join(folder, 'progress.json'), 'utf8')
      .then(JSON.parse)
      .then(async (progress) => {
        if (progress.stage !== last) {
          await stage(progress.stage);
          last = progress.stage;
        }
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 250);
  return () => clearInterval(poll);
}

/** recognition-result.json once the ML side exited: the result, or the error it reported. */
export async function readRecognitionResult(folder: string, code: number | null) {
  const result = JSON.parse(await readFile(path.join(folder, 'recognition-result.json'), 'utf8'));
  if (code !== 0 || !result.ok)
    throw Object.assign(new Error('ML process failed'), {
      code: result.error_code ?? 'PIPELINE_FAILED',
    });
  return result;
}

export const executeRecognition: Runner = async (job, folder, options, stage) => {
  await verifySnapshot(job.pipeline_snapshot, options);
  const input = await writeRecognitionInput(job, folder, options);
  // Shutdown may arrive while hashing checkpoints or writing the payload, before
  // there is a child process to receive a termination signal.
  checkInterrupted(options);
  const log = createWriteStream(path.join(folder, 'worker.log'), { flags: 'a' });
  const child = spawn(
    options.python,
    [
      '-m',
      'app.recognition.supervisor',
      '--payload',
      input,
      '--timeout',
      String(options.timeoutSeconds),
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: pythonEnv(),
    },
  );
  // A full/unwritable log volume must fail this job rather than crash Node and
  // leave inference running without its owning worker.
  log.on('error', () => {
    void stopTree(child);
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.stdin?.on('error', () => {});
  child.stdin?.write('go\n'); // Leave pipe open; supervisor notices worker death via EOF.
  let timedOut = false;
  let interrupted = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      void stopTree(child);
    },
    options.timeoutSeconds * 1000 + 1000,
  );
  const stopPolling = followProgress(folder, stage);
  const onSignal = () => {
    interrupted = true;
    void stopTree(child);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  options.signal?.addEventListener('abort', onSignal, { once: true });
  if (options.signal?.aborted) onSignal();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (interrupted)
      throw Object.assign(new Error('Worker interrupted'), { code: 'WORKER_INTERRUPTED' });
    if (timedOut) throw Object.assign(new Error('Processing timed out'), { code: 'JOB_TIMEOUT' });
    return await readRecognitionResult(folder, code);
  } finally {
    clearTimeout(timer);
    stopPolling();
    child.stdin?.end();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    options.signal?.removeEventListener('abort', onSignal);
    log.end();
  }
};

async function artifact(options: WorkerOptions, folder: string, key: string) {
  const file = safeStorage(options.dataDir, key);
  const actual = await realpath(file);
  const relative = path.relative(await realpath(folder), actual);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(actual)).isFile())
    throw new Error('Artifact is outside this job or missing');
  return actual;
}

async function imageSize(file: string): Promise<[number, number]> {
  const bytes = await readFile(file);
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('Invalid JPEG metadata');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 7
      )
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  throw new Error('Derived image is not a valid PNG/JPEG');
}

function finite(value: any) {
  return typeof value === 'number' && Number.isFinite(value);
}
function probability(value: any) {
  return value === null || value === undefined || (finite(value) && value >= 0 && value <= 1);
}

function validatePrediction(prediction: Row) {
  if (
    typeof prediction.raw_text !== 'string' ||
    prediction.normalized_text !== normalizePlate(prediction.raw_text) ||
    prediction.normalized_text.length > 128 ||
    !probability(prediction.ocr_score) ||
    (prediction.character_scores != null &&
      (!Array.isArray(prediction.character_scores) ||
        prediction.character_scores.some((v: any) => !finite(v) || v < 0 || v > 1))) ||
    !finite(prediction.latency_ms) ||
    prediction.latency_ms < 0
  )
    throw new Error('Invalid OCR prediction');
  if (prediction.decoding != null) validateDecoding(prediction.decoding, prediction.raw_text);
}

const DECODERS = ['greedy', 'beam_plain', 'beam_filter', 'beam_constrained'];
const DECODING_KEYS = [
  'decoder',
  'beam_width',
  'use_tta',
  'plate_text',
  'greedy_text',
  'format_valid',
  'greedy_symbol_confidence',
  'beam_log_score',
  'beam_confidence_proxy',
];

function validateDecoding(decoding: any, rawText: string) {
  const nullableFinite = (value: any) => value === null || finite(value);
  if (
    typeof decoding !== 'object' ||
    Array.isArray(decoding) ||
    Object.keys(decoding).length !== DECODING_KEYS.length ||
    DECODING_KEYS.some((key) => !(key in decoding)) ||
    !DECODERS.includes(decoding.decoder) ||
    !Number.isInteger(decoding.beam_width) ||
    decoding.beam_width < 1 ||
    typeof decoding.use_tta !== 'boolean' ||
    decoding.plate_text !== rawText ||
    typeof decoding.greedy_text !== 'string' ||
    decoding.greedy_text.length > 128 ||
    typeof decoding.format_valid !== 'boolean' ||
    !finite(decoding.greedy_symbol_confidence) ||
    !probability(decoding.greedy_symbol_confidence) ||
    !nullableFinite(decoding.beam_log_score) ||
    !probability(decoding.beam_confidence_proxy)
  )
    throw new Error('Invalid OCR decoding details');
}

export async function validateResult(
  job: Row,
  result: Row,
  folder: string,
  options: WorkerOptions,
) {
  if (
    !Array.isArray(result.appearances) ||
    !result.statistics ||
    typeof result.statistics !== 'object' ||
    Array.isArray(result.statistics)
  )
    throw new Error('Invalid result document');
  const prepare = job.pipeline_snapshot?.task === 'prepare';
  const recognize = job.job_kind === 'recognize' && !prepare;
  const joint = recognize && job.pipeline_snapshot?.recognizer?.input_mode === 'five_frame_joint';
  const video = job.media_type === 'video';
  if (joint && (!video || job.input_mode !== 'scene'))
    throw new Error('Joint five-frame OCR supports scene video only');
  const trackIds = new Set<string>();
  for (const appearance of result.appearances) {
    const detections = appearance.detections;
    if (!Array.isArray(detections) || !detections.length)
      throw new Error('Appearance has no evidence');
    if (detections.length !== (video ? 5 : 1)) throw new Error('Invalid crop count');
    if (video) {
      const frames = detections.map((d: Row) => d.frame_index);
      const timestamps = detections.map((d: Row) => d.timestamp_seconds);
      if (
        new Set(frames).size !== 5 ||
        frames.some(
          (v: any, i: number) => !Number.isInteger(v) || v < 1 || (i && v <= frames[i - 1]),
        ) ||
        timestamps.some((v: any, i: number) => !finite(v) || v < 0 || (i && v <= timestamps[i - 1]))
      )
        throw new Error('Video needs five ordered distinct frames and timestamps');
      if (
        new Set(detections.map((d: Row) => d.crop_storage_key)).size !== 5 ||
        new Set(detections.map((d: Row) => d.frame_storage_key)).size !== 5
      )
        throw new Error('Video needs separate evidence files for each selected frame');
      if (
        typeof appearance.source_track_id !== 'string' ||
        !appearance.source_track_id ||
        appearance.source_track_id.length > 100 ||
        trackIds.has(appearance.source_track_id) ||
        !Number.isInteger(appearance.first_frame) ||
        appearance.first_frame < 1 ||
        !Number.isInteger(appearance.last_frame) ||
        appearance.first_frame > frames[0] ||
        appearance.last_frame < frames[4] ||
        !finite(appearance.start_seconds) ||
        appearance.start_seconds < 0 ||
        !finite(appearance.end_seconds) ||
        appearance.start_seconds > timestamps[0] ||
        appearance.end_seconds < timestamps[4]
      )
        throw new Error('Invalid video track extent or identity');
      trackIds.add(appearance.source_track_id);
    } else if (
      ['source_track_id', 'first_frame', 'last_frame', 'start_seconds', 'end_seconds'].some(
        (key) => appearance[key] != null,
      )
    ) {
      throw new Error('Still image must not claim a video position or track');
    }
    for (let i = 0; i < detections.length; i++) {
      const detection = detections[i];
      if (
        detection.selected_order !== i + 1 ||
        !Number.isInteger(detection.crop_width) ||
        detection.crop_width < 1 ||
        !Number.isInteger(detection.crop_height) ||
        detection.crop_height < 1
      )
        throw new Error('Invalid detection dimensions/order');
      for (const box of [detection.bbox, detection.crop_bbox])
        if (
          !Array.isArray(box) ||
          box.length !== 4 ||
          box.some((v) => !finite(v) || v < 0) ||
          box[2] <= box[0] ||
          box[3] <= box[1]
        )
          throw new Error('Invalid detection geometry');
      if (!probability(detection.detection_score)) throw new Error('Invalid detector confidence');
      const crop = await artifact(options, folder, detection.crop_storage_key);
      const dimensions = await imageSize(crop);
      if (dimensions[0] !== detection.crop_width || dimensions[1] !== detection.crop_height)
        throw new Error('Crop dimensions differ');
      if (
        detection.crop_bbox.some((value: number) => !Number.isInteger(value)) ||
        detection.crop_bbox[2] - detection.crop_bbox[0] !== detection.crop_width ||
        detection.crop_bbox[3] - detection.crop_bbox[1] !== detection.crop_height
      )
        throw new Error('Crop geometry differs from image dimensions');
      const frame = await artifact(options, folder, detection.frame_storage_key);
      const [width, height] = await imageSize(frame);
      if ([detection.bbox, detection.crop_bbox].some((box) => box[2] > width || box[3] > height))
        throw new Error('Detection geometry extends outside its source frame');
      // Live tracks carry stream PTS of one connection (epoch), not file positions.
      const timestampSource = !video
        ? 'still_image'
        : job.live_session_id
          ? 'live_pts'
          : 'video_pts';
      if (
        detection.timestamp_source !== timestampSource ||
        (!video && (detection.frame_index != null || detection.timestamp_seconds != null))
      )
        throw new Error('Invalid evidence timestamp provenance');
      const predictions = detection.predictions;
      if (
        !Array.isArray(predictions) ||
        (recognize && !joint
          ? predictions.length !== 1 || predictions[0].variant !== 'original'
          : predictions.length !== 0)
      )
        throw new Error('Invalid predictions');
      for (const prediction of predictions) {
        validatePrediction(prediction);
        if (prediction.input_storage_key !== detection.crop_storage_key)
          throw new Error('Original prediction input differs from its crop');
        if (prediction.input_storage_keys != null || prediction.frame_weights != null)
          throw new Error('Single-crop prediction cannot claim joint inputs or frame weights');
      }
    }
    if (joint) {
      if (
        !Array.isArray(appearance.predictions) ||
        appearance.predictions.length !== 1 ||
        appearance.predictions[0].variant !== 'joint'
      )
        throw new Error('Joint OCR requires one appearance prediction');
      const prediction = appearance.predictions[0];
      validatePrediction(prediction);
      if (
        prediction.input_storage_key != null ||
        !Array.isArray(prediction.input_storage_keys) ||
        prediction.input_storage_keys.length !== 5 ||
        prediction.input_storage_keys.some(
          (key: any, index: number) => key !== detections[index].crop_storage_key,
        )
      )
        throw new Error('Joint prediction inputs differ from ordered evidence crops');
      const weights = prediction.frame_weights;
      if (
        weights != null &&
        (!Array.isArray(weights) ||
          weights.length !== 5 ||
          weights.some((value: any) => !finite(value) || value < 0 || value > 1) ||
          Math.abs(weights.reduce((total: number, value: number) => total + value, 0) - 1) > 0.005)
      )
        throw new Error('Invalid joint frame weights');
      const text = prediction.normalized_text || null;
      if (
        appearance.machine_text !== text ||
        appearance.machine_status !== (text ? 'readable' : 'unreadable') ||
        appearance.agreement_count !== null ||
        appearance.recognition_method !== 'joint_multiframe'
      )
        throw new Error('Joint prediction aggregation differs');
    } else if (
      appearance.predictions != null &&
      (!Array.isArray(appearance.predictions) || appearance.predictions.length !== 0)
    ) {
      throw new Error('Only joint OCR can have appearance predictions');
    } else if (recognize) {
      const vote = fusePredictions(detections.map((d: Row) => d.predictions[0].raw_text));
      for (const [key, value] of Object.entries(vote))
        if (appearance[key] !== value) throw new Error('Prediction aggregation differs');
      if (
        appearance.recognition_method != null &&
        appearance.recognition_method !== (video ? 'per_crop_majority' : 'single_image')
      )
        throw new Error('Invalid recognition method');
    } else if (
      appearance.machine_status !== 'not_run' ||
      appearance.machine_text !== null ||
      appearance.agreement_count !== 0 ||
      appearance.recognition_method != null
    )
      throw new Error('Detection-only jobs cannot claim OCR');
  }
}

type Client = Pick<PoolClient, 'query'>;

/** Insert one validated appearance with its detections and OCR predictions; returns their ids. */
export async function persistAppearance(client: Client, job: Row, appearance: Row) {
  const appearanceId = id();
  const detectionIds: string[] = [];
  await client.query(
    `INSERT INTO plate_appearances
    (id,job_id,source_track_id,first_frame,last_frame,start_seconds,end_seconds,machine_text,machine_status,agreement_count,effective_text,review_status,revision,recognition_method)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8,'pending',0,$11)`,
    [
      appearanceId,
      job.id,
      appearance.source_track_id,
      appearance.first_frame,
      appearance.last_frame,
      appearance.start_seconds,
      appearance.end_seconds,
      appearance.machine_text,
      appearance.machine_status,
      appearance.agreement_count,
      appearance.recognition_method ??
        (job.job_kind === 'recognize'
          ? job.media_type === 'video'
            ? 'per_crop_majority'
            : 'single_image'
          : null),
    ],
  );
  for (const detection of appearance.detections) {
    const detectionId = id();
    detectionIds.push(detectionId);
    await client.query(
      `INSERT INTO plate_detections
      (id,appearance_id,selected_order,frame_index,timestamp_seconds,timestamp_source,bbox,crop_bbox,detection_score,crop_storage_key,frame_storage_key,crop_width,crop_height)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        detectionId,
        appearanceId,
        detection.selected_order,
        detection.frame_index,
        detection.timestamp_seconds,
        detection.timestamp_source,
        JSON.stringify(detection.bbox),
        JSON.stringify(detection.crop_bbox),
        detection.detection_score,
        detection.crop_storage_key,
        detection.frame_storage_key,
        detection.crop_width,
        detection.crop_height,
      ],
    );
    for (const prediction of detection.predictions)
      await client.query(
        `INSERT INTO ocr_predictions
      (id,detection_id,variant,raw_text,normalized_text,ocr_score,character_scores,input_storage_key,latency_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id(),
          detectionId,
          prediction.variant,
          prediction.raw_text,
          prediction.normalized_text,
          prediction.ocr_score,
          prediction.character_scores == null ? null : JSON.stringify(prediction.character_scores),
          prediction.input_storage_key,
          prediction.latency_ms,
        ],
      );
  }
  for (const prediction of appearance.predictions ?? [])
    await client.query(
      `INSERT INTO ocr_predictions
      (id,appearance_id,variant,raw_text,normalized_text,ocr_score,character_scores,input_storage_keys,frame_weights,decoding,latency_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id(),
        appearanceId,
        prediction.variant,
        prediction.raw_text,
        prediction.normalized_text,
        prediction.ocr_score,
        prediction.character_scores == null ? null : JSON.stringify(prediction.character_scores),
        JSON.stringify(prediction.input_storage_keys),
        prediction.frame_weights == null ? null : JSON.stringify(prediction.frame_weights),
        prediction.decoding == null ? null : JSON.stringify(prediction.decoding),
        prediction.latency_ms,
      ],
    );
  return { appearanceId, detectionIds };
}

export async function persistResult(database: Database, job: Row, result: Row) {
  await database.transaction(async (client) => {
    const running = await client.query(
      "SELECT id FROM recognition_jobs WHERE id=$1 AND status='running' FOR UPDATE",
      [job.id],
    );
    if (!running.rows.length) throw new Error('Job is no longer running');
    for (const appearance of result.appearances) await persistAppearance(client, job, appearance);
    await client.query(
      "UPDATE recognition_jobs SET status='succeeded',stage='complete',statistics=$2,finished_at=now() WHERE id=$1",
      [job.id, JSON.stringify(result.statistics)],
    );
  });
}

export async function processOne(
  database: Database,
  options = workerOptions(),
  runner: Runner = executeRecognition,
  route?: JobRoute,
) {
  if (options.signal?.aborted) return false;
  const job = await claim(database, route);
  if (!job) return false;
  const folder = safeStorage(options.dataDir, `recognition/${job.id}`);
  let phase = 'pipeline';
  try {
    checkInterrupted(options);
    await mkdir(folder, { recursive: true });
    job.input_path = safeStorage(options.dataDir, job.storage_key);
    const actualSource = await realpath(job.input_path).catch(() => {
      throw Object.assign(new Error('Input is missing'), { code: 'INPUT_CHANGED' });
    });
    const sourceRelative = path.relative(await realpath(options.dataDir), actualSource);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative))
      throw Object.assign(new Error('Input is outside storage'), { code: 'INPUT_CHANGED' });
    if ((await sha256(job.input_path).catch(() => '')) !== job.sha256)
      throw Object.assign(new Error('Input changed'), { code: 'INPUT_CHANGED' });
    checkInterrupted(options);
    const stage = async (name: string) => {
      if (['validating', 'detection_tracking', 'recognition', 'persisting'].includes(name))
        await database.query(
          "UPDATE recognition_jobs SET stage=$2 WHERE id=$1 AND status='running'",
          [job.id, name],
        );
    };
    const result = await runner(job, folder, options, stage);
    checkInterrupted(options);
    phase = 'results';
    await stage('persisting');
    await validateResult(job, result, folder, options);
    checkInterrupted(options);
    await persistResult(database, job, result);
  } catch (error) {
    const requested = (error as any)?.code;
    const code = [
      'INPUT_CHANGED',
      'CHECKPOINT_MISSING',
      'ENVIRONMENT_ERROR',
      'JOB_TIMEOUT',
      'WORKER_INTERRUPTED',
      'INVALID_VIDEO',
      'CUDA_ERROR',
      'CUDA_UNAVAILABLE',
      'RESULT_INVALID',
    ].includes(requested)
      ? requested
      : phase === 'results'
        ? 'RESULT_INVALID'
        : 'PIPELINE_FAILED';
    await writeFile(
      path.join(folder, 'worker.log'),
      `${error instanceof Error ? error.stack : String(error)}\n`,
      { flag: 'a' },
    ).catch(() => {});
    await database.query(
      `UPDATE recognition_jobs SET status='failed',stage='failed',finished_at=now(),error_code=$2,
      error_message=$3 WHERE id=$1 AND status='running'`,
      [
        job.id,
        code,
        'Processing failed. Consult the server worker log; create another job to retry.',
      ],
    );
  }
  return true;
}
