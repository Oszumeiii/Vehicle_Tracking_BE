import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Client, Notification } from 'pg';
import { Database } from '../database/database';
import { Actor } from '../common/http';
import { ACTIVE_SQL, ACTIVE_STATUSES, sessionView } from './sessions';

export interface StreamFilter {
  live_session_id?: string;
  stream_source_id?: string;
}
interface SessionMeta {
  owner_id: string;
  stream_source_id: string;
}

function setting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

/** One open event stream: replays durable events after its cursor, then follows notifications. */
class Subscriber {
  private pending = false;
  private running = false;
  private ending = false;
  constructor(
    private hub: LiveEventsHub,
    readonly actor: Actor,
    readonly filter: StreamFilter,
    private cursor: string,
    private res: Response,
  ) {}

  concerns(sessionId: string, meta: SessionMeta) {
    if (this.filter.live_session_id) return this.filter.live_session_id === sessionId;
    if (this.filter.stream_source_id) return this.filter.stream_source_id === meta.stream_source_id;
    return this.actor.role === 'admin' || meta.owner_id === this.actor.id;
  }

  write(chunk: string) {
    if (!this.res.writableEnded) this.res.write(chunk);
  }

  send(event: string, data: unknown, id?: string) {
    this.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Send every committed event after the cursor; notifications arriving meanwhile coalesce. */
  async pull() {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        const rows = await this.hub.eventsAfter(this, this.cursor);
        for (const row of rows) {
          this.cursor = row.id;
          // Alerts belong to the user whose watchlist matched, admins included.
          if (row.event_type === 'alert' && row.payload.owner_id !== this.actor.id) continue;
          this.send(
            row.event_type,
            {
              live_session_id: row.session_id,
              stream_source_id: row.stream_source_id,
              created_at: row.created_at,
              payload: row.payload,
            },
            row.id,
          );
          // Every terminal transition records a status event; the filtered stream ends after it.
          if (
            this.filter.live_session_id &&
            row.event_type === 'status' &&
            !ACTIVE_STATUSES.includes(row.payload.status)
          )
            this.ending = true;
        }
        if (rows.length === EVENT_PAGE) this.pending = true;
      } while (this.pending && !this.res.writableEnded);
    } catch {
      this.pending = true; // retried on the next notification or reconnect
    } finally {
      this.running = false;
    }
    if (this.ending) this.close();
  }

  /** A filtered session finished: flush what is left, say so and close. */
  async finish() {
    this.ending = true;
    await this.pull();
  }

  close() {
    if (this.res.writableEnded) return;
    this.write('event: end\ndata: {}\n\n');
    this.res.end();
  }

  end() {
    if (!this.res.writableEnded) this.res.end();
  }
}

const EVENT_PAGE = 500;

/**
 * Fans PostgreSQL notifications (sent by triggers at commit) out to SSE clients.
 *
 * One dedicated connection LISTENs; nothing is carried in the notification but ids,
 * so each stream re-reads committed rows after its own cursor. After a lost
 * connection the hub reconnects with backoff and every stream catches up by id.
 */
@Injectable()
export class LiveEventsHub implements OnModuleDestroy {
  private client?: Client;
  private connecting?: Promise<Client>;
  private subscribers = new Set<Subscriber>();
  private sessions = new Map<string, SessionMeta>();
  private closed = false;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  readonly heartbeatMs = setting('PLATE_SSE_HEARTBEAT_SECONDS', 20) * 1000;
  readonly maxClients = setting('PLATE_SSE_MAX_CLIENTS', 100);

  constructor(private db: Database) {}

  get size() {
    return this.subscribers.size;
  }

