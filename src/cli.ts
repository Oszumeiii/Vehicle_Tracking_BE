import 'reflect-metadata';
import 'dotenv/config';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { settings } from './common/config';
import { safeStorage } from './recognition/engine';
import { Database } from './database/database';
import { migrate } from './database/migrate';
import { sampleLiveTracks } from './evaluation/sampling';
import { PipelineRegistry } from './recognition/registry';
import { isLivePipeline, isYoutubeUrl, livePayload as buildLivePayload } from './live/payload';
import { z } from 'zod';

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** Payload for running `python -m app.live` by hand. */
export async function livePayload(args: string[]): Promise<string> {
  const pipeline = argument(args, '--pipeline');
  const url = argument(args, '--url');
  const out = argument(args, '--out');
  if (!pipeline || !url || !out)
    throw new Error('Use: live-payload --pipeline ID --url YOUTUBE_URL --out FILE');
  if (!isYoutubeUrl(url)) throw new Error('Provide a YouTube watch or live URL.');
  const snapshot = await new PipelineRegistry().resolve(pipeline);
  if (!isLivePipeline(snapshot))
    throw new Error('Live recognition needs a five_frame_joint recognition pipeline.');
  await writeFile(
    out,
    JSON.stringify(buildLivePayload(snapshot, { type: 'youtube', url }), null, 2),
  );
  return out;
}

/**
 * Export live tracks for independent labelling (docs/EVALUATION.md): a stratified
 * sample across confidence bins, each with its five crops and kept keyframes,
 * machine predictions and a ground-truth template the labeller completes.
 */
export async function exportLiveSamples(
  args: string[],
  database = new Database(),
  dataDir = settings().dataDir,
): Promise<{ out: string; samples: number }> {
  const source = argument(args, '--source');
  const session = argument(args, '--session');
  const out = argument(args, '--out');
  const perBin = Number(argument(args, '--per-bin') ?? 20);
  if ((!source && !session) || !out || !Number.isInteger(perBin) || perBin < 1)
    throw new Error(
      'Use: export-live-samples (--source CAMERA_ID | --session SESSION_ID) --out DIR [--per-bin N]',
    );
  const picked = await sampleLiveTracks(database, { source, session }, perBin);
  const predictions = [];
  const samples = [];
  for (const row of picked) {
    const folder = path.join(out, 'samples', row.job_id);
    await mkdir(folder, { recursive: true });
    const evidence = (
      await database.query(
        `SELECT selected_order, crop_storage_key, frame_storage_key FROM plate_detections
        WHERE appearance_id=$1 ORDER BY selected_order`,
        [row.result_id],
      )
    ).rows;
    for (const detection of evidence) {
      const crop = detection.crop_storage_key as string;
      await copyFile(
        safeStorage(dataDir, crop),
        path.join(folder, `crop_${detection.selected_order}${path.extname(crop)}`),
      );
      if (detection.frame_storage_key)
        await copyFile(
          safeStorage(dataDir, detection.frame_storage_key),
          path.join(
            folder,
            `frame_${detection.selected_order}${path.extname(detection.frame_storage_key)}`,
          ),
        );
    }
    predictions.push({
      sample_id: row.job_id,
      variant: 'five_image',
      detected: true,
      plate_text: row.machine_text,
      confidence: row.confidence,
    });
    // The labeller replaces "" with the plate read from the crops, or null if unreadable.
    samples.push({
      sample_id: row.job_id,
      source_id: row.stream_source_id,
      split: 'test',
      plate_text: '',
    });
  }
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'predictions.json'), JSON.stringify({ predictions }, null, 2));
  await writeFile(
    path.join(out, 'ground_truth.template.json'),
    JSON.stringify({ samples }, null, 2),
  );
  return { out, samples: picked.length };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command] = args;
  if (command === 'export-live-samples') {
    const database = new Database();
    try {
      const result = await exportLiveSamples(args, database);
      console.log(`Exported ${result.samples} live samples to ${result.out}`);
    } finally {
      await database.onModuleDestroy();
    }
    return;
  }
  if (command === 'live-payload') {
    console.log(`Live payload written: ${await livePayload(args)}`);
    return;
  }
  if (!['migrate', 'create-admin'].includes(command ?? '')) {
    throw new Error(
      'Run npm run build first, then use: npm run db:migrate | npm run admin:create -- --email EMAIL' +
        ' | node dist/src/cli.js live-payload --pipeline ID --url YOUTUBE_URL --out FILE' +
        ' | node dist/src/cli.js export-live-samples --source CAMERA_ID --out DIR [--per-bin N]',
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
