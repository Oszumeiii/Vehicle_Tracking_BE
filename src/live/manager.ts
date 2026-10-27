import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { Database } from '../database/database';
import {
  pythonEnv,
  safeStorage,
  stopTree,
  verifySnapshot,
  WorkerOptions,
} from '../recognition/engine';
import { PipelineRegistry } from '../recognition/registry';
import { ingestTrack } from './ingest';
import { DEFAULT_MIN_CONFIDENCE, demoVideoFile, isLivePipeline, livePayload } from './payload';
import { ACTIVE_SQL, recordEvent } from './sessions';

type Row = Record<string, any>;
export type SpawnLive = (python: string, args: string[]) => ChildProcess;

export const spawnLiveProcess: SpawnLive = (python, args) =>
  spawn(python, args, {
    cwd: process.cwd(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: pythonEnv(),
  });

export interface LiveSettings {
  maxSessions: number;
  statsSeconds: number;
  stopSeconds: number;
  stallSeconds: number;
  exclusiveGpu: boolean;
  /** Detector sampling scale for sessions sharing one host (PLATE_LIVE_MAX_SESSIONS > 1). */
  samplingScale?: number;
  hostIdleSeconds?: number;
}

/**
 * Upload jobs and live sessions share the worker's GPU. Two processes each loading
 * YOLO11l and the OCR model overcommit an 8 GB card, and both then nearly freeze, so
 * with exclusive use a job in its own process ('jobs') runs alone. Jobs inside the
 * shared live host ('host') use the models the sessions already hold, so they run
 * beside live sessions. Checks and counts are synchronous, so slots and the live
 * manager never race.
 */
export type GpuUse = 'jobs' | 'live' | 'host';
export class GpuGate {
  private running: Record<GpuUse, number> = { jobs: 0, live: 0, host: 0 };
  constructor(readonly exclusive: boolean) {}
  enter(kind: GpuUse) {
    const { jobs, live, host } = this.running;
    if (this.exclusive && (kind === 'jobs' ? live + host > 0 : jobs > 0)) return false;
    this.running[kind]++;
    return true;
  }
  leave(kind: GpuUse) {
    this.running[kind]--;
  }
}

export function liveSettings(): LiveSettings {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`${name} must be a number from ${min} to ${max}`);
    return value;
  };
  const maxSessions = read('PLATE_LIVE_MAX_SESSIONS', 1, 0, 8);
  if (!Number.isInteger(maxSessions)) throw new Error('PLATE_LIVE_MAX_SESSIONS must be an integer');
  const exclusive = process.env.PLATE_LIVE_EXCLUSIVE_GPU ?? 'true';
  if (!['true', 'false'].includes(exclusive))
    throw new Error('PLATE_LIVE_EXCLUSIVE_GPU must be true or false');
  return {
    maxSessions,
    statsSeconds: read('PLATE_LIVE_STATS_SECONDS', 5, 0.1, 3600),
    stopSeconds: read('PLATE_LIVE_STOP_SECONDS', 120, 1, 3600),
    // The live process reports stats every second; silence means it hangs (e.g. GPU memory thrash).
    stallSeconds: read('PLATE_LIVE_STALL_SECONDS', 180, 10, 3600),
    exclusiveGpu: exclusive === 'true',
    samplingScale: read('PLATE_LIVE_SHARED_SAMPLING_SCALE', 1, 0.1, 1),
    // A shared host stays this long after its last session or job, keeping the models loaded.
    hostIdleSeconds: read('PLATE_LIVE_HOST_IDLE_SECONDS', 300, 0, 86400),
  };
}

/** Sessions of a shared host are killed through it (the whole host goes); others by process tree. */
function killLive(child: ChildProcess) {
  const session = child as ChildProcess & { terminate?: () => void };
  if (typeof session.terminate === 'function') session.terminate();
  else void stopTree(child);
}

