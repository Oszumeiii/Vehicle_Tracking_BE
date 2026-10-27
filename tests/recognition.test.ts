import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  claim,
  executeRecognition,
  persistResult,
  processOne,
  recover,
  validateResult,
  WorkerOptions,
} from '../src/recognition/engine';
import { fusePredictions, normalizePlate } from '../src/recognition/fusion';
import { PipelineRegistry, sha256 } from '../src/recognition/registry';
import { livePayload } from '../src/cli';
import { newId, seedUser, startTestDatabase } from './helpers';

test('Whole-plate fusion keeps abstentions and never converts letter O to zero', () => {
  assert.equal(normalizePlate(' ao-12 3\n'), 'AO123');
  assert.deepEqual(fusePredictions(['abc1234', 'ABC-1234', 'ABC 1234', 'wrong', null]), {
    machine_text: 'ABC1234',
    machine_status: 'readable',
    agreement_count: 3,
  });
  assert.deepEqual(fusePredictions(['ABC', 'ABC', 'DEF', 'DEF', '']), {
    machine_text: null,
    machine_status: 'ambiguous',
    agreement_count: 2,
  });
  assert.equal(fusePredictions(['', '', null, '', '']).machine_status, 'unreadable');
  assert.equal(fusePredictions([' ab-12 ']).machine_text, 'AB12');
  assert.throws(() => fusePredictions(['A', 'A', 'A']), /exactly five/);
});

