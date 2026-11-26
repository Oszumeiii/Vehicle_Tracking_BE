import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { ingestTrack } from '../src/live/ingest';
import { Retention } from '../src/live/retention';
import { calibrationReport } from '../src/evaluation/calibration';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines, writeTrack } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let dataDir: string;
const users = {} as Record<'admin' | 'first' | 'second', { id: string; token: string }>;
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
  for (const role of ['admin', 'first', 'second'] as const) {
    const user = await seedUser(fixture.database, role === 'admin' ? 'admin' : 'user');
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
const OLD = { capturedFrom: '2020-01-01T10:00:00.000Z', capturedTo: '2020-01-01T10:00:04.000Z' };
// One track per confidence bin (0-.5, .5-.7, .7-.8, .8-.85, .85-.9, .9-.95, .95-1).
const CONFIDENCES = [0.3, 0.6, 0.75, 0.82, 0.87, 0.92, 0.97];

async function cameraWithTracks() {
  const source = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('admin'))
      .send({ name: 'cam', url: URL })
      .expect(201)
  ).body;
  const session = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('admin'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    session.id,
  ]);
  const row = (await db().query('SELECT * FROM live_sessions WHERE id=$1', [session.id])).rows[0];
  const jobs: Record<string, string> = {};
  for (const [i, confidence] of CONFIDENCES.entries()) {
    const key = `e000-t00000${i + 1}`;
    await writeTrack(dataDir, row.id, key, { ...OLD, text: `EVA${i}111`, confidence });
    jobs[`EVA${i}111`] = await ingestTrack(db(), workerOptions(), row, key);
  }
  // A track without a confidence is never sampled.
  await writeTrack(dataDir, row.id, 'e000-t000009', { ...OLD, text: 'NOC9999' });
  const unsampled = await ingestTrack(db(), workerOptions(), row, 'e000-t000009');
  await db().query("UPDATE recognition_jobs SET statistics=statistics-'confidence' WHERE id=$1", [
    unsampled,
  ]);
  return { source, session: row, jobs, unsampled };
}

