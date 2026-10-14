import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { Database } from '../src/database/database';
import { migrate } from '../src/database/migrate';

const execute = promisify(execFile);
const projectData = resolve(process.cwd(), 'data');

export interface TestDatabase {
  database: Database;
  url: string;
  root: string;
  dispose(): Promise<void>;
}

function checkedTestRoot(root: string): string {
  const path = resolve(root);
  const within = relative(projectData, path);
  if (
    !within ||
    within.startsWith('..') ||
    isAbsolute(within) ||
    !/^test-postgres-[a-f0-9]{32}$/.test(basename(path)) ||
    dirname(path) !== projectData
  ) {
    throw new Error('Refusing to remove a path outside the isolated PostgreSQL test directory.');
  }
  return path;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Cannot select test PostgreSQL port.');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function postgresBinary(name: string): Promise<string> {
  if (process.env.PG_BIN)
    return join(process.env.PG_BIN, process.platform === 'win32' ? `${name}.exe` : name);
  if (process.platform !== 'win32') return name;
  for (const version of ['18', '17', '16', '15']) {
    const binary = join(
      process.env.ProgramFiles ?? 'C:/Program Files',
      'PostgreSQL',
      version,
      'bin',
      `${name}.exe`,
    );
    try {
      await access(binary);
      return binary;
    } catch {
      /* Try the next installed version. */
    }
  }
  throw new Error(
    'Set PG_BIN to installed PostgreSQL binaries or TEST_DATABASE_URL to a test server.',
  );
}

/** A separate temporary cluster, or a new database on an explicitly supplied test server. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const identity = randomUUID().replaceAll('-', '');
  const root = checkedTestRoot(join(projectData, `test-postgres-${identity}`));
  await mkdir(root, { recursive: true });
  let connectionUrl: string;
  let stopServer: (() => Promise<void>) | undefined;
  let database: Database | undefined;
  try {
    if (process.env.TEST_DATABASE_URL) {
      const url = new URL(process.env.TEST_DATABASE_URL);
      const name = `test_${identity}`;
      const administration = new Pool({ connectionString: url.toString() });
      try {
        await administration.query(`CREATE DATABASE "${name}"`);
      } finally {
        await administration.end();
      }
      const originalUrl = url.toString();
      url.pathname = `/${name}`;
      connectionUrl = url.toString();
      stopServer = async () => {
        const cleanup = new Pool({ connectionString: originalUrl });
        try {
          await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
      };
    } else {
      const initdb = await postgresBinary('initdb');
      const pgctl = await postgresBinary('pg_ctl');
      const cluster = join(root, 'cluster');
      const log = join(root, 'postgres.log');
      const port = await freePort();
      // This cluster is disposable: skipping initdb fsync avoids slow Windows setup.
      await execute(
        initdb,
        [
          '-D',
          cluster,
          '-U',
          'plate_test',
          '--auth=trust',
          '--encoding=UTF8',
          '--locale=C',
          '--no-sync',
        ],
        { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const options = `-h 127.0.0.1 -p ${port}${process.platform === 'win32' ? '' : ` -k ${root}`}`;
      try {
        await execute(pgctl, ['-D', cluster, '-l', log, '-o', options, '-w', '-t', '60', 'start'], {
          windowsHide: true,
          timeout: 75_000,
          maxBuffer: 2 * 1024 * 1024,
        });
      } catch (error) {
        const detail = await readFile(log, 'utf8').catch(() => 'No PostgreSQL log was produced.');
        throw new Error(`Isolated PostgreSQL startup failed: ${detail}`, { cause: error });
      }
      stopServer = async () => {
        await execute(pgctl, ['-D', cluster, '-m', 'fast', '-w', '-t', '30', 'stop'], {
          windowsHide: true,
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
        });
      };
      connectionUrl = `postgresql://plate_test@127.0.0.1:${port}/postgres`;
    }
    database = new Database(connectionUrl);
    await migrate(database);
    let disposed = false;
    return {
      database,
      url: connectionUrl,
      root,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await database!.onModuleDestroy();
        await stopServer!();
        await rm(checkedTestRoot(root), {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 250,
        });
      },
    };
  } catch (error) {
    if (database) await database.onModuleDestroy().catch(() => undefined);
    if (stopServer) await stopServer().catch(() => undefined);
    await rm(checkedTestRoot(root), {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 250,
    }).catch(() => undefined);
    throw error;
  }
}

export function newId(): string {
  return randomUUID().replaceAll('-', '');
}

export async function seedUser(
  database: Database,
  role: 'admin' | 'user' = 'user',
  password = 'a-test-password-123',
) {
  const id = newId();
  const email = `${id}@example.test`;
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const encoded = `scrypt$16384$8$1$${salt.toString('hex')}$${digest.toString('hex')}`;
  await database.query(
    `INSERT INTO users (id,email,password_hash,display_name,role) VALUES ($1,$2,$3,$4,$5)`,
    [id, email, encoded, `Test ${role}`, role],
  );
  return { id, email, password, role };
}