// Statuses of the live process mapped to session statuses; terminal ones are applied at exit.
const PROCESS_STATUS: Record<string, string> = {
  starting: 'starting',
  connecting: 'starting',
  running: 'running',
  reconnecting: 'reconnecting',
};
const TERMINAL = ['ended', 'stopped', 'failed'];
const STARTUP_CODES = [
  'ENVIRONMENT_ERROR',
  'CUDA_UNAVAILABLE',
  'CUDA_ERROR',
  'CHECKPOINT_MISSING',
  'PIPELINE_FAILED',
];

interface Run {
  session: Row;
  child: ChildProcess;
  status: string;
  queue: Promise<void>;
  terminal?: { status: string; reason: string | null };
  lastError?: { code: string; message: string };
  stats?: Row;
  statsDirty: boolean;
  stopSent: boolean;
  interrupted: boolean;
  killed: boolean;
  stalled: boolean;
  lastEventAt: number;
  timers: NodeJS.Timeout[];
  done: Promise<void>;
}

/**
 * Runs queued live sessions as `python -m app.live` children inside the worker.
 *
 * The database holds desired state: the API queues sessions and requests stops,
 * this manager claims them, relays process events into session status, stats and
 * events, and ingests each finished track as a recognition job.
 */
export class LiveManager {
  private runs = new Map<string, Run>();
  // Cameras whose pipeline could not be resolved: retry time and consecutive failures.
  private restartBlocked = new Map<string, { until: number; failures: number }>();

  constructor(
    private database: Database,
    private options: WorkerOptions,
    private settings: LiveSettings = liveSettings(),
    private spawnLive: SpawnLive = spawnLiveProcess,
    private gate = new GpuGate(settings.exclusiveGpu),
    private registry = new PipelineRegistry(),
  ) {}

