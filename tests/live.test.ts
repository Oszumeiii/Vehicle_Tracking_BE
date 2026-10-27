import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { GpuGate, LiveManager } from '../src/live/manager';
import { SharedLiveHost } from '../src/live/host';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import {
  Fake,
  fakeChild,
  livePipelines,
  until,
  writeTrack as writeLiveTrack,
} from './live-fixtures';

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
  const pipelines = await livePipelines(fixture.root);
  ENV_KEYS.push('PLATE_PIPELINES_CONFIG');
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // File-readiness only; no inference runs.
    PLATE_PIPELINES_CONFIG: pipelines,
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

const writeTrack = (
  sessionId: string,
  key: string,
  options?: Parameters<typeof writeLiveTrack>[3],
) => writeLiveTrack(dataDir, sessionId, key, options);

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
    min_confidence: 0.96,
    max_track_seconds: 30,
    max_height: 1080,
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

test('administrators add demo cameras that replay a video from demo-videos in a loop', async () => {
  const videos = join(dataDir, 'demo-videos');
  await mkdir(videos, { recursive: true });
  await writeFile(join(videos, 'camboriu.mp4'), 'not decoded by this test');
  await writeFile(join(videos, 'notes.txt'), 'ignored');
  const listed = await api.get('/api/v2/demo-videos').set(as('admin')).expect(200);
  assert.deepEqual(listed.body.items, [{ path: 'camboriu.mp4', size_bytes: 24 }]);
  await api.get('/api/v2/demo-videos').set(as('owner')).expect(403);

  const demo = { name: 'Demo', source_type: 'file', path: 'camboriu.mp4' };
  await api.post('/api/v2/stream-sources').set(as('owner')).send(demo).expect(403);
  for (const path of ['../users.mp4', 'missing.mp4', 'notes.txt', 'C:/videos/x.mp4'])
    await api
      .post('/api/v2/stream-sources')
      .set(as('admin'))
      .send({ ...demo, path })
      .expect(422);
  const source = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('admin'))
      .send({ ...demo, exclude_zones: [[0, 0, 0.2, 0.2]] })
      .expect(201)
  ).body;
  assert.equal(source.source_type, 'file');
  assert.equal(source.embed_url, null);
  const queued = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('admin'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  const spawned: { args: string[]; child: Fake }[] = [];
  const live = manager(spawned);
  await live.tick();
  const payload = JSON.parse(
    await readFile(join(dataDir, 'live', queued.id, 'payload.json'), 'utf8'),
  );
  assert.deepEqual(payload.source, {
    type: 'file',
    path: join(videos, 'camboriu.mp4'),
    realtime: true,
    loop: true,
    exclude_zones: [[0, 0, 0.2, 0.2]],
  });
  spawned[0].child.exit(1);
  await until(
    () => sessionRow(queued.id),
    (row) => row.status === 'failed',
    'demo session ended',
  );
});

test('IP cameras use their RTSP URL in the live process but never return its password', async () => {
  const secret = 'rtsp://admin:hunter2@10.0.0.5:554/Streaming/Channels/101';
  for (const url of ['http://10.0.0.5/live', 'rtsp://', 'not a url'])
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'Gate', source_type: 'rtsp', url })
      .expect(422);
  const created = await api
    .post('/api/v2/stream-sources')
    .set(as('owner'))
    .send({ name: 'Gate', source_type: 'rtsp', url: secret })
    .expect(201);
  const source = created.body;
  assert.equal(source.source_type, 'rtsp');
  assert.equal(source.url, 'rtsp://admin:***@10.0.0.5:554/Streaming/Channels/101');
  assert.equal(source.embed_url, null);
  for (const response of [
    created,
    await api.get('/api/v2/stream-sources').set(as('owner')).expect(200),
    await api.get(`/api/v2/stream-sources/${source.id}`).set(as('owner')).expect(200),
  ])
    assert.ok(!JSON.stringify(response.body).includes('hunter2'));
  // New credentials: only an RTSP camera's URL can change.
  const rotated = 'rtsp://admin:n3w-pass@10.0.0.5:554/Streaming/Channels/101';
  const patched = await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ url: rotated })
    .expect(200);
  assert.ok(!JSON.stringify(patched.body).includes('n3w-pass'));
  const youtube = await camera('YouTube');
  await api
    .patch(`/api/v2/stream-sources/${youtube.id}`)
    .set(as('owner'))
    .send({ url: rotated })
    .expect(422);

  const queued = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint', max_height: 720 })
      .expect(202)
  ).body;
  const spawned: { args: string[]; child: Fake }[] = [];
  const live = manager(spawned);
  await live.tick();
  const payload = JSON.parse(
    await readFile(join(dataDir, 'live', queued.id, 'payload.json'), 'utf8'),
  );
  assert.deepEqual(payload.source, {
    type: 'rtsp',
    url: rotated,
    exclude_zones: [],
    max_height: 720,
  });
  // ffmpeg errors quote the URL: events and the stored error keep the password out.
  spawned[0].child.line({
    type: 'status',
    status: 'reconnecting',
    reason: `Connection to ${rotated} failed`,
  });
  spawned[0].child.line({
    type: 'status',
    status: 'failed',
    reason: `Camera refused the stream: ${rotated}`,
  });
  spawned[0].child.exit(1);
  const row = await until(
    () => sessionRow(queued.id),
    (value) => value.status === 'failed',
    'rtsp session failed',
  );
  assert.ok(!row.error_message.includes('n3w-pass') && row.error_message.includes('admin:***@'));
  const stored = await fixture.database.query(
    'SELECT payload::text AS text FROM live_session_events WHERE session_id=$1',
    [queued.id],
  );
  assert.ok(stored.rows.length > 0);
  assert.ok(stored.rows.every((event) => !String(event.text).includes('n3w-pass')));
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
    max_height: 1080,
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
  assert.equal(first.media_type, null);
  assert.ok(first.primary_detection_id);
  const liveJob = await api
    .get(`/api/v2/recognition-jobs/${jobs[0].id}`)
    .set(as('owner'))
    .expect(200);
  assert.equal(liveJob.body.media_type, null);
  const liveResults = await api
    .get(`/api/v2/recognition-jobs/${jobs[0].id}/results`)
    .set(as('owner'))
    .expect(200);
  assert.equal(liveResults.body.total, 1);
  assert.equal(liveResults.body.items[0].id, first.id);
  assert.ok(liveResults.body.items[0].primary_detection_id);
  await api.get(`/api/v2/recognition-jobs/${jobs[0].id}/results`).set(as('stranger')).expect(404);
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
  await until(
    async () => live.active,
    (active) => active === 0,
    'finished run',
  ); // status is written first
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

