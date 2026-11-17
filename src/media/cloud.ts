import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * Optional copy of stored files in an S3-compatible bucket (Cloudflare R2, Backblaze B2,
 * MinIO...). Off unless configured. Objects use the same keys as the database
 * (media/<id>/input.mp4, recognition/<job>/tracks/...), so a file pushed to the bucket and
 * removed from the disk is served from there and downloaded again when a job needs it.
 */
export interface CloudSettings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface CloudObject {
  key: string;
  size: number;
}

export interface CloudStore {
  readonly label: string;
  head(key: string): Promise<number | null>;
  put(key: string, file: string): Promise<void>;
  download(key: string, file: string): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): AsyncGenerator<CloudObject>;
  presign(key: string, seconds?: number): string;
}

export function cloudSettings(env: NodeJS.ProcessEnv = process.env): CloudSettings | null {
  const value = (name: string) => env[name]?.trim() ?? '';
  const account = value('PLATE_R2_ACCOUNT_ID');
  const endpoint =
    value('PLATE_S3_ENDPOINT') || (account ? `https://${account}.r2.cloudflarestorage.com` : '');
  const fields = {
    endpoint,
    bucket: value('PLATE_S3_BUCKET'),
    accessKeyId: value('PLATE_S3_ACCESS_KEY_ID'),
    secretAccessKey: value('PLATE_S3_SECRET_ACCESS_KEY'),
  };
  if (Object.values(fields).every((v) => !v)) return null;
  const missing = Object.entries(fields)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length)
    throw new Error(
      `Cloud storage is partly configured (missing ${missing.join(', ')}): set PLATE_S3_ENDPOINT ` +
        'or PLATE_R2_ACCOUNT_ID, PLATE_S3_BUCKET, PLATE_S3_ACCESS_KEY_ID and PLATE_S3_SECRET_ACCESS_KEY.',
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      'PLATE_S3_ENDPOINT must be a URL such as https://<account>.r2.cloudflarestorage.com.',
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('PLATE_S3_ENDPOINT must use https (http only for localhost).');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(fields.bucket))
    throw new Error(
      'PLATE_S3_BUCKET must be a valid bucket name (lowercase letters, digits, - and .).',
    );
  return {
    ...fields,
    endpoint: url.origin,
    region: value('PLATE_S3_REGION') || 'auto',
    prefix: value('PLATE_S3_PREFIX').replace(/^\/+|\/+$/g, ''),
  };
}

let cached: CloudStore | null | undefined;
/** The configured bucket, or null when cloud storage is off. */
export function cloudStore(): CloudStore | null {
  if (cached === undefined) {
    const config = cloudSettings();
    cached = config ? new S3Store(config) : null;
  }
  return cached;
}
/** Tests: replace the store (undefined reads the environment again). */
export function useCloudStore(store: CloudStore | null | undefined) {
  cached = store;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.json': 'application/json',
};
export const mimeType = (key: string) =>
  MIME[path.extname(key).toLowerCase()] ?? 'application/octet-stream';

// ---- AWS Signature Version 4 (the signing every S3-compatible store accepts) ----

const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();
export const UNSIGNED = 'UNSIGNED-PAYLOAD';

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  date?: Date;
  /** Presigned URL valid this many seconds instead of an Authorization header. */
  expires?: number;
  payloadHash?: string;
}

export function signRequest(input: SignInput): { url: string; headers: Record<string, string> } {
  const amzDate = (input.date ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const payloadHash = input.payloadHash ?? UNSIGNED;
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers ?? {}))
    headers[name.toLowerCase()] = String(value);
  const query = [...input.url.searchParams.entries()];
  if (input.expires) {
    const signedHeaders = Object.keys(headers).sort().join(';');
    query.push(
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(input.expires)],
      ['X-Amz-SignedHeaders', signedHeaders],
    );
  } else {
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = payloadHash;
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalQuery = query
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    input.method,
    input.url.pathname,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = hmac(key, toSign).toString('hex');
  const base = `${input.url.origin}${input.url.pathname}`;
  if (input.expires)
    return { url: `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`, headers: {} };
  delete headers.host;
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: canonicalQuery ? `${base}?${canonicalQuery}` : base, headers };
}

const PART = 64 * 1024 * 1024;
const unescapeXml = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
const tag = (xml: string, name: string) =>
  unescapeXml(new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? '');