test('Registry pins local code/checkpoints, sanitizes public metadata and refuses missing OCR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plate-registry-'));
  const previous = {
    config: process.env.PLATE_PIPELINES_CONFIG,
    python: process.env.PLATE_PIPELINE_PYTHON,
  };
  try {
    await mkdir(path.join(root, 'adapter'));
    await writeFile(path.join(root, 'adapter/ocr.py'), '# test-only adapter source');
    await writeFile(path.join(root, 'adapter/preprocessing.py'), '# test-only helper source');
    await writeFile(path.join(root, 'detector.pt'), 'test-checkpoint');
    await writeFile(path.join(root, 'ocr.pt'), 'test-checkpoint');
    const config = path.join(root, 'pipelines.json');
    await writeFile(
      config,
      JSON.stringify({
        pipelines: [
          {
            id: 'test',
            version: '1',
            detector: { model: 'yolo11n', checkpoint: 'detector.pt', version: 'yolo11n' },
            recognizer: {
              factory: 'ocr:create',
              module_root: 'adapter',
              checkpoint: 'ocr.pt',
              version: 'test',
              preprocessing_version: 'test-rgb',
            },
          },
        ],
      }),
    );
    process.env.PLATE_PIPELINES_CONFIG = config;
    process.env.PLATE_PIPELINE_PYTHON = process.execPath; // File-readiness test, no inference.
    const registry = new PipelineRegistry();
    const publicProfiles = await registry.list();
    assert.equal(publicProfiles[0].ready, true);
    assert.equal(JSON.stringify(publicProfiles).includes(root), false);
    const snapshot = await registry.resolve('test');
    assert.equal(snapshot.detector.sha256, await sha256(path.join(root, 'detector.pt')));
    assert.equal(snapshot.tracking.crop_padding, 0.15);
    assert.deepEqual(snapshot.sampling, {
      low_fps: 8,
      med_fps: 12,
      high_fps: 15,
      threshold_low: 2,
      threshold_high: 6,
    });
    assert.deepEqual(snapshot.empty_scene_gate, {
      enabled: true,
      probe_seconds: 0.25,
      empty_confirmations: 3,
      motion_fraction: 0.003,
      warmup_frames: 60,
    });
    assert.equal(snapshot.detector.model, 'yolo11n');
    assert.ok(snapshot.code_files.some((entry: any) => entry.path.endsWith('video_tracking.py')));
    assert.ok(snapshot.code_files.some((entry: any) => entry.path.endsWith('preprocessing.py')));
    assert.equal(snapshot.recognizer.input_mode, 'single_crop');
    const jointConfig = JSON.parse(await readFile(config, 'utf8'));
    jointConfig.pipelines[0].recognizer.input_mode = 'five_frame_joint';
    await writeFile(config, JSON.stringify(jointConfig));
    const jointProfile = (await registry.list())[0];
    assert.deepEqual(jointProfile.media_types, ['video']);
    assert.deepEqual(jointProfile.input_modes, ['scene']);
    const jointSnapshot = await registry.resolve('test');
    assert.deepEqual(jointSnapshot.fusion, {
      version: 'model-joint-five-frame-v1',
      video_crops: 5,
    });
    assert.equal(jointSnapshot.recognizer.input_mode, 'five_frame_joint');
    for (const [key, value, reason] of [
      ['pipeline_root', 'pipeline', /pipeline_root is no longer supported/],
      ['empty_scene_gate', { warmup_frames: 0 }, /empty-scene gate/],
      ['empty_scene_gate', { roi: [0, 0, 1, 1] }, /Unsupported empty-scene gate/],
    ] as const) {
      const invalid = structuredClone(jointConfig);
      invalid.pipelines[0][key] = value;
      await writeFile(config, JSON.stringify(invalid));
      await assert.rejects(registry.resolve('test'), reason);
    }
    const largeDetector = structuredClone(jointConfig);
    largeDetector.pipelines[0].detector.model = 'yolo11l';
    await writeFile(config, JSON.stringify(largeDetector));
    assert.equal((await registry.resolve('test')).detector.model, 'yolo11l');
    largeDetector.pipelines[0].detector.model = 'yolov8';
    await writeFile(config, JSON.stringify(largeDetector));
    await assert.rejects(registry.resolve('test'), /Unsupported license-plate detector/);
    await writeFile(config, JSON.stringify(jointConfig));
    await writeFile(path.join(root, 'adapter/preprocessing.py'), '# changed after enqueue');
    await assert.rejects(
      () =>
        executeRecognition(
          { job_kind: 'recognize', pipeline_snapshot: snapshot },
          root,
          {
            dataDir: root,
            python: process.execPath,
            cacheDir: root,
            timeoutSeconds: 5,
          },
          async () => {},
        ),
      (error: any) => error.code === 'CHECKPOINT_MISSING',
    );
    await rm(path.join(root, 'ocr.pt'));
    assert.equal((await registry.list())[0].ready, false);
    await assert.rejects(() => registry.resolve('test'), /checkpoint is unavailable/);
    await assert.rejects(() => registry.resolve('not-allowed'), /Unknown pipeline/);
    const preparation = JSON.parse(await readFile(config, 'utf8'));
    preparation.pipelines[0].task = 'prepare';
    delete preparation.pipelines[0].recognizer;
    await writeFile(config, JSON.stringify(preparation));
    const preparationProfile = (await registry.list())[0];
    assert.equal(preparationProfile.ready, true);
    assert.equal(preparationProfile.task, 'prepare');
    assert.equal(preparationProfile.models.recognizer, null);
    const preparationSnapshot = await registry.resolve('test');
    assert.equal(preparationSnapshot.task, 'prepare');
    assert.equal(preparationSnapshot.recognizer, undefined);
    assert.equal(preparationSnapshot.fusion, null);
  } finally {
    if (previous.config === undefined) delete process.env.PLATE_PIPELINES_CONFIG;
    else process.env.PLATE_PIPELINES_CONFIG = previous.config;
    if (previous.python === undefined) delete process.env.PLATE_PIPELINE_PYTHON;
    else process.env.PLATE_PIPELINE_PYTHON = previous.python;
    // mkdtemp's exact returned path is the only cleanup target.
    await rm(root, { recursive: true, force: true });
  }
});

