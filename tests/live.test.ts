import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { GpuGate, LiveManager } from '../src/live/manager';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR4nGPkEpFjwAaYsIqSJQEAGNgARL3K8HcAAAAASUVORK5CYII=',
  'base64',
);
const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let dataDir: string;
const tokens: Record<'admin' | 'owner' | 'stranger', string> = {
  admin: '',
  owner: '',
  stranger: '',
};
const oldEnvironment = { ...process.env };
const ENV_KEYS = ['DATABASE_URL', 'PLATE_DATA_DIR', 'PLATE_PIPELINE_PYTHON', 'NODE_ENV'];

before(async () => {
  fixture = await startTestDatabase();
  dataDir = join(fixture.root, 'artifacts');
  const models = join(fixture.root, 'models');
  await mkdir(join(models, 'adapter'), { recursive: true });
  await writeFile(join(models, 'adapter/ocr.py'), '# test-only adapter source');
  await writeFile(join(models, 'detector.pt'), 'test-checkpoint');
  await writeFile(join(models, 'ocr.pt'), 'test-checkpoint');
  const recognizer = {
    factory: 'ocr:create',
    module_root: 'adapter',
    checkpoint: 'ocr.pt',
    version: 'test',
    preprocessing_version: 'test-rgb',
  };
  const detector = { model: 'yolo11l', checkpoint: 'detector.pt', version: 'yolo11l' };
  await writeFile(
    join(models, 'pipelines.json'),
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
  ENV_KEYS.push('PLATE_PIPELINES_CONFIG');
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // File-readiness only; no inference runs.
    PLATE_PIPELINES_CONFIG: join(models, 'pipelines.json'),
    NODE_ENV: 'test',
  });
  app = await createApp();
  api = request(app.getHttpServer());
  for (const role of ['admin', 'owner', 'stranger'] as const) {
    const user = await seedUser(fixture.database, role === 'admin' ? 'admin' : 'user');
    tokens[role] = (
      await api
        .post('/api/v2/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200)
    ).body.access_token;
  }
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
  for (const key of ENV_KEYS) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

const as = (role: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[role]}` });

async function camera(name = 'Camboriú', zones: number[][] = []) {
  return (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name, url: URL, exclude_zones: zones })
      .expect(201)
  ).body;
}

async function session(sourceId: string) {
  return (
    await api
      .post(`/api/v2/stream-sources/${sourceId}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
}

/** A track folder as `python -m app.live` writes it (keys relative to the data dir). */
async function writeTrack(
  sessionId: string,
  key: string,
  options: { duplicateOf?: string; status?: string; text?: string; missingCrop?: boolean } = {},
) {
  const base = `live/${sessionId}/tracks/${key}`;
  await mkdir(join(dataDir, base, 'crops'), { recursive: true });
  await mkdir(join(dataDir, base, 'keyframes'), { recursive: true });
  const text = options.text ?? 'ABC1234';
  const detections = [];
  for (let i = 1; i <= 5; i++) {
    const crop = `${base}/crops/0${i}.png`;
    const frame = `${base}/keyframes/frame_${i}.png`;
    if (!(options.missingCrop && i === 5)) await writeFile(join(dataDir, crop), image);
    await writeFile(join(dataDir, frame), image);
    detections.push({
      selected_order: i,
      frame_index: i * 8,
      timestamp_seconds: 100 + i * 0.8,
      timestamp_source: 'live_pts',
      bbox: [0, 0, 8, 4],
      crop_bbox: [0, 0, 8, 4],
      detection_score: 0.9,
      crop_storage_key: crop,
      frame_storage_key: frame,
      crop_width: 8,
      crop_height: 4,
      predictions: [],
    });
  }
  const record = {
    track: key,
    epoch: 0,
    status: options.status ?? 'readable',
    confidence: 0.9,
    duplicate_of: options.duplicateOf ?? null,
    observations: 12,
    captured_from: '2026-10-24T10:00:00.000Z',
    captured_to: '2026-10-24T10:00:04.000Z',
    appearance: {
      source_track_id: key,
      first_frame: 8,
      last_frame: 40,
      start_seconds: 100.8,
      end_seconds: 104,
      detections,
      machine_text: text,
      machine_status: 'readable',
      agreement_count: null,
      recognition_method: 'joint_multiframe',
      predictions: [
        {
          variant: 'joint',
          raw_text: text,
          normalized_text: text,
          ocr_score: null,
          character_scores: null,
          input_storage_keys: detections.map((d) => d.crop_storage_key),
          frame_weights: null,
          decoding: null,
          latency_ms: 5,
        },
      ],
    },
  };
  await writeFile(join(dataDir, base, 'track.json'), JSON.stringify(record));
}

type Fake = ChildProcess & {
  line(event: Record<string, unknown>): void;
  exit(code: number): void;
  input: string;
};

/** Stand-in for the live process: tests write its stdout and read its stdin. */
function fakeChild(onStop?: (child: Fake) => void): Fake {
  const child = new EventEmitter() as Fake;
  const [stdin, stdout, stderr] = [new PassThrough(), new PassThrough(), new PassThrough()];
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    input: '',
    line: (event: Record<string, unknown>) => stdout.write(JSON.stringify(event) + '\n'),
    exit: (code: number) => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit('close', code));
    },
  });
  stdin.on('data', (chunk) => {
    child.input += String(chunk);
    if (child.input.includes('stop\n')) onStop?.(child);
  });
  return child;
}

