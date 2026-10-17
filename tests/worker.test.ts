import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sha256 } from '../src/recognition/registry';
import { Runner } from '../src/recognition/engine';
import { runWorker, workerConcurrency } from '../src/worker';
import { newId, seedUser, startTestDatabase } from './helpers';

test('worker concurrency setting accepts 1-8 jobs', () => {
  assert.equal(workerConcurrency('1'), 1);
  assert.equal(workerConcurrency('4'), 4);
  for (const value of ['0', '9', '1.5', 'two', ''])
    assert.throws(() => workerConcurrency(value), /PLATE_WORKER_CONCURRENCY/);
});

test('one worker process runs queued jobs in parallel without claiming a job twice', async () => {
  const fixture = await startTestDatabase();
  const { database, root } = fixture;
  const previous = { data: process.env.PLATE_DATA_DIR, poll: process.env.PLATE_POLL_SECONDS };
  process.env.PLATE_DATA_DIR = root;
  process.env.PLATE_POLL_SECONDS = '0.05';
  try {
    const user = await seedUser(database);
    const mediaId = newId();
    await writeFile(path.join(root, 'source.png'), 'test-source');
    await database.query(
      `INSERT INTO media_assets (id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256)
      VALUES ($1,$2,'source.png','image','source.png','image/png',11,$3)`,
      [mediaId, user.id, await sha256(path.join(root, 'source.png'))],
    );
    const jobIds = [newId(), newId(), newId()];
    for (const id of jobIds)
      await database.query(
        "INSERT INTO recognition_jobs(id,media_id,input_mode) VALUES ($1,$2,'plate_crop')",
        [id, mediaId],
      );

    let running = 0,
      peak = 0;
    const seen: string[] = [];
    const runner: Runner = async (job) => {
      seen.push(job.id);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 300));
      running--;
      return { statistics: {}, appearances: [] };
    };

    const worker = runWorker(database, false, 2, runner);
    const deadline = Date.now() + 20000;
    for (;;) {
      const done = await database.query(
        "SELECT count(*)::int AS n FROM recognition_jobs WHERE status='succeeded'",
      );
      if (done.rows[0].n === jobIds.length) break;
      assert.ok(Date.now() < deadline, 'jobs did not finish');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.emit('SIGTERM');
    await worker;

    assert.equal(peak, 2, 'two jobs should run at the same time');
    assert.deepEqual([...seen].sort(), [...jobIds].sort(), 'each job is claimed exactly once');
  } finally {
    process.env.PLATE_DATA_DIR = previous.data;
    process.env.PLATE_POLL_SECONDS = previous.poll;
    if (previous.data === undefined) delete process.env.PLATE_DATA_DIR;
    if (previous.poll === undefined) delete process.env.PLATE_POLL_SECONDS;
    await fixture.dispose();
  }
});
