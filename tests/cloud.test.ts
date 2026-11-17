import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import {
  cloudSettings,
  type CloudObject,
  type CloudStore,
  restoreLocal,
  signRequest,
  useCloudStore,
} from '../src/media/cloud';
import { cloudPush, type PushOptions } from '../src/media/cloud-push';
import { Storage } from '../src/media/storage';

// AWS's published Signature Version 4 examples (S3 "Authenticating Requests" docs).
const AWS = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  date: new Date('2013-05-24T00:00:00Z'),
};

test('signs a presigned GET exactly like the AWS example', () => {
  const { url } = signRequest({
    ...AWS,
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    expires: 86400,
  });
  assert.match(
    url,
    /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request/,
  );
  assert.ok(
    url.endsWith(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    ),
    url,
  );
});

test('signs a header-authenticated GET exactly like the AWS example', () => {
  const { headers } = signRequest({
    ...AWS,
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { Range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('cloud storage is off, refused when half set, and derives the R2 endpoint', () => {
  assert.equal(cloudSettings({}), null);
  assert.throws(() => cloudSettings({ PLATE_S3_BUCKET: 'plates' }), /partly configured/);
  const keys = { PLATE_S3_ACCESS_KEY_ID: 'a', PLATE_S3_SECRET_ACCESS_KEY: 'b' };
  assert.deepEqual(
    cloudSettings({
      PLATE_R2_ACCOUNT_ID: 'abc123',
      PLATE_S3_BUCKET: 'plates',
      ...keys,
      PLATE_S3_PREFIX: '/pbl6/',
    }),
    {
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      bucket: 'plates',
      region: 'auto',
      prefix: 'pbl6',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    },
  );
  assert.throws(
    () =>
      cloudSettings({
        PLATE_S3_ENDPOINT: 'http://example.com',
        PLATE_S3_BUCKET: 'plates',
        ...keys,
      }),
    /https/,
  );
});

/** Bucket kept in memory; files are copied into a folder so downloads return real bytes. */
class MemoryStore implements CloudStore {
  label = 'memory/test';
  objects = new Map<string, Buffer>();
  async head(key: string) {
    return this.objects.get(key)?.length ?? null;
  }
  async put(key: string, file: string) {
    this.objects.set(key, await readFile(file));
  }
  async download(key: string, file: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, body);
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async *list(prefix: string): AsyncGenerator<CloudObject> {
    for (const [key, body] of this.objects)
      if (key.startsWith(prefix)) yield { key, size: body.length };
  }
  presign(key: string, seconds = 300) {
    return `https://bucket.example/${key}?expires=${seconds}`;
  }
}

let dataDir: string;
const exists = async (key: string) => Boolean(await stat(join(dataDir, key)).catch(() => null));
const put = async (key: string, bytes: number) => {
  await mkdir(join(dataDir, key, '..'), { recursive: true });
  await writeFile(join(dataDir, key), Buffer.alloc(bytes, 1));
};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'plate-cloud-test-'));
});
after(async () => {
  useCloudStore(undefined);
  await rm(dataDir, { recursive: true, force: true });
});

// Finished job j1 (crops, keyframe, json); running job j2; uploads: replayed m1, busy m2, free m3.
const db = {
  async query(sql: string) {
    if (!sql.includes('FROM media_assets')) return { rows: [{ id: 'j1' }] } as any;
    return {
      rows: [
        { storage_key: 'media/m1/input.mp4', replayed: true, busy: false },
        { storage_key: 'media/m2/input.mp4', replayed: false, busy: true },
        { storage_key: 'media/m3/input.mp4', replayed: false, busy: false },
      ],
    } as any;
  },
};
const options = (extra: Partial<PushOptions> = {}): PushOptions => ({
  evidence: true,
  media: true,
  freeLocal: false,
  olderThanDays: 0,
  dryRun: false,
  concurrency: 3,
  ...extra,
});

test('cloud-push copies finished evidence and idle uploads, frees only what it may', async () => {
  await put('recognition/j1/tracks/track_000001/01_frame_0000001.png', 100);
  await put('recognition/j1/keyframes/frame_0000001.jpg', 300);
  await put('recognition/j1/track.json', 10);
  await put('recognition/j2/tracks/track_000001/01_frame_0000001.png', 100);
  await put('media/m1/input.mp4', 1000);
  await put('media/m2/input.mp4', 1000);
  await put('media/m3/input.mp4', 2000);
  const store = new MemoryStore();
  const quiet = () => {};

  const dry = await cloudPush(
    db,
    dataDir,
    store,
    options({ freeLocal: true, dryRun: true }),
    quiet,
  );
  assert.equal(dry.uploaded, 4);
  assert.equal(store.objects.size, 0);
  assert.ok(await exists('media/m3/input.mp4'));

  // A cap that fits the evidence and the replayed video but not the 2000-byte upload.
  const capped = await cloudPush(db, dataDir, store, options({ maxGb: 1500 / 1024 ** 3 }), quiet);
  assert.deepEqual([capped.uploaded, capped.overLimit], [3, 1]);
  assert.deepEqual([...store.objects.keys()].sort(), [
    'media/m1/input.mp4',
    'recognition/j1/keyframes/frame_0000001.jpg',
    'recognition/j1/tracks/track_000001/01_frame_0000001.png',
  ]);

  const freed = await cloudPush(db, dataDir, store, options({ freeLocal: true }), quiet);
  assert.deepEqual(
    [freed.uploaded, freed.alreadyThere, freed.freed, freed.kept, freed.failed],
    [1, 3, 3, 1, 0],
  );
  assert.equal(freed.freedBytes, 100 + 300 + 2000);
  assert.ok(!(await exists('recognition/j1/keyframes/frame_0000001.jpg')));
  assert.ok(!(await exists('media/m3/input.mp4')));
  assert.ok(await exists('recognition/j1/track.json'), 'json stays local');
  assert.ok(await exists('media/m1/input.mp4'), 'a replayed video stays local');
  assert.ok(await exists('media/m2/input.mp4'), 'a busy video is not touched');
  assert.ok(await exists('recognition/j2/tracks/track_000001/01_frame_0000001.png'));
  assert.ok(!store.objects.has('media/m2/input.mp4'));

  // A job needing m3 again gets it back from the bucket.
  assert.equal(
    await restoreLocal(join(dataDir, 'media/m3/input.mp4'), 'media/m3/input.mp4', store),
    true,
  );
  assert.equal((await stat(join(dataDir, 'media/m3/input.mp4'))).size, 2000);
  assert.equal(
    await restoreLocal(join(dataDir, 'media/m3/input.mp4'), 'media/m3/input.mp4', store),
    false,
  );
});

test('a freed file is served by redirect to the bucket; local and invalid keys are unchanged', async () => {
  const previous = process.env.PLATE_DATA_DIR;
  process.env.PLATE_DATA_DIR = dataDir;
  try {
    const storage = new Storage();
    const response = () => {
      const seen: Record<string, unknown> = {};
      return {
        seen,
        setHeader: (name: string, value: string) => (seen[name] = value),
        redirect: (status: number, url: string) => Object.assign(seen, { status, url }),
        type: (value: string) => ((seen.type = value), undefined),
        sendFile: (file: string) => (seen.file = file),
      };
    };
    await put('recognition/j9/keyframes/local.jpg', 5);
    useCloudStore(null);
    await assert.rejects(
      storage.send(response() as any, 'recognition/j9/keyframes/gone.jpg'),
      NotFoundException,
    );
    useCloudStore(new MemoryStore());
    const local = response();
    await storage.send(local as any, 'recognition/j9/keyframes/local.jpg', 'image/jpeg');
    assert.equal(local.seen.type, 'image/jpeg');
    assert.match(String(local.seen.file), /local\.jpg$/);
    const gone = response();
    await storage.send(gone as any, 'recognition/j9/keyframes/gone.jpg');
    assert.equal(gone.seen.status, 302);
    assert.equal(
      gone.seen.url,
      'https://bucket.example/recognition/j9/keyframes/gone.jpg?expires=600',
    );
    assert.equal(gone.seen['Cache-Control'], 'private, no-store');
    await assert.rejects(storage.send(response() as any, '../outside.jpg'), NotFoundException);
  } finally {
    useCloudStore(undefined);
    if (previous === undefined) delete process.env.PLATE_DATA_DIR;
    else process.env.PLATE_DATA_DIR = previous;
  }
});