function manager(spawned: { args: string[]; child: Fake }[], onStop?: (child: Fake) => void) {
  const options = { ...workerOptions(), python: process.execPath };
  return new LiveManager(
    fixture.database,
    options,
    { maxSessions: 1, statsSeconds: 0.05, stopSeconds: 5, stallSeconds: 60, exclusiveGpu: true },
    (_python, args) => {
      const child = fakeChild(onStop);
      spawned.push({ args, child });
      return child;
    },
  );
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sessionRow = async (id: string) =>
  (await fixture.database.query('SELECT * FROM live_sessions WHERE id=$1', [id])).rows[0];
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

test('cameras and sessions are owner scoped, validated and limited to one active session', async () => {
  await api
    .post('/api/v2/stream-sources')
    .set(as('owner'))
    .send({ name: 'x', url: 'https://example.com/watch?v=1' })
    .expect(422);
  for (const zone of [
    [0.5, 0.2, 0.4, 0.3],
    [0, 0, 1.2, 1],
    [0, 0, 1],
  ])
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'x', url: URL, exclude_zones: [zone] })
      .expect(422);
  const source = await camera('Avenida', [[0.1, 0.1, 0.3, 0.2]]);
  assert.deepEqual(source.exclude_zones, [[0.1, 0.1, 0.3, 0.2]]);
  assert.equal(source.active_session, null);
  await api.get(`/api/v2/stream-sources/${source.id}`).set(as('stranger')).expect(404);
  assert.equal((await api.get('/api/v2/stream-sources').set(as('stranger'))).body.total, 0);
  assert.ok((await api.get('/api/v2/stream-sources').set(as('admin'))).body.total >= 1);
  const renamed = await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ name: 'Avenida Atlântica', exclude_zones: [[0.6, 0.1, 0.9, 0.2]] })
    .expect(200);
  assert.equal(renamed.body.name, 'Avenida Atlântica');
  await api.patch(`/api/v2/stream-sources/${source.id}`).set(as('owner')).send({}).expect(422);

  const start = (role: keyof typeof tokens, pipeline: string) =>
    api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as(role))
      .send({ pipeline_id: pipeline });
  await start('stranger', 'joint').expect(404);
  await start('owner', 'single').expect(422);
  await start('owner', 'missing').expect(404);
  const queued = (await start('owner', 'joint').expect(202)).body;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.pipeline_id, 'joint');
  assert.equal(queued.pipeline_snapshot, undefined);
  assert.deepEqual(queued.settings, {
    min_confidence: 0.85,
    max_track_seconds: 30,
    exclude_zones: [[0.6, 0.1, 0.9, 0.2]],
  });
  await start('owner', 'joint').expect(409);
  const shown = await api.get(`/api/v2/stream-sources/${source.id}`).set(as('owner')).expect(200);
  assert.equal(shown.body.active_session.id, queued.id);
  await api.get(`/api/v2/live-sessions/${queued.id}`).set(as('stranger')).expect(404);

  const stopped = await api
    .post(`/api/v2/live-sessions/${queued.id}/stop`)
    .set(as('owner'))
    .expect(202);
  assert.equal(stopped.body.status, 'stopped');
  await api.post(`/api/v2/live-sessions/${queued.id}/stop`).set(as('owner')).expect(409);
  const events = await api
    .get(`/api/v2/live-sessions/${queued.id}/events`)
    .set(as('owner'))
    .expect(200);
  assert.deepEqual(
    events.body.items.map((e: any) => e.payload.status),
    ['queued', 'stopped'],
  );
  const listed = await api
    .get(`/api/v2/live-sessions?stream_source_id=${source.id}&status=stopped`)
    .set(as('owner'))
    .expect(200);
  assert.equal(listed.body.total, 1);
  await api.delete(`/api/v2/stream-sources/${source.id}`).set(as('owner')).expect(409);
  const unused = await camera('unused');
  await api.delete(`/api/v2/stream-sources/${unused.id}`).set(as('stranger')).expect(404);
  await api.delete(`/api/v2/stream-sources/${unused.id}`).set(as('owner')).expect(204);
});

