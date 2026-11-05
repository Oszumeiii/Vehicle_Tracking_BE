import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { LiveManager } from '../src/live/manager';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { Fake, fakeChild, livePipelines, until } from './live-fixtures';

// An uploaded video replayed as if it were a live camera (source_type 'media').
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
const ATLANTICA = { latitude: -26.9925, longitude: -48.633, name: 'Av. Atlântica', heading: null };

before(async () => {
  fixture = await startTestDatabase();
  dataDir = join(fixture.root, 'artifacts');
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath,
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
const db = () => fixture.database;

/** An uploaded file of the owner (bytes on disk under media/). */
async function upload(name: string, type: 'video' | 'image' = 'video') {
  const id = randomUUID().replaceAll('-', '');
  const key = `media/${id}`;
  await mkdir(join(dataDir, 'media'), { recursive: true });
  await writeFile(join(dataDir, key), `video bytes of ${name}`);
  await db().query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,duration_seconds)
    VALUES($1,$2,$3,$4,$5,$6,20,$7,300)`,
    [
      id,
      users.owner.id,
      name,
      type,
      key,
      type === 'video' ? 'video/mp4' : 'image/png',
      createHash('sha256').update(id).digest('hex'),
    ],
  );
  return id;
}

function manager(spawned: { args: string[]; child: Fake }[]) {
  return new LiveManager(
    db(),
    { ...workerOptions(), python: process.execPath },
    { maxSessions: 1, statsSeconds: 0.05, stopSeconds: 5, stallSeconds: 60, exclusiveGpu: true },
    (_python, args) => {
      const child = fakeChild();
      spawned.push({ args, child });
      return child;
    },
  );
}

const sessionRow = async (id: string) =>
  (await db().query('SELECT * FROM live_sessions WHERE id=$1', [id])).rows[0];

test('an uploaded video becomes a camera that replays it; only its owner can, and only videos', async () => {
  const video = await upload('bc_atlantica.mp4');
  await api
    .patch(`/api/v2/media/${video}`)
    .set(as('owner'))
    .send({
      location: {
        latitude: ATLANTICA.latitude,
        longitude: ATLANTICA.longitude,
        name: ATLANTICA.name,
      },
    })
    .expect(200);
  const camera = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'Phát lại BC', source_type: 'media', media_id: video })
      .expect(201)
  ).body;
  assert.equal(camera.source_type, 'media');
  assert.equal(camera.media_id, video);
  assert.equal(camera.replay_loop, false);
  assert.equal(camera.url, 'bc_atlantica.mp4');
  assert.equal(camera.embed_url, null);
  // Filmed on Av. Atlântica, so the camera is there unless told otherwise.
  assert.deepEqual(camera.location, ATLANTICA);
  const elsewhere = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({
        name: 'Elsewhere',
        source_type: 'media',
        media_id: video,
        loop: true,
        location: null,
      })
      .expect(201)
  ).body;
  assert.equal(elsewhere.location, null);
  assert.equal(elsewhere.replay_loop, true);

  await api
    .post('/api/v2/stream-sources')
    .set(as('stranger'))
    .send({ name: 'Not mine', source_type: 'media', media_id: video })
    .expect(404);
  const image = await upload('frame.png', 'image');
  await api
    .post('/api/v2/stream-sources')
    .set(as('owner'))
    .send({ name: 'Image', source_type: 'media', media_id: image })
    .expect(422);
  await api
    .post('/api/v2/stream-sources')
    .set(as('owner'))
    .send({ name: 'No video', source_type: 'media' })
    .expect(422);

  const looped = await api
    .patch(`/api/v2/stream-sources/${camera.id}`)
    .set(as('owner'))
    .send({ loop: true })
    .expect(200);
  assert.equal(looped.body.replay_loop, true);
  await api
    .patch(`/api/v2/stream-sources/${camera.id}`)
    .set(as('owner'))
    .send({ loop: false })
    .expect(200);
  const youtube = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'yt', url: 'https://www.youtube.com/watch?v=5Xl6pSgiy3A' })
      .expect(201)
  ).body;
  await api
    .patch(`/api/v2/stream-sources/${youtube.id}`)
    .set(as('owner'))
    .send({ loop: true })
    .expect(422);

  // The video stays while a camera replays it.
  await api.delete(`/api/v2/media/${video}`).set(as('owner')).expect(409);
  const served = await api
    .get(`/api/v2/stream-sources/${camera.id}/demo-video`)
    .set(as('owner'))
    .buffer(true)
    .parse((res, done) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString()));
      res.on('end', () => done(null, text));
    })
    .expect(200);
  assert.equal(served.body, 'video bytes of bc_atlantica.mp4');
  await api.get(`/api/v2/stream-sources/${camera.id}/demo-video`).set(as('stranger')).expect(404);
  await api.get(`/api/v2/stream-sources/${youtube.id}/demo-video`).set(as('owner')).expect(404);
  for (const id of [camera.id, elsewhere.id])
    await api.delete(`/api/v2/stream-sources/${id}`).set(as('owner')).expect(204);
  await api.delete(`/api/v2/media/${video}`).set(as('owner')).expect(204);
});

test('the worker replays the upload once on its filming clock, or loops on the wall clock', async () => {
  const video = await upload('bc_1400.mp4');
  await api
    .patch(`/api/v2/media/${video}`)
    .set(as('owner'))
    .send({ recorded_at: '2026-03-01T11:00:00-03:00' })
    .expect(200);
  const camera = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'Replay', source_type: 'media', media_id: video })
      .expect(201)
  ).body;
  const run = async () => {
    const queued = (
      await api
        .post(`/api/v2/stream-sources/${camera.id}/sessions`)
        .set(as('owner'))
        .send({ pipeline_id: 'joint' })
        .expect(202)
    ).body;
    const spawned: { args: string[]; child: Fake }[] = [];
    const live = manager(spawned);
    await live.tick();
    const payload = JSON.parse(
      await readFile(join(dataDir, 'live', queued.id, 'payload.json'), 'utf8').catch(() => 'null'),
    );
    if (spawned.length) {
      // A single pass ends like a broadcast that went off air.
      spawned[0].child.line({ type: 'status', status: 'ended', reason: 'source exhausted' });
      spawned[0].child.exit(0);
    }
    const done = await until(
      () => sessionRow(queued.id),
      (row) => !['queued', 'starting', 'running', 'stopping'].includes(row.status),
      'session end',
    );
    return { payload, session: done };
  };

  const once = await run();
  assert.deepEqual(once.payload.source, {
    type: 'file',
    path: join(dataDir, 'media', video),
    realtime: true,
    loop: false,
    start_time: '2026-03-01T14:00:00.000Z',
    exclude_zones: [],
  });
  assert.equal(once.session.status, 'ended');

  await api
    .patch(`/api/v2/stream-sources/${camera.id}`)
    .set(as('owner'))
    .send({ loop: true })
    .expect(200);
  const looped = await run();
  assert.equal(looped.payload.source.loop, true);
  assert.equal(looped.payload.source.start_time, undefined);

  // The file is gone: the session fails at once with a clear reason.
  await rm(join(dataDir, 'media', video));
  const missing = await run();
  assert.equal(missing.payload, null);
  assert.equal(missing.session.status, 'failed');
  assert.equal(missing.session.error_code, 'SOURCE_MISSING');
});

test('a camera detection region is validated, copied into sessions and handed to the worker', async () => {
  const youtube = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({
        name: 'roi',
        url: 'https://www.youtube.com/watch?v=R-OLN-xAVoA',
        detect_roi: [0.3, 0.35, 1, 1],
      })
      .expect(201)
  ).body;
  assert.deepEqual(youtube.detect_roi, [0.3, 0.35, 1, 1]);
  for (const detect_roi of [
    [0.5, 0.5, 0.4, 1],
    [0, 0, 0.05, 1],
    [0, 0, 1],
    [-0.1, 0, 1, 1],
  ])
    await api
      .patch(`/api/v2/stream-sources/${youtube.id}`)
      .set(as('owner'))
      .send({ detect_roi })
      .expect(422);
  // Other changes keep the region.
  const renamed = await api
    .patch(`/api/v2/stream-sources/${youtube.id}`)
    .set(as('owner'))
    .send({ name: 'roi 2' })
    .expect(200);
  assert.deepEqual(renamed.body.detect_roi, [0.3, 0.35, 1, 1]);

  const queued = (
    await api
      .post(`/api/v2/stream-sources/${youtube.id}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  assert.deepEqual((await sessionRow(queued.id)).settings.detect_roi, [0.3, 0.35, 1, 1]);
  const spawned: { args: string[]; child: Fake }[] = [];
  await manager(spawned).tick();
  const payload = JSON.parse(
    await readFile(join(dataDir, 'live', queued.id, 'payload.json'), 'utf8'),
  );
  assert.deepEqual(payload.source.detect_roi, [0.3, 0.35, 1, 1]);
  spawned[0].child.line({ type: 'status', status: 'stopped' });
  spawned[0].child.exit(0);
  await until(
    () => sessionRow(queued.id),
    (row) => !['queued', 'starting', 'running', 'stopping'].includes(row.status),
    'session end',
  );

  // Cleared: the whole frame again, also for sessions an always-on camera restarts.
  const cleared = await api
    .patch(`/api/v2/stream-sources/${youtube.id}`)
    .set(as('owner'))
    .send({ detect_roi: null, always_on: true, auto_settings: { pipeline_id: 'joint' } })
    .expect(200);
  assert.equal(cleared.body.detect_roi, null);
  await api
    .patch(`/api/v2/stream-sources/${youtube.id}`)
    .set(as('owner'))
    .send({ detect_roi: [0, 0.5, 1, 1] })
    .expect(200);
  // The short session above would make auto restart back off; it is gone now.
  await api.delete(`/api/v2/live-sessions/${queued.id}`).set(as('owner')).expect(204);
  await manager([]).autoRestart();
  const restarted = (
    await db().query(
      "SELECT settings FROM live_sessions WHERE stream_source_id=$1 AND status='queued'",
      [youtube.id],
    )
  ).rows[0];
  assert.deepEqual(restarted.settings.detect_roi, [0, 0.5, 1, 1]);
});
