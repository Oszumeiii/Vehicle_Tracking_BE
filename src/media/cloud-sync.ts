import type { QueryResult } from 'pg';
import { cloudStore, type CloudStore } from './cloud';
import { cloudPush, type PushSummary } from './cloud-push';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

export interface CloudSyncSettings {
  /** Move evidence images of results at least this many hours old; null: off. */
  afterHours: number | null;
  /** Stop before the bucket (under the prefix) holds more than this many GB. */
  maxGb: number;
  intervalMs: number;
}

function positive(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function cloudSyncSettings(): CloudSyncSettings {
  const raw = process.env.PLATE_CLOUD_EVIDENCE_AFTER_HOURS;
  let afterHours: number | null = null;
  if (raw !== undefined && raw !== '') {
    afterHours = Number(raw);
    if (!Number.isFinite(afterHours) || afterHours < 0)
      throw new Error('PLATE_CLOUD_EVIDENCE_AFTER_HOURS must be a number of hours (0 or more)');
  }
  return {
    afterHours,
    // R2's free tier is 10 GB a month: stay just under it unless told otherwise.
    maxGb: positive('PLATE_CLOUD_MAX_GB', 9.5),
    intervalMs: positive('PLATE_CLOUD_SYNC_MINUTES', 60) * 60_000,
  };
}

/**
 * Keeps plate crops and keyframes in the bucket instead of on the disk, run by the worker
 * when PLATE_CLOUD_EVIDENCE_AFTER_HOURS is set and cloud storage is configured: every
 * PLATE_CLOUD_SYNC_MINUTES, the images of finished results older than that many hours are
 * uploaded, checked by size, and deleted locally (cloudPush with freeLocal). The API serves
 * a freed file by redirect to a short-lived bucket link, and retention deletes it from the
 * bucket with the track. Uploaded videos stay on the disk (`npm run cloud:push -- --media`).
 */
export class CloudSync {
  constructor(
    private database: Queryable,
    private dataDir: string,
    private settings: CloudSyncSettings = cloudSyncSettings(),
    private store: () => CloudStore | null = cloudStore,
    private log: (line: string) => void = (line) => console.log(line),
  ) {}

  get enabled() {
    return this.settings.afterHours !== null && this.store() !== null;
  }

  async run(signal: AbortSignal) {
    if (this.settings.afterHours === null) return;
    if (!this.store()) {
      this.log('PLATE_CLOUD_EVIDENCE_AFTER_HOURS is set but cloud storage is off; nothing moved.');
      return;
    }
    while (!signal.aborted) {
      await this.sweep().catch((error) =>
        console.error('Cloud sync failed:', error instanceof Error ? error.message : error),
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.settings.intervalMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }

  /** One pass; null when off. */
  async sweep(): Promise<PushSummary | null> {
    const store = this.store();
    if (this.settings.afterHours === null || !store) return null;
    const summary = await cloudPush(
      this.database,
      this.dataDir,
      store,
      {
        evidence: true,
        media: false,
        freeLocal: true,
        olderThanDays: this.settings.afterHours / 24,
        dryRun: false,
        concurrency: 4,
        maxGb: this.settings.maxGb,
      },
      () => {}, // per-file progress would flood the worker log every hour
    );
    if (summary.uploaded || summary.freed || summary.failed || summary.overLimit)
      this.log(
        `Cloud sync (${store.label}): ${summary.uploaded} uploaded, ${summary.freed} freed ` +
          `(${(summary.freedBytes / 2 ** 20).toFixed(1)} MB), ${summary.failed} failed` +
          (summary.overLimit
            ? `, ${summary.overLimit} kept local: the bucket would pass ${this.settings.maxGb} GB`
            : '') +
          '.',
      );
    return summary;
  }
}