  async open(
    actor: Actor,
    filter: StreamFilter,
    after: string | undefined,
    req: Request,
    res: Response,
  ) {
    if (this.subscribers.size >= this.maxClients)
      throw new ServiceUnavailableException('Too many open event streams; retry later.');
    try {
      await this.listen();
    } catch {
      throw new ServiceUnavailableException('Live events are unavailable.');
    }
    const cursor =
      after ??
      (await this.db.query('SELECT coalesce(max(id),0)::text AS id FROM live_session_events'))
        .rows[0].id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const subscriber = new Subscriber(this, actor, filter, cursor, res);
    this.subscribers.add(subscriber);
    const heartbeat = setInterval(() => subscriber.write(': ping\n\n'), this.heartbeatMs);
    req.on('close', () => {
      clearInterval(heartbeat);
      this.subscribers.delete(subscriber);
    });
    subscriber.write('retry: 3000\n\n');
    const values: unknown[] = [actor.role === 'admin', actor.id];
    let where = `($1::boolean OR c.owner_id=$2)`;
    if (filter.live_session_id) {
      values.push(filter.live_session_id);
      where += ' AND s.id=$3'; // shown even when finished
    } else {
      where += ` AND s.status IN ${ACTIVE_SQL}`;
      if (filter.stream_source_id) {
        values.push(filter.stream_source_id);
        where += ' AND s.stream_source_id=$3';
      }
    }
    try {
      const sessions = (
        await this.db.query(
          `SELECT s.*, c.owner_id FROM live_sessions s JOIN stream_sources c ON c.id=s.stream_source_id
          WHERE ${where} ORDER BY s.created_at`,
          values,
        )
      ).rows;
      for (const session of sessions) subscriber.send('session', sessionView(session));
      const done = filter.live_session_id && !ACTIVE_STATUSES.includes(sessions[0]?.status);
      if (done) await subscriber.finish();
      else await subscriber.pull();
    } catch {
      subscriber.end(); // headers are sent: the client reconnects and resumes by id
    }
  }

  async eventsAfter(subscriber: Subscriber, cursor: string) {
    const { actor, filter } = subscriber;
    return (
      await this.db.query(
        `SELECT e.id::text AS id, e.session_id, e.event_type, e.payload, e.created_at, s.stream_source_id
        FROM live_session_events e JOIN live_sessions s ON s.id=e.session_id
        JOIN stream_sources c ON c.id=s.stream_source_id
        WHERE e.id > $1::bigint AND ($2::boolean OR c.owner_id=$3)
          AND ($4::text IS NULL OR e.session_id=$4) AND ($5::text IS NULL OR s.stream_source_id=$5)
        ORDER BY e.id LIMIT ${EVENT_PAGE}`,
        [
          cursor,
          actor.role === 'admin',
          actor.id,
          filter.live_session_id ?? null,
          filter.stream_source_id ?? null,
        ],
      )
    ).rows;
  }

  private async listen(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ connectionString: this.db.pool.options.connectionString });
      client.on('notification', (note) => void this.notified(note));
      client.on('error', () => this.lost(client));
      client.on('end', () => this.lost(client));
      try {
        await client.connect();
        await client.query('LISTEN live_session_events');
        await client.query('LISTEN live_sessions');
      } catch (error) {
        client.end().catch(() => {});
        throw error;
      }
      this.client = client;
      this.failures = 0;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private lost(client: Client) {
    if (this.client !== client) return;
    this.client = undefined;
    client.end().catch(() => {});
    this.reconnect();
  }

  private reconnect() {
    if (this.closed || this.retry) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.failures);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.listen()
        .then(() => {
          // Events committed while disconnected are found by id.
          for (const subscriber of this.subscribers) void subscriber.pull();
        })
        .catch(() => {
          this.failures++;
          this.reconnect();
        });
    }, delay);
  }

  private async meta(sessionId: string): Promise<SessionMeta | undefined> {
    let meta = this.sessions.get(sessionId);
    if (!meta) {
      meta = (
        await this.db.query<SessionMeta>(
          `SELECT c.owner_id, s.stream_source_id FROM live_sessions s
          JOIN stream_sources c ON c.id=s.stream_source_id WHERE s.id=$1`,
          [sessionId],
        )
      ).rows[0];
      if (meta) this.sessions.set(sessionId, meta);
    }
    return meta;
  }

  private async notified(note: Notification) {
    if (!this.subscribers.size || !note.payload) return;
    try {
      if (note.channel === 'live_session_events') {
        const sessionId = note.payload.split(':')[0];
        const meta = await this.meta(sessionId);
        if (!meta) return;
        for (const subscriber of this.subscribers)
          if (subscriber.concerns(sessionId, meta)) void subscriber.pull();
      } else if (note.channel === 'live_sessions') {
        const session = (
          await this.db.query<SessionMeta & Record<string, any>>(
            `SELECT s.*, c.owner_id FROM live_sessions s JOIN stream_sources c ON c.id=s.stream_source_id
            WHERE s.id=$1`,
            [note.payload],
          )
        ).rows[0];
        if (!session) return;
        const view = sessionView(session);
        for (const subscriber of this.subscribers)
          if (subscriber.concerns(session.id, session)) subscriber.send('session', view);
      }
    } catch {
      // A failed lookup is retried by the next notification; streams keep their cursor.
    }
  }

  async onModuleDestroy() {
    this.closed = true;
    clearTimeout(this.retry);
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }
}
