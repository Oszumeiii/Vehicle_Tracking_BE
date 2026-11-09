import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { trustProxy } from '../src/common/config';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines } from './live-fixtures';

test('PLATE_TRUST_PROXY is off by default, takes hops or subnets and refuses true', () => {
  for (const off of [undefined, '', ' ', 'false', '0']) assert.equal(trustProxy(off), false);
  assert.equal(trustProxy('2'), 2);
  assert.deepEqual(trustProxy('loopback, uniquelocal'), ['loopback', 'uniquelocal']);
  assert.deepEqual(trustProxy('10.0.0.0/8'), ['10.0.0.0/8']);
  assert.throws(() => trustProxy('true'), /PLATE_TRUST_PROXY/);
});

let fixture: TestDatabase;
let app: INestApplication;
const oldEnvironment = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'PLATE_DATA_DIR',
  'PLATE_PIPELINE_PYTHON',
  'PLATE_PIPELINES_CONFIG',
  'PLATE_TRUST_PROXY',
  'NODE_ENV',
];

before(async () => {
  fixture = await startTestDatabase();
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: join(fixture.root, 'artifacts'),
    PLATE_PIPELINE_PYTHON: process.execPath,
    PLATE_PIPELINES_CONFIG: await livePipelines(fixture.root),
    // supertest connects from 127.0.0.1, which stands in for the reverse proxy here.
    PLATE_TRUST_PROXY: 'loopback',
    NODE_ENV: 'test',
  });
  app = await createApp();
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
  for (const key of ENV_KEYS) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

test('behind a trusted proxy the audit log and sign-in throttle see the client address', async () => {
  const user = await seedUser(fixture.database, 'user');
  const api = request(app.getHttpServer());
  await api
    .post('/api/v2/auth/login')
    .set('X-Forwarded-For', '203.0.113.7')
    .send({ email: user.email, password: 'wrong-password-123' })
    .expect(401);
  const row = (
    await fixture.database.query(
      `SELECT ip FROM audit_log WHERE action='auth.login_failed' ORDER BY id DESC LIMIT 1`,
    )
  ).rows[0];
  assert.equal(row.ip, '203.0.113.7');
});
