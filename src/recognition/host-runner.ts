import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import type { SharedLiveHost } from '../live/host';
import {
  checkInterrupted,
  followProgress,
  readRecognitionResult,
  Runner,
  verifySnapshot,
  writeRecognitionInput,
} from './engine';

/**
 * Runs an upload job inside the shared live host, beside the live sessions and with
 * the models it already holds, instead of a separate ML process that would load its
 * own copy (two copies overcommit an 8 GB GPU). Files, stages and results are the
 * same as executeRecognition's. A timeout or shutdown asks the host to stop the job;
 * if it has not stopped after stopSeconds the host is killed, and with it the live
 * sessions inside (a model call cannot be interrupted per thread).
 */
export function hostRunner(host: SharedLiveHost, stopSeconds = 30): Runner {
  return async (job, folder, options, stage) => {
    await verifySnapshot(job.pipeline_snapshot, options);
    // Another pipeline in a busy host: wait for it to finish rather than load a second copy.
    while (!host.accepts(job.pipeline_snapshot)) {
      checkInterrupted(options);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const input = await writeRecognitionInput(job, folder, options);
    checkInterrupted(options);
    const log = createWriteStream(path.join(folder, 'worker.log'), { flags: 'a' });
    log.on('error', () => {});
    log.write(
      `[host] runs inside the shared live process; its log is ${path.join('live', 'host.log')}\n`,
    );
    const run = host.runJob(options.python, job.id, input, job.pipeline_snapshot);
    let timedOut = false;
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      run.stop();
      killTimer ??= setTimeout(() => host.kill(), stopSeconds * 1000);
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      options.timeoutSeconds * 1000 + 1000,
    );
    const stopPolling = followProgress(folder, stage);
    const onSignal = () => {
      interrupted = true;
      stop();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    options.signal?.addEventListener('abort', onSignal, { once: true });
    if (options.signal?.aborted) onSignal();
    try {
      const code = await run.exit;
      if (interrupted)
        throw Object.assign(new Error('Worker interrupted'), { code: 'WORKER_INTERRUPTED' });
      if (timedOut) throw Object.assign(new Error('Processing timed out'), { code: 'JOB_TIMEOUT' });
      if (code === null)
        throw Object.assign(new Error('The shared live process stopped'), {
          code: 'PIPELINE_FAILED',
        });
      return await readRecognitionResult(folder, code);
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      stopPolling();
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      options.signal?.removeEventListener('abort', onSignal);
      log.end();
    }
  };
}
