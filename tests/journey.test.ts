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
import { CONFUSION_PAIRS } from '../src/results/confusions';
import { changeCount, LOOKALIKE_PAIRS, similarSpellings } from '../src/results/lookalikes';
import {
  confusableSpellings,
  fuzzyEdits,
  matchReason,
  oneEditAway,
  oneSwap,
  plateMercosul,
  plateQuery,
  plateSkeleton,
  plateTwins,
  withMatchReason,
} from '../src/results/plate-match';
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

async function track(
  live: Record<string, any>,
  key: string,
  text: string,
  at: string,
  candidates?: { text: string; probability: number }[],
) {
  const from = new Date(at);
  await writeTrack(dataDir, live.id, key, {
    text,
    capturedFrom: from.toISOString(),
    capturedTo: new Date(from.getTime() + 4000).toISOString(),
    candidates,
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

test('fuzzy search looks up skeletons one edit away; the skeleton is the SQL function', async () => {
  const near = oneEditAway('A8C1234');
  assert.ok(near.includes('A8C1234') && near.includes('A8C124') && near.includes('A8C12345'));
  assert.ok(near.includes('X8C1234') && near.includes('A8C1E34'));
  assert.ok(!near.includes('A8C1255'), 'two edits away');
  assert.equal(new Set(near).size, near.length);
  assert.ok(near.length < 450, `${near.length} skeletons for a 7-character plate`);
  // Same folding as plate_skeleton(): old Brazilian letter in fifth place, look-alikes.
  const plates = [
    'SXE6J35',
    'sxe6935',
    'ABC1D23',
    'QOD1234',
    'ILZ5SBG',
    'ABCD',
    'ABC1D234',
    'ZZZ9J99',
  ];
  for (const plate of plates) {
    const { rows } = await fixture.database.query('SELECT plate_skeleton($1) AS s', [plate]);
    assert.equal(plateSkeleton(plate), rows[0].s, plate);
  }
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
  // The plate and its old plate first, then near reads (E/F and 5/S are not pairs the models
  // often confuse); equal scores and distances: newest first.
  assert.deepEqual(
    fuzzy.items.map((item: any) => [item.effective_text, item.match_reason, item.match_distance]),
    [
      ['SXE6J35', 'same', 0],
      ['SXE6935', 'same', 1],
      ['SXF6J35', 'near', 1],
      ['SXE6J3S', 'near', 1],
      ['SXF6J3S', 'near', 2],
    ],
  );
  assert.deepEqual(
    fuzzy.items.map((item: any) => [item.match_score, item.match_probability]),
    [
      [0, null],
      [0, null],
      [2, null],
      [2, null],
      [2, null],
    ],
  );
  const grouped = await search({ plate: 'SXE6J35', match: 'fuzzy', group_by: 'sighting' });
  assert.equal(grouped.items[0].match_distance, 0);
  assert.equal(grouped.items[0].match_reason, 'same');
});

test('fuzzy search also finds reads the model gave the plate as an alternative, likeliest first', async () => {
  const live = await session((await camera('alternatives', PLACES.atlantica)).id);
  const other = await session((await camera('alternatives 2', PLACES.brasil)).id);
  // Searching BAK5495. The read itself; its Mercosul plate; a misread 3 characters off whose
  // second reading was the plate (30%); one character off, also weighed as the plate (45%);
  // one off by 5/8 (often confused) and by 5/7 (not); a reviewed read and one below 2%.
  await track(live, 'e000-t000001', 'BAK5495', '2026-05-01T08:00:00Z');
  await track(live, 'e000-t000002', 'BAK5E95', '2026-05-01T08:10:00Z');
  await track(other, 'e000-t000001', 'BAK9480', '2026-05-01T08:01:00Z', [
    { text: 'BAK9480', probability: 0.55 },
    { text: 'BAK5495', probability: 0.3 },
    { text: 'BAK9486', probability: 0.01 },
  ]);
  await track(live, 'e000-t000003', 'BXK5495', '2026-05-01T08:20:00Z', [
    { text: 'BXK5495', probability: 0.5 },
    { text: 'BAK5495', probability: 0.45 },
  ]);
  await track(live, 'e000-t000004', 'BAK5498', '2026-05-01T08:30:00Z');
  await track(live, 'e000-t000005', 'BAK5497', '2026-05-01T08:40:00Z');
  const reviewed = await track(live, 'e000-t000006', 'BAK9481', '2026-05-01T08:50:00Z', [
    { text: 'BAK9481', probability: 0.6 },
    { text: 'BAK5495', probability: 0.4 },
  ]);
  await db().query("UPDATE plate_appearances SET review_status='confirmed' WHERE job_id=$1", [
    reviewed,
  ]);
  await track(live, 'e000-t000007', 'BAK9999', '2026-05-01T09:00:00Z', [
    { text: 'BAK9999', probability: 0.99 },
    { text: 'BAK5495', probability: 0.01 },
  ]);
  // Only alternatives from 2% are kept, never the chosen reading.
  const kept = (
    await db().query(
      `SELECT a.machine_text, c.rank, c.text, c.probability FROM plate_candidates c
      JOIN plate_appearances a ON a.id=c.appearance_id
      WHERE a.machine_text LIKE 'BAK9%' OR a.machine_text='BXK5495' ORDER BY a.machine_text`,
    )
  ).rows;
  assert.deepEqual(
    kept.map((row) => [row.machine_text, row.rank, row.text, Number(row.probability.toFixed(2))]),
    [
      ['BAK9480', 1, 'BAK5495', 0.3],
      ['BAK9481', 1, 'BAK5495', 0.4],
      ['BXK5495', 1, 'BAK5495', 0.45],
    ],
  );
  const search = async (query: Record<string, string>) =>
    (await api.get('/api/v2/recognition-results').query(query).set(as('owner')).expect(200)).body;
  const fuzzy = await search({ plate: 'BAK5495', match: 'fuzzy' });
  assert.deepEqual(
    fuzzy.items.map((item: any) => [
      item.effective_text,
      item.match_reason,
      item.match_probability === null ? null : Number(item.match_probability.toFixed(2)),
      Number(item.match_score.toFixed(2)),
    ]),
    [
      ['BAK5495', 'same', null, 0],
      ['BAK5E95', 'same', null, 0],
      ['BXK5495', 'alternative', 0.45, 0.55],
      ['BAK9480', 'alternative', 0.3, 0.7],
      ['BAK5498', 'confusable', null, 1.5],
      ['BAK5497', 'near', null, 2],
    ],
  );
  assert.equal(fuzzy.total, 6);
  const grouped = await search({ plate: 'BAK5495', match: 'fuzzy', group_by: 'sighting' });
  assert.equal(grouped.total, 6);
  // Exact search stays on the reading itself.
  assert.deepEqual(
    (await search({ plate: 'BAK5495' })).items.map((item: any) => item.effective_text),
    ['BAK5495'],
  );
  // The result shows the model's readings.
  const detail = (
    await api.get(`/api/v2/recognition-results/${fuzzy.items[3].id}`).set(as('owner')).expect(200)
  ).body;
  assert.deepEqual(
    detail.predictions[0].decoding.candidates.map((c: any) => c.text),
    ['BAK9480', 'BAK5495', 'BAK9486'],
  );

  // A journey followed approximately takes the alternative, and says so.
  const journey = (
    await api.get('/api/v2/plates/BAK5495/journey?match=fuzzy').set(as('owner')).expect(200)
  ).body;
  const viaAlternative = journey.points.find((p: any) => p.plate === 'BAK9480');
  assert.equal(viaAlternative.camera.name, 'alternatives 2');
  assert.equal(viaAlternative.match_reason, 'alternative');
  assert.equal(Number(viaAlternative.match_probability.toFixed(2)), 0.3);
  assert.ok(!journey.points.some((p: any) => p.plate === 'BAK9481' || p.plate === 'BAK9999'));
  const exact = (await api.get('/api/v2/plates/BAK5495/journey').set(as('owner')).expect(200)).body;
  assert.deepEqual(
    exact.points.map((p: any) => [p.plate, p.match_reason]),
    [['BAK5495', null]],
  );
});

test('match reasons: twins, often-confused spellings and the scores the SQL orders by', () => {
  for (const pair of CONFUSION_PAIRS) assert.equal(pair, [...pair].sort().join(''));
  assert.equal(new Set(CONFUSION_PAIRS).size, CONFUSION_PAIRS.length);
  assert.equal(plateMercosul('abc1d23'), 'ABC1323');
  assert.deepEqual(plateTwins('ABC1234'), ['ABC1234', 'ABC1C34']);
  assert.deepEqual(plateTwins('ABC1C34'), ['ABC1234', 'ABC1C34']);
  assert.deepEqual(plateTwins('ABC1K34'), ['ABC1K34']);
  assert.deepEqual(plateTwins('51F12345'), ['51F12345']);
  assert.equal(oneSwap('HBC1234', 'MBC1234'), 'HM');
  assert.equal(oneSwap('HBC1284', 'MBC1234'), null);
  assert.equal(oneSwap('BAK549', 'BAK5495'), null);
  // The spellings the SQL calls confusable are exactly those matchReason calls so.
  const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const plate of ['BAK5495', 'BAK5E95', 'HMN1234', '51F12345']) {
    const spellings = confusableSpellings(plate);
    assert.ok(spellings.length > 0, plate);
    for (const spelling of spellings)
      assert.equal(matchReason(spelling, plate, null).reason, 'confusable', `${spelling} ${plate}`);
    for (let i = 0; i < plate.length; i++)
      for (const c of characters) {
        const other = plate.slice(0, i) + c + plate.slice(i + 1);
        if (!spellings.includes(other) && matchReason(other, plate, null).reason === 'confusable')
          assert.fail(`${other} is confusable with ${plate} but not listed`);
      }
  }
  assert.ok(confusableSpellings('BAK5495').includes('BAK5498'), '5/8');
  assert.ok(confusableSpellings('BAK5495').includes('BAK5G95'), 'Mercosul spelling of 4/6');
  assert.deepEqual(confusableSpellings("AB'1234"), []);
  assert.deepEqual(matchReason('BAK5E95', 'BAK5495', null), { reason: 'same', score: 0 });
  assert.deepEqual(matchReason('BAK9480', 'BAK5495', 0.25), { reason: 'alternative', score: 0.75 });
  assert.deepEqual(matchReason('HBC1234', 'MBC1234', null), { reason: 'confusable', score: 1.5 });
  assert.deepEqual(matchReason('BAK5497', 'BAK5495', null), { reason: 'near', score: 2 });
  assert.deepEqual(
    [
      { match_score: 0, match_probability: 0.3 },
      { match_score: 0.7, match_probability: 0.3 },
      { match_score: 1.5, match_probability: null },
      { match_score: 2, match_probability: null },
      { plate: 'exact search' },
    ].map((row) => withMatchReason(row)),
    [
      { match_score: 0, match_probability: null, match_reason: 'same' },
      { match_score: 0.7, match_probability: 0.3, match_reason: 'alternative' },
      { match_score: 1.5, match_probability: null, match_reason: 'confusable' },
      { match_score: 2, match_probability: null, match_reason: 'near' },
      { plate: 'exact search' },
    ],
  );
});

test('the review queue filters by crop width and orders by confidence', async () => {
  const live = await session((await camera('queue')).id);
  const read = async (key: string, text: string, confidence: number, at: string) => {
    await writeTrack(dataDir, live.id, key, {
      text,
      confidence,
      status: confidence >= 0.96 ? 'readable' : 'low_confidence',
      capturedFrom: at,
      capturedTo: new Date(Date.parse(at) + 4000).toISOString(),
    });
    return ingestTrack(db(), workerOptions(), live, key);
  };
  await read('e000-t000001', 'ABC1D23', 0.62, '2026-05-01T08:00:00.000Z');
  const wide = await read('e000-t000002', 'DEF4G56', 0.91, '2026-05-01T08:01:00.000Z');
  await read('e000-t000003', 'GHI7J89', 0.75, '2026-05-01T08:02:00.000Z');
  // The second read's crops are 80 px wide; the fixture's are 8 px.
  await db().query(
    'UPDATE plate_detections SET crop_width=80 WHERE appearance_id IN (SELECT id FROM plate_appearances WHERE job_id=$1)',
    [wide],
  );
  const list = async (query: Record<string, string>) =>
    (
      await api
        .get('/api/v2/recognition-results')
        .query({ stream_source_id: live.stream_source_id, ...query })
        .set(as('owner'))
        .expect(200)
    ).body;
  const byConfidence = await list({ order: 'confidence', confidence_status: 'low_confidence' });
  assert.deepEqual(
    byConfidence.items.map((item: any) => [item.effective_text, item.confidence]),
    [
      ['DEF4G56', 0.91],
      ['GHI7J89', 0.75],
      ['ABC1D23', 0.62],
    ],
  );
  const byTime = await list({});
  assert.deepEqual(
    byTime.items.map((item: any) => item.effective_text),
    ['GHI7J89', 'DEF4G56', 'ABC1D23'],
  );
  const large = await list({ min_crop_width: '50' });
  assert.deepEqual(
    large.items.map((item: any) => item.effective_text),
    ['DEF4G56'],
  );
  await list({ order: 'random' }).catch(() => null);
  await api.get('/api/v2/recognition-results?order=random').set(as('owner')).expect(422);
  await api.get('/api/v2/recognition-results?min_crop_width=0').set(as('owner')).expect(422);
});

test('of two copies of one file, the copy with a corrected read stands for both', async () => {
  // Copy 1, uploaded first: its misread TQB9E23 was corrected to TOB9E23. Copy 2, uploaded
  // and analysed later, still reads TQB9E23 (R08 of the November review).
  const corrected = await upload('bc_1600.mp4', 'bc-1600', [['TQB9E23', 40, 44]]);
  await db().query("UPDATE media_assets SET uploaded_at=now() - interval '1 day' WHERE id=$1", [
    corrected,
  ]);
  const again = await upload('bc_1600 (2).mp4', 'bc-1600', [['TQB9E23', 40, 44]]);
  for (const media of [corrected, again])
    await api
      .patch(`/api/v2/media/${media}`)
      .set(as('owner'))
      .send({ recorded_at: '2026-03-02T16:00:00Z' })
      .expect(200);
  const result = (
    await db().query(
      'SELECT a.id FROM plate_appearances a JOIN recognition_jobs j ON j.id=a.job_id WHERE j.media_id=$1',
      [corrected],
    )
  ).rows[0].id;
  await api
    .post(`/api/v2/recognition-results/${result}/reviews`)
    .set(as('owner'))
    .send({ action: 'correct', corrected_text: 'TOB9E23', expected_revision: 0 })
    .expect(201);

  const journey = (
    await api
      .get('/api/v2/plates/TOB9E23/journey')
      .query({ match: 'fuzzy' })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.deepEqual(
    journey.points.map((p: any) => [p.camera.name, p.plate, p.review_status]),
    [['bc_1600.mp4', 'TOB9E23', 'corrected']],
  );
  // Without any review the newest upload still stands for its copies.
  const plain = (
    await api
      .get('/api/v2/plates/TQB9E23/journey')
      .query({ match: 'exact' })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.deepEqual(
    plain.points.map((p: any) => p.camera.name),
    ['bc_1600 (2).mp4'],
  );
});

test('look-alike spellings: one or two characters read as a look-alike, Mercosul counts none', () => {
  for (const { pair } of LOOKALIKE_PAIRS) assert.equal(pair, [...pair].sort().join(''));
  assert.equal(new Set(LOOKALIKE_PAIRS.map((p) => p.pair)).size, LOOKALIKE_PAIRS.length);
  const kinds = (pair: string) => LOOKALIKE_PAIRS.find((p) => p.pair === pair)?.kinds;
  assert.deepEqual(kinds('1I'), ['shape']);
  assert.deepEqual(kinds('68'), ['ocr']);
  assert.deepEqual(kinds('17'), ['shape', 'ocr']);
  const spellings = similarSpellings('ABC3I34');
  const changes = (spelling: string) =>
    spellings.get(spelling)?.map((c) => `${c.from}>${c.to}:${c.kinds.join('+')}`);
  assert.deepEqual(
    [...spellings.keys()].slice(0, 2),
    ['ABC3I34', 'ABC3834'],
    'the plate, its twin',
  );
  assert.deepEqual(changes('ABC3I34'), []);
  assert.deepEqual(changes('ABC3834'), ['I>8:mercosul']);
  assert.deepEqual(changes('ABC3134'), ['I>1:shape']);
  assert.deepEqual(changes('ABC3L34'), ['I>L:shape']);
  assert.deepEqual(changes('A8C3I34'), ['B>8:shape']);
  assert.deepEqual(changes('A8C3134'), ['B>8:shape', 'I>1:shape']);
  assert.equal(spellings.get('ABC3X34'), undefined, 'I and X do not look alike');
  assert.equal(changeCount(spellings.get('ABC3834')!), 0);
  assert.equal(changeCount(spellings.get('A8C3134')!), 2);
  // Ordered by the number of changes; a few hundred spellings at two changes.
  const counts = [...spellings.values()].map(changeCount);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => a - b),
  );
  assert.ok(spellings.size > 300 && spellings.size < 1500, `${spellings.size} spellings`);
  assert.ok(![...similarSpellings('ABC3I34', 1).values()].some((c) => changeCount(c) > 1));
  assert.deepEqual([...similarSpellings('ABCD').keys()], ['ABCD'], 'too short for look-alikes');
});

test('approximate search lists the plates read with look-alike characters, grouped and ranked', async () => {
  const gate = await camera('similar A', PLACES.atlantica);
  const street = await camera('similar B', PLACES.brasil);
  const a = await session(gate.id);
  const b = await session(street.id);
  // GKD4J31 twice; its old plate; 3 read as 8 on both cameras; 3 as 8 and G as C; an unrelated
  // character (X); a rejected read; and a read of the stranger's own camera.
  await track(a, 'e000-t000001', 'GKD4J31', '2026-06-01T08:00:00Z');
  await track(a, 'e000-t000002', 'GKD4J31', '2026-06-01T08:10:00Z');
  await track(a, 'e000-t000003', 'GKD4931', '2026-06-01T08:20:00Z');
  await track(a, 'e000-t000004', 'GKD4J81', '2026-06-01T08:30:00Z');
  await track(b, 'e000-t000001', 'GKD4J81', '2026-06-01T08:31:00Z');
  await track(a, 'e000-t000005', 'CKD4J81', '2026-06-01T08:40:00Z');
  await track(a, 'e000-t000006', 'GKD4J3X', '2026-06-01T08:50:00Z');
  const rejected = await track(a, 'e000-t000007', 'GKD4JB1', '2026-06-01T09:00:00Z');
  await db().query("UPDATE plate_appearances SET review_status='rejected' WHERE job_id=$1", [
    rejected,
  ]);
  const theirs = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('stranger'))
      .send({ name: 'their camera', url: URL })
      .expect(201)
  ).body;
  const started = (
    await api
      .post(`/api/v2/stream-sources/${theirs.id}/sessions`)
      .set(as('stranger'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    started.id,
  ]);
  const their = (await db().query('SELECT * FROM live_sessions WHERE id=$1', [started.id])).rows[0];
  await track(their, 'e000-t000001', 'GKD4J81', '2026-06-01T08:35:00Z');

  const summary = (await api.get('/api/v2/plates/gkd-4j31/similar').set(as('owner')).expect(200))
    .body;
  assert.equal(summary.plate, 'GKD4J31');
  assert.equal(summary.max_changes, 2);
  assert.equal(summary.exact.reads, 2);
  assert.deepEqual(summary.exact.changes, []);
  assert.deepEqual(
    summary.similar.map((s: any) => [
      s.plate,
      s.changed,
      s.reads,
      s.cameras.map((c: any) => c.name),
    ]),
    [
      ['GKD4931', 0, 1, ['similar A']],
      ['GKD4J81', 1, 2, ['similar A', 'similar B']],
      ['CKD4J81', 2, 1, ['similar A']],
    ],
  );
  assert.deepEqual(summary.similar[1].changes, [
    { index: 5, from: '3', to: '8', kinds: ['shape'] },
  ]);
  assert.ok(summary.similar[1].primary_detection_id);
  assert.equal(summary.similar[1].last_seen, '2026-06-01T08:31:00.000Z');
  assert.ok(summary.spellings.includes('GKD4J81') && !summary.spellings.includes('GKD4J3X'));
  assert.ok(summary.pairs.length > 50);
  // One character at most; one camera; another user's reads stay theirs.
  const one = (
    await api.get('/api/v2/plates/GKD4J31/similar?max_changes=1').set(as('owner')).expect(200)
  ).body;
  assert.deepEqual(
    one.similar.map((s: any) => s.plate),
    ['GKD4931', 'GKD4J81'],
  );
  const onB = (
    await api
      .get('/api/v2/plates/GKD4J31/similar')
      .query({ stream_source_id: street.id })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.equal(onB.exact, null);
  assert.deepEqual(
    onB.similar.map((s: any) => [s.plate, s.reads]),
    [['GKD4J81', 1]],
  );
  const stranger = (await api.get('/api/v2/plates/GKD4J31/similar').set(as('stranger')).expect(200))
    .body;
  assert.equal(stranger.exact, null);
  assert.deepEqual(
    stranger.similar.map((s: any) => [s.plate, s.cameras.map((c: any) => c.name)]),
    [['GKD4J81', ['their camera']]],
  );
  // Refreshing the same search is logged once.
  const logged = await db().query(
    "SELECT count(*)::int AS n FROM audit_log WHERE user_id=$1 AND action='results.search' AND details->>'plate'='GKD4J31' AND details->>'match'='similar'",
    [users.owner.id],
  );
  assert.equal(logged.rows[0].n, 1);
  await api.get('/api/v2/plates/GKD4J31/similar?max_changes=4').set(as('owner')).expect(422);

  // The Results page lists every read (reviewed ones too), fewest changes first, then newest.
  const list = (
    await api
      .get('/api/v2/recognition-results')
      .query({ plate: 'GKD4J31', match: 'similar', stream_source_id: gate.id })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.deepEqual(
    list.items.map((item: any) => [item.effective_text, item.match_distance]),
    [
      ['GKD4931', 0],
      ['GKD4J31', 0],
      ['GKD4J31', 0],
      ['GKD4JB1', 1],
      ['GKD4J81', 1],
      ['CKD4J81', 2],
    ],
  );
  assert.deepEqual(
    list.items[5].match_changes.map((c: any) => `${c.from}>${c.to}`),
    ['G>C', '3>8'],
  );
  assert.deepEqual(list.items[1].match_changes, []);
  const grouped = (
    await api
      .get('/api/v2/recognition-results')
      .query({ plate: 'GKD4J31', match: 'similar', group_by: 'sighting' })
      .set(as('owner'))
      .expect(200)
  ).body;
  assert.equal(grouped.items[0].match_distance, 0);
  // Journeys follow the look-alike reads too.
  const journey = (
    await api.get('/api/v2/plates/GKD4J31/journey?match=similar').set(as('owner')).expect(200)
  ).body;
  const viaB = journey.points.find((p: any) => p.camera.name === 'similar B');
  assert.equal(viaB.plate, 'GKD4J81');
  assert.deepEqual(
    viaB.match_changes.map((c: any) => `${c.from}>${c.to}`),
    ['3>8'],
  );
});