  /**
   * Queue a new session for each always-on camera that has none. Consecutive short
   * sessions (under two minutes, e.g. a broadcast that is down) back off 1, 2, 4...
   * up to 30 minutes; a session that ran longer resets the backoff.
   */
  async autoRestart() {
    const cameras = (
      await this.database.query(
        `SELECT c.* FROM stream_sources c WHERE c.always_on AND NOT EXISTS (
          SELECT 1 FROM live_sessions s WHERE s.stream_source_id=c.id AND s.status IN ${ACTIVE_SQL})`,
      )
    ).rows;
    for (const camera of cameras) {
      const recent = (
        await this.database.query(
          `SELECT id, finished_at, extract(epoch FROM finished_at - coalesce(started_at, created_at)) AS ran
          FROM live_sessions WHERE stream_source_id=$1 ORDER BY created_at DESC LIMIT 12`,
          [camera.id],
        )
      ).rows;
      const failures = recent.findIndex((row) => Number(row.ran) >= 120);
      const short = failures < 0 ? recent.length : failures;
      const delay = short ? Math.min(30, 2 ** (short - 1)) * 60_000 : 0;
      const last = recent[0];
      if (last?.finished_at && Date.now() - new Date(last.finished_at).getTime() < delay) continue;
      const blocked = this.restartBlocked.get(camera.id);
      if (blocked && Date.now() < blocked.until) continue;
      const auto = camera.auto_settings;
      let snapshot: Row;
      try {
        snapshot = await this.registry.resolve(auto.pipeline_id);
        if (!isLivePipeline(snapshot))
          throw new Error('Pipeline is not a five-frame joint pipeline');
      } catch (error) {
        const failures = (blocked?.failures ?? 0) + 1;
        this.restartBlocked.set(camera.id, {
          failures,
          until: Date.now() + Math.min(30, 2 ** (failures - 1)) * 60_000,
        });
        if (last)
          await recordEvent(this.database, last.id, 'error', {
            code: 'AUTO_RESTART_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        continue;
      }
      this.restartBlocked.delete(camera.id);
      const settings = {
        min_confidence: auto.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
        max_track_seconds: auto.max_track_seconds ?? 30,
        max_height: auto.max_height ?? 1080,
        exclude_zones: camera.exclude_zones,
      };
      await this.database
        .transaction(async (c) => {
          const id = randomUUID().replace(/-/g, '');
          await c.query(
            `INSERT INTO live_sessions(id,stream_source_id,requested_by,pipeline_snapshot,settings)
            VALUES($1,$2,$3,$4,$5)`,
            [id, camera.id, camera.owner_id, JSON.stringify(snapshot), JSON.stringify(settings)],
          );
          await recordEvent(c, id, 'status', { status: 'queued', reason: 'auto_restart' });
        })
        .catch((error) => {
          // Another session became active meanwhile (one per camera); try again next tick.
          if ((error as any)?.code !== '23505') throw error;
        });
    }
  }

  get active() {
    return this.runs.size;
  }

  /** Sessions left running by a previous worker are interrupted; their written tracks are kept. */
  async recover() {
    const interrupted = await this.database.query(
      `UPDATE live_sessions SET status='interrupted',finished_at=now(),error_code='WORKER_INTERRUPTED',
      error_message='Worker stopped during the session. Start a new session to continue.'
      WHERE status IN ('starting','running','reconnecting','stopping') RETURNING id`,
    );
    for (const row of interrupted.rows)
      await recordEvent(this.database, row.id, 'status', {
        status: 'interrupted',
        reason: 'worker restarted',
      });
    const root = safeStorage(this.options.dataDir, 'live');
    const sessions = await readdir(root).catch(() => [] as string[]);
    for (const sessionId of sessions) {
      const session = (
        await this.database.query('SELECT * FROM live_sessions WHERE id=$1', [sessionId])
      ).rows[0];
      if (!session) continue;
      const tracks = await readdir(path.join(root, sessionId, 'tracks')).catch(
        () => [] as string[],
      );
      for (const key of tracks.sort()) await this.ingest(session, key);
    }
  }

  async run(signal: AbortSignal, intervalMs: number) {
    try {
      while (!signal.aborted) {
        await this.tick();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    } finally {
      await this.shutdown();
    }
  }

  /** Kill hung processes, apply stop requests, then start queued sessions while slots are free. */
  async tick() {
    for (const run of this.runs.values())
      if (!run.stalled && Date.now() - run.lastEventAt > this.settings.stallSeconds * 1000) {
        run.stalled = true;
        await recordEvent(this.database, run.session.id, 'error', {
          code: 'LIVE_STALLED',
          message: `No events for ${this.settings.stallSeconds} s; live process killed.`,
        });
        killLive(run.child);
      }
    if (this.runs.size) {
      const stops = await this.database.query(
        'SELECT id FROM live_sessions WHERE id=ANY($1) AND stop_requested_at IS NOT NULL',
        [[...this.runs.keys()]],
      );
      for (const row of stops.rows) {
        const run = this.runs.get(row.id);
        if (run) await this.requestStop(run);
      }
    }
    await this.autoRestart();
    while (this.runs.size < this.settings.maxSessions && !this.options.signal?.aborted) {
      if (!this.gate.enter('live')) break;
      let session: Row | undefined;
      try {
        session = await this.claim();
      } finally {
        if (!session) this.gate.leave('live');
      }
      if (!session) break;
      await this.start(session); // Leaves the gate when the session ends.
    }
  }

  /** Worker shutdown: stop every child gracefully (bounded), keep its tracks, mark it interrupted. */
  async shutdown() {
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.interrupted = true;
      await this.requestStop(run).catch(() => {});
    }
    await Promise.all(runs.map((run) => run.done));
  }

  private async claim(): Promise<Row | undefined> {
    return this.database.transaction(async (c) => {
      const session = (
        await c.query(`WITH candidate AS (
          SELECT id FROM live_sessions WHERE status='queued' ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE live_sessions s SET status='starting' FROM candidate WHERE s.id=candidate.id
        RETURNING s.*`)
      ).rows[0];
      if (!session) return undefined;
      const source = (
        await c.query('SELECT url,source_type FROM stream_sources WHERE id=$1', [
          session.stream_source_id,
        ])
      ).rows[0];
      await recordEvent(c, session.id, 'status', { status: 'starting' });
      return { ...session, url: source.url, source_type: source.source_type };
    });
  }

  private async start(session: Row) {
    const folder = safeStorage(this.options.dataDir, `live/${session.id}`);
    let child: ChildProcess;
    try {
      await verifySnapshot(session.pipeline_snapshot, this.options);
      await mkdir(folder, { recursive: true });
      const payload = path.join(folder, 'payload.json');
      await writeFile(
        payload,
        JSON.stringify(
          livePayload(
            session.pipeline_snapshot,
            session.source_type === 'file'
              ? { type: 'file', path: demoVideoFile(this.options.dataDir, session.url) }
              : { type: 'youtube', url: session.url },
            session.settings.exclude_zones ?? [],
            session.settings.max_height ?? 1080,
          ),
        ),
      );
      child = this.spawnLive(this.options.python, [
        '-m',
        'app.live',
        '--payload',
        payload,
        '--out',
        folder,
        '--data-dir',
        this.options.dataDir,
        '--min-confidence',
        String(session.settings.min_confidence ?? DEFAULT_MIN_CONFIDENCE),
        '--max-track-seconds',
        String(session.settings.max_track_seconds ?? 30),
      ]);
    } catch (error) {
      this.gate.leave('live');
      await this.finish(session.id, 'failed', {
        code: (error as any)?.code ?? 'PIPELINE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let resolveDone!: () => void;
    const run: Run = {
      session,
      child,
      status: 'starting',
      queue: Promise.resolve(),
      statsDirty: false,
      stopSent: false,
      interrupted: false,
      killed: false,
      stalled: false,
      lastEventAt: Date.now(),
      timers: [],
      done: new Promise<void>((resolve) => (resolveDone = resolve)),
    };
    this.runs.set(session.id, run);
    const log = createWriteStream(path.join(folder, 'live.log'), { flags: 'a' });
    log.on('error', () => killLive(child));
    child.stderr?.pipe(log, { end: false });
    child.stdin?.on('error', () => {});
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      run.lastEventAt = Date.now();
      let event: Row;
      try {
        event = JSON.parse(line);
      } catch {
        log.write(`[stdout] ${line}\n`);
        return;
      }
      run.queue = run.queue
        .then(() => this.handle(run, event))
        .catch((error) => {
          log.write(`[manager] ${error instanceof Error ? error.stack : error}\n`);
        });
    });
    run.timers.push(
      setInterval(() => {
        run.queue = run.queue.then(() => this.flushStats(run)).catch(() => {});
      }, this.settings.statsSeconds * 1000),
    );
    let closed = false;
    const close = async (exitCode: number | null) => {
      if (closed) return;
      closed = true;
      run.timers.forEach(clearTimeout);
      await run.queue;
      await this.flushStats(run).catch(() => {});
      let status: string, error: { code: string; message: string } | undefined;
      if (run.interrupted) {
        status = 'interrupted';
        error = { code: 'WORKER_INTERRUPTED', message: 'Worker stopped during the session.' };
      } else if (run.stalled) {
        status = 'failed';
        error = {
          code: 'LIVE_STALLED',
          message: `The live process stopped reporting for ${this.settings.stallSeconds} s and was killed.`,
        };
      } else if (run.terminal) {
        status = run.terminal.status;
        if (status === 'failed')
          error =
            run.terminal.reason === 'startup'
              ? {
                  code: STARTUP_CODES.includes(run.lastError?.code ?? '')
                    ? run.lastError!.code
                    : 'PIPELINE_FAILED',
                  message: run.lastError?.message ?? 'Live process failed to start.',
                }
              : { code: 'STREAM_FAILED', message: run.terminal.reason ?? 'Stream failed.' };
      } else if (run.stopSent) {
        status = 'stopped';
      } else {
        status = 'failed';
        error = {
          code: 'LIVE_PROCESS_EXITED',
          message: `Live process exited unexpectedly (code ${exitCode}).`,
        };
      }
      await this.finish(session.id, status, error, exitCode, run.killed).catch(() => {});
      log.end();
      this.runs.delete(session.id);
      this.gate.leave('live');
      resolveDone();
    };
    // Wait for stdout to drain so the final events are handled before finishing.
    const ended = new Promise<void>((resolve) => lines.once('close', () => resolve()));
    child.once('close', (code) => void ended.then(() => close(code)));
    child.once('error', () => void close(null));
  }

  private async handle(run: Run, event: Row) {
    const id = run.session.id;
    if (event.type === 'status') {
      if (TERMINAL.includes(event.status)) {
        run.terminal = { status: event.status, reason: event.reason ?? null };
        return;
      }
      const status = PROCESS_STATUS[event.status];
      if (!status) return;
      const { type: _type, time: _time, ...payload } = event;
      await recordEvent(this.database, id, 'status', payload);
      // A requested stop stays visible as stopping until the process exits.
      if (status !== run.status && run.status !== 'stopping') {
        run.status = status;
        await this.database.query(
          `UPDATE live_sessions SET status=$2${status === 'running' ? ',started_at=coalesce(started_at,now())' : ''}
          WHERE id=$1 AND status IN ('starting','running','reconnecting')`,
          [id, status],
        );
      }
    } else if (event.type === 'stats') {
      const { type: _type, ...stats } = event;
      run.stats = stats;
      run.statsDirty = true;
    } else if (event.type === 'error') {
      run.lastError = { code: String(event.code), message: String(event.message ?? '') };
      const { type: _type, time: _time, ...payload } = event;
      await recordEvent(this.database, id, 'error', payload);
    } else if (event.type === 'track') {
      await this.ingest(run.session, String(event.track));
    }
  }

  private async ingest(session: Row, key: string) {
    try {
      await ingestTrack(this.database, this.options, session, key);
    } catch (error) {
      await recordEvent(this.database, session.id, 'track_rejected', {
        track: key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushStats(run: Run) {
    if (!run.statsDirty) return;
    run.statsDirty = false;
    await this.database.query('UPDATE live_sessions SET stats=$2,stats_at=now() WHERE id=$1', [
      run.session.id,
      JSON.stringify(run.stats),
    ]);
  }

  private async requestStop(run: Run) {
    if (run.stopSent) return;
    run.stopSent = true;
    run.child.stdin?.write('stop\n');
    run.timers.push(
      setTimeout(() => {
        // Open tracks not finished by now are lost; finished ones are already ingested.
        run.killed = true;
        killLive(run.child);
      }, this.settings.stopSeconds * 1000),
    );
    if (run.interrupted) return;
    run.status = 'stopping';
    await this.database.query(
      "UPDATE live_sessions SET status='stopping' WHERE id=$1 AND status IN ('starting','running','reconnecting')",
      [run.session.id],
    );
    await recordEvent(this.database, run.session.id, 'status', { status: 'stopping' });
  }

  private async finish(
    id: string,
    status: string,
    error?: { code: string; message: string },
    exitCode: number | null = null,
    killed = false,
  ) {
    await this.database.query(
      `UPDATE live_sessions SET status=$2,finished_at=now(),error_code=$3,error_message=$4 WHERE id=$1`,
      [id, status, error?.code ?? null, error?.message ?? null],
    );
    await recordEvent(this.database, id, 'status', {
      status,
      ...(error ? { code: error.code, message: error.message } : {}),
      ...(exitCode === null ? {} : { exit_code: exitCode }),
      ...(killed ? { forced: true } : {}),
    });
  }
}