test('Live payload pins the same joint-OCR snapshot as a job and accepts only YouTube', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plate-live-'));
  const previous = {
    config: process.env.PLATE_PIPELINES_CONFIG,
    python: process.env.PLATE_PIPELINE_PYTHON,
  };
  try {
    await mkdir(path.join(root, 'adapter'));
    await writeFile(path.join(root, 'adapter/ocr.py'), '# test-only adapter source');
    await writeFile(path.join(root, 'detector.pt'), 'test-checkpoint');
    await writeFile(path.join(root, 'ocr.pt'), 'test-checkpoint');
    const recognizer = {
      factory: 'ocr:create',
      module_root: 'adapter',
      checkpoint: 'ocr.pt',
      version: 'test',
      preprocessing_version: 'test-rgb',
    };
    const detector = { model: 'yolo11l', checkpoint: 'detector.pt', version: 'yolo11l' };
    const config = path.join(root, 'pipelines.json');
    await writeFile(
      config,
      JSON.stringify({
        pipelines: [
          {
            id: 'joint',
            version: '1',
            detector,
            recognizer: { ...recognizer, input_mode: 'five_frame_joint' },
          },
          { id: 'single', version: '1', detector, recognizer },
        ],
      }),
    );
    process.env.PLATE_PIPELINES_CONFIG = config;
    process.env.PLATE_PIPELINE_PYTHON = process.execPath; // File-readiness test, no inference.
    const out = path.join(root, 'payload.json');
    const url = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
    assert.equal(
      await livePayload(['live-payload', '--pipeline', 'joint', '--url', url, '--out', out]),
      out,
    );
    const payload = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(payload.source, { type: 'youtube', url, exclude_zones: [], max_height: 1080 });
    assert.deepEqual(payload.pipeline_snapshot, await new PipelineRegistry().resolve('joint'));
    for (const [pipeline, link, reason] of [
      ['joint', 'https://example.com/watch?v=x', /YouTube/],
      ['single', url, /five_frame_joint/],
      ['missing', url, /Unknown pipeline/],
    ] as const)
      await assert.rejects(
        livePayload(['live-payload', '--pipeline', pipeline, '--url', link, '--out', out]),
        reason,
      );
    await assert.rejects(livePayload(['live-payload', '--url', url]), /Use: live-payload/);
  } finally {
    if (previous.config === undefined) delete process.env.PLATE_PIPELINES_CONFIG;
    else process.env.PLATE_PIPELINES_CONFIG = previous.config;
    if (previous.python === undefined) delete process.env.PLATE_PIPELINE_PYTHON;
    else process.env.PLATE_PIPELINE_PYTHON = previous.python;
    await rm(root, { recursive: true, force: true });
  }
});

