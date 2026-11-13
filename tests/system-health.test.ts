import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { recordEvent } from '../src/live/sessions';
import { WORKER_LOCK } from '../src/system/health.controller';
import { newId, seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines } from './live-fixtures';

let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let dataDir: string;
const tokens = {} as Record<'admin' | 'user', string>;
const ids = {} as Record<'admin' | 'user', string>;
const oldEnvironment = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'PLATE_DATA_DIR',
  'PLATE_PIPELINE_PYTHON',
  'PLATE_PIPELINES_CONFIG',
  'PLATE_BACKUP_HOURS',
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
  delete process.env.PLATE_BACKUP_HOURS;
  app = await createApp();
  api = request(app.getHttpServer());
  for (const role of ['admin', 'user'] as const) {
    const user = await seedUser(fixture.database, role);
    const login = await api
      .post('/api/v2/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    tokens[role] = login.body.access_token;
    ids[role] = user.id;
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

async function health() {
  const token = tokens.admin;
  return (
    await api.get('/api/v2/system/health').set('Authorization', `Bearer ${token}`).expect(200)
  ).body;
}
const codes = (body: any) => body.issues.map((issue: any) => issue.code).sort();

test('system health reports a missing worker and missing or stale backups to administrators only', async () => {
  await api.get('/api/v2/system/health').expect(401);
  await api.get('/api/v2/system/health').set('Authorization', `Bearer ${tokens.user}`).expect(403);

  const first = await health();
  assert.equal(first.ok, false);
  assert.equal(first.worker_running, false);
  assert.equal(first.last_backup_at, null);
  assert.deepEqual(codes(first), ['BACKUP_OVERDUE', 'WORKER_DOWN']);
  assert.ok(first.issues.every((issue: any) => ['error', 'warning'].includes(issue.severity)));

  // A worker is whoever holds the advisory lock (src/worker.ts).
  const worker = await fixture.database.pool.connect();
  try {
    await worker.query('SELECT pg_advisory_lock($1)', [WORKER_LOCK]);
    const backups = join(dataDir, 'backups');
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, 'plate-new.dump'), 'dump');
    await writeFile(join(backups, 'plate-empty.dump.part'), 'ignored');
    const fine = await health();
    assert.equal(fine.worker_running, true);
    assert.deepEqual(fine.issues, []);
    assert.equal(fine.ok, true);
    assert.ok(Date.now() - new Date(fine.last_backup_at).getTime() < 60_000);

    // Two periods without a backup (default: 24 hours each).
    const old = new Date(Date.now() - 49 * 3600_000);
    await utimes(join(backups, 'plate-new.dump'), old, old);
    const stale = await health();
    assert.deepEqual(codes(stale), ['BACKUP_OVERDUE']);
    assert.equal(stale.issues[0].severity, 'warning');
    assert.equal(stale.issues[0].since, stale.last_backup_at);
    process.env.PLATE_BACKUP_HOURS = '0'; // Backups are made elsewhere.
    assert.deepEqual((await health()).issues, []);
    delete process.env.PLATE_BACKUP_HOURS;
    await writeFile(join(backups, 'plate-newer.dump'), 'dump');
  } finally {
    await worker.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]);
    worker.release();
  }
  assert.deepEqual(codes(await health()), ['WORKER_DOWN']);
});

