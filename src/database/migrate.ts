import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from './database';

/** Readiness must reject an older schema even when the original jobs table exists. */
export async function assertCurrentMigrations(
  database: Database,
  directory = resolve(process.cwd(), 'src/database/migrations'),
): Promise<void> {
  const migrations = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!migrations.length) throw new Error('No SQL migrations were found.');
  const applied = await database.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const known = new Map(applied.rows.map((row) => [row.version, row.checksum]));
  if (known.size !== migrations.length) throw new Error('Database migration set differs.');
  for (const filename of migrations) {
    const sql = await readFile(resolve(directory, filename), 'utf8');
    if (known.get(filename) !== createHash('sha256').update(sql).digest('hex'))
      throw new Error('Database migrations are not current.');
  }
}

/** Apply each version once; checksum protection prevents silent schema drift. */
export async function migrate(
  database: Database,
  directory = resolve(process.cwd(), 'src/database/migrations'),
): Promise<string[]> {
  const migrations = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (migrations.length === 0) throw new Error('No SQL migrations were found.');
  return database.transaction(async (client) => {
    // Transaction-scoped advisory lock prevents two startup/CLI runs racing.
    await client.query('SELECT pg_advisory_xact_lock(742108327, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const known = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    const changed: string[] = [];
    for (const filename of migrations) {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (known.has(filename)) {
        if (known.get(filename) !== checksum)
          throw new Error(`Previously applied migration ${filename} has changed.`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
      changed.push(filename);
    }
    for (const version of known.keys()) {
      if (!migrations.includes(version))
        throw new Error(`Database contains unknown migration ${version}.`);
    }
    return changed;
  });
}
