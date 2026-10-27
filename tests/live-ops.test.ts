import assert from 'node:assert/strict';
import { access, mkdir, readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { ingestTrack } from '../src/live/ingest';
import { LiveManager } from '../src/live/manager';
import { Retention } from '../src/live/retention';
import { exportLiveSamples } from '../src/cli';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines, writeTrack } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let dataDir: string;
const users = {} as Record<'owner' | 'stranger', { id: string; token: string }>;
const oldEnvironment = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'PLATE_DATA_DIR',
  'PLATE_PIPELINE_PYTHON',
  'PLATE_PIPELINES_CONFIG',
  'NODE_ENV',
];

before(async () => {
  fixture = await startTestDatabase();
  dataDir = join(fixture.root, 'artifacts');
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // File-readiness only; no inference runs.
    PLATE_PIPELINES_CONFIG: await livePipelines(fixture.root),
    NODE_ENV: 'test',
  });
  app = await createApp();
  api = request(app.getHttpServer());
  for (const role of ['owner', 'stranger'] as const) {
    const user = await seedUser(fixture.database);
    const login = await api
      .post('/api/v2/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    users[role] = { id: user.id, token: login.body.access_token };
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

const as = (role: keyof typeof users) => ({ Authorization: `Bearer ${users[role].token}` });
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const db = () => fixture.database;

async function camera() {
  return (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'cam', url: URL })
      .expect(201)
  ).body;
}

