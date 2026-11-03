import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { ingestTrack } from '../src/live/ingest';
import { haversineMeters, journeyLegs } from '../src/results/journey';
import { fuzzyEdits, plateQuery } from '../src/results/plate-match';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines, writeTrack } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
// Balneário Camboriú (SC, Brazil), where the project's cameras are: Av. Brasil is ~0.8 km from
// Av. Atlântica, Itajaí ~10 km away.
const PLACES = {
  atlantica: { latitude: -26.9925, longitude: -48.633, name: 'Av. Atlântica', heading: 180 },
  brasil: { latitude: -26.987, longitude: -48.638, name: 'Av. Brasil' },
  itajai: { latitude: -26.9078, longitude: -48.6619, name: 'Itajaí' },
};
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
const id = () => randomUUID().replaceAll('-', '');

async function camera(name: string, location?: unknown) {
  return (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name, url: URL, ...(location === undefined ? {} : { location }) })
      .expect(201)
  ).body;
}

async function session(sourceId: string) {
  const created = (
    await api
      .post(`/api/v2/stream-sources/${sourceId}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    created.id,
  ]);
  return (await db().query('SELECT * FROM live_sessions WHERE id=$1', [created.id])).rows[0];
}

async function track(live: Record<string, any>, key: string, text: string, at: string) {
  const from = new Date(at);
  await writeTrack(dataDir, live.id, key, {
    text,
    capturedFrom: from.toISOString(),
    capturedTo: new Date(from.getTime() + 4000).toISOString(),
  });
  return ingestTrack(db(), workerOptions(), live, key);
}

/** An uploaded video with a succeeded recognition: results at [text, start, end] seconds. */
async function upload(name: string, file: string, results: [string, number, number][]) {
  const media = id();
  await db().query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,duration_seconds)
    VALUES($1,$2,$3,'video',$4,'video/mp4',1000,$5,1800)`,
    [
      media,
      users.owner.id,
      name,
      `media/${media}`,
      createHash('sha256').update(file).digest('hex'),
    ],
  );
  const job = id();
  await db().query(
    `INSERT INTO recognition_jobs(id,media_id,job_kind,status,stage,started_at,finished_at)
    VALUES($1,$2,'recognize','succeeded','complete',now(),now())`,
    [job, media],
  );
  for (const [text, start, end] of results)
    await db().query(
      `INSERT INTO plate_appearances(id,job_id,start_seconds,end_seconds,machine_text,machine_status,effective_text)
      VALUES($1,$2,$3,$4,$5,'readable',$5)`,
      [id(), job, start, end, text],
    );
  return media;
}

test('plate queries drop separators; fuzzy edits grow with the plate length', () => {
  assert.equal(plateQuery(' abc-1d23 '), 'ABC1D23');
  assert.equal(plateQuery('abc-1234'), 'ABC1234');
  assert.throws(() => plateQuery(' -. '), /cannot be empty/);
  assert.deepEqual(['ABCD', 'ABC12', 'ABC1D23', 'ABC1D234'].map(fuzzyEdits), [0, 1, 1, 2]);
});

test('journey legs measure distance, time and speed and flag impossible ones', () => {
  const cam = (cameraId: string, location: any) => ({ id: cameraId, name: cameraId, location });
  const at = (first: string, last: string) => ({ first_seen: first, last_seen: last });
  const a = { ...PLACES.atlantica, name: null, heading: null };
  const b = { ...PLACES.brasil, name: null, heading: null };
  const legs = journeyLegs(
    [
      { camera: cam('a', a), ...at('2026-01-01T10:00:00Z', '2026-01-01T10:00:04Z') },
      { camera: cam('b', b), ...at('2026-01-01T10:02:04Z', '2026-01-01T10:02:08Z') },
      { camera: cam('a', a), ...at('2026-01-01T10:02:10Z', '2026-01-01T10:02:12Z') },
      { camera: cam('c', null), ...at('2026-01-01T10:02:11Z', '2026-01-01T10:02:20Z') },
    ],
    150,
  );
  const meters = haversineMeters(a, b);
  assert.ok(meters > 700 && meters < 900, `${meters}`);
  assert.equal(legs[0].distance_m, Math.round(meters));
  assert.equal(legs[0].gap_seconds, 120);
  assert.equal(legs[0].speed_kmh, Math.round((meters / 120) * 3.6 * 10) / 10);
  assert.equal(legs[0].implausible, false);
  // ~0.8 km in 2 s.
  assert.deepEqual(legs[1].reasons, ['too_fast']);
  // A camera without a location: no distance, but two cameras at once is still flagged.
  assert.equal(legs[2].distance_m, null);
  assert.deepEqual(legs[2].reasons, ['overlap']);
});

test('cameras keep a location that can be changed and cleared; bad ones are refused', async () => {
  const created = await camera('located', PLACES.atlantica);
  assert.deepEqual(created.location, PLACES.atlantica);
  assert.equal(created.latitude, undefined);
  const plain = await camera('plain');
  assert.equal(plain.location, null);
  const moved = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ location: { latitude: -26.99, longitude: -48.63 } })
    .expect(200);
  assert.deepEqual(moved.body.location, {
    latitude: -26.99,
    longitude: -48.63,
    name: null,
    heading: null,
  });
  // Other changes keep the location.
  const renamed = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ name: 'renamed' })
    .expect(200);
  assert.equal(renamed.body.location.latitude, -26.99);
  const cleared = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ location: null })
    .expect(200);
  assert.equal(cleared.body.location, null);
  for (const location of [
    { latitude: 91, longitude: 0 },
    { latitude: -26 },
    { latitude: -26, longitude: -48, heading: 360 },
    { latitude: -26, longitude: -48, extra: 1 },
  ])
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'bad', url: URL, location })
      .expect(422);
  const listed = await api.get('/api/v2/stream-sources').set(as('owner')).expect(200);
  assert.deepEqual(
    listed.body.items.find((item: any) => item.id === created.id).location,
    PLACES.atlantica,
  );
});

