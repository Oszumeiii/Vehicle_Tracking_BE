import assert from 'node:assert/strict';
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
// Three cameras in Da Nang: the second ~2.7 km from the first, the third ~23 km away (Hoi An).
const PLACES = {
  bridge: { latitude: 16.061, longitude: 108.2272, name: 'Cầu Rồng', heading: 90 },
  market: { latitude: 16.0544, longitude: 108.2022, name: 'Chợ Cồn' },
  hoian: { latitude: 15.8801, longitude: 108.338, name: 'Hội An' },
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

test('plate queries drop separators; fuzzy edits grow with the plate length', () => {
  assert.equal(plateQuery(' 43a-123.45 '), '43A12345');
  assert.throws(() => plateQuery(' -. '), /cannot be empty/);
  assert.deepEqual(['ABCD', 'ABCDE', '43A1234', '43A12345'].map(fuzzyEdits), [0, 1, 1, 2]);
});

test('journey legs measure distance, time and speed and flag impossible ones', () => {
  const cam = (id: string, location: any) => ({ id, name: id, location });
  const at = (first: string, last: string) => ({ first_seen: first, last_seen: last });
  const a = { ...PLACES.bridge, name: null, heading: null };
  const b = { ...PLACES.market, name: null, heading: null };
  const legs = journeyLegs(
    [
      { camera: cam('a', a), ...at('2026-01-01T10:00:00Z', '2026-01-01T10:00:04Z') },
      { camera: cam('b', b), ...at('2026-01-01T10:05:04Z', '2026-01-01T10:05:08Z') },
      { camera: cam('a', a), ...at('2026-01-01T10:05:10Z', '2026-01-01T10:05:12Z') },
      { camera: cam('c', null), ...at('2026-01-01T10:05:11Z', '2026-01-01T10:05:20Z') },
    ],
    150,
  );
  const meters = haversineMeters(a, b);
  assert.ok(meters > 2500 && meters < 3000, `${meters}`);
  assert.equal(legs[0].distance_m, Math.round(meters));
  assert.equal(legs[0].gap_seconds, 300);
  assert.equal(legs[0].speed_kmh, Math.round((meters / 300) * 3.6 * 10) / 10);
  assert.equal(legs[0].implausible, false);
  // ~2.7 km in 2 s.
  assert.deepEqual(legs[1].reasons, ['too_fast']);
  // A camera without a location: no distance, but two cameras at once is still flagged.
  assert.equal(legs[2].distance_m, null);
  assert.deepEqual(legs[2].reasons, ['overlap']);
});

test('cameras keep a location that can be changed and cleared; bad ones are refused', async () => {
  const created = await camera('located', PLACES.bridge);
  assert.deepEqual(created.location, PLACES.bridge);
  assert.equal(created.latitude, undefined);
  const plain = await camera('plain');
  assert.equal(plain.location, null);
  const moved = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ location: { latitude: 16.05, longitude: 108.2 } })
    .expect(200);
  assert.deepEqual(moved.body.location, {
    latitude: 16.05,
    longitude: 108.2,
    name: null,
    heading: null,
  });
  // Other changes keep the location.
  const renamed = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ name: 'renamed' })
    .expect(200);
  assert.equal(renamed.body.location.latitude, 16.05);
  const cleared = await api
    .patch(`/api/v2/stream-sources/${plain.id}`)
    .set(as('owner'))
    .send({ location: null })
    .expect(200);
  assert.equal(cleared.body.location, null);
  for (const location of [
    { latitude: 91, longitude: 0 },
    { latitude: 16 },
    { latitude: 16, longitude: 108, heading: 360 },
    { latitude: 16, longitude: 108, extra: 1 },
  ])
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'bad', url: URL, location })
      .expect(422);
  const listed = await api.get('/api/v2/stream-sources').set(as('owner')).expect(200);
  assert.deepEqual(
    listed.body.items.find((item: any) => item.id === created.id).location,
    PLACES.bridge,
  );
});

