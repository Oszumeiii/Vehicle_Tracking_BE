import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/main';
import { PipelineRegistry } from '../src/recognition/registry';
import { newId, seedUser, startTestDatabase, TestDatabase } from './helpers';

let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let owner: Awaited<ReturnType<typeof seedUser>>;
let ownerToken: string;
let strangerToken: string;
const oldEnvironment = { ...process.env };

before(async () => {
  fixture = await startTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.PLATE_DATA_DIR = join(fixture.root, 'artifacts');
  process.env.NODE_ENV = 'test';
  app = await createApp();
  api = request(app.getHttpServer());
  owner = await seedUser(fixture.database);
  const stranger = await seedUser(fixture.database);
  for (const user of [owner, stranger]) {
    const response = await api
      .post('/api/v2/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    if (user === owner) ownerToken = response.body.access_token;
    else strangerToken = response.body.access_token;
  }
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
  for (const key of ['DATABASE_URL', 'PLATE_DATA_DIR', 'NODE_ENV']) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

async function jointAppearance() {
  const db = fixture.database;
  const mediaId = newId(),
    jobId = newId(),
    appearanceId = newId();
  await db.query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
    VALUES($1,$2,'video.mp4','video',$3,'video/mp4',100,$4)`,
    [mediaId, owner.id, `media/${mediaId}/input.mp4`, 'a'.repeat(64)],
  );
  await db.query(`INSERT INTO recognition_jobs(id,media_id,status) VALUES($1,$2,'succeeded')`, [
    jobId,
    mediaId,
  ]);
  await db.query(
    `INSERT INTO plate_appearances(id,job_id,machine_text,machine_status,effective_text,recognition_method,agreement_count)
    VALUES($1,$2,'ABC1D23','readable','ABC1D23','joint_multiframe',NULL)`,
    [appearanceId, jobId],
  );
  const detections = [];
  for (let i = 0; i < 5; i++) {
    const id = newId(),
      key = `recognition/${jobId}/crop-${i}.jpg`;
    await db.query(
      `INSERT INTO plate_detections(id,appearance_id,selected_order,frame_index,crop_storage_key)
      VALUES($1,$2,$3,$3,$4)`,
      [id, appearanceId, i, key],
    );
    detections.push({ id, key });
  }
  return { mediaId, jobId, appearanceId, detections };
}

test('joint OCR schema enforces one parent and preserves independent prediction rows', async () => {
  const db = fixture.database;
  const value = await jointAppearance();
  const keys = JSON.stringify(value.detections.map((d) => d.key));
  await assert.rejects(
    db.query(`INSERT INTO ocr_predictions(id,input_storage_key) VALUES($1,'unused')`, [newId()]),
    { code: '23514' },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO ocr_predictions(id,detection_id,appearance_id,input_storage_key) VALUES($1,$2,$3,'unused')`,
      [newId(), value.detections[0].id, value.appearanceId],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO ocr_predictions(id,appearance_id,input_storage_keys) VALUES($1,$2,'[]')`,
      [newId(), value.appearanceId],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    db.query(`UPDATE plate_appearances SET agreement_count=5 WHERE id=$1`, [value.appearanceId]),
    { code: '23514' },
  );
  const jointId = newId();
  await db.query(
    `INSERT INTO ocr_predictions(id,appearance_id,input_storage_keys,frame_weights) VALUES($1,$2,$3,$4)`,
    [jointId, value.appearanceId, keys, JSON.stringify([0.1, 0.1, 0.2, 0.3, 0.3])],
  );
  await assert.rejects(
    db.query(`INSERT INTO ocr_predictions(id,appearance_id,input_storage_keys) VALUES($1,$2,$3)`, [
      newId(),
      value.appearanceId,
      keys,
    ]),
    { code: '23505' },
  );
  await assert.rejects(
    db.query(`UPDATE ocr_predictions SET frame_weights='[1,0]' WHERE id=$1`, [jointId]),
    { code: '23514' },
  );
  const independentId = newId();
  await db.query(
    `INSERT INTO ocr_predictions(id,detection_id,input_storage_key) VALUES($1,$2,$3)`,
    [independentId, value.detections[0].id, value.detections[0].key],
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM ocr_predictions WHERE id=ANY($1)', [
        [jointId, independentId],
      ])
    ).rows[0].n,
    2,
  );
  await db.query('DELETE FROM recognition_jobs WHERE id=$1', [value.jobId]);
  assert.equal(
    (await db.query('SELECT id FROM ocr_predictions WHERE id=ANY($1)', [[jointId, independentId]]))
      .rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT id FROM media_assets WHERE id=$1', [value.mediaId])).rowCount,
    1,
  );
});

test('joint result API keeps one ordered prediction, private provenance, immutable review history and CSV semantics', async () => {
  const value = await jointAppearance();
  // Different ordering from detection display order ensures provenance follows
  // the stored model inputs rather than an accidental SELECT row ordering.
  const ordered = [
    value.detections[2],
    value.detections[0],
    value.detections[4],
    value.detections[1],
    value.detections[3],
  ];
  const weights = [0.1, 0.2, 0.3, 0.1, 0.3];
  const decoding = { decoder: 'beam_filter', plate_text: 'abc-1d23', format_valid: true };
  const predictionId = newId();
  await fixture.database.query(
    `INSERT INTO ocr_predictions(id,appearance_id,variant,input_storage_keys,frame_weights,decoding,raw_text,normalized_text,ocr_score,latency_ms)
    VALUES($1,$2,'joint',$3,$4,$5,'abc-1d23','ABC1D23',NULL,12)`,
    [
      predictionId,
      value.appearanceId,
      JSON.stringify(ordered.map((d) => d.key)),
      JSON.stringify(weights),
      JSON.stringify(decoding),
    ],
  );
  const uri = `/api/v2/recognition-results/${value.appearanceId}`;
  await api.get(uri).set('Authorization', `Bearer ${strangerToken}`).expect(404);
  const response = await api.get(uri).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(response.body.recognition_method, 'joint_multiframe');
  assert.equal(response.body.agreement_count, null);
  assert.equal(response.body.predictions.length, 1);
  assert.equal(response.body.predictions[0].appearance_id, value.appearanceId);
  assert.equal(response.body.predictions[0].variant, 'joint');
  assert.equal(response.body.predictions[0].ocr_score, null);
  assert.deepEqual(
    response.body.predictions[0].detection_ids,
    ordered.map((d) => d.id),
  );
  assert.deepEqual(response.body.predictions[0].frame_weights, weights);
  assert.deepEqual(response.body.predictions[0].decoding, decoding);
  assert.ok(response.body.detections.every((d: any) => d.predictions.length === 0));
  const serialized = JSON.stringify(response.body);
  for (const field of [
    'input_storage_key',
    'input_storage_keys',
    'crop_storage_key',
    'frame_storage_key',
  ])
    assert.ok(!serialized.includes(`"${field}"`));
  const beforePrediction = (
    await fixture.database.query('SELECT * FROM ocr_predictions WHERE id=$1', [predictionId])
  ).rows[0];
  await api
    .post(`${uri}/reviews`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'correct', corrected_text: 'xyz-9a87', expected_revision: 0 })
    .expect(201);
  const after = await api.get(uri).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(after.body.machine_text, 'ABC1D23');
  assert.equal(after.body.effective_text, 'XYZ9A87');
  assert.equal(after.body.reviews.length, 1);
  assert.deepEqual(
    (await fixture.database.query('SELECT * FROM ocr_predictions WHERE id=$1', [predictionId]))
      .rows[0],
    beforePrediction,
  );
  const csv = await api
    .get(`/api/v2/recognition-jobs/${value.jobId}/export`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const [header, row] = csv.text
    .trim()
    .replace(/^\ufeff/, '')
    .split('\r\n')
    .map((line: string) => line.split(',').map((cell: string) => cell.slice(1, -1)));
  assert.equal(row[header.indexOf('recognition_method')], 'joint_multiframe');
  assert.equal(row[header.indexOf('agreement_count')], '');
  assert.equal(row[header.indexOf('decoder')], 'beam_filter');
  assert.equal(row[header.indexOf('format_valid')], 'true');
  assert.equal(row[header.indexOf('beam_confidence_proxy')], '');
});

test('joint OCR creation rejects images and cropped-video input before queueing', async () => {
  const video = await jointAppearance();
  const imageId = newId();
  await fixture.database.query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
     VALUES($1,$2,'plate.png','image',$3,'image/png',100,$4)`,
    [imageId, owner.id, `media/${imageId}/input.png`, 'b'.repeat(64)],
  );
  const registry = app.get(PipelineRegistry);
  const original = registry.resolve;
  let resolutions = 0;
  registry.resolve = async () => {
    resolutions++;
    return {
      id: 'joint-test',
      version: 'v1',
      task: 'recognize',
      recognizer: { input_mode: 'five_frame_joint', version: 'test' },
    };
  };
  try {
    await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ media_id: video.mediaId, pipeline_id: 'joint-test' })
      .expect(404);
    assert.equal(resolutions, 0, 'Ownership is checked before resolving the model.');
    for (const input_mode of ['scene', 'plate_crop'])
      await api
        .post('/api/v2/recognition-jobs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ media_id: imageId, pipeline_id: 'joint-test', input_mode })
        .expect(422);
    await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: video.mediaId, pipeline_id: 'joint-test', input_mode: 'plate_crop' })
      .expect(422);
    assert.equal(
      (
        await fixture.database.query(
          "SELECT id FROM recognition_jobs WHERE media_id=ANY($1) AND status='queued'",
          [[video.mediaId, imageId]],
        )
      ).rowCount,
      0,
    );
    const accepted = await api
      .post('/api/v2/recognition-jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ media_id: video.mediaId, pipeline_id: 'joint-test', input_mode: 'scene' })
      .expect(202);
    const job = (
      await fixture.database.query('SELECT * FROM recognition_jobs WHERE id=$1', [
        accepted.body.job_id,
      ])
    ).rows[0];
    assert.equal(job.job_kind, 'recognize');
    assert.equal(job.pipeline_snapshot.recognizer.input_mode, 'five_frame_joint');
  } finally {
    registry.resolve = original;
  }
});

