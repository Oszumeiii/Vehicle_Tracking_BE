import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { migrate } from '../src/database/migrate';
import { verifyPassword } from '../src/auth/security';
import { newId, seedUser, startTestDatabase, TestDatabase } from './helpers';

let fixture: TestDatabase;
before(async () => {
  fixture = await startTestDatabase();
});
after(async () => {
  if (fixture) await fixture.dispose();
});

test('PostgreSQL schema preserves UTC instants, source restrictions and derived cascades', async () => {
  const db = fixture.database;
  const owner = await seedUser(db);
  const mediaId = newId();
  const jobId = newId();
  const appearanceId = newId();
  const detectionId = newId();
  await db.query(
    `INSERT INTO media_assets (id, owner_id, original_name, media_type, storage_key, mime_type, size_bytes, sha256, uploaded_at)
    VALUES ($1,$2,'input.jpg','image',$3,'image/jpeg',42,$4,'2026-10-08T07:00:00+07:00')`,
    [mediaId, owner.id, `media/${mediaId}/input.jpg`, 'a'.repeat(64)],
  );
  await db.query("INSERT INTO recognition_jobs (id,media_id,status) VALUES ($1,$2,'succeeded')", [
    jobId,
    mediaId,
  ]);
  await db.query('INSERT INTO plate_appearances (id,job_id) VALUES ($1,$2)', [appearanceId, jobId]);
  await db.query(
    'INSERT INTO plate_detections (id,appearance_id,crop_storage_key) VALUES ($1,$2,$3)',
    [detectionId, appearanceId, `recognition/${jobId}/a.jpg`],
  );
  await db.query(
    'INSERT INTO ocr_predictions (id,detection_id,input_storage_key) VALUES ($1,$2,$3)',
    [newId(), detectionId, `recognition/${jobId}/a.jpg`],
  );
  await db.query(
    "INSERT INTO recognition_reviews (id,appearance_id,reviewer_id,action,revision) VALUES ($1,$2,$3,'reject',1)",
    [newId(), appearanceId, owner.id],
  );
  assert.equal(
    (
      await db.query('SELECT uploaded_at FROM media_assets WHERE id=$1', [mediaId])
    ).rows[0].uploaded_at.toISOString(),
    '2026-10-08T00:00:00.000Z',
  );
  await assert.rejects(db.query('DELETE FROM media_assets WHERE id=$1', [mediaId]), (error: any) =>
    ['23503', '23001'].includes(error.code),
  );
  await assert.rejects(
    db.query(
      "INSERT INTO recognition_reviews (id,appearance_id,reviewer_id,action,revision) VALUES ($1,$2,$3,'reject',1)",
      [newId(), appearanceId, owner.id],
    ),
    { code: '23505' },
  );
  await assert.rejects(
    db.query("UPDATE recognition_jobs SET status='anything' WHERE id=$1", [jobId]),
    { code: '23514' },
  );
  await db.query('DELETE FROM recognition_jobs WHERE id=$1', [jobId]);
  assert.equal((await db.query('SELECT id FROM media_assets WHERE id=$1', [mediaId])).rowCount, 1);
  assert.equal(
    (await db.query('SELECT id FROM plate_appearances WHERE id=$1', [appearanceId])).rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT id FROM plate_detections WHERE id=$1', [detectionId])).rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT id FROM ocr_predictions WHERE detection_id=$1', [detectionId]))
      .rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT id FROM recognition_reviews WHERE appearance_id=$1', [appearanceId]))
      .rowCount,
    0,
  );
});

test('Database transaction rolls back all changes and returns the connection to its pool', async () => {
  const userId = newId();
  await assert.rejects(
    fixture.database.transaction(async (client) => {
      await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [
        userId,
        `${userId}@example.test`,
        'unused',
      ]);
      throw new Error('abort transaction');
    }),
    /abort transaction/,
  );
  assert.equal(
    (await fixture.database.query('SELECT id FROM users WHERE id=$1', [userId])).rowCount,
    0,
  );
  assert.equal(
    await fixture.database.transaction(
      async (client) => (await client.query('SELECT 42 AS answer')).rows[0].answer,
    ),
    42,
  );
});

test('Administrative CLI creates a usable normalized account and rejects duplicate bootstrap', async () => {
  const email = `${newId()}@example.test`;
  const password = 'cli-test-password-123';
  const args = [
    resolve(__dirname, '../src/cli.js'),
    'create-admin',
    '--email',
    ` ${email.toUpperCase()} `,
  ];
  const options = {
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: fixture.url, PLATE_ADMIN_PASSWORD: password },
  };
  const result = await promisify(execFile)(process.execPath, args, options);
  assert.match(result.stdout, /Administrator created/);
  assert.ok(!result.stdout.includes(password));
  const user = (await fixture.database.query('SELECT * FROM users WHERE email=$1', [email]))
    .rows[0];
  assert.equal(user.role, 'admin');
  assert.equal(user.is_active, true);
  assert.equal(await verifyPassword(password, user.password_hash), true);
  await assert.rejects(
    promisify(execFile)(process.execPath, args, options),
    /An account with that email already exists/,
  );
});

test('SQL migration is idempotent and rejects changes to an applied migration', async () => {
  assert.deepEqual(await migrate(fixture.database), []);
  const destination = join(fixture.root, 'changed-migrations');
  await cp(resolve('src/database/migrations'), destination, { recursive: true });
  const filename = join(destination, '0001_business.sql');
  await writeFile(filename, `${await readFile(filename, 'utf8')}\n-- changed after deployment\n`);
  await assert.rejects(migrate(fixture.database, destination), /has changed/);
  assert.equal(
    (await fixture.database.query('SELECT version FROM schema_migrations')).rows.length,
    3,
  );
});
