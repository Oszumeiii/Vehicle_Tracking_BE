import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export type PipelineSnapshot = Record<string, any>;

export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function isFile(file: string) {
  return stat(file)
    .then((value) => value.isFile())
    .catch(() => false);
}

async function codeFiles(root: string): Promise<{ path: string; sha256: string }[]> {
  const found: { path: string; sha256: string }[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === '__pycache__') continue;
    const file = path.join(root, item.name);
    if (item.isDirectory()) found.push(...(await codeFiles(file)));
    else if (item.isFile() && /\.(py|json|ya?ml)$/.test(item.name))
      found.push({ path: file, sha256: await sha256(file) });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// Ultralytics license-plate fine-tunes (morsetechlab v1n/v1l); one class, License_Plate.
const DETECTOR_MODELS = ['yolo11n', 'yolo11l'];

@Injectable()
export class PipelineRegistry {
  private async profiles(): Promise<{ profiles: PipelineSnapshot[]; base: string }> {
    const config = process.env.PLATE_PIPELINES_CONFIG;
    if (!config) return { profiles: [], base: process.cwd() };
    try {
      const document = JSON.parse((await readFile(config, 'utf8')).replace(/^\uFEFF/, ''));
      const profiles = document.pipelines;
      if (!Array.isArray(profiles)) throw new Error();
      const ids = profiles.map((p) => p.id);
      if (
        ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error();
      return { profiles, base: path.dirname(path.resolve(config)) };
    } catch {
      throw new ServiceUnavailableException('Pipeline configuration is unavailable or invalid');
    }
  }

  private async snapshot(profile: PipelineSnapshot, base: string): Promise<PipelineSnapshot> {
    const snapshot = structuredClone(profile);
    try {
      const python = process.env.PLATE_PIPELINE_PYTHON;
      if (!python || !(await isFile(path.resolve(python))))
        throw new Error('Configured ML interpreter is unavailable');
      if (!snapshot.version) throw new Error('Pipeline version is required');
      snapshot.task ??= 'recognize';
      if (!['prepare', 'recognize'].includes(snapshot.task))
        throw new Error('Invalid pipeline task');
      const recognize = snapshot.task === 'recognize';
      snapshot.version = String(snapshot.version);
      // Tracking and OCR source both live in app/recognition (pinned below).
      if ('pipeline_root' in snapshot)
        throw new Error('pipeline_root is no longer supported; tracking runs from app/recognition');
      const code: { path: string; sha256: string }[] = [];
      for (const component of recognize ? ['detector', 'recognizer'] : ['detector']) {
        const spec = snapshot[component];
        if (!spec?.version || !spec.checkpoint)
          throw new Error('Model version and checkpoint are required');
        spec.checkpoint = path.resolve(base, spec.checkpoint);
        if (!(await isFile(spec.checkpoint))) throw new Error('Model checkpoint is unavailable');
        const actual = await sha256(spec.checkpoint);
        if (spec.sha256 && spec.sha256 !== actual) throw new Error('Checkpoint checksum differs');
        spec.sha256 = actual;
      }
      snapshot.detector.model ??= 'yolo11n';
      if (!DETECTOR_MODELS.includes(snapshot.detector.model))
        throw new Error('Unsupported license-plate detector');
      if (recognize) {
        const recognizer = snapshot.recognizer;
        recognizer.input_mode ??= 'single_crop';
        if (!['single_crop', 'five_frame_joint'].includes(recognizer.input_mode))
          throw new Error('Invalid recognizer input mode');
        if (
          typeof recognizer.factory !== 'string' ||
          !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/.test(recognizer.factory)
        )
          throw new Error('Recognizer factory is invalid');
        if (!recognizer.preprocessing_version)
          throw new Error('Recognizer preprocessing version is required');
        recognizer.module_root = path.resolve(base, recognizer.module_root);
        const module = path.join(
          recognizer.module_root,
          ...recognizer.factory.split(':')[0].split('.'),
        );
        const source = (await isFile(`${module}.py`))
          ? `${module}.py`
          : path.join(module, '__init__.py');
        if (!(await isFile(source))) throw new Error('Recognizer adapter source is unavailable');
        // A standalone adapter can import sibling preprocessing/decoder modules.
        // Pin the dedicated adapter source root, not just the factory's file.
        code.push(...(await codeFiles(recognizer.module_root)));
        recognizer.config ??= {};
      } else {
        // A preparation profile does not execute or claim any OCR configuration.
        delete snapshot.recognizer;
      }
      // Defaults are the PBL6 notebook's LOW/MED/HIGH_FPS.
      const sampling = {
        low_fps: 8,
        med_fps: 12,
        high_fps: 15,
        threshold_low: 2,
        threshold_high: 6,
      };
      if (Object.keys(snapshot.sampling ?? {}).some((k) => !(k in sampling)))
        throw new Error('Unsupported sampling option');
      Object.assign(sampling, snapshot.sampling);
      if (
        Object.values(sampling).some((v) => !Number.isFinite(v) || v <= 0) ||
        sampling.low_fps > sampling.med_fps ||
        sampling.med_fps > sampling.high_fps ||
        sampling.threshold_low >= sampling.threshold_high
      )
        throw new Error('Invalid sampling rates or thresholds');
      const tracking = {
        imgsz: 1280,
        batch: 16,
        track_buffer_seconds: 1.5,
        crop_padding: 0.15,
        crop_confidence: 0.25,
        min_frames: 5,
      };
      if (Object.keys(snapshot.tracking ?? {}).some((k) => !(k in tracking)))
        throw new Error('Unsupported tracking option');
      Object.assign(tracking, snapshot.tracking);
      if (
        Object.values(tracking).some((v) => !Number.isFinite(v)) ||
        !Number.isInteger(tracking.imgsz) ||
        tracking.imgsz < 32 ||
        !Number.isInteger(tracking.batch) ||
        tracking.batch < 1 ||
        tracking.track_buffer_seconds <= 0 ||
        tracking.crop_padding < 0 ||
        tracking.crop_padding > 1 ||
        tracking.crop_confidence < 0.1 ||
        tracking.crop_confidence > 1 ||
        ![4, 5].includes(tracking.min_frames) ||
        // Four-crop tracks are read only by the joint model (one crop is repeated).
        (tracking.min_frames === 4 &&
          !(recognize && snapshot.recognizer?.input_mode === 'five_frame_joint'))
      )
        throw new Error('Invalid tracking configuration');
      const gate = {
        enabled: true,
        probe_seconds: 0.25,
        empty_confirmations: 3,
        motion_fraction: 0.003,
        warmup_frames: 60,
      };
      if (Object.keys(snapshot.empty_scene_gate ?? {}).some((k) => !(k in gate)))
        throw new Error('Unsupported empty-scene gate option');
      Object.assign(gate, snapshot.empty_scene_gate);
      if (
        typeof gate.enabled !== 'boolean' ||
        !Number.isFinite(gate.probe_seconds) ||
        gate.probe_seconds <= 0 ||
        !Number.isInteger(gate.empty_confirmations) ||
        gate.empty_confirmations < 1 ||
        !Number.isFinite(gate.motion_fraction) ||
        gate.motion_fraction <= 0 ||
        gate.motion_fraction > 1 ||
        !Number.isInteger(gate.warmup_frames) ||
        gate.warmup_frames < 1
      )
        throw new Error('Invalid empty-scene gate configuration');
      code.push(...(await codeFiles(path.resolve('app/recognition'))));
      const device = process.env.PLATE_DEVICE ?? 'cpu';
      if (!['cpu', 'cuda'].includes(device)) throw new Error('Unsupported inference device');
      const joint = recognize && snapshot.recognizer.input_mode === 'five_frame_joint';
      return {
        ...snapshot,
        code_files: code,
        sampling,
        tracking,
        empty_scene_gate: gate,
        pipeline_python: path.resolve(python),
        device,
        fusion: recognize
          ? joint
            ? { version: 'model-joint-five-frame-v1', video_crops: 5 }
            : { version: 'whole-plate-majority-v1', required_votes: 3, video_crops: 5 }
          : null,
        timestamp_source: 'video_pts',
        media_types: joint ? ['video'] : ['image', 'video'],
        input_modes: joint ? ['scene'] : ['scene', 'plate_crop'],
      };
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error && !('code' in error)
          ? error.message
          : 'Pipeline configuration is incomplete or invalid',
      );
    }
  }

  async list() {
    const { profiles, base } = await this.profiles();
    return Promise.all(
      profiles.map(async (profile) => {
        const joint =
          profile.task !== 'prepare' && profile.recognizer?.input_mode === 'five_frame_joint';
        const item = {
          id: profile.id,
          name: profile.name ?? profile.id,
          version: String(profile.version ?? ''),
          task: profile.task ?? 'recognize',
          media_types: joint ? ['video'] : ['image', 'video'],
          input_modes: joint ? ['scene'] : ['scene', 'plate_crop'],
          ready: false,
          unavailable_reason: null as string | null,
          models: {
            detector: profile.detector?.version ?? null,
            recognizer: profile.task === 'prepare' ? null : (profile.recognizer?.version ?? null),
          },
          preprocessing_version:
            profile.task === 'prepare' ? null : (profile.recognizer?.preprocessing_version ?? null),
        };
        try {
          await this.snapshot(profile, base);
          item.ready = true;
        } catch (error) {
          item.unavailable_reason = error instanceof Error ? error.message : 'Unavailable';
        }
        return item;
      }),
    );
  }

  async resolve(id: string): Promise<PipelineSnapshot> {
    const { profiles, base } = await this.profiles();
    const profile = profiles.find((value) => value.id === id);
    if (!profile) throw new NotFoundException('Unknown pipeline');
    return this.snapshot(profile, base);
  }
}
