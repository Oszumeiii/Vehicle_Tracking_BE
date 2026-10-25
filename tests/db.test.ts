import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { migrate } from '../src/database/migrate';
import { Client } from 'pg';
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

test('live schema keeps jobs on one source, one active session per camera and complete live fields', async () => {
  const db = fixture.database;
  const owner = await seedUser(db);
  const sourceId = newId();
  const sessionId = newId();
  await db.query(
    `INSERT INTO stream_sources (id,owner_id,name,url) VALUES ($1,$2,'cam','https://youtu.be/x')`,
    [sourceId, owner.id],
  );
  const session = (id: string, status = 'queued') =>
    db.query(
      `INSERT INTO live_sessions (id,stream_source_id,requested_by,pipeline_snapshot,status)
      VALUES ($1,$2,$3,'{}',$4)`,
      [id, sourceId, owner.id, status],
    );
  await session(sessionId, 'running');
  await assert.rejects(session(newId()), { code: '23505' });
  await session(newId(), 'stopped');
  await assert.rejects(
    db.query(
      `INSERT INTO stream_sources (id,owner_id,name,url,exclude_zones) VALUES ($1,$2,'c','u','{}')`,
      [newId(), owner.id],
    ),
    { code: '23514' },
  );
  const live = (id: string, key: string) =>
    db.query(
      `INSERT INTO recognition_jobs
      (id,live_session_id,live_track_key,captured_from,captured_to,confidence_status,status)
      VALUES ($1,$2,$3,'2026-10-23T10:00:00Z','2026-10-23T10:00:02Z','readable','succeeded')`,
      [id, sessionId, key],
    );
  const first = newId();
  await live(first, 'e000-t000001');
  await assert.rejects(live(newId(), 'e000-t000001'), { code: '23505' });
  await assert.rejects(db.query('INSERT INTO recognition_jobs (id) VALUES ($1)', [newId()]), {
    code: '23514',
  });
  await assert.rejects(
    db.query('INSERT INTO recognition_jobs (id,live_session_id,live_track_key) VALUES ($1,$2,$3)', [
      newId(),
      sessionId,
      'e000-t000002',
    ]),
    { code: '23514' },
  );
  const second = newId();
  await live(second, 'e000-t000002');
  await db.query('UPDATE recognition_jobs SET duplicate_of_job_id=$1 WHERE id=$2', [first, second]);
  await db.query('DELETE FROM recognition_jobs WHERE id=$1', [first]);
  assert.equal(
    (await db.query('SELECT duplicate_of_job_id FROM recognition_jobs WHERE id=$1', [second]))
      .rows[0].duplicate_of_job_id,
    null,
  );
  await assert.rejects(db.query('DELETE FROM live_sessions WHERE id=$1', [sessionId]), {
    code: '23001',
  });
  await db.query("INSERT INTO live_session_events (session_id,event_type) VALUES ($1,'status')", [
    sessionId,
  ]);
  await assert.rejects(
    db.query("INSERT INTO live_session_events (session_id,event_type) VALUES ($1,'bogus')", [
      sessionId,
    ]),
    { code: '23514' },
  );
});

test('live events notify listeners only after commit and watchlist plates stay normalized', async () => {
  const db = fixture.database;
  const owner = await seedUser(db);
  const sourceId = newId();
  const sessionId = newId();
  await db.query(
    `INSERT INTO stream_sources (id,owner_id,name,url) VALUES ($1,$2,'cam','https://youtu.be/x')`,
    [sourceId, owner.id],
  );
  await db.query(
    `INSERT INTO live_sessions (id,stream_source_id,requested_by,pipeline_snapshot) VALUES ($1,$2,$3,'{}')`,
    [sessionId, sourceId, owner.id],
  );
  const listener = new Client({ connectionString: fixture.url });
  await listener.connect();
  const notes: { channel: string; payload?: string }[] = [];
  listener.on('notification', (note) => notes.push(note));
  await listener.query('LISTEN live_session_events');
  await listener.query('LISTEN live_sessions');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  try {
    let eventId = '';
    await db.transaction(async (c) => {
      for (const type of ['track', 'alert'])
        eventId = (
          await c.query(
            'INSERT INTO live_session_events (session_id,event_type) VALUES ($1,$2) RETURNING id',
            [sessionId, type],
          )
        ).rows[0].id;
      await settle();
      assert.equal(notes.length, 0, 'nothing is announced before commit');
    });
    await settle();
    assert.deepEqual(
      notes.map((n) => n.channel),
      ['live_session_events', 'live_session_events'],
    );
    assert.equal(notes[1].payload, `${sessionId}:${eventId}`);
    await db.query('UPDATE live_sessions SET stats=\'{"fps":30}\' WHERE id=$1', [sessionId]);
    await settle();
    assert.deepEqual([notes[2].channel, notes[2].payload], ['live_sessions', sessionId]);
  } finally {
    await listener.end();
  }
  const watch = (plate: string) =>
    db.query('INSERT INTO plate_watchlist (id,owner_id,plate) VALUES ($1,$2,$3)', [
      newId(),
      owner.id,
      plate,
    ]);
  await watch('ABC1D23');
  await assert.rejects(watch('ABC1D23'), { code: '23505' });
  for (const plate of ['abc1234', 'ABC-1234', 'ABC 1234', ''])
    await assert.rejects(watch(plate), { code: '23514' });
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
    6,
  );
});
