import 'reflect-metadata';
import 'dotenv/config';
import { Database } from './database/database';
import {
  executeRecognition,
  processOne,
  recover,
  Runner,
  workerOptions,
} from './recognition/engine';

/** Jobs processed in parallel by this worker; each job runs its own ML subprocess. */
export function workerConcurrency(value = process.env.PLATE_WORKER_CONCURRENCY ?? '1') {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('PLATE_WORKER_CONCURRENCY must be an integer from 1 to 8');
  return concurrency;
}

// One worker process owns the database (advisory lock), so startup recovery may fail
// every running job safely. Parallelism comes from slots inside that process; claims use
// FOR UPDATE SKIP LOCKED, so two slots never take the same job.
export async function runWorker(
  database: Database,
  once = false,
  concurrency = workerConcurrency(),
  runner: Runner = executeRecognition,
) {
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
    const idle = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        shutdown.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    const slot = async () => {
      try {
        while (!stopping) {
          const worked = await processOne(database, options, runner);
          if (once || stopping) break;
          if (!worked) await idle();
        }
      } catch (error) {
        stop(); // A failing slot (e.g. lost database) stops the others too.
        throw error;
      }
    };
    // --once keeps its meaning: process at most one job.
    const results = await Promise.allSettled(
      Array.from({ length: once ? 1 : concurrency }, () => slot()),
    );
    if (lostLock) throw lostLock;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
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