test('with several sessions allowed, sessions share one host process and end independently', async () => {
  const hosts: { args: string[]; child: Fake; commands: any[] }[] = [];
  const shared = new SharedLiveHost(
    (_python, args) => {
      const child = fakeChild();
      const entry = { args, child, commands: [] as any[] };
      createInterface({ input: child.stdin as unknown as NodeJS.ReadableStream }).on(
        'line',
        (line) => entry.commands.push(JSON.parse(line)),
      );
      hosts.push(entry);
      return child;
    },
    dataDir,
    0.5,
  );
  const live = new LiveManager(
    fixture.database,
    { ...workerOptions(), python: process.execPath },
    { maxSessions: 2, statsSeconds: 0.05, stopSeconds: 5, stallSeconds: 60, exclusiveGpu: true },
    shared.spawn,
  );
  const first = await session((await camera('host-1')).id);
  const second = await session((await camera('host-2')).id);
  await live.tick();
  await until(
    async () => hosts[0]?.commands.length ?? 0,
    (n) => n === 2,
    'two start commands',
  );
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0].args.includes('--host'));
  assert.deepEqual(hosts[0].commands.map((c) => c.session).sort(), [first.id, second.id].sort());
  const host = hosts[0].child;
  for (const s of [first, second]) {
    await writeTrack(s.id, 'e000-t000001', { text: s === first ? 'HOS1111' : 'HOS2222' });
    host.line({ type: 'status', status: 'running', epoch: 0, session: s.id });
    host.line({ type: 'stats', frames_read: 30, sampling_scale: 0.5, session: s.id });
    host.line({ type: 'track', track: 'e000-t000001', epoch: 0, session: s.id });
  }
  for (const s of [first, second])
    await until(
      () => sessionRow(s.id),
      (row) =>
        row.status === 'running' && row.tracks_count === 1 && row.stats?.sampling_scale === 0.5,
      'both sessions running with a track',
    );

  await api.post(`/api/v2/live-sessions/${first.id}/stop`).set(as('owner')).expect(202);
  await live.tick();
  await until(
    async () => hosts[0].commands.at(-1),
    (c) => c?.cmd === 'stop' && c.session === first.id,
    'stop command',
  );
  host.line({ type: 'status', status: 'stopped', session: first.id });
  host.line({ type: 'exit', code: 0, session: first.id });
  await until(
    () => sessionRow(first.id),
    (row) => row.status === 'stopped',
    'first stopped',
  );
  assert.equal((await sessionRow(second.id)).status, 'running');
  assert.equal(live.active, 1);

  host.exit(1); // the host crashes: its remaining session fails like an exited process
  const failed = await until(
    () => sessionRow(second.id),
    (row) => row.status === 'failed',
    'second failed',
  );
  assert.equal(failed.error_code, 'LIVE_PROCESS_EXITED');
  assert.equal(live.active, 0);
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
  // Jobs inside the shared live host run beside sessions; a job process still runs alone.
  assert.equal(gate.enter('live') && gate.enter('host'), true);
  assert.equal(gate.enter('jobs'), false);
  gate.leave('live');
  assert.equal(gate.enter('jobs'), false, 'a host job also keeps job processes out');
  gate.leave('host');
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
