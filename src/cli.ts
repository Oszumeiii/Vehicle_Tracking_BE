import 'reflect-metadata';
import 'dotenv/config';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Database } from './database/database';
import { migrate } from './database/migrate';
import { PipelineRegistry } from './recognition/registry';
import { z } from 'zod';

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

/** Payload for `python -m app.live`: the same pinned snapshot a job gets, plus the source. */
export async function livePayload(args: string[]): Promise<string> {
  const pipeline = argument(args, '--pipeline');
  const url = argument(args, '--url');
  const out = argument(args, '--out');
  if (!pipeline || !url || !out)
    throw new Error('Use: live-payload --pipeline ID --url YOUTUBE_URL --out FILE');
  const parsed = z.url().safeParse(url);
  if (!parsed.success || !YOUTUBE_HOSTS.includes(new URL(url).hostname))
    throw new Error('Provide a YouTube watch or live URL.');
  const snapshot = await new PipelineRegistry().resolve(pipeline);
  if (snapshot.task !== 'recognize' || snapshot.recognizer?.input_mode !== 'five_frame_joint')
    throw new Error('Live recognition needs a five_frame_joint recognition pipeline.');
  await writeFile(
    out,
    JSON.stringify({ pipeline_snapshot: snapshot, source: { type: 'youtube', url } }, null, 2),
  );
  return out;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command] = args;
  if (command === 'live-payload') {
    console.log(`Live payload written: ${await livePayload(args)}`);
    return;
  }
  if (!['migrate', 'create-admin'].includes(command ?? '')) {
    throw new Error(
      'Run npm run build first, then use: npm run db:migrate | npm run admin:create -- --email EMAIL' +
        ' | node dist/src/cli.js live-payload --pipeline ID --url YOUTUBE_URL --out FILE',
    );
  }
  const database = new Database();
  try {
    if (command === 'migrate') {
      const changed = await migrate(database);
      console.log(
        changed.length ? `Applied: ${changed.join(', ')}` : 'Database is already up to date.',
      );
      return;
    }
    const email = argument(args, '--email')?.trim().toLowerCase();
    const displayName = argument(args, '--display-name')?.trim() ?? 'Administrator';
    if (!z.email().max(254).safeParse(email).success) {
      throw new Error('Provide a valid --email address.');
    }
    if (!displayName || displayName.length > 120)
      throw new Error('Display name must contain 1-120 characters.');
    const password = process.env.PLATE_ADMIN_PASSWORD;
    if (!password || password.length < 12 || password.length > 128) {
      throw new Error('Set PLATE_ADMIN_PASSWORD to a password containing 12-128 characters.');
    }
    const salt = randomBytes(16);
    const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const hash = `scrypt$16384$8$1$${salt.toString('hex')}$${digest.toString('hex')}`;
    const result = await database.query(
      `INSERT INTO users (id, email, password_hash, display_name, role)
      VALUES ($1, $2, $3, $4, 'admin') ON CONFLICT (email) DO NOTHING RETURNING id`,
      [randomUUID().replaceAll('-', ''), email, hash, displayName],
    );
    if (result.rowCount !== 1) throw new Error('An account with that email already exists.');
    console.log(`Administrator created: ${email}`);
  } finally {
    await database.onModuleDestroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Administrative command failed.');
    process.exitCode = 1;
  });
}
