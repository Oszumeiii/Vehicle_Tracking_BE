import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
  ServiceUnavailableException,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdir, rename, rm, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { diskStorage } from 'multer';
import { settings } from '../common/config';
import { newId } from '../common/http';
import { z } from 'zod';
const run = promisify(execFile);
const metadataSchema = z
  .object({
    media_type: z.enum(['image', 'video']),
    mime_type: z.enum([
      'image/png',
      'image/jpeg',
      'video/mp4',
      'video/quicktime',
      'video/x-msvideo',
    ]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration_seconds: z.number().finite().nonnegative().nullable(),
  })
  .strict();
type MediaMetadata = Omit<z.infer<typeof metadataSchema>, 'width' | 'height'> & {
  width: number | null;
  height: number | null;
};

export function uploadOptions() {
  return {
    storage: diskStorage({
      destination: (_req, _file, callback) => {
        const folder = resolve(settings().dataDir, 'incoming');
        mkdir(folder, { recursive: true }).then(
          () => callback(null, folder),
          (error) => callback(error, folder),
        );
      },
      filename: (_req, _file, callback) => callback(null, newId()),
    }),
    limits: { fileSize: settings().maxUpload, files: 1, fields: 8, fieldSize: 4096, parts: 10 },
  };
}

@Injectable()
export class MediaUploadInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const Interceptor = FileInterceptor('file', uploadOptions());
    return new Interceptor().intercept(context, next);
  }
}

@Injectable()
export class Storage {
  root() {
    return settings().dataDir;
  }
  path(key: string): string {
    if (
      typeof key !== 'string' ||
      !key ||
      key.includes('\\') ||
      key.includes(':') ||
      isAbsolute(key) ||
      key.split('/').includes('..')
    )
      throw new NotFoundException('Artifact not found.');
    const path = resolve(this.root(), key),
      rel = relative(this.root(), path);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new NotFoundException('Artifact not found.');
    return path;
  }
  async file(key: string) {
    const path = this.path(key);
    try {
      const resolved = await realpath(path),
        root = await realpath(this.root()),
        rel = relative(root, resolved);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await stat(resolved)).isFile())
        throw new Error();
      return resolved;
    } catch {
      throw new NotFoundException('Artifact not found.');
    }
  }
  async discardUpload(file?: Express.Multer.File) {
    if (file) {
      const rel = relative(resolve(this.root(), 'incoming'), resolve(file.path));
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) await rm(file.path, { force: true });
    }
  }
  async receive(file: Express.Multer.File | undefined) {
    if (!file) throw new UnprocessableEntityException('file is required.');
    const suffix = extname(file.originalname).toLowerCase();
    let folder: string | undefined;
    try {
      const video = ['.mp4', '.avi', '.mov'].includes(suffix),
        image = ['.png', '.jpg', '.jpeg'].includes(suffix);
      if (!video && !image)
        throw new UnsupportedMediaTypeException('Supported: JPG, PNG, MP4, AVI, MOV.');
      if (!file.size) throw new UnprocessableEntityException('File is empty.');
      if (file.size > settings().maxUpload) throw new PayloadTooLargeException();
      const id = newId(),
        key = `media/${id}/input${suffix}`;
      await mkdir(resolve(this.root(), 'media'), { recursive: true });
      folder = this.path(`media/${id}`);
      await mkdir(folder, { recursive: false });
      const target = this.path(key);
      await rename(file.path, target);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      let metadata: MediaMetadata;
      try {
        const { stdout } = await run(
          settings().python,
          ['-m', 'scripts.probe_media', '--path', target],
          { cwd: process.cwd(), timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        metadata = metadataSchema.parse(JSON.parse(stdout));
        if (metadata.media_type !== (video ? 'video' : 'image'))
          throw new Error('Unexpected metadata type');
      } catch (error) {
        if ((error as { code?: unknown })?.code === 2)
          throw new UnprocessableEntityException(
            'Media cannot be decoded or exceeds image limits.',
          );
        throw new ServiceUnavailableException(
          'Media inspection is unavailable; check the server Python environment.',
        );
      }
      return {
        id,
        storage_key: key,
        original_name: basename(file.originalname.replaceAll('\\', '/')).slice(0, 255),
        size_bytes: file.size,
        sha256: hash.digest('hex'),
        ...metadata,
      };
    } catch (error) {
      if (folder) await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      await this.discardUpload(file);
    }
  }
  async quarantine(key: string) {
    const source = this.path(key),
      trash = this.path(`trash/${newId()}`);
    await mkdir(resolve(this.root(), 'trash'), { recursive: true });
    try {
      await rename(source, trash);
      return {
        restore: () => rename(trash, source),
        purge: () => rm(trash, { recursive: true, force: true }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { restore: async () => {}, purge: async () => {} };
    }
  }
}