test('Node ML supervisor invokes only the configured crop adapter and propagates timeout', async (t) => {
  const python =
    process.env.PLATE_TEST_PYTHON ??
    path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  if (
    !(await access(python)
      .then(() => true)
      .catch(() => false))
  )
    return t.skip('Set PLATE_TEST_PYTHON to the Python/Pillow test interpreter');
  const root = await mkdtemp(path.join(tmpdir(), 'plate-sidecar-'));
  const previous = {
    config: process.env.PLATE_PIPELINES_CONFIG,
    python: process.env.PLATE_PIPELINE_PYTHON,
  };
  try {
    await mkdir(path.join(root, 'adapter'));
    await writeFile(
      path.join(root, 'adapter/sidecar_test_ocr.py'),
      `def create(config):\n    def predict(image):\n        assert image.mode == 'RGB'\n        assert image.size == (1, 1)\n        if config.get('config', {}).get('sleep'):\n            import time\n            time.sleep(30)\n        return {'raw_text': 'test-123', 'ocr_score': None}\n    return predict\n`,
    );
    await writeFile(path.join(root, 'detector.pt'), 'test-only-checkpoint');
    await writeFile(path.join(root, 'ocr.pt'), 'test-only-checkpoint');
    // Pillow-produced valid 1x1 RGB PNG.
    await writeFile(
      path.join(root, 'source.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    const config = path.join(root, 'pipelines.json');
    await writeFile(
      config,
      JSON.stringify({
        pipelines: [
          {
            id: 'sidecar',
            version: 'test',
            detector: { checkpoint: 'detector.pt', version: 'test' },
            recognizer: {
              factory: 'sidecar_test_ocr:create',
              module_root: 'adapter',
              checkpoint: 'ocr.pt',
              version: 'test',
              preprocessing_version: 'test',
            },
          },
        ],
      }),
    );
    process.env.PLATE_PIPELINES_CONFIG = config;
    process.env.PLATE_PIPELINE_PYTHON = python;
    const snapshot = await new PipelineRegistry().resolve('sidecar');
    const options: WorkerOptions = {
      dataDir: root,
      python,
      cacheDir: root,
      timeoutSeconds: 10,
    };
    const job = {
      id: newId(),
      job_kind: 'recognize',
      input_mode: 'plate_crop',
      media_type: 'image',
      pipeline_snapshot: snapshot,
      input_path: path.join(root, 'source.png'),
    };
    const folder = path.join(root, 'recognition', job.id);
    await mkdir(folder, { recursive: true });
    const result = await executeRecognition(job, folder, options, async () => {}).catch(
      async (error) => {
        throw new Error(
          `${error.message}\n${await readFile(path.join(folder, 'worker.log'), 'utf8')}`,
          { cause: error },
        );
      },
    );
    await validateResult(job, result, folder, options);
    assert.equal(result.appearances[0].machine_text, 'TEST123');
    assert.equal(result.appearances[0].detections[0].detection_score, null);
    assert.equal(result.appearances[0].detections[0].predictions[0].ocr_score, null);
    // A worker restart/config edit must not silently change an already queued run.
    assert.equal(
      JSON.parse(await readFile(path.join(folder, 'recognition-input.json'), 'utf8')).device,
      snapshot.device,
    );
    const preparationFolder = path.join(root, 'prepare');
    await mkdir(preparationFolder);
    const preparationSnapshot: Record<string, any> = { ...snapshot, task: 'prepare' };
    delete preparationSnapshot.recognizer;
    const preparationJob = {
      ...job,
      job_kind: 'detect_only',
      pipeline_snapshot: preparationSnapshot,
    };
    const preparationResult = await executeRecognition(
      preparationJob,
      preparationFolder,
      options,
      async () => {},
    );
    await validateResult(preparationJob, preparationResult, preparationFolder, options);
    assert.equal(preparationResult.appearances[0].machine_status, 'not_run');
    assert.equal(preparationResult.appearances[0].machine_text, null);
    assert.deepEqual(preparationResult.appearances[0].detections[0].predictions, []);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      () =>
        executeRecognition(
          job,
          path.join(root, 'never-started'),
          { ...options, signal: cancelled.signal },
          async () => {},
        ),
      (error: any) => error.code === 'WORKER_INTERRUPTED',
    );
    await assert.rejects(() => access(path.join(root, 'never-started')));
    snapshot.recognizer.config = { sleep: true };
    const timeoutFolder = path.join(root, 'timeout');
    await mkdir(timeoutFolder);
    await assert.rejects(
      () =>
        executeRecognition(job, timeoutFolder, { ...options, timeoutSeconds: 0.5 }, async () => {}),
      (error: any) => error.code === 'JOB_TIMEOUT',
    );
    await writeFile(path.join(root, 'ocr.pt'), 'modified-after-enqueue');
    await assert.rejects(
      () => executeRecognition(job, timeoutFolder, options, async () => {}),
      (error: any) => error.code === 'CHECKPOINT_MISSING',
    );
  } finally {
    if (previous.config === undefined) delete process.env.PLATE_PIPELINES_CONFIG;
    else process.env.PLATE_PIPELINES_CONFIG = previous.config;
    if (previous.python === undefined) delete process.env.PLATE_PIPELINE_PYTHON;
    else process.env.PLATE_PIPELINE_PYTHON = previous.python;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('PostgreSQL worker claims once, persists immutable evidence atomically, rejects invalid output and recovers', async (t) => {
  const fixture = await startTestDatabase();
  const { database, root } = fixture;
  const options: WorkerOptions = {
    dataDir: root,
    python: '',
    cacheDir: path.join(root, 'cache'),
    timeoutSeconds: 5,
  };
  try {
    const user = await seedUser(database);
    const mediaId = newId();
    const storageKey = 'source.png';
    await writeFile(path.join(root, storageKey), 'test-source');
    await database.query(
      `INSERT INTO media_assets (id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
      VALUES ($1,$2,'source.png','image',$3,'image/png',11,$4)`,
      [mediaId, user.id, storageKey, await sha256(path.join(root, storageKey))],
    );
    const enqueue = async () => {
      const jobId = newId();
      await database.query(
        "INSERT INTO recognition_jobs(id,media_id,input_mode) VALUES ($1,$2,'plate_crop')",
        [jobId, mediaId],
      );
      return jobId;
    };
    const evidence = async (jobId: string, folder: string) => {
      await mkdir(folder, { recursive: true });
      await writeFile(
        path.join(folder, 'crop.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQKkAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const key = `recognition/${jobId}/crop.png`;
      return {
        statistics: { total_detections: 1 },
        appearances: [
          {
            source_track_id: null,
            first_frame: null,
            last_frame: null,
            start_seconds: null,
            end_seconds: null,
            ...fusePredictions(['abc-1234']),
            detections: [
              {
                selected_order: 1,
                frame_index: null,
                timestamp_seconds: null,
                timestamp_source: 'still_image',
                bbox: [0, 0, 1, 1],
                crop_bbox: [0, 0, 1, 1],
                detection_score: null,
                crop_storage_key: key,
                frame_storage_key: key,
                crop_width: 1,
                crop_height: 1,
                predictions: [
                  {
                    variant: 'original',
                    raw_text: 'abc-1234',
                    normalized_text: 'ABC1234',
                    ocr_score: null,
                    character_scores: null,
                    input_storage_key: key,
                    latency_ms: 2,
                  },
                ],
              },
            ],
          },
        ],
      };
    };
    await t.test('concurrent claims never return the same queued job', async () => {
      const jobId = await enqueue();
      const claims = await Promise.all([claim(database), claim(database)]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claims.find(Boolean)?.id, jobId);
      await recover(database);
      assert.equal(
        (await database.query('SELECT error_code FROM recognition_jobs WHERE id=$1', [jobId]))
          .rows[0].error_code,
        'WORKER_INTERRUPTED',
      );
    });
    await t.test(
      'jobs the shared live host can run are claimed apart from the others',
      async () => {
        const processJob = await enqueue();
        const videoId = newId();
        await database.query(
          `INSERT INTO media_assets (id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
        VALUES ($1,$2,'clip.mp4','video','clip.mp4','video/mp4',1,$3)`,
          [videoId, user.id, 'a'.repeat(64)],
        );
        const hostJob = newId();
        await database.query(
          `INSERT INTO recognition_jobs(id,media_id,input_mode,pipeline_snapshot) VALUES ($1,$2,'scene',$3)`,
          [
            hostJob,
            videoId,
            JSON.stringify({ task: 'recognize', recognizer: { input_mode: 'five_frame_joint' } }),
          ],
        );
        assert.equal((await claim(database, 'host'))?.id, hostJob);
        assert.equal(
          await claim(database, 'host'),
          undefined,
          'a plate-crop job needs its own process',
        );
        assert.equal((await claim(database, 'process'))?.id, processJob);
        await recover(database);
      },
    );
    await t.test(
      'successful runner stores original prediction and pending machine result',
      async () => {
        const jobId = await enqueue();
        assert.equal(
          await processOne(database, options, async (job, folder, _options, stage) => {
            await stage('recognition');
            return evidence(job.id, folder);
          }),
          true,
        );
        const job = (await database.query('SELECT * FROM recognition_jobs WHERE id=$1', [jobId]))
          .rows[0];
        assert.equal(job.status, 'succeeded');
        const appearance = (
          await database.query('SELECT * FROM plate_appearances WHERE job_id=$1', [jobId])
        ).rows[0];
        assert.equal(appearance.effective_text, 'ABC1234');
        assert.equal(appearance.review_status, 'pending');
        const prediction = (await database.query('SELECT * FROM ocr_predictions')).rows[0];
        assert.equal(prediction.raw_text, 'abc-1234');
        assert.equal(prediction.ocr_score, null);
      },
    );
    await t.test(
      'invalid aggregation rejects all output and leaves no partial appearances',
      async () => {
        const jobId = await enqueue();
        await processOne(database, options, async (job, folder) => {
          const result = await evidence(job.id, folder);
          result.appearances[0].machine_text = 'WRONG';
          return result;
        });
        assert.equal(
          (await database.query('SELECT error_code FROM recognition_jobs WHERE id=$1', [jobId]))
            .rows[0].error_code,
          'RESULT_INVALID',
        );
        assert.equal(
          (await database.query('SELECT * FROM plate_appearances WHERE job_id=$1', [jobId])).rows
            .length,
          0,
        );
      },
    );
    await t.test('preparation persists evidence without inventing OCR predictions', async () => {
      const jobId = await enqueue();
      await database.query(
        "UPDATE recognition_jobs SET job_kind='detect_only', pipeline_snapshot=$2 WHERE id=$1",
        [jobId, JSON.stringify({ task: 'prepare' })],
      );
      await processOne(database, options, async (job, folder) => {
        const result: any = await evidence(job.id, folder);
        const appearance = result.appearances[0];
        appearance.machine_text = null;
        appearance.machine_status = 'not_run';
        appearance.agreement_count = 0;
        appearance.detections[0].predictions = [];
        return result;
      });
      const job = (await database.query('SELECT status FROM recognition_jobs WHERE id=$1', [jobId]))
        .rows[0];
      assert.equal(job.status, 'succeeded');
      const appearance = (
        await database.query('SELECT * FROM plate_appearances WHERE job_id=$1', [jobId])
      ).rows[0];
      assert.equal(appearance.machine_status, 'not_run');
      assert.equal(appearance.machine_text, null);
      assert.equal(appearance.effective_text, null);
      assert.equal(appearance.review_status, 'pending');
      assert.equal(
        (
          await database.query(
            'SELECT p.id FROM ocr_predictions p JOIN plate_detections d ON d.id=p.detection_id WHERE d.appearance_id=$1',
            [appearance.id],
          )
        ).rows.length,
        0,
      );
    });
    await t.test('shutdown before claiming leaves queued work for the next worker', async () => {
      const jobId = await enqueue();
      const shutdown = new AbortController();
      shutdown.abort();
      let called = false;
      assert.equal(
        await processOne(database, { ...options, signal: shutdown.signal }, async () => {
          called = true;
          throw new Error('An interrupted worker must not invoke inference');
        }),
        false,
      );
      assert.equal(called, false);
      assert.equal(
        (await database.query('SELECT status FROM recognition_jobs WHERE id=$1', [jobId])).rows[0]
          .status,
        'queued',
      );
      await database.query('DELETE FROM recognition_jobs WHERE id=$1', [jobId]);
    });
    await t.test('shutdown after inference cannot commit a successful result', async () => {
      const jobId = await enqueue();
      const shutdown = new AbortController();
      await processOne(database, { ...options, signal: shutdown.signal }, async (job, folder) => {
        const result = await evidence(job.id, folder);
        shutdown.abort();
        return result;
      });
      const job = (
        await database.query('SELECT status, error_code FROM recognition_jobs WHERE id=$1', [jobId])
      ).rows[0];
      assert.equal(job.status, 'failed');
      assert.equal(job.error_code, 'WORKER_INTERRUPTED');
      assert.equal(
        (await database.query('SELECT * FROM plate_appearances WHERE job_id=$1', [jobId])).rows
          .length,
        0,
      );
    });
    await t.test('five copies of one frame cannot be persisted as a video track', async () => {
      const jobId = newId();
      const folder = path.join(root, 'recognition', jobId);
      const result: any = await evidence(jobId, folder);
      const detection = result.appearances[0].detections[0];
      result.appearances[0].detections = Array.from({ length: 5 }, (_, i) => ({
        ...detection,
        selected_order: i + 1,
        frame_index: 1,
        timestamp_seconds: i,
      }));
      await assert.rejects(
        () =>
          validateResult({ job_kind: 'recognize', media_type: 'video' }, result, folder, options),
        /distinct frames/,
      );
      await assert.rejects(
        () =>
          validateResult(
            {
              job_kind: 'detect_only',
              media_type: 'video',
              pipeline_snapshot: { task: 'prepare' },
            },
            result,
            folder,
            options,
          ),
        /distinct frames/,
      );
    });
    await t.test('metadata cannot detach OCR evidence from the crop or source frame', async () => {
      const jobId = newId();
      const folder = path.join(root, 'recognition', jobId);
      const result = await evidence(jobId, folder);
      const detection = result.appearances[0].detections[0];
      detection.bbox = [0, 0, 2, 2];
      await assert.rejects(
        () =>
          validateResult({ job_kind: 'recognize', media_type: 'image' }, result, folder, options),
        /outside its source frame/,
      );
      detection.bbox = [0, 0, 1, 1];
      detection.predictions[0].input_storage_key = 'unrelated.png';
      await assert.rejects(
        () =>
          validateResult({ job_kind: 'recognize', media_type: 'image' }, result, folder, options),
        /differs from its crop/,
      );
    });
    await t.test(
      'valid five-frame evidence passes but repeated track identities fail',
      async () => {
        const jobId = newId();
        const folder = path.join(root, 'recognition', jobId);
        const result: any = await evidence(jobId, folder);
        const appearance = result.appearances[0];
        const detection = appearance.detections[0];
        appearance.detections = await Promise.all(
          Array.from({ length: 5 }, async (_, i) => {
            const key = `recognition/${jobId}/frame-${i}.png`;
            await writeFile(
              path.join(folder, `frame-${i}.png`),
              await readFile(path.join(folder, 'crop.png')),
            );
            return {
              ...detection,
              selected_order: i + 1,
              frame_index: i + 1,
              timestamp_seconds: i,
              timestamp_source: 'video_pts',
              crop_storage_key: key,
              frame_storage_key: key,
              predictions: [{ ...detection.predictions[0], input_storage_key: key }],
            };
          }),
        );
        Object.assign(appearance, {
          source_track_id: '42',
          first_frame: 1,
          last_frame: 5,
          start_seconds: 0,
          end_seconds: 4,
          ...fusePredictions(Array(5).fill('abc-1234')),
        });
        await validateResult(
          { job_kind: 'recognize', media_type: 'video' },
          result,
          folder,
          options,
        );
        // The same five crops can feed a single joint prediction; there are no
        // individual OCR predictions or majority votes to invent in that case.
        const jointResult = structuredClone(result);
        const jointAppearance = jointResult.appearances[0];
        const originalPrediction = jointAppearance.detections[0].predictions[0];
        jointAppearance.predictions = [
          {
            variant: 'joint',
            raw_text: 'abc-1234',
            normalized_text: 'ABC1234',
            ocr_score: null,
            character_scores: null,
            latency_ms: 12,
            input_storage_keys: jointAppearance.detections.map((d: any) => d.crop_storage_key),
            frame_weights: [0.1, 0.2, 0.3, 0.25, 0.15],
            decoding: {
              decoder: 'beam_filter',
              beam_width: 8,
              use_tta: false,
              plate_text: 'abc-1234',
              greedy_text: 'ABC12234',
              format_valid: false,
              greedy_symbol_confidence: 0.9,
              beam_log_score: -0.7,
              beam_confidence_proxy: 0.9,
            },
          },
        ];
        jointAppearance.detections.forEach((d: any) => {
          d.predictions = [];
        });
        jointAppearance.agreement_count = null;
        jointAppearance.recognition_method = 'joint_multiframe';
        const jointJob = {
          id: jobId,
          job_kind: 'recognize',
          media_type: 'video',
          input_mode: 'scene',
          pipeline_snapshot: { recognizer: { input_mode: 'five_frame_joint' } },
        };
        await validateResult(jointJob, jointResult, folder, options);
        const decoding = jointAppearance.predictions[0].decoding;
        for (const invalid of [
          { ...decoding, plate_text: 'OTHER' },
          { ...decoding, decoder: 'vote' },
          { ...decoding, beam_confidence_proxy: 1.5 },
          { ...decoding, extra: true },
          'beam_filter',
        ]) {
          jointAppearance.predictions[0].decoding = invalid;
          await assert.rejects(
            () => validateResult(jointJob, jointResult, folder, options),
            /Invalid OCR decoding details/,
          );
        }
        jointAppearance.predictions[0].decoding = decoding;
        await assert.rejects(
          () => validateResult({ ...jointJob, media_type: 'image' }, jointResult, folder, options),
          /scene video only/,
        );
        jointAppearance.predictions[0].input_storage_keys.reverse();
        await assert.rejects(
          () => validateResult(jointJob, jointResult, folder, options),
          /ordered evidence/,
        );
        jointAppearance.predictions[0].input_storage_keys.reverse();
        jointAppearance.agreement_count = 5;
        await assert.rejects(
          () => validateResult(jointJob, jointResult, folder, options),
          /aggregation differs/,
        );
        jointAppearance.agreement_count = null;
        jointAppearance.detections[0].predictions = [originalPrediction];
        await assert.rejects(
          () => validateResult(jointJob, jointResult, folder, options),
          /Invalid predictions/,
        );
        jointAppearance.detections[0].predictions = [];
        const videoId = newId();
        await database.query(
          `INSERT INTO media_assets
          (id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
          VALUES ($1,$2,'test.mp4','video',$3,'video/mp4',11,$4)`,
          [videoId, user.id, 'fixture-joint.mp4', 'a'.repeat(64)],
        );
        await database.query(
          `INSERT INTO recognition_jobs(id,media_id,input_mode,status,pipeline_snapshot)
          VALUES ($1,$2,'scene','running',$3)`,
          [jobId, videoId, JSON.stringify(jointJob.pipeline_snapshot)],
        );
        await persistResult(database, jointJob, jointResult);
        const savedAppearance = (
          await database.query('SELECT * FROM plate_appearances WHERE job_id=$1', [jobId])
        ).rows[0];
        assert.equal(savedAppearance.recognition_method, 'joint_multiframe');
        assert.equal(savedAppearance.agreement_count, null);
        assert.equal(savedAppearance.effective_text, 'ABC1234');
        const savedPrediction = (
          await database.query('SELECT * FROM ocr_predictions WHERE appearance_id=$1', [
            savedAppearance.id,
          ])
        ).rows[0];
        assert.equal(savedPrediction.detection_id, null);
        assert.equal(savedPrediction.input_storage_key, null);
        assert.deepEqual(
          savedPrediction.input_storage_keys,
          jointAppearance.predictions[0].input_storage_keys,
        );
        assert.deepEqual(savedPrediction.frame_weights, [0.1, 0.2, 0.3, 0.25, 0.15]);
        assert.equal(savedPrediction.ocr_score, null);
        assert.equal(
          (
            await database.query(
              `SELECT p.id FROM ocr_predictions p JOIN plate_detections d
          ON d.id=p.detection_id WHERE d.appearance_id=$1`,
              [savedAppearance.id],
            )
          ).rowCount,
          0,
        );
        result.appearances.push(structuredClone(appearance));
        await assert.rejects(
          () =>
            validateResult({ job_kind: 'recognize', media_type: 'video' }, result, folder, options),
          /extent or identity/,
        );
      },
    );
    await t.test('changed source fails before the runner is invoked', async () => {
      const jobId = await enqueue();
      await writeFile(path.join(root, storageKey), 'changed');
      let called = false;
      await processOne(database, options, async () => {
        called = true;
        throw new Error();
      });
      assert.equal(called, false);
      assert.equal(
        (await database.query('SELECT error_code FROM recognition_jobs WHERE id=$1', [jobId]))
          .rows[0].error_code,
        'INPUT_CHANGED',
      );
    });
  } finally {
    await fixture.dispose();
  }
});