test('joint lookup uses reviewed text from the latest successful run and retains old job history', async () => {
  const value = await jointAppearance();
  await api
    .post(`/api/v2/recognition-results/${value.appearanceId}/reviews`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'correct', corrected_text: 'xyz-9a87', expected_revision: 0 })
    .expect(201);
  const find = (token: string, plate: string) =>
    api
      .get('/api/v2/recognition-results')
      .set('Authorization', `Bearer ${token}`)
      .query({ media_id: value.mediaId, plate });
  assert.equal((await find(ownerToken, 'xyz-9a87').expect(200)).body.total, 1);
  assert.equal((await find(ownerToken, 'ABC1D23').expect(200)).body.total, 0);
  assert.equal((await find(strangerToken, 'XYZ9A87').expect(200)).body.total, 0);
  const newerId = newId();
  await fixture.database.query(
    `INSERT INTO recognition_jobs(id,media_id,status,created_at)
     VALUES($1,$2,'failed',now()+interval '1 second')`,
    [newerId, value.mediaId],
  );
  assert.equal((await find(ownerToken, 'XYZ9A87').expect(200)).body.total, 1);
  await fixture.database.query("UPDATE recognition_jobs SET status='succeeded' WHERE id=$1", [
    newerId,
  ]);
  assert.equal((await find(ownerToken, 'XYZ9A87').expect(200)).body.total, 0);
  const history = await api
    .get(`/api/v2/recognition-jobs/${value.jobId}/results`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(history.body.items[0].effective_text, 'XYZ9A87');
  assert.equal(history.body.items[0].recognition_method, 'joint_multiframe');
});
