import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/*
 * Which code a process runs, so an operator learns when the checkout has moved on without
 * it: a build that was never restarted, or source that was never built. Both happened (a
 * merged fix sat unused for hours because the API and worker kept the previous build).
 */

/** The checkout (or image) the running code was loaded from: dist/src/system -> root. */
export const codeRoot = () => process.env.PLATE_CODE_ROOT ?? path.resolve(__dirname, '../../..');

const SKIP = new Set(['node_modules', '__pycache__']);

async function list(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    if (item.name.startsWith('.') || SKIP.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await list(full, ext, out);
    else if (item.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// Hash of each file, reused while its size and modification time are unchanged.
const hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();

/**
 * Content fingerprint of the `ext` files under `dir`, or null when there are none. A
 * rebuild that produces the same output keeps the same fingerprint.
 */
export async function fingerprint(dir: string, ext: string) {
  const files = (await list(dir, ext)).sort();
  if (!files.length) return null;
  const all = createHash('sha256');
  for (const file of files) {
    const info = await stat(file);
    let entry = hashes.get(file);
    if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      const hash = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
      entry = { mtimeMs: info.mtimeMs, size: info.size, hash };
      hashes.set(file, entry);
    }
    all.update(`${path.relative(dir, file)}\0${entry.hash}\n`);
  }
  return all.digest('hex').slice(0, 16);
}

/** Newest modification time (ms) of the `ext` files under `dir`, or null when there are none. */
export async function newest(dir: string, ext: string) {
  let latest: number | null = null;
  for (const file of await list(dir, ext)) {
    const { mtimeMs } = await stat(file);
    if (latest === null || mtimeMs > latest) latest = mtimeMs;
  }
  return latest;
}

export type RunningCode = { build: string | null; python: string | null };

/** The compiled backend (dist/src) and the Python recognition code (app) under `root`. */
export async function runningCode(root = codeRoot()): Promise<RunningCode> {
  try {
    return {
      build: await fingerprint(path.join(root, 'dist', 'src'), '.js'),
      python: await fingerprint(path.join(root, 'app'), '.py'),
    };
  } catch {
    return { build: null, python: null };
  }
}

export type WorkerRun = RunningCode & { pid: number; started_at: string };

const runFile = (dataDir: string) => path.join(dataDir, 'run', 'worker.json');

/** Written by the worker when it starts: the API compares it with the code on disk. */
export async function recordWorkerRun(dataDir: string) {
  const run: WorkerRun = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    ...(await runningCode()),
  };
  await mkdir(path.dirname(runFile(dataDir)), { recursive: true });
  await writeFile(runFile(dataDir), JSON.stringify(run));
}

/** What the running worker recorded at start, or null when it recorded nothing. */
export async function readWorkerRun(dataDir: string): Promise<WorkerRun | null> {
  try {
    return JSON.parse(await readFile(runFile(dataDir), 'utf8')) as WorkerRun;
  } catch {
    return null;
  }
}
