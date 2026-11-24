import type { QueryResult } from 'pg';
import { newId } from '../common/http';
import { Database } from '../database/database';
import type { AlertPayload } from './message';
import { DeliveryError, sendDelivery, type ChannelTarget } from './senders';
import { notifySettings, priorityRank, retryDelayMs, type NotifySettings } from './settings';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

let wake: (() => void) | null = null;

/** Let this process's notifier look for due deliveries now (an ingest just committed some). */
export function wakeAlertNotifier() {
  wake?.();
}

/**
 * One delivery per enabled channel of each recipient whose minimum priority the alert
 * reaches. Called inside the ingest transaction (an outbox): alerts and their deliveries
 * commit together, and deliveries a crash left unsent wait for the next worker.
 */
export async function enqueueDeliveries(
  c: Queryable,
  payloads: Map<string, AlertPayload>,
  jobId: string | null,
) {
  if (!payloads.size) return 0;
  const channels = (
    await c.query(
      'SELECT id, owner_id, min_priority FROM notification_channels WHERE enabled AND owner_id = ANY($1) ORDER BY created_at, id',
      [[...payloads.keys()]],
    )
  ).rows;
  let queued = 0;
  for (const channel of channels) {
    const payload = payloads.get(channel.owner_id)!;
    if (priorityRank(payload.priority ?? 'normal') < priorityRank(channel.min_priority)) continue;
    await c.query(
      'INSERT INTO alert_deliveries(id, channel_id, job_id, payload) VALUES ($1, $2, $3, $4)',
      [newId(), channel.id, jobId, JSON.stringify(payload)],
    );
    queued++;
  }
  return queued;
}

interface Due {
  id: string;
  channel_id: string;
  payload: AlertPayload;
  attempts: number;
}

type Send = (
  channel: ChannelTarget,
  delivery: { id: string; payload: AlertPayload },
  settings: NotifySettings,
  dataDir: string,
) => Promise<void>;

/**
 * Sends alert deliveries from the worker and retries failures with backoff
 * (30 s doubling to 30 min, 8 attempts); permanent failures (a chat that blocked the bot,
 * a webhook answering 4xx) stop at once. The outcome is kept on the delivery and the
 * channel, for the settings page and the system health check.
 */
export class AlertNotifier {
  constructor(
    private database: Database,
    private dataDir: string,
    private settings: NotifySettings = notifySettings(),
    private send: Send = sendDelivery,
  ) {}

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        while (!signal.aborted && (await this.deliverDue()) > 0);
      } catch (error) {
        console.error('Alert delivery failed:', error instanceof Error ? error.message : error);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (wake === done) wake = null;
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, this.settings.pollMs);
        wake = done;
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  /** Send the deliveries due now, at most `batch`; returns how many were tried. */
  async deliverDue(batch = 10) {
    // Lease them first: until an outcome is written, no other worker or retry takes them.
    const { rows } = await this.database.query(
      `UPDATE alert_deliveries SET next_attempt_at = now() + interval '2 minutes'
      WHERE id IN (
        SELECT id FROM alert_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, channel_id, payload, attempts`,
      [batch],
    );
    for (const row of rows as Due[]) await this.deliver(row);
    return rows.length;
  }

  private async deliver(row: Due) {
    const channel = (
      await this.database.query(
        'SELECT kind, target, secret, enabled FROM notification_channels WHERE id=$1',
        [row.channel_id],
      )
    ).rows[0] as (ChannelTarget & { enabled: boolean }) | undefined;
    const attempts = row.attempts + 1;
    try {
      if (!channel?.enabled) throw new DeliveryError('The channel is turned off.', true);
      await this.send(channel, { id: row.id, payload: row.payload }, this.settings, this.dataDir);
      await this.database.query(
        "UPDATE alert_deliveries SET status='sent', attempts=$2, sent_at=now(), last_error=NULL WHERE id=$1",
        [row.id, attempts],
      );
      await this.database.query(
        'UPDATE notification_channels SET last_sent_at=now(), last_error=NULL, last_error_at=NULL WHERE id=$1',
        [row.channel_id],
      );
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const permanent = error instanceof DeliveryError && error.permanent;
      const failed = permanent || attempts >= this.settings.maxAttempts;
      const wait = Math.max(
        retryDelayMs(attempts),
        error instanceof DeliveryError ? (error.retryAfterMs ?? 0) : 0,
      );
      await this.database.query(
        `UPDATE alert_deliveries SET attempts=$2, last_error=$3, status=$4,
          next_attempt_at=now() + make_interval(secs => $5) WHERE id=$1`,
        [row.id, attempts, message, failed ? 'failed' : 'pending', wait / 1000],
      );
      if (channel)
        await this.database.query(
          'UPDATE notification_channels SET last_error=$2, last_error_at=now() WHERE id=$1',
          [row.channel_id, message],
        );
    }
  }
}
