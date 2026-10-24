import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

// Shared fixtures for live tests: model files, track folders and a fake live process.
export const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR4nGPkEpFjwAaYsIqSJQEAGNgARL3K8HcAAAAASUVORK5CYII=',
  'base64',
);

/** Test-only pipeline config with a joint (live-capable) and a single-crop profile. */
export async function livePipelines(root: string) {
  const models = join(root, 'models');
  await mkdir(join(models, 'adapter'), { recursive: true });
  await writeFile(join(models, 'adapter/ocr.py'), '# test-only adapter source');
  await writeFile(join(models, 'detector.pt'), 'test-checkpoint');
  await writeFile(join(models, 'ocr.pt'), 'test-checkpoint');
  const recognizer = {
    factory: 'ocr:create',
    module_root: 'adapter',
    checkpoint: 'ocr.pt',
    version: 'test',
    preprocessing_version: 'test-rgb',
  };
  const detector = { model: 'yolo11l', checkpoint: 'detector.pt', version: 'yolo11l' };
  await writeFile(
    join(models, 'pipelines.json'),
    JSON.stringify({
      pipelines: [
        {
          id: 'joint',
          version: '1',
          detector,
          recognizer: { ...recognizer, input_mode: 'five_frame_joint' },
        },
        { id: 'single', version: '1', detector, recognizer },
      ],
    }),
  );
  return join(models, 'pipelines.json');
}

/** A track folder as `python -m app.live` writes it (keys relative to the data dir). */
export async function writeTrack(
  dataDir: string,
  sessionId: string,
  key: string,
  options: { duplicateOf?: string; status?: string; text?: string; missingCrop?: boolean } = {},
) {
  const base = `live/${sessionId}/tracks/${key}`;
  await mkdir(join(dataDir, base, 'crops'), { recursive: true });
  await mkdir(join(dataDir, base, 'keyframes'), { recursive: true });
  const text = options.text ?? 'ABC1234';
  const detections = [];
  for (let i = 1; i <= 5; i++) {
    const crop = `${base}/crops/0${i}.png`;
    const frame = `${base}/keyframes/frame_${i}.png`;
    if (!(options.missingCrop && i === 5)) await writeFile(join(dataDir, crop), image);
    await writeFile(join(dataDir, frame), image);
    detections.push({
      selected_order: i,
      frame_index: i * 8,
      timestamp_seconds: 100 + i * 0.8,
      timestamp_source: 'live_pts',
      bbox: [0, 0, 8, 4],
      crop_bbox: [0, 0, 8, 4],
      detection_score: 0.9,
      crop_storage_key: crop,
      frame_storage_key: frame,
      crop_width: 8,
      crop_height: 4,
      predictions: [],
    });
  }
  const record = {
    track: key,
    epoch: 0,
    status: options.status ?? 'readable',
    confidence: 0.9,
    duplicate_of: options.duplicateOf ?? null,
    observations: 12,
    captured_from: '2026-10-24T10:00:00.000Z',
    captured_to: '2026-10-24T10:00:04.000Z',
    appearance: {
      source_track_id: key,
      first_frame: 8,
      last_frame: 40,
      start_seconds: 100.8,
      end_seconds: 104,
      detections,
      machine_text: text,
      machine_status: 'readable',
      agreement_count: null,
      recognition_method: 'joint_multiframe',
      predictions: [
        {
          variant: 'joint',
          raw_text: text,
          normalized_text: text,
          ocr_score: null,
          character_scores: null,
          input_storage_keys: detections.map((d) => d.crop_storage_key),
          frame_weights: null,
          decoding: null,
          latency_ms: 5,
        },
      ],
    },
  };
  await writeFile(join(dataDir, base, 'track.json'), JSON.stringify(record));
}

export type Fake = ChildProcess & {
  line(event: Record<string, unknown>): void;
  exit(code: number): void;
  input: string;
};

/** Stand-in for the live process: tests write its stdout and read its stdin. */
export function fakeChild(onStop?: (child: Fake) => void): Fake {
  const child = new EventEmitter() as Fake;
  const [stdin, stdout, stderr] = [new PassThrough(), new PassThrough(), new PassThrough()];
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    input: '',
    line: (event: Record<string, unknown>) => stdout.write(JSON.stringify(event) + '\n'),
    exit: (code: number) => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit('close', code));
    },
  });
  stdin.on('data', (chunk) => {
    child.input += String(chunk);
    if (child.input.includes('stop\n')) onStop?.(child);
  });
  return child;
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