export class S3Store implements CloudStore {
  constructor(private config: CloudSettings) {}
  get label() {
    return `${new URL(this.config.endpoint).host}/${this.config.bucket}`;
  }
  private objectKey(key: string) {
    if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..'))
      throw new Error(`Invalid storage key: ${key}`);
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }
  private url(key: string | null, query: Record<string, string> = {}) {
    const objectPath =
      key === null ? '' : `/${this.objectKey(key).split('/').map(encode).join('/')}`;
    const url = new URL(`${this.config.endpoint}/${encode(this.config.bucket)}${objectPath}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
    return url;
  }
  private async send(
    method: string,
    url: URL,
    options: { body?: Buffer | string; headers?: Record<string, string>; allow?: number[] } = {},
  ) {
    const signed = signRequest({ method, url, ...this.config, headers: options.headers });
    const response = await fetch(signed.url, {
      method,
      headers: { ...signed.headers, ...(options.headers ?? {}) },
      body:
        typeof options.body === 'string'
          ? options.body
          : options.body && new Uint8Array(options.body),
    });
    if (!response.ok && !(options.allow ?? []).includes(response.status)) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `${method} ${url.pathname} -> ${response.status} ${tag(text, 'Code') || response.statusText}`,
      );
    }
    return response;
  }
  async head(key: string) {
    const response = await this.send('HEAD', this.url(key), { allow: [404] });
    return response.status === 404 ? null : Number(response.headers.get('content-length') ?? 0);
  }
  async put(key: string, file: string) {
    const size = (await stat(file)).size;
    const headers = { 'content-type': mimeType(key) };
    const handle = await open(file, 'r');
    try {
      const read = async (offset: number, length: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new Error(`Short read of ${file}`);
        return buffer;
      };
      if (size <= PART) {
        await (
          await this.send('PUT', this.url(key), { body: await read(0, size), headers })
        ).text();
        return;
      }
      const created = await (
        await this.send('POST', this.url(key, { uploads: '' }), { headers })
      ).text();
      const uploadId = tag(created, 'UploadId');
      if (!uploadId) throw new Error('Multipart upload did not return an UploadId');
      try {
        const parts: string[] = [];
        for (let offset = 0, number = 1; offset < size; offset += PART, number++) {
          const response = await this.send(
            'PUT',
            this.url(key, { partNumber: String(number), uploadId }),
            { body: await read(offset, Math.min(PART, size - offset)) },
          );
          await response.text();
          parts.push(
            `<Part><PartNumber>${number}</PartNumber><ETag>${response.headers.get('etag')}</ETag></Part>`,
          );
        }
        const done = await (
          await this.send('POST', this.url(key, { uploadId }), {
            body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
            headers: { 'content-type': 'application/xml' },
          })
        ).text();
        if (done.includes('<Error>'))
          throw new Error(`Multipart upload failed: ${tag(done, 'Code')}`);
      } catch (error) {
        await this.send('DELETE', this.url(key, { uploadId }), { allow: [404] }).catch(() => {});
        throw error;
      }
    } finally {
      await handle.close();
    }
  }
  async download(key: string, file: string) {
    const response = await this.send('GET', this.url(key));
    if (!response.body) throw new Error(`Empty body for ${key}`);
    await mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.cloud-${process.pid}-${Date.now()}`;
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        createWriteStream(partial),
      );
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  async remove(key: string) {
    await (await this.send('DELETE', this.url(key), { allow: [404] })).text();
  }
  async *list(prefix: string) {
    const strip = this.config.prefix ? this.config.prefix.length + 1 : 0;
    let token = '';
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.objectKey(prefix) };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.send('GET', this.url(null, query))).text();
      for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
        yield { key: tag(body, 'Key').slice(strip), size: Number(tag(body, 'Size')) };
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : '';
    } while (token);
  }
  presign(key: string, seconds = 300) {
    return signRequest({ method: 'GET', url: this.url(key), ...this.config, expires: seconds }).url;
  }
}

/**
 * Bring a file back from the bucket when it is no longer on the disk (a job or replay camera
 * needs a local video). Returns false when there is nothing to restore.
 */
export async function restoreLocal(file: string, key: string, store = cloudStore()) {
  if ((await stat(file).catch(() => null))?.isFile()) return false;
  if (!store || (await store.head(key)) === null) return false;
  await store.download(key, file);
  return true;
}

/** Remove a key, or every key under a folder prefix ending in '/', from the bucket; never throws. */
export async function forgetInCloud(keys: string[], store = cloudStore()) {
  if (!store) return;
  for (const key of keys)
    try {
      if (!key.endsWith('/')) await store.remove(key);
      else for await (const object of store.list(key)) await store.remove(object.key);
    } catch (error) {
      console.warn(
        `Cloud cleanup of ${key} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
}