test('sets are sampled per confidence bin, labelled blind and calibrated from consensus labels', async () => {
  const empty = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('admin'))
      .send({ name: 'empty', url: URL })
      .expect(201)
  ).body;
  const { source, jobs, unsampled } = await cameraWithTracks();
  const body = { name: 'Camboriú', stream_source_id: source.id, per_bin: 1 };
  await api.post('/api/v2/evaluation-sets').set(as('first')).send(body).expect(403);
  await api
    .post('/api/v2/evaluation-sets')
    .set(as('admin'))
    .send({ ...body, live_session_id: 'x' })
    .expect(422);
  await api
    .post('/api/v2/evaluation-sets')
    .set(as('admin'))
    .send({ ...body, stream_source_id: 'missing' })
    .expect(404);
  await api
    .post('/api/v2/evaluation-sets')
    .set(as('admin'))
    .send({ ...body, stream_source_id: empty.id })
    .expect(422);
  // Test crops are 8 px wide: a minimum width above that leaves nothing to sample.
  await api
    .post('/api/v2/evaluation-sets')
    .set(as('admin'))
    .send({ ...body, min_crop_width: 9 })
    .expect(422);
  const wide = (
    await api
      .post('/api/v2/evaluation-sets')
      .set(as('admin'))
      .send({ ...body, min_crop_width: 8 })
      .expect(201)
  ).body;
  assert.equal(wide.items, CONFIDENCES.length);
  assert.equal(wide.params.min_crop_width, 8);
  await api.delete(`/api/v2/evaluation-sets/${wide.id}`).set(as('admin')).expect(204);
  const set = (await api.post('/api/v2/evaluation-sets').set(as('admin')).send(body).expect(201))
    .body;
  assert.equal(set.items, CONFIDENCES.length);
  assert.equal(set.params.min_crop_width, undefined);
  assert.equal(set.my_labels, 0);
  const items = (
    await db().query('SELECT id, job_id, bin FROM evaluation_items WHERE set_id=$1', [set.id])
  ).rows;
  const itemOf = (text: string) => items.find((item) => item.job_id === jobs[text])!.id;
  assert.deepEqual(items.map((item) => item.bin).sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(!items.some((item) => item.job_id === unsampled));
  const listed = await api.get('/api/v2/evaluation-sets').set(as('first')).expect(200);
  assert.equal(listed.body.items[0].id, set.id);

  // Labellers see evidence only: no machine text, confidence or review state.
  const next = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/next`).set(as('first')).expect(200)
  ).body;
  assert.equal(next.remaining, CONFIDENCES.length);
  assert.deepEqual(Object.keys(next.item).sort(), [
    'crop_urls',
    'frame_url',
    'id',
    'my_label',
    'set_id',
    'video',
    'window_index',
  ]);
  assert.equal(next.item.video, null);
  assert.equal(next.item.window_index, null);
  assert.doesNotMatch(JSON.stringify(next), /EVA|confidence|review/);
  assert.equal(next.item.crop_urls.length, 5);
  assert.match(next.item.frame_url, /\/3\/frame$/);
  const crop = await api.get(next.item.crop_urls[0]).set(as('first')).expect(200);
  assert.ok(crop.body.length > 0);
  await api.get(next.item.frame_url).set(as('second')).expect(200);
  await api
    .get(`/api/v2/evaluation-sets/${set.id}/items/${next.item.id}/artifacts/9/crop`)
    .set(as('first'))
    .expect(404);
  const skipped = (
    await api
      .get(`/api/v2/evaluation-sets/${set.id}/next?exclude=${next.item.id}`)
      .set(as('first'))
      .expect(200)
  ).body;
  assert.notEqual(skipped.item.id, next.item.id);

  const put = (role: keyof typeof users, text: string, plate: string | null, status = 200) =>
    api
      .put(`/api/v2/evaluation-sets/${set.id}/items/${itemOf(text)}/label`)
      .set(as(role))
      .send({ plate_text: plate })
      .expect(status);
  await put('first', 'EVA6111', '', 422);
  await put('first', 'EVA6111', 'A!', 422);
  await api
    .put(`/api/v2/evaluation-sets/${set.id}/items/missing/label`)
    .set(as('first'))
    .send({ plate_text: null })
    .expect(404);
  // Correct, correct, wrong, unreadable by people, disagreement, correct, one label only.
  const labels: [string, string | null, string | null | undefined][] = [
    ['EVA6111', 'eva-6111', 'EVA6111'],
    ['EVA5111', 'EVA5111', 'EVA 5111'],
    ['EVA4111', 'EVA4112', 'EVA4112'],
    ['EVA3111', null, null],
    ['EVA2111', 'EVA2111', 'EVA2117'],
    ['EVA1111', 'EVA1111', 'EVA1111'],
    ['EVA0111', 'EVA0111', undefined],
  ];
  await put('first', 'EVA6111', 'WRONG1');
  for (const [text, first, second] of labels) {
    const saved = (await put('first', text, first)).body;
    assert.equal(
      saved.plate_text,
      first === null ? null : first.replace(/[\s-]/g, '').toUpperCase(),
    );
    if (second !== undefined) await put('second', text, second);
  }
  const item = (
    await api
      .get(`/api/v2/evaluation-sets/${set.id}/items/${itemOf('EVA6111')}`)
      .set(as('first'))
      .expect(200)
  ).body;
  assert.equal(item.my_label.plate_text, 'EVA6111', 'a label can be corrected');
  const done = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/next`).set(as('first')).expect(200)
  ).body;
  assert.deepEqual(done, { remaining: 0, item: null });
  const progress = (
    await api.get(`/api/v2/evaluation-sets/${set.id}`).set(as('second')).expect(200)
  ).body;
  assert.equal(progress.labelled_items, 7);
  assert.equal(progress.labelers, 2);
  assert.equal(progress.my_labels, 6);

  await api.get(`/api/v2/evaluation-sets/${set.id}/report`).set(as('first')).expect(403);
  const report = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/report`).set(as('admin')).expect(200)
  ).body;
  assert.equal(report.samples, 6, 'the disagreement is left out');
  assert.equal(report.disagreements, 1);
  assert.equal(report.multi_labelled, 6);
  assert.equal(report.agreement, 5 / 6);
  assert.equal(report.unreadable_by_labeller, 1);
  assert.equal(report.exact_match, 4 / 6);
  const at = (threshold: number) => report.thresholds.find((r: any) => r.threshold === threshold);
  assert.deepEqual(at(0.5), {
    threshold: 0.5,
    readable: 5,
    correct: 3,
    precision: 0.6,
    coverage: 5 / 6,
  });
  assert.equal(at(0.85).precision, 2 / 3);
  assert.equal(at(0.9).precision, 1);
  assert.equal(report.recommended_threshold, 0.88);
  assert.equal(report.bins.length, 7);
  assert.equal(report.bins[4].exact_match, 0);
  const strict = (
    await api
      .get(`/api/v2/evaluation-sets/${set.id}/report?min_labels=2&target=0.6`)
      .set(as('admin'))
      .expect(200)
  ).body;
  assert.equal(strict.samples, 5);
  assert.equal(strict.recommended_threshold, 0.5);
  const files = (
    await api
      .get(`/api/v2/evaluation-sets/${set.id}/report?format=files`)
      .set(as('admin'))
      .expect(200)
  ).body;
  assert.equal(files.predictions.predictions.length, 6);
  assert.equal(files.ground_truth.samples.length, 6);
  assert.ok(
    files.ground_truth.samples.some((s: any) => s.plate_text === null && s.source_id === source.id),
  );

  // Sampled tracks are protected from retention; the unsampled one is deleted.
  await api
    .patch(`/api/v2/stream-sources/${source.id}`)
    .set(as('admin'))
    .send({ keyframe_retention_hours: 0, track_retention_days: 0 })
    .expect(200);
  const swept = await new Retention(db(), workerOptions(), {
    intervalMs: 60_000,
    batch: 50,
  }).sweep();
  assert.equal(swept.deleted, 1);
  assert.equal(swept.pruned, 1, 'only the unsampled track is pruned, then deleted');
  assert.equal(
    (await db().query('SELECT count(*)::int AS n FROM evaluation_items WHERE set_id=$1', [set.id]))
      .rows[0].n,
    7,
  );

  await api.delete(`/api/v2/evaluation-sets/${set.id}`).set(as('first')).expect(403);
  await api.delete(`/api/v2/evaluation-sets/${set.id}`).set(as('admin')).expect(204);
  await api.get(`/api/v2/evaluation-sets/${set.id}`).set(as('admin')).expect(404);
  assert.equal(
    (await db().query('SELECT count(*)::int AS n FROM evaluation_labels')).rows[0].n,
    0,
    'labels go with their set; tracks stay',
  );
});

test('calibration treats plates no person can read as wrong and validates the target', () => {
  const item = (labels: (string | null)[], text: string | null, confidence: number | null) => ({
    item_id: String(Math.random()),
    job_id: 'j',
    bin: 0,
    machine_text: text,
    confidence,
    labels,
  });
  const report = calibrationReport([
    item([null], 'ABC1234', 0.99),
    item(['ABC1234'], 'ABC1234', 0.99),
    item([], 'ZZZ', 0.99),
    item(['ABC1234'], null, null),
  ]);
  assert.equal(report.samples, 3);
  assert.equal(report.labelled, 3);
  assert.equal(report.agreement, null);
  assert.equal(report.thresholds[0].readable, 2);
  assert.equal(report.thresholds[0].precision, 0.5);
  assert.equal(report.recommended_threshold, null);
  assert.throws(() => calibrationReport([], { targetPrecision: 0 }), /target precision/);
});

/** A camera that replays an uploaded video (once unless loop), with tracks at these seconds. */
async function replayWithTracks(starts: number[], loop = false) {
  const media = randomUUID().replaceAll('-', '');
  await mkdir(join(dataDir, 'media'), { recursive: true });
  await writeFile(join(dataDir, 'media', media), 'video bytes');
  await db().query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,duration_seconds)
    VALUES($1,$2,'eval.mp4','video',$3,'video/mp4',11,$4,7200)`,
    [media, users.admin.id, `media/${media}`, createHash('sha256').update(media).digest('hex')],
  );
  const source = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('admin'))
      .send({ name: 'replay', source_type: 'media', media_id: media, loop })
      .expect(201)
  ).body;
  const session = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('admin'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  await db().query("UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1", [
    session.id,
  ]);
  const row = (await db().query('SELECT * FROM live_sessions WHERE id=$1', [session.id])).rows[0];
  const jobs: string[] = [];
  for (const [i, start] of starts.entries()) {
    const key = `e000-t${String(i + 1).padStart(6, '0')}`;
    await writeTrack(dataDir, row.id, key, { ...OLD, text: `WIN${i}A11`, confidence: 0.9 });
    const job = await ingestTrack(db(), workerOptions(), row, key);
    await db().query(
      'UPDATE plate_appearances SET start_seconds=$2, end_seconds=$3 WHERE job_id=$1',
      [job, start, start + 2],
    );
    jobs.push(job);
  }
  return { session: row, jobs };
}

