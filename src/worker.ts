import 'reflect-metadata';
import 'dotenv/config';
import { Database } from './database/database';
import { processOne, recover, workerOptions } from './recognition/engine';

export async function runWorker(database: Database, once = false) {
  const lock = await database.pool.connect();
  try {
    const result = await lock.query('SELECT pg_try_advisory_lock(762143901) AS acquired');
    if (!result.rows[0].acquired)
      throw new Error('Another recognition worker already owns this database');
  } catch (error) {
    lock.release(error instanceof Error ? error : true);
    throw error;
  }
  let stopping = false;
  let lostLock: Error | undefined;
  const shutdown = new AbortController();
  const stop = () => {
    stopping = true;
    shutdown.abort();
  };
  const onLockError = (error: Error) => {
    lostLock = error;
    stop();
  };
  lock.on('error', onLockError);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await recover(database);
    const options = { ...workerOptions(), signal: shutdown.signal };
    const interval = Number(process.env.PLATE_POLL_SECONDS ?? 2) * 1000;
    if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid polling interval');
    while (!stopping) {
      const worked = await processOne(database, options);
      if (once || stopping) break;
      if (!worked) await new Promise((resolve) => setTimeout(resolve, interval));
    }
    if (lostLock) throw lostLock;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await lock.query('SELECT pg_advisory_unlock(762143901)').catch(() => {});
    lock.off('error', onLockError);
    lock.release(lostLock);
  }
}

if (require.main === module) {
  const database = new Database();
  runWorker(database, process.argv.includes('--once'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => database.pool.end());
}