test('live manager runs a session, ingests tracks as jobs and stops on request', async () => {
  const source = await camera('Camboriú', [[0.1, 0.1, 0.3, 0.2]]);
  const queued = await session(source.id);
  const spawned: { args: string[]; child: Fake }[] = [];
  const live = manager(spawned, (child) => {
    child.line({ type: 'status', status: 'stopped', reason: null, tracks: 2 });
    child.exit(0);
  });
  await live.tick();
  assert.equal(spawned.length, 1);
  const { args, child } = spawned[0];
  const folder = join(dataDir, 'live', queued.id);
  assert.deepEqual(args.slice(0, 2), ['-m', 'app.live']);
  assert.equal(args[args.indexOf('--out') + 1], folder);
  assert.equal(args[args.indexOf('--data-dir') + 1], dataDir);
  const payload = JSON.parse(await readFile(join(folder, 'payload.json'), 'utf8'));
  assert.deepEqual(payload.source, {
    type: 'youtube',
    url: URL,
    exclude_zones: [[0.1, 0.1, 0.3, 0.2]],
  });
  assert.equal(payload.pipeline_snapshot.id, 'joint');

  await writeTrack(queued.id, 'e000-t000001');
  await writeTrack(queued.id, 'e000-t000002', {
    duplicateOf: 'e000-t000001',
    status: 'low_confidence',
  });
  await writeTrack(queued.id, 'e000-t000003', { missingCrop: true });
  child.line({ type: 'status', status: 'starting' });
  child.line({ type: 'status', status: 'connecting', epoch: 0 });
  child.line({ type: 'status', status: 'running', epoch: 0, width: 1920, height: 1080, fps: 30 });
  child.line({ type: 'stats', epoch: 0, frames_read: 30, frames_dropped: 0, lag_seconds: 0.4 });
  for (const track of ['e000-t000001', 'e000-t000002', 'e000-t000003'])
    child.line({ type: 'track', track, epoch: 0 });
  const running = await until(
    () => sessionRow(queued.id),
    (row) => row.tracks_count === 2 && row.stats_at !== null,
    'tracks and stats',
  );
  assert.equal(running.status, 'running');
  assert.ok(running.started_at);
  assert.equal(running.stats.frames_read, 30);
  await until(
    async () =>
      (
        await fixture.database.query(
          "SELECT payload FROM live_session_events WHERE session_id=$1 AND event_type='track_rejected'",
          [queued.id],
        )
      ).rows,
    (rows) => rows.length === 1 && rows[0].payload.track === 'e000-t000003',
    'rejected track event',
  );
  assert.ok(await exists(join(folder, 'tracks', 'e000-t000003', 'track.json')));

  const jobs = (
    await fixture.database.query(
      'SELECT * FROM recognition_jobs WHERE live_session_id=$1 ORDER BY live_track_key',
      [queued.id],
    )
  ).rows;
  assert.deepEqual(
    jobs.map((j) => [j.live_track_key, j.status, j.confidence_status]),
    [
      ['e000-t000001', 'succeeded', 'readable'],
      ['e000-t000002', 'succeeded', 'low_confidence'],
    ],
  );
  assert.equal(jobs[1].duplicate_of_job_id, jobs[0].id);
  assert.equal(jobs[0].captured_from.toISOString(), '2026-10-24T10:00:00.000Z');
  assert.ok(!(await exists(join(folder, 'tracks', 'e000-t000001'))));
  assert.ok(await exists(join(dataDir, 'recognition', jobs[0].id, 'track.json')));
  const detections = (
    await fixture.database.query(
      `SELECT d.* FROM plate_detections d JOIN plate_appearances a ON a.id=d.appearance_id
      WHERE a.job_id=$1 ORDER BY d.selected_order`,
      [jobs[0].id],
    )
  ).rows;
  assert.equal(detections.length, 5);
  assert.ok(detections.every((d) => d.crop_storage_key.startsWith(`recognition/${jobs[0].id}/`)));
  assert.ok(detections.every((d) => d.timestamp_source === 'live_pts'));

  // Live results join the general plate search, review, evidence and CSV paths.
  const search = await api
    .get('/api/v2/recognition-results?origin=live&plate=abc-1234')
    .set(as('owner'))
    .expect(200);
  assert.equal(search.body.total, 2);
  const first = search.body.items.find((item: any) => item.job_id === jobs[0].id);
  assert.equal(first.origin, 'live');
  assert.equal(first.stream_source_id, source.id);
  assert.equal(first.media_id, null);
  assert.equal(first.confidence_status, 'readable');
  assert.equal(
    (
      await api
        .get(`/api/v2/recognition-results?live_session_id=${queued.id}&exclude_duplicates=true`)
        .set(as('owner'))
    ).body.total,
    1,
  );
  assert.equal(
    (await api.get('/api/v2/recognition-results?origin=live').set(as('stranger'))).body.total,
    0,
  );
  await api.get(`/api/v2/recognition-results/${first.id}`).set(as('stranger')).expect(404);
  const detail = await api.get(`/api/v2/recognition-results/${first.id}`).set(as('owner'));
  assert.equal(detail.status, 200);
  await api
    .get(`/api/v2/detections/${detections[0].id}/artifacts/crop`)
    .set(as('owner'))
    .expect(200);
  await api
    .post(`/api/v2/recognition-results/${first.id}/reviews`)
    .set(as('owner'))
    .send({ action: 'correct', corrected_text: 'ABC1235', expected_revision: 0 })
    .expect(201);
  const csv = await api
    .get(`/api/v2/recognition-jobs/${jobs[0].id}/export`)
    .set(as('owner'))
    .expect(200);
  assert.match(csv.text, /2026-10-24T10:00:00\.000Z/);
  assert.match(csv.text, /"readable"/);
  const defaultJobs = await api.get('/api/v2/recognition-jobs').set(as('owner')).expect(200);
  assert.ok(defaultJobs.body.items.every((job: any) => job.media_id !== null));
  const liveJobs = await api
    .get(`/api/v2/recognition-jobs?origin=live&live_session_id=${queued.id}`)
    .set(as('owner'))
    .expect(200);
  assert.equal(liveJobs.body.total, 2);
  assert.equal(liveJobs.body.items[0].pipeline_id, 'joint');

  await api.post(`/api/v2/live-sessions/${queued.id}/stop`).set(as('owner')).expect(202);
  await live.tick();
  assert.equal(child.input, 'stop\n');
  const stopped = await until(
    () => sessionRow(queued.id),
    (row) => row.status === 'stopped',
    'stopped session',
  );
  assert.ok(stopped.finished_at);
  assert.equal(stopped.error_code, null);
  assert.equal(live.active, 0);
  const statuses = (
    await fixture.database.query(
      "SELECT payload->>'status' AS status FROM live_session_events WHERE session_id=$1 AND event_type='status' ORDER BY id",
      [queued.id],
    )
  ).rows.map((row) => row.status);
  assert.deepEqual(statuses, [
    'queued',
    'starting',
    'starting',
    'connecting',
    'running',
    'stopping',
    'stopped',
  ]);

  await api.delete(`/api/v2/recognition-jobs/${jobs[1].id}`).set(as('owner')).expect(204);
  assert.ok(!(await exists(join(dataDir, 'recognition', jobs[1].id))));
});

