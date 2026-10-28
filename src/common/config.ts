import 'dotenv/config';
import { resolve } from 'node:path';

function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
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
    // Failed sign-ins allowed per email and client address, and per address, in the window.
    loginMaxFailures: positive('PLATE_LOGIN_MAX_FAILURES', 5),
    loginMaxFailuresPerAddress: positive('PLATE_LOGIN_MAX_FAILURES_PER_ADDRESS', 30),
    loginWindowMinutes: positive('PLATE_LOGIN_WINDOW_MINUTES', 15),
  };
}