test('system health reports always-on cameras that stay down and jobs that wait too long', async () => {
  const sourceId = newId();
  await fixture.database.query(
    `INSERT INTO stream_sources(id,owner_id,name,source_type,url,always_on,auto_settings)
    VALUES($1,$2,'Cổng chính','youtube','https://www.youtube.com/watch?v=5Xl6pSgiy3A',true,$3)`,
    [sourceId, ids.admin, JSON.stringify({ pipeline_id: 'joint' })],
  );
  const cameraIssue = async () =>
    (await health()).issues.find((issue: any) => issue.code === 'CAMERA_DOWN');
  // Just switched on: the worker needs a moment to queue the first session.
  assert.equal(await cameraIssue(), undefined);
  await fixture.database.query(
    `UPDATE stream_sources SET updated_at=now() - interval '10 minutes' WHERE id=$1`,
    [sourceId],
  );
  assert.deepEqual(await cameraIssue(), {
    code: 'CAMERA_DOWN',
    severity: 'error',
    subject: 'Cổng chính',
    detail: null,
    since: null,
  });

  const sessionId = newId();
  await fixture.database.query(
    `INSERT INTO live_sessions(id,stream_source_id,requested_by,pipeline_snapshot,status,finished_at,error_code)
    VALUES($1,$2,$3,'{}','interrupted',now() - interval '1 minute','WORKER_INTERRUPTED')`,
    [sessionId, sourceId, ids.admin],
  );
  assert.equal(await cameraIssue(), undefined); // Ended a minute ago: restarting.
  await fixture.database.query(
    `UPDATE live_sessions SET finished_at=now() - interval '2 hours' WHERE id=$1`,
    [sessionId],
  );
  assert.equal((await cameraIssue()).detail, 'WORKER_INTERRUPTED');
  await recordEvent(fixture.database, sessionId, 'error', {
    code: 'AUTO_RESTART_FAILED',
    message: 'Unknown pipeline',
  });
  const down = await cameraIssue();
  assert.equal(down.detail, 'Unknown pipeline');
  assert.ok(Date.now() - new Date(down.since).getTime() > 7_000_000);

  await fixture.database.query(
    `INSERT INTO live_sessions(id,stream_source_id,requested_by,pipeline_snapshot,status)
    VALUES($1,$2,$3,'{}','running')`,
    [newId(), sourceId, ids.admin],
  );
  assert.equal(await cameraIssue(), undefined);

  const mediaId = newId();
  await fixture.database.query(
    `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,width,height)
    VALUES($1,$2,'a.mp4','video',$3,'video/mp4',1,$4,10,10)`,
    [mediaId, ids.admin, `media/${mediaId}/a.mp4`, 'a'.repeat(64)],
  );
  await fixture.database.query('INSERT INTO recognition_jobs(id,media_id) VALUES($1,$2)', [
    newId(),
    mediaId,
  ]);
  const waiting = async () =>
    (await health()).issues.find((issue: any) => issue.code === 'JOBS_WAITING');
  assert.equal(await waiting(), undefined);
  await fixture.database.query(
    `UPDATE recognition_jobs SET created_at=now() - interval '45 minutes' WHERE media_id=$1`,
    [mediaId],
  );
  const queued = await waiting();
  assert.equal(queued.severity, 'warning');
  assert.match(queued.detail, /^1 job\(s\) queued for more than 30 minutes/);
});

test('system health reports pipelines whose model is missing', async () => {
  const previous = process.env.PLATE_PIPELINES_CONFIG;
  const config = join(fixture.root, 'broken-pipelines.json');
  await writeFile(
    config,
    JSON.stringify({
      pipelines: [
        {
          id: 'missing-model',
          name: 'Thiếu model',
          version: 'v1',
          detector: { checkpoint: join(fixture.root, 'missing.pt'), version: 'v1' },
        },
      ],
    }),
  );
  process.env.PLATE_PIPELINES_CONFIG = config;
  try {
    // A fresh application: pipeline readiness is cached for five minutes.
    const other = await createApp();
    try {
      const body = (
        await request(other.getHttpServer())
          .get('/api/v2/system/health')
          .set('Authorization', `Bearer ${tokens.admin}`)
          .expect(200)
      ).body;
      const issue = body.issues.find((item: any) => item.code === 'PIPELINE_UNAVAILABLE');
      assert.equal(issue.subject, 'Thiếu model');
      assert.equal(issue.severity, 'error');
      assert.equal(typeof issue.detail, 'string');
    } finally {
      await other.close();
    }
  } finally {
    process.env.PLATE_PIPELINES_CONFIG = previous;
  }
});
