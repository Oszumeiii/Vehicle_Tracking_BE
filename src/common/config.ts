import 'dotenv/config';
import { resolve } from 'node:path';

function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

/**
 * Express "trust proxy" from PLATE_TRUST_PROXY, so req.ip (sign-in throttle, audit log) is the
 * client and not the reverse proxy. Unset, empty, "false" or "0": trust no proxy (direct access).
 * A number: trust that many hops. Otherwise a comma list of addresses, CIDRs or the presets
 * loopback, linklocal and uniquelocal. "true" (trust every hop) is refused: the client then
 * picks its own address with X-Forwarded-For and walks around the throttle.
 */
export function trustProxy(raw: string | undefined): false | number | string[] {
  const value = (raw ?? '').trim();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true')
    throw new Error(
      'PLATE_TRUST_PROXY=true lets clients choose their own address; give a hop count or the proxy subnets.',
    );
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function settings() {
  return {
    dataDir: resolve(process.env.PLATE_DATA_DIR ?? 'data'),
    python: resolve(
      process.env.PLATE_PIPELINE_PYTHON ??
        (process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'),
    ),
    maxUpload: positive('PLATE_MAX_UPLOAD_MIB', 500) * 1024 * 1024,
    sessionHours: positive('PLATE_SESSION_HOURS', 12),
    // Lifetime of the signed tokens put in image and video URLs.
    assetTokenMinutes: positive('PLATE_ASSET_TOKEN_MINUTES', 60),
    // Failed sign-ins allowed per email and client address, and per address, in the window.
    loginMaxFailures: positive('PLATE_LOGIN_MAX_FAILURES', 5),
    loginMaxFailuresPerAddress: positive('PLATE_LOGIN_MAX_FAILURES_PER_ADDRESS', 30),
    loginWindowMinutes: positive('PLATE_LOGIN_WINDOW_MINUTES', 15),
  };
}
