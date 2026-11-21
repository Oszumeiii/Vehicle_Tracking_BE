import 'reflect-metadata';
import 'dotenv/config';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { settings } from './common/config';
import { safeStorage } from './recognition/engine';
import { cloudStore, restoreLocal, type CloudStore } from './media/cloud';
import { cloudPush } from './media/cloud-push';
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
      // Evidence moved to the bucket (cloud sync) is fetched back first.
      await restoreLocal(safeStorage(dataDir, crop), crop);
      await copyFile(
        safeStorage(dataDir, crop),
        path.join(folder, `crop_${detection.selected_order}${path.extname(crop)}`),
      );
      if (detection.frame_storage_key) {
        await restoreLocal(
          safeStorage(dataDir, detection.frame_storage_key),
          detection.frame_storage_key,
        );
        await copyFile(
          safeStorage(dataDir, detection.frame_storage_key),
          path.join(
            folder,
            `frame_${detection.selected_order}${path.extname(detection.frame_storage_key)}`,
          ),
        );
      }
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

/** Write, read back, link and delete a small object: proves the keys and bucket work. */
export async function cloudCheck(store: CloudStore) {
  const key = `healthcheck/${randomUUID()}.json`;
  const folder = await mkdtemp(path.join(tmpdir(), 'plate-cloud-'));
  try {
    const file = path.join(folder, 'probe.json');
    const body = JSON.stringify({ at: new Date().toISOString() });
    await writeFile(file, body);
    await store.put(key, file);
    if ((await store.head(key)) !== Buffer.byteLength(body))
      throw new Error('Uploaded size differs.');
    const linked = await fetch(store.presign(key, 60));
    if (!linked.ok || (await linked.text()) !== body)
      throw new Error(`Presigned link failed (${linked.status}).`);
    await store.remove(key);
    if ((await store.head(key)) !== null) throw new Error('Delete did not remove the object.');
    return 'Cloud storage OK: upload, read, presigned link and delete all work.';
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
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
  if (command === 'cloud-check' || command === 'cloud-push') {
    const store = cloudStore();
    if (!store)
      throw new Error(
        'Cloud storage is off: set PLATE_R2_ACCOUNT_ID (or PLATE_S3_ENDPOINT), PLATE_S3_BUCKET, ' +
          'PLATE_S3_ACCESS_KEY_ID and PLATE_S3_SECRET_ACCESS_KEY in .env (docs/CLOUD_STORAGE.md).',
      );
    if (command === 'cloud-check') {
      console.log(`Bucket: ${store.label}`);
      console.log(await cloudCheck(store));
      return;
    }
    const flags = new Set(args);
    const days = Number(argument(args, '--older-than-days') ?? 0);
    if (!Number.isFinite(days) || days < 0) throw new Error('--older-than-days must be >= 0.');
    const limit = argument(args, '--max-gb');
    const maxGb = limit === undefined ? undefined : Number(limit);
    if (maxGb !== undefined && !(maxGb > 0)) throw new Error('--max-gb must be a positive number.');
    const media = flags.has('--media') || flags.has('--all');
    const evidence = flags.has('--evidence') || flags.has('--all') || !media;
    const database = new Database();
    try {
      const summary = await cloudPush(database, settings().dataDir, store, {
        evidence,
        media,
        freeLocal: flags.has('--free-local'),
        olderThanDays: days,
        dryRun: flags.has('--dry-run'),
        concurrency: 8,
        maxGb,
      });
      const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
      console.log(
        `Uploaded ${summary.uploaded} (${mb(summary.uploadedBytes)}), already there ${summary.alreadyThere}, ` +
          `freed ${summary.freed} local file(s) (${mb(summary.freedBytes)}), kept ${summary.kept} replayed video(s), ` +
          `${summary.overLimit} over --max-gb, failed ${summary.failed}. Bucket now ${mb(summary.bucketBytes)}.`,
      );
      if (summary.failed) process.exitCode = 1;
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
        ' | node dist/src/cli.js export-live-samples --source CAMERA_ID --out DIR [--per-bin N]' +
        ' | node dist/src/cli.js cloud-check' +
        ' | node dist/src/cli.js cloud-push [--evidence|--media|--all] [--free-local] [--older-than-days N] [--max-gb N] [--dry-run]',
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
