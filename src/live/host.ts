import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { stopTree } from '../recognition/engine';
import type { SpawnLive } from './manager';

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

const argument = (args: string[], name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

/**
 * Runs live sessions inside one `python -m app.live --host` process so they share a
 * single copy of the detector and OCR model; separate processes overcommit an 8 GB
 * GPU. `spawn` has the SpawnLive signature, so LiveManager drives each session as
 * if it were its own process: its stdout carries that session's events, writing
 * "stop" to its stdin stops it, and it closes when the host reports the session's
 * exit. The host starts with the first session and exits after the last one, which
 * frees the GPU for upload jobs. Killing a session (stall or stop timeout) kills the
 * host and so every session in it: a hung model call cannot be undone per thread.
 */
export class SharedLiveHost {
  private host?: ChildProcess;
  private exited?: Promise<void>;
  private starting?: Promise<void>;
  private sessions = new Map<string, Entry>();

  constructor(
    private spawnProcess: SpawnLive,
    private dataDir: string,
    private samplingScale = 1,
  ) {}

  /** Sessions currently inside the host. */
  get size() {
    return this.sessions.size;
  }

  readonly spawn: SpawnLive = (python, args) => {
    const out = argument(args, '--out');
    const session = out ? path.basename(out) : '';
    const entry = this.entry(session);
    void this.send(python, entry, {
      cmd: 'start',
      session,
      payload: argument(args, '--payload'),
      out,
      min_confidence: Number(argument(args, '--min-confidence') ?? 0.85),
      max_track_seconds: Number(argument(args, '--max-track-seconds') ?? 30),
    }).catch((error) => {
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
      if (input.includes('stop\n')) {
        input = '';
        this.write({ cmd: 'stop', session });
      }
    });
    const entry = { child, stdout, stderr, closed: false };
    this.sessions.set(session, entry);
    return entry;
  }

  private async send(python: string, entry: Entry, command: Record<string, unknown>) {
    // A host still finishing its last session is waited for, never reused while exiting.
    while (!this.host)
      await (this.starting ??= (async () => {
        await this.exited;
        await this.startHost(python);
      })().finally(() => (this.starting = undefined)));
    entry.host = this.host;
    this.write(command);
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
      if (this.host === host) this.host = undefined;
      // Its sessions the host did not report as finished end with it (a crash or a kill).
      for (const [session, entry] of [...this.sessions])
        if (entry.host === host) this.close(session, code ?? null, true);
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
    // The last session out stops the host, releasing GPU memory for upload jobs.
    if (!this.sessions.size && this.host && !hostGone) {
      const host = this.host;
      this.host = undefined;
      host.stdin?.end();
    }
  }

  /** Kill the host and with it every session; they finish as exited processes. */
  kill() {
    const hosts = new Set([...this.sessions.values()].map((entry) => entry.host));
    for (const host of hosts) if (host) void stopTree(host);
  }
}