test('a crashed live process fails its session; worker restart and shutdown interrupt sessions but keep tracks', async () => {
  const spawned: { args: string[]; child: Fake }[] = [];
  const crashing = await camera('crash');
  const crashed = await session(crashing.id);
  const live = manager(spawned);
  await live.tick();
  spawned[0].child.line({ type: 'status', status: 'running', epoch: 0 });
  spawned[0].child.exit(1);
  const failed = await until(
    () => sessionRow(crashed.id),
    (row) => row.status === 'failed',
    'failed session',
  );
  assert.equal(failed.error_code, 'LIVE_PROCESS_EXITED');

  const startup = await session(crashing.id);
  await live.tick();
  spawned[1].child.line({ type: 'error', code: 'CHECKPOINT_MISSING', message: 'missing' });
  spawned[1].child.line({ type: 'status', status: 'failed', reason: 'startup' });
  spawned[1].child.exit(1);
  assert.equal(
    (
      await until(
        () => sessionRow(startup.id),
        (row) => row.status === 'failed',
        'startup',
      )
    ).error_code,
    'CHECKPOINT_MISSING',
  );

  // A previous worker died mid-session after writing a track to disk.
  const orphan = await camera('orphan');
  const left = await session(orphan.id);
  await fixture.database.query("UPDATE live_sessions SET status='running' WHERE id=$1", [left.id]);
  await writeTrack(left.id, 'e001-t000004');
  await manager([]).recover();
  const recovered = await sessionRow(left.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.error_code, 'WORKER_INTERRUPTED');
  assert.equal(recovered.tracks_count, 1);
  assert.ok(!(await exists(join(dataDir, 'live', left.id, 'tracks', 'e001-t000004'))));

  // Worker shutdown stops the child gracefully; its final tracks still count.
  const running = await session(orphan.id);
  const stopping: { args: string[]; child: Fake }[] = [];
  const graceful = manager(stopping, (child) => {
    void writeTrack(running.id, 'e000-t000009').then(() => {
      child.line({ type: 'track', track: 'e000-t000009', epoch: 0 });
      child.line({ type: 'status', status: 'stopped', reason: null, tracks: 1 });
      child.exit(0);
    });
  });
  await graceful.tick();
  stopping[0].child.line({ type: 'status', status: 'running', epoch: 0 });
  await graceful.shutdown();
  const interrupted = await sessionRow(running.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.tracks_count, 1);
});