async function finishedSession(sourceId: string) {
  const session = (
    await api
      .post(`/api/v2/stream-sources/${sourceId}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    session.id,
  ]);
  return (await db().query('SELECT * FROM live_sessions WHERE id=$1', [session.id])).rows[0];
}

async function ingest(
  session: Record<string, any>,
  key: string,
  options: Parameters<typeof writeTrack>[3] = {},
) {
  await writeTrack(dataDir, session.id, key, options);
  return ingestTrack(db(), workerOptions(), session, key);
}

function manager() {
  return new LiveManager(
    db(),
    { ...workerOptions(), python: process.execPath },
    { maxSessions: 0, statsSeconds: 1, stopSeconds: 5, stallSeconds: 60, exclusiveGpu: true },
  );
}

test('retention prunes keyframes, deletes old tracks, keeps reviewed or alerted ones and sweeps orphans', async () => {
  const source = await camera();
  const session = await finishedSession(source.id);
  const old = { capturedFrom: '2020-01-01T10:00:00.000Z', capturedTo: '2020-01-01T10:00:04.000Z' };
  const pruned = await ingest(session, 'e000-t000001', { ...old, text: 'AAA1111' });
  const reviewed = await ingest(session, 'e000-t000002', { ...old, text: 'BBB2222' });
  const before = (
    await db().query('SELECT evidence_bytes FROM recognition_jobs WHERE id=$1', [pruned])
  ).rows[0].evidence_bytes;
  assert.ok(Number(before) > 0);
  const result = (await db().query('SELECT id FROM plate_appearances WHERE job_id=$1', [reviewed]))
    .rows[0];
  await api
    .post(`/api/v2/recognition-results/${result.id}/reviews`)
    .set(as('owner'))
    .send({ action: 'confirm', expected_revision: 0 })
    .expect(201);
  await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ keyframe_retention_hours: 0, track_retention_days: null })
    .expect(200);
  const retention = new Retention(db(), workerOptions(), { intervalMs: 60_000, batch: 50 });
  assert.equal((await retention.sweep()).pruned, 1);
  const detections = (
    await db().query(
      `SELECT d.id, d.selected_order, d.frame_storage_key, d.crop_storage_key FROM plate_detections d
      JOIN plate_appearances a ON a.id=d.appearance_id WHERE a.job_id=$1 ORDER BY d.selected_order`,
      [pruned],
    )
  ).rows;
  assert.deepEqual(
    detections.map((d) => d.frame_storage_key !== null),
    [false, false, true, false, false],
  );
  for (const d of detections) assert.ok(await exists(join(dataDir, d.crop_storage_key)));
  assert.equal(
    (await readFileOrNull(join(dataDir, `recognition/${pruned}/keyframes/frame_1.png`))) === null,
    true,
  );
  const job = (await db().query('SELECT * FROM recognition_jobs WHERE id=$1', [pruned])).rows[0];
  assert.ok(job.evidence_pruned_at);
  assert.ok(Number(job.evidence_bytes) < Number(before));
  await api
    .get(`/api/v2/detections/${detections[0].id}/artifacts/frame`)
    .set(as('owner'))
    .expect(404);
  await api
    .get(`/api/v2/detections/${detections[2].id}/artifacts/frame`)
    .set(as('owner'))
    .expect(200);
  const kept = (
    await db().query('SELECT evidence_pruned_at FROM recognition_jobs WHERE id=$1', [reviewed])
  ).rows[0];
  assert.equal(kept.evidence_pruned_at, null, 'reviewed tracks are protected');

  const alerted = await ingest(session, 'e000-t000003', { ...old, text: 'CCC3333' });
  await db().query('UPDATE recognition_jobs SET alerted=true WHERE id=$1', [alerted]);
  await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ track_retention_days: 0 })
    .expect(200);
  const orphan = join(dataDir, 'recognition', 'f'.repeat(32));
  await mkdir(orphan, { recursive: true });
  const hourAgo = new Date(Date.now() - 2 * 3600_000);
  await utimes(orphan, hourAgo, hourAgo);
  const swept = await retention.sweep();
  assert.equal(swept.deleted, 1);
  assert.equal(swept.orphans, 1);
  const left = (
    await db().query('SELECT id FROM recognition_jobs WHERE live_session_id=$1 ORDER BY id', [
      session.id,
    ])
  ).rows.map((row) => row.id);
  assert.deepEqual(left.sort(), [reviewed, alerted].sort());
  assert.ok(!(await exists(join(dataDir, `recognition/${pruned}`))));
  assert.ok(!(await exists(orphan)));
});

const readFileOrNull = (file: string) => readFile(file).catch(() => null);

test('finished sessions can be deleted with their tracks and evidence', async () => {
  const source = await camera();
  const active = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await api.delete(`/api/v2/live-sessions/${active.id}`).set(as('owner')).expect(409);
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    active.id,
  ]);
  const session = (await db().query('SELECT * FROM live_sessions WHERE id=$1', [active.id]))
    .rows[0];
  const job = await ingest(session, 'e000-t000001');
  const shown = await api.get(`/api/v2/live-sessions/${session.id}`).set(as('owner')).expect(200);
  assert.ok(typeof shown.body.evidence_bytes === 'number' && shown.body.evidence_bytes > 0);
  await api.delete(`/api/v2/live-sessions/${session.id}`).set(as('stranger')).expect(404);
  await api.delete(`/api/v2/live-sessions/${session.id}`).set(as('owner')).expect(204);
  assert.equal((await db().query('SELECT 1 FROM recognition_jobs WHERE id=$1', [job])).rowCount, 0);
  assert.ok(!(await exists(join(dataDir, `recognition/${job}`))));
  assert.ok(!(await exists(join(dataDir, `live/${session.id}`))));
  await api.delete(`/api/v2/stream-sources/${source.id}`).set(as('owner')).expect(204);
});

test('always-on cameras restart with backoff, and a user stop turns always-on off', async () => {
  const source = await camera();
  await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ always_on: true })
    .expect(422);
  await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ always_on: true, auto_settings: { pipeline_id: 'single' } })
    .expect(422);
  const patched = await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('owner'))
    .send({ always_on: true, auto_settings: { pipeline_id: 'joint', max_height: 720 } })
    .expect(200);
  assert.equal(patched.body.always_on, true);
  assert.equal(patched.body.auto_settings.max_track_seconds, 30);
  const live = manager();
  const sessions = async () =>
    (
      await db().query(
        'SELECT * FROM live_sessions WHERE stream_source_id=$1 ORDER BY created_at DESC',
        [source.id],
      )
    ).rows;
  await live.autoRestart();
  const [first] = await sessions();
  assert.equal(first.status, 'queued');
  assert.equal(first.requested_by, users.owner.id);
  assert.equal(first.settings.max_height, 720);
  const queuedEvent = (
    await db().query('SELECT payload FROM live_session_events WHERE session_id=$1', [first.id])
  ).rows[0].payload;
  assert.equal(queuedEvent.reason, 'auto_restart');
  await live.autoRestart();
  assert.equal((await sessions()).length, 1, 'one active session per camera');

  // A session that died at once (broadcast down) delays the next one by a minute.
  await db().query(
    "UPDATE live_sessions SET status='failed',started_at=now(),finished_at=now() WHERE id=$1",
    [first.id],
  );
  await live.autoRestart();
  assert.equal((await sessions()).length, 1, 'backing off');
  await db().query("UPDATE live_sessions SET finished_at=now()-interval '2 minutes' WHERE id=$1", [
    first.id,
  ]);
  await live.autoRestart();
  const [second] = await sessions();
  assert.notEqual(second.id, first.id);

  // A worker restart interrupts it; the next tick starts a new one.
  await db().query(
    "UPDATE live_sessions SET status='running',started_at=now()-interval '10 minutes' WHERE id=$1",
    [second.id],
  );
  await manager().recover();
  await live.autoRestart();
  const [third] = await sessions();
  assert.notEqual(third.id, second.id);
  assert.equal(third.status, 'queued');

  await api.post(`/api/v2/live-sessions/${third.id}/stop`).set(as('owner')).expect(202);
  const stopped = await api.get(`/api/v2/stream-sources/${source.id}`).set(as('owner')).expect(200);
  assert.equal(stopped.body.always_on, false);
  await live.autoRestart();
  assert.equal((await sessions()).length, 3);
});

test('tracks of the same plate on a camera within the sighting window form one sighting', async () => {
  const source = await camera();
  const session = await finishedSession(source.id);
  const at = (minute: number, second = 0) =>
    `2026-10-24T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
  const a = await ingest(session, 'e000-t000001', {
    text: 'SGT1234',
    capturedFrom: at(0),
    capturedTo: at(0, 4),
    confidence: 0.8,
  });
  const b = await ingest(session, 'e000-t000002', {
    text: 'SGT1235',
    capturedFrom: at(2),
    capturedTo: at(2, 4),
    confidence: 0.95,
  });
  const other = await ingest(session, 'e000-t000003', {
    text: 'ZZZ9999',
    capturedFrom: at(2, 30),
    capturedTo: at(2, 34),
  });
  const later = await ingest(session, 'e000-t000004', {
    text: 'SGT1234',
    capturedFrom: at(20),
    capturedTo: at(20, 4),
  });
  const sightings = new Map(
    (
      await db().query('SELECT id, sighting_id FROM recognition_jobs WHERE live_session_id=$1', [
        session.id,
      ])
    ).rows.map((row) => [row.id, row.sighting_id]),
  );
  assert.equal(sightings.get(a), a);
  assert.equal(sightings.get(b), a);
  assert.equal(sightings.get(other), other);
  assert.equal(sightings.get(later), later);
  const grouped = await api
    .get(`/api/v2/recognition-results?live_session_id=${session.id}&group_by=sighting`)
    .set(as('owner'))
    .expect(200);
  assert.equal(grouped.body.total, 3);
  const pair = grouped.body.items.find((item: any) => item.sighting_id === a);
  assert.equal(pair.sighting_count, 2);
  assert.equal(pair.job_id, b, 'the most confident track represents the sighting');
  assert.equal(new Date(pair.first_seen).toISOString(), at(0));
  assert.equal(new Date(pair.last_seen).toISOString(), at(2, 4));
  const members = await api.get(`/api/v2/sightings/${a}/results`).set(as('owner')).expect(200);
  assert.deepEqual(
    members.body.items.map((item: any) => item.job_id),
    [a, b],
  );
  await api.get(`/api/v2/sightings/${a}/results`).set(as('stranger')).expect(404);
  const flat = await api
    .get(`/api/v2/recognition-results?live_session_id=${session.id}`)
    .set(as('owner'))
    .expect(200);
  assert.equal(flat.body.total, 4);
});

test('live samples export stratified crops, predictions and a ground-truth template', async () => {
  const source = await camera();
  const session = await finishedSession(source.id);
  for (const [i, confidence] of [0.3, 0.6, 0.86, 0.97, 0.98].entries())
    await ingest(session, `e000-t00000${i + 1}`, { text: `EXP${i}234`, confidence });
  const out = join(fixture.root, 'samples');
  const result = await exportLiveSamples(
    ['export-live-samples', '--source', source.id, '--out', out, '--per-bin', '1'],
    db(),
    dataDir,
  );
  assert.equal(result.samples, 4, 'one per confidence bin: 0-.5, .5-.7, .85-.9, .95-1');
  const predictions = JSON.parse(await readFile(join(out, 'predictions.json'), 'utf8')).predictions;
  const template = JSON.parse(
    await readFile(join(out, 'ground_truth.template.json'), 'utf8'),
  ).samples;
  assert.equal(predictions.length, 4);
  assert.ok(predictions.every((p: any) => p.variant === 'five_image' && p.confidence !== null));
  assert.ok(template.every((s: any) => s.plate_text === '' && s.source_id === source.id));
  assert.ok(await exists(join(out, 'samples', predictions[0].sample_id, 'crop_5.png')));
  await assert.rejects(
    exportLiveSamples(['export-live-samples', '--out', out], db(), dataDir),
    /Use:/,
  );
});

test('old rolling recordings and cut videos are swept, a running epoch is kept', async () => {
  const live = join(dataDir, 'live', 'a'.repeat(32));
  const oldEpoch = join(live, 'record', 'e000');
  const newEpoch = join(live, 'record', 'e001');
  const cache = join(live, 'cache');
  for (const folder of [oldEpoch, newEpoch, cache]) await mkdir(folder, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(oldEpoch, 'index.jsonl'), '');
  await writeFile(join(newEpoch, 'index.jsonl'), '');
  await writeFile(join(cache, 'old.mp4'), 'x');
  await writeFile(join(cache, 'new.mp4'), 'x');
  const past = new Date(Date.now() - 5 * 3600_000);
  await utimes(join(oldEpoch, 'index.jsonl'), past, past);
  await utimes(join(cache, 'old.mp4'), past, past);
  const retention = new Retention(db(), workerOptions(), { intervalMs: 60_000, batch: 50 });
  const swept = await retention.sweep();
  assert.equal(swept.recordings, 2);
  assert.ok(!(await exists(oldEpoch)) && (await exists(newEpoch)));
  assert.ok(!(await exists(join(cache, 'old.mp4'))) && (await exists(join(cache, 'new.mp4'))));
});
