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
  };
}
