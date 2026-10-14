import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
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