test('an exclusive GPU runs upload jobs or live sessions, never both, and a silent live process is killed', async () => {
  const gate = new GpuGate(true);
  assert.equal(gate.enter('jobs'), true);
  assert.equal(gate.enter('jobs'), true);
  assert.equal(gate.enter('live'), false);
  gate.leave('jobs');
  gate.leave('jobs');
  const shared = new GpuGate(false);
  assert.equal(shared.enter('jobs') && shared.enter('live'), true);

  const source = await camera('stall');
  const waiting = await session(source.id);
  const spawned: { args: string[]; child: Fake }[] = [];
  const live = new LiveManager(
    fixture.database,
    { ...workerOptions(), python: process.execPath },
    { maxSessions: 1, statsSeconds: 0.05, stopSeconds: 5, stallSeconds: 0.2, exclusiveGpu: true },
    (_python) => {
      const child = fakeChild();
      spawned.push({ args: [], child });
      return child;
    },
    gate,
  );
  gate.enter('jobs'); // an upload job is running
  await live.tick();
  assert.equal(spawned.length, 0);
  assert.equal((await sessionRow(waiting.id)).status, 'queued');
  gate.leave('jobs');
  await live.tick();
  assert.equal(spawned.length, 1);
  assert.equal(gate.enter('jobs'), false, 'uploads wait while the session runs');

  await new Promise((resolve) => setTimeout(resolve, 300)); // no events from the process
  await live.tick();
  spawned[0].child.exit(1); // what stopTree does to a real process
  const failed = await until(
    () => sessionRow(waiting.id),
    (row) => row.status === 'failed',
    'stalled session',
  );
  assert.equal(failed.error_code, 'LIVE_STALLED');
  assert.equal(gate.enter('jobs'), true, 'the GPU is free again');
  gate.leave('jobs');
});