test('window sets hold every track in stretches of a replayed video and record missed vehicles', async () => {
  const { session, jobs } = await replayWithTracks([130, 10, 70, 50, 200]);
  const body = {
    name: 'Pizza Hot 2 h',
    live_session_id: session.id,
    windows: [
      { from: 120, to: 180 },
      { from: 0, to: 60 },
    ],
  };
  const create = (changes: object, status: number) =>
    api
      .post('/api/v2/evaluation-sets')
      .set(as('admin'))
      .send({ ...body, ...changes })
      .expect(status);
  await create({ live_session_id: undefined, stream_source_id: session.stream_source_id }, 422);
  await create(
    {
      windows: [
        { from: 0, to: 60 },
        { from: 30, to: 90 },
      ],
    },
    422,
  );
  await create({ windows: [{ from: 60, to: 60 }] }, 422);
  await create({ windows: [{ from: 0, to: 4000 }] }, 422);
  const looping = await replayWithTracks([10], true);
  await create({ live_session_id: looping.session.id }, 422);
  const set = (await create({}, 201)).body;
  // Tracks at 10, 50 and 130 are inside; 70 and 200 fall outside. Windows are kept in order.
  assert.equal(set.items, 3);
  assert.deepEqual(set.params.windows, [
    { from: 0, to: 60 },
    { from: 120, to: 180 },
  ]);
  assert.equal(set.my_misses, 0);

  // Labellers go through the video in order and can watch each car pass.
  const next = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/next`).set(as('first')).expect(200)
  ).body;
  assert.equal(next.item.window_index, 0);
  assert.deepEqual(next.item.video, {
    url: `/api/v2/evaluation-sets/${set.id}/video`,
    start_seconds: 10,
    end_seconds: 12,
  });
  assert.doesNotMatch(JSON.stringify(next), /WIN|confidence/);
  const video = await api.get(next.item.video.url).set(as('first')).buffer(true).expect(200);
  assert.equal(video.headers['content-type'], 'video/mp4');
  await api.get(next.item.video.url).expect(401);
  await api
    .put(`/api/v2/evaluation-sets/${set.id}/items/${next.item.id}/label`)
    .set(as('first'))
    .send({ plate_text: 'WIN1A11' })
    .expect(200);
  const second = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/next`).set(as('first')).expect(200)
  ).body;
  assert.equal(second.item.video.start_seconds, 50);

  const add = (role: keyof typeof users, miss: object, status: number) =>
    api.post(`/api/v2/evaluation-sets/${set.id}/misses`).set(as(role)).send(miss).expect(status);
  await add('first', { window_index: 2, video_seconds: 10, plate_text: null }, 422);
  await add('first', { window_index: 1, video_seconds: 100, plate_text: null }, 422);
  await add('first', { window_index: 0, video_seconds: 30, plate_text: 'A!' }, 422);
  const missed = (
    await add('first', { window_index: 0, video_seconds: 30.5, plate_text: 'mis-1d23' }, 201)
  ).body;
  assert.equal(missed.plate_text, 'MIS1D23');
  // A car still in view a little after the window ends.
  const late = (await add('first', { window_index: 1, video_seconds: 205, plate_text: null }, 201))
    .body;
  await api
    .delete(`/api/v2/evaluation-sets/${set.id}/misses/${late.id}`)
    .set(as('second'))
    .expect(404);
  await api
    .delete(`/api/v2/evaluation-sets/${set.id}/misses/${late.id}`)
    .set(as('first'))
    .expect(204);

  const listed = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/windows`).set(as('first')).expect(200)
  ).body;
  assert.equal(listed.video_url, `/api/v2/evaluation-sets/${set.id}/video`);
  assert.deepEqual(
    listed.windows.map((w: any) => [w.index, w.from, w.to, w.items, w.my_labels]),
    [
      [0, 0, 60, 2, 1],
      [1, 120, 180, 1, 0],
    ],
  );
  assert.deepEqual(listed.windows[0].tracks, [
    { start_seconds: 10, end_seconds: 12 },
    { start_seconds: 50, end_seconds: 52 },
  ]);
  assert.deepEqual(
    listed.windows[0].my_misses.map((m: any) => [m.video_seconds, m.plate_text]),
    [[30.5, 'MIS1D23']],
  );
  assert.equal(listed.windows[1].my_misses.length, 0);
  const others = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/windows`).set(as('second')).expect(200)
  ).body;
  assert.equal(others.windows[0].my_misses.length, 0);
  const mine = (await api.get(`/api/v2/evaluation-sets/${set.id}`).set(as('first')).expect(200))
    .body;
  assert.equal(mine.my_misses, 1);

  await api.get(`/api/v2/evaluation-sets/${set.id}/export`).set(as('first')).expect(403);
  const exported = (
    await api.get(`/api/v2/evaluation-sets/${set.id}/export`).set(as('admin')).expect(200)
  ).body;
  assert.deepEqual(
    exported.items.map((i: any) => [i.start_seconds, i.machine_text, i.window_index]),
    [
      [10, 'WIN1A11', 0],
      [50, 'WIN3A11', 0],
      [130, 'WIN0A11', 1],
    ],
  );
  assert.equal(exported.items[0].job_id, jobs[1]);
  assert.equal(exported.items[0].crop_width, 8);
  assert.equal(exported.items[0].labels[0].plate_text, 'WIN1A11');
  assert.ok(exported.items[0].labels[0].labeler);
  assert.deepEqual(exported.items[1].labels, []);
  assert.equal(exported.misses.length, 1);
  assert.equal(exported.sessions[0].id, session.id);
  assert.equal(exported.sessions[0].pipeline_id, 'joint');

  await api.delete(`/api/v2/evaluation-sets/${set.id}`).set(as('admin')).expect(204);
  const left = await db().query(
    'SELECT count(*)::int AS n FROM evaluation_misses WHERE set_id=$1',
    [set.id],
  );
  assert.equal(left.rows[0].n, 0);
});

test('a sampled set has no windows or video', async () => {
  const { source } = await cameraWithTracks();
  const set = (
    await api
      .post('/api/v2/evaluation-sets')
      .set(as('admin'))
      .send({ name: 'sampled', stream_source_id: source.id, per_bin: 1 })
      .expect(201)
  ).body;
  await api.get(`/api/v2/evaluation-sets/${set.id}/windows`).set(as('first')).expect(404);
  await api.get(`/api/v2/evaluation-sets/${set.id}/video`).set(as('first')).expect(404);
  await api
    .post(`/api/v2/evaluation-sets/${set.id}/misses`)
    .set(as('first'))
    .send({ window_index: 0, video_seconds: 1, plate_text: null })
    .expect(404);
});
