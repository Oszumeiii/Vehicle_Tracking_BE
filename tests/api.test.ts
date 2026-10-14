import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { PipelineRegistry } from '../src/recognition/registry';
import { Database } from '../src/database/database';
import { processOne, workerOptions } from '../src/recognition/engine';
import { newId, seedUser, startTestDatabase, TestDatabase } from './helpers';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR4nGPkEpFjwAaYsIqSJQEAGNgARL3K8HcAAAAASUVORK5CYII=',
  'base64',
);
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let admin: Awaited<ReturnType<typeof seedUser>>;
let owner: Awaited<ReturnType<typeof seedUser>>;
let stranger: Awaited<ReturnType<typeof seedUser>>;
let adminToken: string;
let ownerToken: string;
let strangerToken: string;
let mediaRoot: string;
const oldEnvironment = { ...process.env };

async function login(user: { email: string; password: string }) {
  const response = await api
    .post('/api/v2/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  assert.equal(response.body.token_type, 'bearer');
  assert.ok(response.body.expires_at);
  return response.body.access_token as string;
}

before(async () => {
  fixture = await startTestDatabase();
  mediaRoot = join(fixture.root, 'artifacts');
  process.env.DATABASE_URL = fixture.url;
  process.env.PLATE_DATA_DIR = mediaRoot;
  process.env.PLATE_PIPELINE_PYTHON = resolve(
    process.env.PLATE_PIPELINE_PYTHON ??
      (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'),
  );
  process.env.PLATE_MAX_UPLOAD_MIB = '1';
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  delete process.env.PLATE_PIPELINES_CONFIG;
  app = await createApp();
  api = request(app.getHttpServer());
  admin = await seedUser(fixture.database, 'admin');
  owner = await seedUser(fixture.database);
  stranger = await seedUser(fixture.database);
  adminToken = await login(admin);
  ownerToken = await login(owner);
  strangerToken = await login(stranger);
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
  for (const key of [
    'DATABASE_URL',
    'PLATE_DATA_DIR',
    'PLATE_PIPELINE_PYTHON',
    'PLATE_MAX_UPLOAD_MIB',
    'NODE_ENV',
    'CORS_ORIGINS',
    'PLATE_PIPELINES_CONFIG',
  ]) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

async function media(ownerId = owner.id) {
  const id = newId();
  const key = `media/${id}/input.png`;
  await mkdir(join(mediaRoot, 'media', id), { recursive: true });
  await writeFile(join(mediaRoot, key), image);
  await fixture.database.query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,width,height)
    VALUES($1,$2,'input.png','image',$3,'image/png',$4,$5,8,4)`,
    [id, ownerId, key, image.length, createHash('sha256').update(image).digest('hex')],
  );
  return id;
}

async function completed(
  options: {
    mediaId?: string;
    ownerId?: string;
    kind?: string;
    text?: string;
    created?: string;
    jobId?: string;
    track?: string;
  } = {},
) {
  const mediaId = options.mediaId ?? (await media(options.ownerId));
  const jobId = options.jobId ?? newId();
  const resultId = newId();
  const detectionId = newId();
  const cropKey = `recognition/${jobId}/crop.png`;
  const frameKey = `recognition/${jobId}/frame.png`;
  const text = options.text ?? 'ABC1D23';
  await mkdir(join(mediaRoot, 'recognition', jobId), { recursive: true });
  await writeFile(join(mediaRoot, cropKey), image);
  await writeFile(join(mediaRoot, frameKey), image);
  if (!options.jobId)
    await fixture.database.query(
      `INSERT INTO recognition_jobs(id,media_id,job_kind,status,stage,created_at,pipeline_snapshot,statistics)
    VALUES($1,$2,$3,'succeeded','complete',$4,$5,$6)`,
      [
        jobId,
        mediaId,
        options.kind ?? 'recognize',
        options.created ?? new Date().toISOString(),
        JSON.stringify({ id: 'test-pipeline', version: 'v1', model: 'yolo11n', confidence: 0.25 }),
        JSON.stringify({ selected_frames: 1, total_crops: 1 }),
      ],
    );
  else
    await fixture.database.query(
      "UPDATE recognition_jobs SET status='succeeded',stage='complete',statistics=$2 WHERE id=$1",
      [jobId, JSON.stringify({ selected_frames: 1, total_crops: 1 })],
    );
  const detectOnly = options.kind === 'detect_only';
  await fixture.database.query(
    `INSERT INTO plate_appearances(id,job_id,source_track_id,first_frame,last_frame,start_seconds,end_seconds,machine_text,machine_status,effective_text,agreement_count)
    VALUES($1,$2,$3,1,1,0,0,$4,$5,$4,$6)`,
    [
      resultId,
      jobId,
      options.track ?? 'track-1',
      detectOnly ? null : text,
      detectOnly ? 'not_run' : 'readable',
      detectOnly ? 0 : 1,
    ],
  );
  await fixture.database.query(
    `INSERT INTO plate_detections(id,appearance_id,selected_order,frame_index,timestamp_seconds,timestamp_source,bbox,crop_bbox,detection_score,crop_storage_key,frame_storage_key,crop_width,crop_height,legacy_crop_id)
    VALUES($1,$2,1,1,0,'video_pts',$3,$3,0.9,$4,$5,8,4,'crop-001')`,
    [detectionId, resultId, JSON.stringify([0, 0, 8, 4]), cropKey, frameKey],
  );
  if (!detectOnly)
    await fixture.database.query(
      `INSERT INTO ocr_predictions(id,detection_id,variant,raw_text,normalized_text,ocr_score,input_storage_key,latency_ms)
    VALUES($1,$2,'original',$3,$4,0.88,$5,12)`,
      [newId(), detectionId, text, text, cropKey],
    );
  return { mediaId, jobId, resultId, detectionId, cropKey };
}

test('sessions preserve password bytes, revoke on logout/disable/reset, and protect administration', async () => {
  const unauthenticated = await api.get('/api/v2/media').expect(401);
  assert.match(unauthenticated.headers['www-authenticate'], /Bearer/i);
  await api.get('/api/v2/auth/me').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  await api.get('/api/v2/users').set('Authorization', `Bearer ${ownerToken}`).expect(403);
  await api
    .post('/api/v2/users')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      email: 'unauthorized@example.test',
      password: 'password123456',
      display_name: 'x',
      role: 'admin',
    })
    .expect(403);
  await api
    .patch(`/api/v2/users/${admin.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ is_active: false })
    .expect(409);
  const account = await seedUser(fixture.database, 'user', '  preserve-password-spaces  ');
  await api
    .post('/api/v2/auth/login')
    .send({ email: account.email, password: account.password.trim() })
    .expect(401);
  const token = await login(account);
  await api.post('/api/v2/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
  await api.get('/api/v2/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  const token2 = await login(account);
  await api
    .patch(`/api/v2/users/${account.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ password: 'new-password-12345' })
    .expect(200);
  await api.get('/api/v2/auth/me').set('Authorization', `Bearer ${token2}`).expect(401);
  const token3 = await login({ email: account.email, password: 'new-password-12345' });
  await api
    .patch(`/api/v2/users/${account.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ is_active: false })
    .expect(200);
  await api.get('/api/v2/auth/me').set('Authorization', `Bearer ${token3}`).expect(401);
  await api
    .post('/api/v2/auth/login')
    .send({ email: account.email, password: 'new-password-12345' })
    .expect(401);
  const stored = (
    await fixture.database.query('SELECT token_hash FROM auth_sessions WHERE user_id=$1', [
      owner.id,
    ])
  ).rows[0];
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.token_hash, ownerToken);
});

test('image uploads are decoded, bounded, private, and invalid uploads leave no incoming files', async () => {
  const valid = await api
    .post('/api/v2/media')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', image, 'plate.png')
    .expect(201);
  assert.equal(valid.body.media_type, 'image');
  assert.equal(valid.body.media_id, valid.body.id);
  assert.equal(valid.body.width, 8);
  assert.equal(valid.body.height, 4);
  assert.equal(valid.body.size_bytes, image.length);
  assert.ok(!JSON.stringify(valid.body).includes('storage_key'));
  const content = await api
    .get(valid.body.content_url)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.deepEqual(content.body, image);
  assert.match(content.headers['cache-control'], /no-store/);
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  const partial = await api
    .get(valid.body.content_url)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('Range', 'bytes=0-7')
    .set('Origin', 'http://localhost:5173')
    .expect(206);
  assert.deepEqual(partial.body, image.subarray(0, 8));
  assert.equal(partial.headers['content-range'], `bytes 0-7/${image.length}`);
  assert.match(partial.headers['access-control-expose-headers'], /Content-Disposition/);
  const invalidRange = await api
    .get(valid.body.content_url)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('Range', `bytes=${image.length + 100}-`)
    .expect(416);
  assert.equal(invalidRange.headers['content-range'], `bytes */${image.length}`);
  assert.match(invalidRange.headers['content-type'], /application\/json/);
  assert.equal(invalidRange.body.detail, 'Requested byte range is outside the file.');
  await api.get(valid.body.content_url).set('Authorization', `Bearer ${strangerToken}`).expect(404);
  await api.post('/api/v2/media').set('Authorization', `Bearer ${ownerToken}`).expect(422);
  await api
    .post('/api/v2/media')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', Buffer.from('broken'), 'fake.png')
    .expect(422);
  await api
    .post('/api/v2/media')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', image, 'disguised.mp4')
    .expect(422);
  await api
    .post('/api/v2/media')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', image, 'bad.exe')
    .expect(415);
  await api
    .post('/api/v2/media')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', Buffer.alloc(1024 * 1024 + 1), 'huge.png')
    .expect(413);
  assert.deepEqual(await readdir(join(mediaRoot, 'incoming')), []);
  await api
    .delete(`/api/v2/media/${valid.body.id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(204);
  await api.get(valid.body.content_url).set('Authorization', `Bearer ${ownerToken}`).expect(404);
});

test('job creation validates ownership before pipeline and stores independent immutable rerun snapshots', async () => {
  const mediaId = await media();
  await api
    .post('/api/v2/recognition-jobs')
    .set('Authorization', `Bearer ${strangerToken}`)
    .send({ media_id: mediaId, pipeline_id: 'unknown' })
    .expect(404);
  await api
    .post('/api/v2/recognition-jobs')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ media_id: mediaId, pipeline_id: 'unknown' })
    .expect(404);
  const registry = app.get(PipelineRegistry);
  const original = registry.resolve;
  const snapshot = { id: 'fixture-pipeline', version: 'v1', recognizer: { version: 'fixture' } };
  registry.resolve = async () => structuredClone(snapshot);
  try {
    const first = await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: mediaId, pipeline_id: snapshot.id, input_mode: 'plate_crop' })
      .expect(202);
    snapshot.version = 'v2';
    const second = await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: mediaId, pipeline_id: snapshot.id })
      .expect(202);
    assert.notEqual(first.body.job_id, second.body.job_id);
    assert.equal(
      (
        await api
          .get(first.body.status_url)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body.pipeline_version,
      'v1',
    );
    assert.equal(
      (
        await api
          .get(second.body.status_url)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body.pipeline_version,
      'v2',
    );
    await api
      .get(`${first.body.status_url}/results`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    await api
      .delete(first.body.status_url)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    await api
      .delete(`/api/v2/media/${mediaId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    await fixture.database.query("UPDATE recognition_jobs SET status='failed' WHERE media_id=$1", [
      mediaId,
    ]);
    await api
      .delete(first.body.status_url)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
    await api
      .get(`/api/v2/media/${mediaId}/content`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    await api.get(second.body.status_url).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    await api
      .delete(second.body.status_url)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
    await api
      .delete(`/api/v2/media/${mediaId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
  } finally {
    registry.resolve = original;
  }
});

test('unavailable media probe returns 503 and rolls back uploaded files', async () => {
  const python = process.env.PLATE_PIPELINE_PYTHON;
  const folders = (await readdir(join(mediaRoot, 'media'))).sort();
  const count = (await fixture.database.query('SELECT count(*) FROM media_assets')).rows[0].count;
  process.env.PLATE_PIPELINE_PYTHON = join(fixture.root, 'missing-python.exe');
  try {
    await api
      .post('/api/v2/media')
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('file', image, 'valid.png')
      .expect(503);
    assert.deepEqual((await readdir(join(mediaRoot, 'media'))).sort(), folders);
    assert.deepEqual(await readdir(join(mediaRoot, 'incoming')), []);
    assert.equal(
      (await fixture.database.query('SELECT count(*) FROM media_assets')).rows[0].count,
      count,
    );
  } finally {
    process.env.PLATE_PIPELINE_PYTHON = python;
  }
});

test('prepare pipeline works without OCR and supports manual review, search and CSV', async () => {
  const mediaId = await media();
  const registry = app.get(PipelineRegistry);
  const original = registry.resolve;
  registry.resolve = async () => ({ id: 'test-prepare', version: '1', task: 'prepare' });
  try {
    const response = await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: mediaId, pipeline_id: 'test-prepare', input_mode: 'plate_crop' })
      .expect(202);
    const jobId = response.body.job_id;
    const queued = (
      await api
        .get(response.body.status_url)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body;
    assert.equal(queued.job_kind, 'detect_only');
    assert.equal(queued.pipeline_task, 'prepare');
    await processOne(fixture.database, workerOptions(), async (_job, folder) => {
      await writeFile(join(folder, 'crop.png'), image);
      await writeFile(join(folder, 'frame.png'), image);
      return {
        statistics: { total_detections: 1, recognition_state: 'not_requested' },
        appearances: [
          {
            source_track_id: null,
            first_frame: null,
            last_frame: null,
            start_seconds: null,
            end_seconds: null,
            machine_text: null,
            machine_status: 'not_run',
            agreement_count: 0,
            detections: [
              {
                selected_order: 1,
                frame_index: null,
                timestamp_seconds: null,
                timestamp_source: 'still_image',
                bbox: [0, 0, 8, 4],
                crop_bbox: [0, 0, 8, 4],
                detection_score: null,
                crop_storage_key: `recognition/${jobId}/crop.png`,
                frame_storage_key: `recognition/${jobId}/frame.png`,
                crop_width: 8,
                crop_height: 4,
                predictions: [],
              },
            ],
          },
        ],
      };
    });
    const results = (
      await api
        .get(`${response.body.status_url}/results`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body;
    assert.equal(results.total, 1);
    const resultId = results.items[0].id;
    const detail = (
      await api
        .get(`/api/v2/recognition-results/${resultId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body;
    assert.equal(detail.machine_status, 'not_run');
    assert.equal(detail.machine_text, null);
    assert.deepEqual(detail.detections[0].predictions, []);
    await api
      .post(`/api/v2/recognition-results/${resultId}/reviews`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ action: 'confirm', expected_revision: 0 })
      .expect(422);
    await api
      .post(`/api/v2/recognition-results/${resultId}/reviews`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ action: 'correct', corrected_text: ' abc-1d23 ', expected_revision: 0 })
      .expect(201);
    const found = await api
      .get('/api/v2/recognition-results')
      .query({ media_id: mediaId, plate: 'ABC1D23' })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    assert.equal(found.body.total, 1);
    assert.equal(found.body.items[0].machine_status, 'not_run');
    const csv = await api
      .get(`${response.body.status_url}/export?format=csv`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    assert.ok(csv.text.includes('ABC1D23'));
    assert.ok(csv.text.includes('not_run'));
  } finally {
    registry.resolve = original;
  }
});

test('owner restrictions cover search, details, crops, source, reviews, exports and deletion; admin can inspect', async () => {
  const item = await completed();
  const paths = [
    `/api/v2/recognition-jobs/${item.jobId}`,
    `/api/v2/recognition-jobs/${item.jobId}/results`,
    `/api/v2/recognition-results/${item.resultId}`,
    `/api/v2/detections/${item.detectionId}/artifacts/crop`,
    `/api/v2/detections/${item.detectionId}/artifacts/frame`,
    `/api/v2/media/${item.mediaId}/content`,
    `/api/v2/recognition-jobs/${item.jobId}/export?format=csv`,
  ];
  for (const path of paths) {
    await api.get(path).set('Authorization', `Bearer ${strangerToken}`).expect(404);
    await api.get(path).set('Authorization', `Bearer ${adminToken}`).expect(200);
  }
  await api
    .post(`/api/v2/recognition-results/${item.resultId}/reviews`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .send({ action: 'confirm', expected_revision: 0 })
    .expect(404);
  await api
    .delete(`/api/v2/recognition-jobs/${item.jobId}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(404);
  await api
    .delete(`/api/v2/media/${item.mediaId}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(404);
  const search = await api
    .get(`/api/v2/recognition-results?media_id=${item.mediaId}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(200);
  assert.equal(search.body.total, 0);
  const detail = await api
    .get(`/api/v2/recognition-results/${item.resultId}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(detail.body.detections[0].predictions[0].raw_text, 'ABC1D23');
  assert.ok(!JSON.stringify(detail.body).includes('storage_key'));
  await fixture.database.query('UPDATE plate_detections SET crop_storage_key=$2 WHERE id=$1', [
    item.detectionId,
    '../.env',
  ]);
  await api
    .get(`/api/v2/detections/${item.detectionId}/artifacts/crop`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(404);
});

test('concurrent reviews commit exactly one revision, preserve machine output and update exact normalized lookup', async () => {
  const item = await completed();
  const path = `/api/v2/recognition-results/${item.resultId}/reviews`;
  const responses = await Promise.all(
    ['XYZ-9A88', 'XYZ-9A89'].map((corrected_text) =>
      api
        .post(path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ action: 'correct', corrected_text, expected_revision: 0 }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const accepted = responses.find((r) => r.status === 201)!;
  const detail = (
    await api
      .get(`/api/v2/recognition-results/${item.resultId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
  ).body;
  assert.equal(detail.revision, 1);
  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.machine_text, 'ABC1D23');
  assert.equal(detail.detections[0].predictions[0].raw_text, 'ABC1D23');
  assert.equal(detail.effective_text, accepted.body.corrected_text);
  const query = await api
    .get('/api/v2/recognition-results')
    .query({ media_id: item.mediaId, plate: ` ${detail.effective_text.toLowerCase()} ` })
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(query.body.total, 1);
  assert.equal(
    (
      await api
        .get('/api/v2/recognition-results')
        .query({ media_id: item.mediaId, plate: 'ABC1D23' })
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.total,
    0,
  );
  await api
    .post(path)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'unreadable', expected_revision: 1 })
    .expect(201);
  const latest = (
    await api
      .get(`/api/v2/recognition-results/${item.resultId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
  ).body;
  assert.equal(latest.effective_text, null);
  assert.equal(latest.machine_text, 'ABC1D23');
  assert.equal(latest.reviews.length, 2);
});

test('search selects latest succeeded recognition run, ignores failed/running/detect-only runs, retains old detail', async () => {
  const mediaId = await media();
  const earlier = await completed({ mediaId, text: 'OLD1234', created: '2026-10-08T00:00:00Z' });
  const current = await completed({ mediaId, text: 'NEW1234', created: '2026-10-08T01:00:00Z' });
  await completed({ mediaId, kind: 'detect_only', created: '2026-10-08T02:00:00Z' });
  for (const status of ['failed', 'running'])
    await fixture.database.query(
      `INSERT INTO recognition_jobs(id,media_id,status,created_at) VALUES($1,$2,$3,'2026-10-08T03:00:00Z')`,
      [newId(), mediaId, status],
    );
  const result = await api
    .get('/api/v2/recognition-results')
    .query({ media_id: mediaId })
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.items[0].id, current.resultId);
  assert.equal(
    (
      await api
        .get(`/api/v2/recognition-results/${earlier.resultId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200)
    ).body.machine_text,
    'OLD1234',
  );
  await fixture.database.query(
    "UPDATE recognition_jobs SET status='failed' WHERE media_id=$1 AND status='running'",
    [mediaId],
  );
});

test('CSV retains machine and human values, escapes quotes and spreadsheet formulas', async () => {
  const item = await completed({ track: '=HYPERLINK("malicious")' });
  await api
    .post(`/api/v2/recognition-results/${item.resultId}/reviews`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'correct', corrected_text: 'XYZ9999', expected_revision: 0 })
    .expect(201);
  const response = await api
    .get(`/api/v2/recognition-jobs/${item.jobId}/export?format=csv`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /attachment/);
  assert.ok(response.text.includes('machine_text'));
  assert.ok(response.text.includes('effective_text'));
  assert.ok(response.text.includes('ABC1D23'));
  assert.ok(response.text.includes('XYZ9999'));
  assert.ok(response.text.includes("'="));
  assert.ok(response.text.includes('""malicious""'));
});

test('worker marks invalid manifest failed and never publishes partial result rows', async () => {
  const mediaId = await media();
  const jobId = newId();
  await fixture.database.query('INSERT INTO recognition_jobs(id,media_id) VALUES($1,$2)', [
    jobId,
    mediaId,
  ]);
  assert.equal(
    await processOne(fixture.database, workerOptions(), async () => ({
      statistics: {},
      appearances: [{ detections: [] }],
    })),
    true,
  );
  const response = await api
    .get(`/api/v2/recognition-jobs/${jobId}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(response.body.status, 'failed');
  assert.equal(response.body.error_code, 'RESULT_INVALID');
  assert.equal(
    (await fixture.database.query('SELECT id FROM plate_appearances WHERE job_id=$1', [jobId]))
      .rowCount,
    0,
  );
  await api
    .get(`/api/v2/recognition-jobs/${jobId}/results`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(409);
  assert.ok(
    (await readFile(join(mediaRoot, 'recognition', jobId, 'worker.log'), 'utf8')).includes(
      'Appearance has no evidence',
    ),
  );
});

test('public health and OpenAPI are usable while invalid query/body values return client errors', async () => {
  await api.get('/health').expect(200);
  await api.get('/health/ready').expect(200);
  const docs = await api.get('/docs-json').expect(200);
  assert.ok(docs.body.paths['/api/v2/recognition-jobs']);
  await api
    .get('/api/v2/recognition-results?limit=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(422);
  await api
    .get('/api/v2/recognition-results?plate=%20-%20')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(422);
  await api
    .get('/api/v2/recognition-results')
    .query({ uploaded_from: '2026-10-09T00:00:00Z', uploaded_to: '2026-10-08T00:00:00Z' })
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(422);
  await api
    .post('/api/v2/recognition-jobs')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ media_id: 'x', pipeline_id: 'x', checkpoint: '/tmp/model' })
    .expect(422);
});

test('admin-created accounts normalize unique email, hide hashes, and apply current roles to existing sessions', async () => {
  const email = `${newId()}@example.test`;
  const create = await api
    .post('/api/v2/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      email: ` ${email.toUpperCase()} `,
      password: 'new-account-password',
      display_name: ' Test Account ',
    })
    .expect(201);
  assert.equal(create.body.email, email);
  assert.equal(create.body.display_name, 'Test Account');
  assert.equal(create.body.role, 'user');
  assert.ok(!('password_hash' in create.body));
  await api
    .post('/api/v2/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: email.toUpperCase(), password: 'another-password', display_name: 'Duplicate' })
    .expect(409);
  await api
    .post('/api/v2/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: `${newId()}@example.test`, password: 'short', display_name: 'Invalid' })
    .expect(422);
  const token = await login({ email, password: 'new-account-password' });
  await api.get('/api/v2/users').set('Authorization', `Bearer ${token}`).expect(403);
  await api
    .patch(`/api/v2/users/${create.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'admin' })
    .expect(200);
  const page = await api
    .get('/api/v2/users?limit=1&offset=0')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.equal(page.body.items.length, 1);
  assert.ok(page.body.total >= 4);
  assert.ok(!JSON.stringify(page.body).includes('password_hash'));
  await api
    .patch(`/api/v2/users/${create.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'user' })
    .expect(200);
  await api.get('/api/v2/users').set('Authorization', `Bearer ${token}`).expect(403);
  await fixture.database.query(
    "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [create.body.id],
  );
  await api.get('/api/v2/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
});

test('missing models report pipeline not ready and do not create a queued job', async () => {
  const config = join(fixture.root, 'pipelines-unready.json');
  await writeFile(
    config,
    JSON.stringify({
      pipelines: [
        {
          id: 'missing-model',
          version: 'v1',
          detector: { checkpoint: join(fixture.root, 'missing-detector.pt'), version: 'v1' },
        },
      ],
    }),
  );
  process.env.PLATE_PIPELINES_CONFIG = config;
  try {
    const profiles = await api
      .get('/api/v2/pipelines')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    assert.equal(profiles.body.items[0].id, 'missing-model');
    assert.equal(profiles.body.items[0].ready, false);
    assert.equal(typeof profiles.body.items[0].unavailable_reason, 'string');
    const mediaId = await media();
    await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: mediaId, pipeline_id: 'missing-model' })
      .expect(503);
    assert.equal(
      (await fixture.database.query('SELECT id FROM recognition_jobs WHERE media_id=$1', [mediaId]))
        .rowCount,
      0,
    );
  } finally {
    delete process.env.PLATE_PIPELINES_CONFIG;
  }
});

test('reviews validate actions and revisions, reject ambiguous confirmation, and retain rejection history', async () => {
  const readable = await completed();
  await api
    .post(`/api/v2/recognition-results/${readable.resultId}/reviews`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'confirm', expected_revision: 0 })
    .expect(201);
  const confirmed = (
    await api
      .get(`/api/v2/recognition-results/${readable.resultId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
  ).body;
  assert.equal(confirmed.effective_text, 'ABC1D23');
  assert.equal(confirmed.review_status, 'confirmed');
  assert.equal(confirmed.reviews[0].action, 'confirm');
  const item = await completed();
  const path = `/api/v2/recognition-results/${item.resultId}/reviews`;
  for (const body of [
    { action: 'correct', expected_revision: 0 },
    { action: 'confirm', corrected_text: 'ABC1234', expected_revision: 0 },
    { action: 'correct', corrected_text: ' - ', expected_revision: 0 },
    { action: 'reject', expected_revision: -1 },
    { action: 'reject', expected_revision: 0.5 },
  ])
    await api.post(path).set('Authorization', `Bearer ${ownerToken}`).send(body).expect(422);
  await fixture.database.query(
    "UPDATE plate_appearances SET machine_text=NULL,effective_text=NULL,machine_status='ambiguous',agreement_count=2 WHERE id=$1",
    [item.resultId],
  );
  await api
    .post(path)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'confirm', expected_revision: 0 })
    .expect(422);
  assert.equal(
    (
      await fixture.database.query('SELECT id FROM recognition_reviews WHERE appearance_id=$1', [
        item.resultId,
      ])
    ).rowCount,
    0,
  );
  await api
    .post(path)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'correct', corrected_text: ' oO-001 a ', expected_revision: 0 })
    .expect(201);
  const corrected = (
    await api
      .get(`/api/v2/recognition-results/${item.resultId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
  ).body;
  assert.equal(corrected.effective_text, 'OO001A');
  await api
    .post(path)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'reject', expected_revision: 1, note: 'Track joined different plates' })
    .expect(201);
  const rejected = (
    await api
      .get(`/api/v2/recognition-results/${item.resultId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200)
  ).body;
  assert.equal(rejected.review_status, 'rejected');
  assert.equal(rejected.effective_text, null);
  assert.equal(rejected.revision, 2);
  assert.equal(rejected.reviews[0].corrected_text, 'OO001A');
  assert.equal(rejected.reviews[1].action, 'reject');
  assert.equal(rejected.detections[0].predictions[0].raw_text, 'ABC1D23');
});

test('plate_crop is image-only and readiness distinguishes database availability from liveness', async () => {
  const mediaId = await media();
  await fixture.database.query(
    "UPDATE media_assets SET media_type='video',mime_type='video/mp4' WHERE id=$1",
    [mediaId],
  );
  const registry = app.get(PipelineRegistry);
  const original = registry.resolve;
  registry.resolve = async () => ({ id: 'fixture', version: 'v1' });
  try {
    await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: mediaId, pipeline_id: 'fixture', input_mode: 'plate_crop' })
      .expect(422);
    assert.equal(
      (await fixture.database.query('SELECT id FROM recognition_jobs WHERE media_id=$1', [mediaId]))
        .rowCount,
      0,
    );
  } finally {
    registry.resolve = original;
  }
  const database = app.get(Database);
  const originalQuery = database.query;
  database.query = async () => {
    throw new Error('test-only unavailable database');
  };
  try {
    await api.get('/health').expect(200);
    const ready = await api.get('/health/ready').expect(503);
    assert.ok(!JSON.stringify(ready.body).includes('test-only'));
  } finally {
    database.query = originalQuery;
  }
  await api.get('/health/ready').expect(200);
});

test('readiness rejects a missing or changed OCR migration while liveness stays available', async () => {
  const migration = (
    await fixture.database.query('SELECT * FROM schema_migrations WHERE version=$1', [
      '0002_joint_ocr.sql',
    ])
  ).rows[0];
  assert.ok(migration);
  try {
    await fixture.database.query('DELETE FROM schema_migrations WHERE version=$1', [
      migration.version,
    ]);
    await api.get('/health').expect(200);
    const missing = await api.get('/health/ready').expect(503);
    assert.ok(!JSON.stringify(missing.body).includes('0002_joint_ocr'));
    await fixture.database.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      migration.version,
      '0'.repeat(64),
    ]);
    await api.get('/health/ready').expect(503);
  } finally {
    await fixture.database.query(
      `INSERT INTO schema_migrations(version,checksum,applied_at) VALUES($1,$2,$3)
       ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum,applied_at=excluded.applied_at`,
      [migration.version, migration.checksum, migration.applied_at],
    );
  }
  await api.get('/health/ready').expect(200);
});

test('successful no-plate rerun has empty results and supersedes older detections in default lookup', async () => {
  const earlier = await completed({ created: '2026-10-08T00:00:00Z' });
  const jobId = newId();
  await fixture.database.query(
    `INSERT INTO recognition_jobs(id,media_id,job_kind,status,stage,created_at,statistics)
    VALUES($1,$2,'recognize','succeeded','complete','2026-10-08T01:00:00Z','{"appearances":0}'::jsonb)`,
    [jobId, earlier.mediaId],
  );
  const results = await api
    .get(`/api/v2/recognition-jobs/${jobId}/results`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(results.body.total, 0);
  assert.deepEqual(results.body.items, []);
  const search = await api
    .get('/api/v2/recognition-results')
    .query({ media_id: earlier.mediaId })
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(search.body.total, 0);
  await api
    .get(`/api/v2/recognition-results/${earlier.resultId}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
});
