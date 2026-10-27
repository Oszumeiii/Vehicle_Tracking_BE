import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, readFileSync, WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { stopTree } from '../recognition/engine';
import type { SpawnLive } from './manager';
import { DEFAULT_MIN_CONFIDENCE } from './payload';

/** A session inside the shared host, shaped like the child process LiveManager expects. */
export type SessionChild = ChildProcess & { terminate(): void };

interface Entry {
  child: SessionChild;
  stdout: PassThrough;
  stderr: PassThrough;
  closed: boolean;
  /** The host process that received this session's start command. */
  host?: ChildProcess;
}

interface JobEntry {
  done: (code: number | null) => void;
  host?: ChildProcess;
}

/** A job sent to the host: its exit code (null when the host died) and a way to stop it. */
export interface HostJob {
  exit: Promise<number | null>;
  stop(): void;
}

const argument = (args: string[], name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

/** JSON with sorted object keys: snapshots read back from PostgreSQL jsonb lose key order. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : JSON.stringify(value ?? null);

/** The models a snapshot loads; the host holds one such set (app/live/host.py SharedModels.key). */
export const pipelineKey = (snapshot: Record<string, any>) =>
  canonical([
    snapshot?.id,
    snapshot?.version,
    snapshot?.device,
    snapshot?.detector,
    snapshot?.recognizer,
  ]);

const payloadPipeline = (file?: string) => {
  try {
    return file ? pipelineKey(JSON.parse(readFileSync(file, 'utf8')).pipeline_snapshot) : undefined;
  } catch {
    return undefined; // the host reports the unreadable payload as this session's startup error
  }
};

/**
 * Runs live sessions inside one `python -m app.live --host` process so they share a
 * single copy of the detector and OCR model; separate processes overcommit an 8 GB
 * GPU. `spawn` has the SpawnLive signature, so LiveManager drives each session as
 * if it were its own process: its stdout carries that session's events, writing
 * "stop" to its stdin stops it, and it closes when the host reports the session's
 * exit. Upload jobs of the same pipeline run in the host too (runJob), beside the
 * sessions and without loading the models again. The host starts with the first
 * session or job and exits idleSeconds after the last one (0: at once), which frees
 * the GPU for job processes; staying warm saves reloading the models (~20 s) for
 * the next session or job. Killing a session (stall or stop timeout) kills the host
 * and so every session and job in it: a hung model call cannot be undone per thread.
 */
export class SharedLiveHost {
  private host?: ChildProcess;
  private exited?: Promise<void>;
  private starting?: Promise<void>;
  private sessions = new Map<string, Entry>();
  private jobs = new Map<string, JobEntry>();
  /** pipelineKey of the models the running host loads. */
  private pipeline?: string;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private spawnProcess: SpawnLive,
    private dataDir: string,
    private samplingScale = 1,
    private idleSeconds = 0,
  ) {}

  /** Sessions currently inside the host. */
  get size() {
    return this.sessions.size;
  }

  /** Sessions and jobs inside the host. */
  get members() {
    return this.sessions.size + this.jobs.size;
  }

  /** Whether a job of this snapshot can run in the host now (same models, or a host it may restart). */
  accepts(snapshot: Record<string, any>) {
    return !this.host || !this.members || this.pipeline === pipelineKey(snapshot);
  }

  /** Run an upload job (its recognition-input.json) inside the host. */
  runJob(python: string, job: string, payload: string, snapshot: Record<string, any>): HostJob {
    let done!: (code: number | null) => void;
    const exit = new Promise<number | null>((resolve) => (done = resolve));
    const entry: JobEntry = { done };
    this.jobs.set(job, entry);
    void this.send(python, entry, { cmd: 'job', job, payload }, pipelineKey(snapshot)).catch(() =>
      this.closeJob(job, null),
    );
    return { exit, stop: () => this.write({ cmd: 'stop_job', job }) };
  }

  /** End a host that has no sessions or jobs (a warm idle host), freeing the GPU now. */
  async stopIdle() {
    if (this.host && !this.members) this.endHost();
    await this.exited;
  }

  readonly spawn: SpawnLive = (python, args) => {
    const out = argument(args, '--out');
    const session = out ? path.basename(out) : '';
    const entry = this.entry(session);
    const payload = argument(args, '--payload');
    void this.send(
      python,
      entry,
      {
        cmd: 'start',
        session,
        payload,
        out,
        min_confidence: Number(argument(args, '--min-confidence') ?? DEFAULT_MIN_CONFIDENCE),
        max_track_seconds: Number(argument(args, '--max-track-seconds') ?? 30),
      },
      payloadPipeline(payload),
    ).catch((error) => {
      entry.stderr.write(`[host] ${error instanceof Error ? error.message : error}\n`);
      this.close(session, null);
    });
    return entry.child;
  };

  private entry(session: string): Entry {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      pid: undefined,
      terminate: () => this.kill(),
    }) as unknown as SessionChild;
    let input = '';
    stdin.on('data', (chunk) => {
      input += String(chunk);
      // "clip TRACK" lines ask the session for a track's clip (a watchlist hit).
      for (const match of input.matchAll(/^clip (\S+)\n/gm))
        this.write({ cmd: 'clip', session, track: match[1] });
      input = input.replace(/^clip \S+\n/gm, '');
      if (input.includes('stop\n')) {
        input = '';
        this.write({ cmd: 'stop', session });
      }
    });
    const entry = { child, stdout, stderr, closed: false };
    this.sessions.set(session, entry);
    return entry;
  }

  private async send(
    python: string,
    entry: Entry | JobEntry,
    command: Record<string, unknown>,
    pipeline?: string,
  ) {
    clearTimeout(this.idleTimer);
    // A warm host holding other models is restarted when nothing else runs in it. With
    // members inside, a session of another pipeline gets the host's own startup error.
    if (this.host && pipeline && this.pipeline && pipeline !== this.pipeline && this.members <= 1)
      this.endHost();
    // A host still finishing its last session is waited for, never reused while exiting.
    while (!this.host)
      await (this.starting ??= (async () => {
        await this.exited;
        await this.startHost(python);
        this.pipeline = pipeline;
      })().finally(() => (this.starting = undefined)));
    this.pipeline ??= pipeline;
    entry.host = this.host;
    this.write(command);
  }

  private endHost() {
    clearTimeout(this.idleTimer);
    const host = this.host;
    this.host = this.pipeline = undefined;
    host?.stdin?.end();
  }

  private write(command: Record<string, unknown>) {
    this.host?.stdin?.write(JSON.stringify(command) + '\n');
  }

  private async startHost(python: string) {
    const folder = path.join(this.dataDir, 'live');
    await mkdir(folder, { recursive: true });
    const log = createWriteStream(path.join(folder, 'host.log'), { flags: 'a' });
    log.on('error', () => {});
    const host = this.spawnProcess(python, [
      '-m',
      'app.live',
      '--host',
      '--data-dir',
      this.dataDir,
      '--sampling-scale',
      String(this.samplingScale),
    ]);
    this.host = host;
    host.stdin?.on('error', () => {});
    host.stderr?.pipe(log, { end: false });
    const lines = createInterface({ input: host.stdout! });
    lines.on('line', (line) => this.route(line, log));
    let resolveExited!: () => void;
    this.exited = new Promise((resolve) => (resolveExited = resolve));
    const ended = new Promise<void>((resolve) => lines.once('close', () => resolve()));
    let done = false;
    const exit = (code: number | null) => {
      if (done) return;
      done = true;
      if (this.host === host) this.host = this.pipeline = undefined;
      // Its sessions and jobs the host did not report as finished end with it (a crash or a kill).
      for (const [session, entry] of [...this.sessions])
        if (entry.host === host) this.close(session, code ?? null, true);
      for (const [job, entry] of [...this.jobs]) if (entry.host === host) this.closeJob(job, null);
      log.end();
      resolveExited();
    };
    host.once('close', (code) => void ended.then(() => exit(code)));
    host.once('error', () => exit(null));
  }

  private route(line: string, log: WriteStream) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      log.write(`[stdout] ${line}\n`);
      return;
    }
    if (typeof event.job === 'string' && event.type === 'exit') {
      log.write(`${line}\n`);
      this.closeJob(event.job, Number(event.code));
      return;
    }
    const entry = typeof event.session === 'string' ? this.sessions.get(event.session) : undefined;
    if (!entry) {
      log.write(`${line}\n`);
      return;
    }
    if (event.type === 'exit') {
      this.close(event.session, Number(event.code));
      return;
    }
    const { session: _session, ...rest } = event;
    entry.stdout.write(JSON.stringify(rest) + '\n');
  }

  private close(session: string, code: number | null, hostGone = false) {
    const entry = this.sessions.get(session);
    if (!entry || entry.closed) return;
    entry.closed = true;
    this.sessions.delete(session);
    (entry.child as any).exitCode = code;
    entry.stdout.end();
    entry.stderr.end();
    setImmediate(() => entry.child.emit('close', hostGone ? null : code));
    if (!hostGone) this.idle();
  }

  private closeJob(job: string, code: number | null) {
    const entry = this.jobs.get(job);
    if (!entry) return;
    this.jobs.delete(job);
    entry.done(code !== null && Number.isFinite(code) ? code : null);
    this.idle();
  }

  /** The last member out stops the host (after idleSeconds), releasing GPU memory for job processes. */
  private idle() {
    if (this.members || !this.host) return;
    clearTimeout(this.idleTimer);
    if (this.idleSeconds > 0) {
      this.idleTimer = setTimeout(() => !this.members && this.endHost(), this.idleSeconds * 1000);
      this.idleTimer.unref?.();
    } else this.endHost();
  }

  /** Kill the host and with it every session and job; they finish as exited processes. */
  kill() {
    const hosts = new Set(
      [...this.sessions.values(), ...this.jobs.values()].map((entry) => entry.host),
    );
    for (const host of hosts) if (host) void stopTree(host);
  }
}
