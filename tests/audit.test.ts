import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { Retention } from '../src/live/retention';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
const users = {} as Record<
  'admin' | 'user',
  { id: string; email: string; password: string; token: string }
>;
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
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: join(fixture.root, 'artifacts'),
    PLATE_PIPELINE_PYTHON: process.execPath,
    PLATE_PIPELINES_CONFIG: await livePipelines(fixture.root),
    NODE_ENV: 'test',
  });
  app = await createApp();
  api = request(app.getHttpServer());
  for (const role of ['admin', 'user'] as const) {
    const user = await seedUser(fixture.database, role);
    const login = await api
      .post('/api/v2/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    users[role] = { ...user, token: login.body.access_token };
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
const actions = async (userId: string) =>
  (
    await db().query('SELECT action FROM audit_log WHERE user_id=$1 ORDER BY id', [userId])
  ).rows.map((row) => row.action);

test('sign-ins, plate searches, journeys and changes are recorded without secrets', async () => {
  const user = users.user;
  // A wrong password is recorded against the account, with the reason.
  await api
    .post('/api/v2/auth/login')
    .send({ email: user.email, password: 'wrong-password-123' })
    .expect(401);
  await api
    .post('/api/v2/auth/login')
    .send({ email: 'nobody@example.test', password: 'wrong-password-123' })
    .expect(401);

  await api
    .get('/api/v2/recognition-results')
    .query({ plate: '43A-123.45', match: 'fuzzy' })
    .set(as('user'))
    .expect(200);
  // Browsing without a plate is not a search worth recording.
  await api.get('/api/v2/recognition-results').set(as('user')).expect(200);
  await api.get('/api/v2/plates/43A12345/journey').set(as('user')).expect(200);
  const camera = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('user'))
      .send({ name: 'audited', url: URL })
      .expect(201)
  ).body;
  await api
    .patch(`/api/v2/stream-sources/${camera.id}`)
    .set(as('user'))
    .send({ location: { latitude: 16.06, longitude: 108.22 } })
    .expect(200);
  await api.delete(`/api/v2/stream-sources/${camera.id}`).set(as('user')).expect(204);
  const entry = (
    await api.post('/api/v2/watchlist').set(as('user')).send({ plate: '43A-999.99' }).expect(201)
  ).body;
  await api.delete(`/api/v2/watchlist/${entry.id}`).set(as('user')).expect(204);

  assert.deepEqual(await actions(user.id), [
    'auth.login',
    'auth.login_failed',
    'results.search',
    'journey.view',
    'camera.create',
    'camera.update',
    'camera.delete',
    'watchlist.add',
    'watchlist.delete',
  ]);
  const rows = (
    await db().query('SELECT * FROM audit_log WHERE user_id=$1 OR user_id IS NULL ORDER BY id', [
      user.id,
    ])
  ).rows;
  const of = (action: string) => rows.filter((row) => row.action === action);
  assert.deepEqual(of('auth.login_failed')[0].details, { email: user.email, reason: 'invalid' });
  // An unknown email has no user, but the attempt is kept.
  assert.ok(of('auth.login_failed').some((row) => row.user_id === null));
  assert.deepEqual(of('results.search')[0].details, { plate: '43A12345', match: 'fuzzy' });
  assert.deepEqual(of('journey.view')[0].details, {
    plate: '43A12345',
    match: 'exact',
    sightings: 0,
  });
  assert.deepEqual(of('camera.update')[0].details, { name: 'audited', changed: ['location'] });
  assert.equal(of('camera.delete')[0].target_id, camera.id);
  assert.deepEqual(of('watchlist.delete')[0].details, { plate: '43A99999' });
  assert.ok(rows.every((row) => row.ip));
  const everything = JSON.stringify(rows);
  assert.ok(!everything.includes(user.password) && !everything.includes('wrong-password-123'));
  assert.ok(!everything.includes(user.token));
});

test('administrator changes to accounts are recorded by field name, never the password', async () => {
  const created = (
    await api
      .post('/api/v2/users')
      .set(as('admin'))
      .send({
        email: 'audited@example.test',
        password: 'new-account-password-1',
        display_name: 'Audited',
      })
      .expect(201)
  ).body;
  await api
    .patch(`/api/v2/users/${created.id}`)
    .set(as('admin'))
    .send({ password: 'another-password-12345', is_active: false })
    .expect(200);
  const rows = (
    await db().query(
      "SELECT * FROM audit_log WHERE user_id=$1 AND action LIKE 'user.%' ORDER BY id",
      [users.admin.id],
    )
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.action, row.target_id]),
    [
      ['user.create', created.id],
      ['user.update', created.id],
    ],
  );
  assert.deepEqual(rows[1].details, {
    email: 'audited@example.test',
    changed: ['is_active', 'password'],
    is_active: false,
  });
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('new-account-password-1') && !text.includes('another-password-12345'));
});

test('only administrators read the audit log, filtered by user, action and time', async () => {
  await api.get('/api/v2/audit-logs').set(as('user')).expect(403);
  await api.get('/api/v2/audit-logs').expect(401);
  const all = (await api.get('/api/v2/audit-logs').set(as('admin')).expect(200)).body;
  assert.ok(all.total >= all.items.length && all.items.length > 0);
  const times = all.items.map((item: any) => Date.parse(item.created_at));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  const mine = (
    await api
      .get('/api/v2/audit-logs')
      .query({ user_id: users.user.id, action: 'camera.' })
      .set(as('admin'))
      .expect(200)
  ).body;
  assert.deepEqual(
    mine.items.map((item: any) => item.action),
    ['camera.delete', 'camera.update', 'camera.create'],
  );
  assert.equal(mine.items[0].user_email, users.user.email);
  assert.equal(typeof mine.items[0].id, 'number');
  const exact = (
    await api
      .get('/api/v2/audit-logs')
      .query({ action: 'journey.view' })
      .set(as('admin'))
      .expect(200)
  ).body;
  assert.ok(exact.items.every((item: any) => item.action === 'journey.view'));
  const future = (
    await api
      .get('/api/v2/audit-logs')
      .query({ from: '2999-01-01T00:00:00Z' })
      .set(as('admin'))
      .expect(200)
  ).body;
  assert.equal(future.total, 0);
  await api.get('/api/v2/audit-logs?action=DROP%20TABLE').set(as('admin')).expect(422);
  await api
    .get('/api/v2/audit-logs')
    .query({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
    .set(as('admin'))
    .expect(422);
});

test('retention deletes audit rows older than PLATE_AUDIT_RETENTION_DAYS', async () => {
  await db().query(
    "INSERT INTO audit_log(user_id,action,created_at) VALUES($1,'old.entry',now() - interval '400 days')",
    [users.admin.id],
  );
  const kept = Number((await db().query('SELECT count(*) FROM audit_log')).rows[0].count);
  const swept = await new Retention(db(), workerOptions(), {
    intervalMs: 60_000,
    batch: 50,
  }).sweep();
  assert.equal(swept.audit, 1);
  assert.equal(
    Number((await db().query('SELECT count(*) FROM audit_log')).rows[0].count),
    kept - 1,
  );
});