test('uploaded videos take a recording time and place; others cannot change them', async () => {
  const media = await upload('bc.mp4', 'place-test', []);
  const set = await api
    .patch(`/api/v2/media/${media}`)
    .set(as('owner'))
    .send({ recorded_at: '2026-03-01T11:00:00-03:00', location: PLACES.atlantica })
    .expect(200);
  assert.equal(set.body.recorded_at, '2026-03-01T14:00:00.000Z');
  assert.deepEqual(set.body.location, PLACES.atlantica);
  assert.equal(set.body.latitude, undefined);
  const kept = await api
    .patch(`/api/v2/media/${media}`)
    .set(as('owner'))
    .send({ location: null })
    .expect(200);
  assert.equal(kept.body.recorded_at, '2026-03-01T14:00:00.000Z');
  assert.equal(kept.body.location, null);
  await api.patch(`/api/v2/media/${media}`).set(as('owner')).send({}).expect(422);
  await api
    .patch(`/api/v2/media/${media}`)
    .set(as('owner'))
    .send({ recorded_at: '01/03/2026' })
    .expect(422);
  await api
    .patch(`/api/v2/media/${media}`)
    .set(as('stranger'))
    .send({ recorded_at: null })
    .expect(404);
  const listed = await api.get('/api/v2/media').set(as('owner')).expect(200);
  assert.equal(
    listed.body.items.find((item: any) => item.id === media).recorded_at,
    set.body.recorded_at,
  );
});