test('a plate is followed across cameras, misreads included when fuzzy', async () => {
  const bridge = await session((await camera('bridge', PLACES.bridge)).id);
  const market = await session((await camera('market', PLACES.market)).id);
  const hoian = await session((await camera('hoian', PLACES.hoian)).id);
  const unplaced = await session((await camera('unplaced')).id);
  // Two tracks of one passage at the bridge, then the market 5 min later (~33 km/h),
  // then Hoi An one minute after (impossible), read with Z for 2; another car too.
  await track(bridge, 'e000-t000001', '43A12345', '2026-03-01T10:00:00Z');
  await track(bridge, 'e000-t000002', '43A12345', '2026-03-01T10:00:10Z');
  await track(market, 'e000-t000001', '43A12345', '2026-03-01T10:05:14Z');
  await track(hoian, 'e000-t000001', '43A1Z345', '2026-03-01T10:06:18Z');
  await track(unplaced, 'e000-t000001', '43A12345', '2026-03-01T11:00:00Z');
  await track(market, 'e000-t000002', '43A99999', '2026-03-01T10:05:30Z');

  const exact = (await api.get('/api/v2/plates/43A-123.45/journey').set(as('owner')).expect(200))
    .body;
  assert.equal(exact.plate, '43A12345');
  assert.deepEqual(
    exact.points.map((p: any) => [p.camera.name, p.reads]),
    [
      ['bridge', 2],
      ['market', 1],
      ['unplaced', 1],
    ],
  );
  assert.equal(exact.points[0].first_seen, '2026-03-01T10:00:00.000Z');
  assert.equal(exact.points[0].last_seen, '2026-03-01T10:00:14.000Z');
  assert.deepEqual(exact.points[0].camera.location, PLACES.bridge);
  assert.equal(exact.points[2].camera.location, null);
  assert.ok(exact.points[0].primary_detection_id);
  assert.equal(exact.legs[0].gap_seconds, 300);
  assert.equal(exact.legs[0].implausible, false);
  assert.equal(exact.legs[1].distance_m, null);
  assert.equal(exact.summary.cameras, 3);
  assert.equal(exact.summary.truncated, false);

  const fuzzy = (
    await api.get('/api/v2/plates/43A12345/journey?match=fuzzy').set(as('owner')).expect(200)
  ).body;
  assert.deepEqual(
    fuzzy.points.map((p: any) => [p.camera.name, p.plate, p.match_distance]),
    [
      ['bridge', '43A12345', 0],
      ['market', '43A12345', 0],
      ['hoian', '43A1Z345', 1],
      ['unplaced', '43A12345', 0],
    ],
  );
  assert.deepEqual(fuzzy.legs[1].reasons, ['too_fast']);
  assert.equal(fuzzy.summary.implausible_legs, 1);
  assert.deepEqual(fuzzy.summary.plates, ['43A12345', '43A1Z345']);

  const window = (
    await api
      .get('/api/v2/plates/43A12345/journey')
      .query({ captured_from: '2026-03-01T10:01:00Z', captured_to: '2026-03-01T10:30:00Z' })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.deepEqual(
    window.points.map((p: any) => p.camera.name),
    ['market'],
  );
  const limited = (
    await api.get('/api/v2/plates/43A12345/journey?limit=2').set(as('owner')).expect(200)
  ).body;
  assert.equal(limited.points.length, 2);
  assert.equal(limited.summary.truncated, true);

  // A rejected read leaves the journey.
  const result = fuzzy.points[2].result_id;
  await db().query("UPDATE plate_appearances SET review_status='rejected' WHERE id=$1", [result]);
  const afterReview = (
    await api.get('/api/v2/plates/43A12345/journey?match=fuzzy').set(as('owner')).expect(200)
  ).body;
  assert.equal(afterReview.points.length, 3);

  const stranger = (
    await api.get('/api/v2/plates/43A12345/journey').set(as('stranger')).expect(200)
  ).body;
  assert.deepEqual(stranger.points, []);
  assert.equal(stranger.summary.first_seen, null);

  await api.get('/api/v2/plates/%20-%20/journey').set(as('owner')).expect(422);
  await api.get('/api/v2/plates/43A12345/journey?match=contains').set(as('owner')).expect(422);
  await api
    .get('/api/v2/plates/43A12345/journey')
    .query({ captured_from: '2026-03-02T00:00:00Z', captured_to: '2026-03-01T00:00:00Z' })
    .set(as('owner'))
    .expect(422);
  await api.get('/api/v2/plates/43A12345/journey').expect(401);
});

test('result search matches look-alike misreads when fuzzy, nearest first', async () => {
  const live = await session((await camera('search')).id);
  await track(live, 'e000-t000001', '92B54321', '2026-04-01T08:00:00Z');
  await track(live, 'e000-t000002', '92B5432I', '2026-04-01T08:01:00Z');
  await track(live, 'e000-t000003', '92B5A3Z1', '2026-04-01T08:02:00Z');
  await track(live, 'e000-t000004', '9285432', '2026-04-01T08:03:00Z');
  const search = async (query: Record<string, string>) =>
    (
      await api
        .get('/api/v2/recognition-results')
        .query({ stream_source_id: live.stream_source_id, ...query })
        .set(as('owner'))
        .expect(200)
    ).body;
  const exact = await search({ plate: '92B-543.21' });
  assert.deepEqual(
    exact.items.map((item: any) => item.effective_text),
    ['92B54321'],
  );
  assert.equal(exact.items[0].match_distance, undefined);
  const fuzzy = await search({ plate: '92B54321', match: 'fuzzy' });
  // I folds to 1 (skeleton equal); "9285432" drops a character after B->8; "92B5A3Z1" is 2 off.
  // Equal distances: newest first.
  assert.deepEqual(
    fuzzy.items.map((item: any) => [item.effective_text, item.match_distance]),
    [
      ['92B54321', 0],
      ['92B5432I', 1],
      ['9285432', 2],
      ['92B5A3Z1', 2],
    ],
  );
  const short = await search({ plate: '9285432', match: 'fuzzy' });
  // 7 characters: one edit after folding; 92B54321 folds to 92854321 (one insertion).
  assert.deepEqual(short.items.map((item: any) => item.effective_text).sort(), [
    '9285432',
    '92B54321',
    '92B5432I',
  ]);
  const grouped = await search({ plate: '92B54321', match: 'fuzzy', group_by: 'sighting' });
  assert.equal(grouped.items[0].match_distance, 0);
});
