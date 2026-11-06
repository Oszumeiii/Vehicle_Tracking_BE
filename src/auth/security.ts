import {
  randomBytes,
  scrypt as scryptCallback,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('hex')}$${digest.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [kind, n, r, p, salt, digest] = encoded.split('$');
  if (
    kind !== 'scrypt' ||
    n !== '16384' ||
    r !== '8' ||
    p !== '1' ||
    !/^[a-f0-9]{32}$/.test(salt ?? '') ||
    !/^[a-f0-9]{128}$/.test(digest ?? '')
  )
    return false;
  const actual = (await scrypt(password, Buffer.from(salt, 'hex'), 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const makeToken = () => randomBytes(32).toString('base64url');

// Short-lived asset tokens for <img>/<video> URLs, which cannot send headers. They are signed with
// the session's token hash (a server-side secret per session), so signing out or expiry of the
// session also ends them, and the bearer token never appears in a URL.
const assetMessage = (sessionId: string, expires: number) => `asset:${sessionId}:${expires}`;
const assetSignature = (tokenHash: string, sessionId: string, expires: number) =>
  createHmac('sha256', tokenHash).update(assetMessage(sessionId, expires)).digest('base64url');
export const signAssetToken = (sessionId: string, tokenHash: string, expires: number) =>
  `${sessionId}.${expires}.${assetSignature(tokenHash, sessionId, expires)}`;
export function parseAssetToken(token: string) {
  const match = /^([0-9a-f]{32})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  return { sessionId: match[1], expires: Number(match[2]), signature: match[3] };
}
export function assetTokenValid(
  parsed: { sessionId: string; expires: number; signature: string },
  tokenHash: string,
  now = Date.now(),
) {
  if (parsed.expires * 1000 <= now) return false;
  const expected = Buffer.from(assetSignature(tokenHash, parsed.sessionId, parsed.expires));
  const actual = Buffer.from(parsed.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