test('a plate is followed across cameras and dated uploads, old/Mercosul plates when fuzzy', async () => {
  const atlantica = await session((await camera('atlantica', PLACES.atlantica)).id);
  const brasil = await session((await camera('brasil', PLACES.brasil)).id);
  const itajai = await session((await camera('itajai', PLACES.itajai)).id);
  const unplaced = await session((await camera('unplaced')).id);
  // Two tracks of one passage on Av. Atlântica, Av. Brasil 2 min later (~24 km/h), Itajaí one
  // minute after that (impossible) read as the old plate QJK0277 (Mercosul C = 2); another car too.
  await track(atlantica, 'e000-t000001', 'QJK0C77', '2026-03-01T12:00:00Z');
  await track(atlantica, 'e000-t000002', 'QJK0C77', '2026-03-01T12:00:10Z');
  await track(brasil, 'e000-t000001', 'QJK0C77', '2026-03-01T12:02:14Z');
  await track(itajai, 'e000-t000001', 'QJK0277', '2026-03-01T12:03:18Z');
  await track(unplaced, 'e000-t000001', 'QJK0C77', '2026-03-01T13:00:00Z');
  await track(brasil, 'e000-t000002', 'SXE6J35', '2026-03-01T12:02:30Z');
  // Footage filmed on Av. Atlântica from 14:00: a passage at 0:30-0:52 (two tracks) and one at
  // 15:00. The same file uploaded earlier counts once; a video without a time is left out.
  const copy = await upload('bc_1400 (copy).mp4', 'bc-1400', [['QJK0C77', 30, 34]]);
  await db().query("UPDATE media_assets SET uploaded_at=now() - interval '1 day' WHERE id=$1", [
    copy,
  ]);
  const filmed = await upload('bc_1400.mp4', 'bc-1400', [
    ['QJK0C77', 30, 34],
    ['QJK0C77', 50, 52],
    ['QJK0C77', 900, 903],
    ['SXE6J35', 60, 62],
  ]);
  for (const media of [copy, filmed])
    await api
      .patch(`/api/v2/media/${media}`)
      .set(as('owner'))
      .send({ recorded_at: '2026-03-01T14:00:00Z', location: PLACES.atlantica })
      .expect(200);
  await upload('undated.mp4', 'undated', [['QJK0C77', 10, 12]]);

  const exact = (await api.get('/api/v2/plates/qjk-0c77/journey').set(as('owner')).expect(200))
    .body;
  assert.equal(exact.plate, 'QJK0C77');
  assert.deepEqual(
    exact.points.map((p: any) => [p.source, p.camera.name, p.reads, p.first_seen.slice(11, 19)]),
    [
      ['live', 'atlantica', 2, '12:00:00'],
      ['live', 'brasil', 1, '12:02:14'],
      ['live', 'unplaced', 1, '13:00:00'],
      ['upload', 'bc_1400.mp4', 2, '14:00:30'],
      ['upload', 'bc_1400.mp4', 1, '14:15:00'],
    ],
  );
  assert.equal(exact.points[0].last_seen, '2026-03-01T12:00:14.000Z');
  assert.equal(exact.points[3].last_seen, '2026-03-01T14:00:52.000Z');
  assert.equal(exact.points[3].camera.kind, 'upload');
  assert.equal(exact.points[3].camera.id, filmed);
  assert.deepEqual(exact.points[3].camera.location, PLACES.atlantica);
  assert.equal(exact.points[0].camera.kind, 'camera');
  assert.ok(exact.points[0].primary_detection_id);
  assert.equal(exact.legs[0].gap_seconds, 120);
  assert.equal(exact.legs[0].implausible, false);
  assert.equal(exact.legs[1].distance_m, null);
  assert.equal(exact.legs[3].distance_m, 0);
  assert.equal(exact.legs[3].gap_seconds, 848);
  assert.equal(exact.summary.cameras, 4);
  assert.equal(exact.summary.undated_upload_results, 1);
  assert.equal(exact.summary.truncated, false);

  const fuzzy = (
    await api.get('/api/v2/plates/QJK0C77/journey?match=fuzzy').set(as('owner')).expect(200)
  ).body;
  assert.deepEqual(
    fuzzy.points.map((p: any) => [p.camera.name, p.plate, p.match_distance]),
    [
      ['atlantica', 'QJK0C77', 0],
      ['brasil', 'QJK0C77', 0],
      ['itajai', 'QJK0277', 1],
      ['unplaced', 'QJK0C77', 0],
      ['bc_1400.mp4', 'QJK0C77', 0],
      ['bc_1400.mp4', 'QJK0C77', 0],
    ],
  );
  assert.deepEqual(fuzzy.legs[1].reasons, ['too_fast']);
  assert.equal(fuzzy.summary.implausible_legs, 1);
  assert.deepEqual(fuzzy.summary.plates, ['QJK0277', 'QJK0C77']);

  const live = (
    await api.get('/api/v2/plates/QJK0C77/journey?sources=live').set(as('owner')).expect(200)
  ).body;
  assert.equal(live.points.length, 3);
  assert.equal(live.summary.undated_upload_results, 0);
  const uploads = (
    await api.get('/api/v2/plates/QJK0C77/journey?sources=upload').set(as('owner')).expect(200)
  ).body;
  assert.deepEqual(
    uploads.points.map((p: any) => p.source),
    ['upload', 'upload'],
  );
  const window = (
    await api
      .get('/api/v2/plates/QJK0C77/journey')
      .query({ captured_from: '2026-03-01T12:01:00Z', captured_to: '2026-03-01T14:10:00Z' })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.deepEqual(
    window.points.map((p: any) => p.camera.name),
    ['brasil', 'unplaced', 'bc_1400.mp4'],
  );
  const limited = (
    await api.get('/api/v2/plates/QJK0C77/journey?limit=2').set(as('owner')).expect(200)
  ).body;
  assert.equal(limited.points.length, 2);
  assert.equal(limited.summary.truncated, true);

  // A rejected read leaves the journey.
  await db().query("UPDATE plate_appearances SET review_status='rejected' WHERE id=$1", [
    fuzzy.points[2].result_id,
  ]);
  const afterReview = (
    await api.get('/api/v2/plates/QJK0C77/journey?match=fuzzy').set(as('owner')).expect(200)
  ).body;
  assert.equal(afterReview.points.length, 5);

  const stranger = (await api.get('/api/v2/plates/QJK0C77/journey').set(as('stranger')).expect(200))
    .body;
  assert.deepEqual(stranger.points, []);
  assert.equal(stranger.summary.first_seen, null);
  assert.equal(stranger.summary.undated_upload_results, 0);

  await api.get('/api/v2/plates/%20-%20/journey').set(as('owner')).expect(422);
  await api.get('/api/v2/plates/QJK0C77/journey?match=contains').set(as('owner')).expect(422);
  await api.get('/api/v2/plates/QJK0C77/journey?sources=media').set(as('owner')).expect(422);
  await api
    .get('/api/v2/plates/QJK0C77/journey')
    .query({ captured_from: '2026-03-02T00:00:00Z', captured_to: '2026-03-01T00:00:00Z' })
    .set(as('owner'))
    .expect(422);
  await api.get('/api/v2/plates/QJK0C77/journey').expect(401);
});

test('result search matches misreads and old/Mercosul plates when fuzzy, nearest first', async () => {
  const live = await session((await camera('search')).id);
  // SXE6J35 (Mercosul) and its old plate SXE6935 (J = 9); S/5 confusion; one changed letter;
  // a changed letter plus a confusion (2 raw edits, 1 after folding); and a different plate.
  await track(live, 'e000-t000001', 'SXE6J35', '2026-04-01T08:00:00Z');
  await track(live, 'e000-t000002', 'SXE6935', '2026-04-01T08:01:00Z');
  await track(live, 'e000-t000003', 'SXE6J3S', '2026-04-01T08:02:00Z');
  await track(live, 'e000-t000004', 'SXF6J35', '2026-04-01T08:03:00Z');
  await track(live, 'e000-t000005', 'SXF6J3S', '2026-04-01T08:04:00Z');
  await track(live, 'e000-t000006', 'SYF6J35', '2026-04-01T08:05:00Z');
  const search = async (query: Record<string, string>) =>
    (
      await api
        .get('/api/v2/recognition-results')
        .query({ stream_source_id: live.stream_source_id, ...query })
        .set(as('owner'))
        .expect(200)
    ).body;
  const exact = await search({ plate: 'SXE-6J35' });
  assert.deepEqual(
    exact.items.map((item: any) => item.effective_text),
    ['SXE6J35'],
  );
  assert.equal(exact.items[0].match_distance, undefined);
  const fuzzy = await search({ plate: 'SXE6J35', match: 'fuzzy' });
  // Equal distances: newest first.
  assert.deepEqual(
    fuzzy.items.map((item: any) => [item.effective_text, item.match_distance]),
    [
      ['SXE6J35', 0],
      ['SXF6J35', 1],
      ['SXE6J3S', 1],
      ['SXE6935', 1],
      ['SXF6J3S', 2],
    ],
  );
  const grouped = await search({ plate: 'SXE6J35', match: 'fuzzy', group_by: 'sighting' });
  assert.equal(grouped.items[0].match_distance, 0);
});
