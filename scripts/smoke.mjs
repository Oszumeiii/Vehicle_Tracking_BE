// Pre-demo check of a running stack (API, worker, FE, models, cameras), optionally end to end.
//
// usage (credentials of an account on this stack, never on the command line):
//   $env:PLATE_SMOKE_EMAIL='admin@example.com'; $env:PLATE_SMOKE_PASSWORD='...'
//   npm run smoke                                   quick checks, about 1 s
//   npm run smoke -- --upload clip.mp4              + upload, recognize, evidence, then delete
//   npm run smoke -- --live "Demo Camboriú (ban ngày)" [--seconds 90]
//                                                   + run that camera, count tracks, stop
// Exit code 1 when a check fails.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = (process.env.PLATE_SMOKE_API ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const WEB = process.env.PLATE_SMOKE_WEB ?? 'http://localhost:5173';
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
let failures = 0;
let token;

const ok = (label, detail = '') => console.log(`  OK   ${label}${detail ? ` - ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures++;
  console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, body, raw) {
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail =
      typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail ?? data);
    throw new Error(`${method} ${path} -> ${response.status} ${detail}`.slice(0, 300));
  }
  return data;
}

async function step(label, action) {
  try {
    const detail = await action();
    ok(label, detail);
    return true;
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function until(read, done, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${seconds} s waiting for ${label}`);
    await sleep(2000);
  }
}

async function upload(file, pipelines) {
  const bytes = await readFile(file);
  const form = new FormData();
  form.append('file', new Blob([bytes]), basename(file));
  const media = await call('POST', '/api/v2/media', form, true);
  const pipeline = pipelines.find(
    (p) => p.ready && p.task === 'recognize' && p.media_types.includes(media.media_type),
  );
  if (!pipeline) throw new Error(`no ready recognition pipeline for ${media.media_type}`);
  const { job_id: jobId } = await call('POST', '/api/v2/recognition-jobs', {
    media_id: media.id,
    pipeline_id: pipeline.id,
  });
  try {
    const started = Date.now();
    const done = await until(
      () => call('GET', `/api/v2/recognition-jobs/${jobId}`),
      (j) => ['succeeded', 'failed'].includes(j.status),
      900,
      'the job',
    );
    if (done.status !== 'succeeded')
      throw new Error(`job ${done.status}: ${done.error_code} ${done.error_message ?? ''}`);
    const results = await call('GET', `/api/v2/recognition-jobs/${jobId}/results?limit=200`);
    const items = results.items ?? [];
    const first = items.find((r) => r.primary_detection_id);
    if (first) {
      const crop = await fetch(
        `${API}/api/v2/detections/${first.primary_detection_id}/artifacts/crop`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!crop.ok) throw new Error(`crop of the first result -> ${crop.status}`);
    }
    const readable = items.filter((r) => r.confidence_status === 'readable').length;
    return `${pipeline.id}, ${Math.round((Date.now() - started) / 1000)} s, ${items.length} plates (${readable} readable)${first ? ', evidence OK' : ''}`;
  } finally {
    if (!args.includes('--keep')) {
      await call('DELETE', `/api/v2/recognition-jobs/${jobId}`).catch(() => {});
      await call('DELETE', `/api/v2/media/${media.id}`).catch(() => {});
    }
  }
}

async function live(name, seconds, pipelines) {
  const cameras = (await call('GET', '/api/v2/stream-sources?limit=200')).items;
  const camera = cameras.find((c) => c.id === name || c.name === name);
  if (!camera)
    throw new Error(`camera "${name}" not found (have: ${cameras.map((c) => c.name).join(', ')})`);
  if (camera.active_session) throw new Error('camera already has an active session; stop it first');
  const pipeline =
    pipelines.find((p) => p.ready && p.id === camera.auto_settings?.pipeline_id) ??
    pipelines.find((p) => p.ready && p.task === 'recognize' && p.media_types.includes('video'));
  if (!pipeline) throw new Error('no ready video pipeline');
  const session = await call('POST', `/api/v2/stream-sources/${camera.id}/sessions`, {
    pipeline_id: pipeline.id,
  });
  const read = () => call('GET', `/api/v2/live-sessions/${session.id}`);
  try {
    const t0 = Date.now();
    const running = await until(
      read,
      (s) => s.status !== 'queued' && s.status !== 'starting',
      180,
      'running',
    );
    if (running.status !== 'running')
      throw new Error(`session ${running.status}: ${running.error_code ?? ''}`);
    const startup = Math.round((Date.now() - t0) / 1000);
    await sleep(seconds * 1000);
    const now = await read();
    const stats = now.stats ?? {};
    const dropped = stats.frames_read ? (100 * (stats.frames_dropped ?? 0)) / stats.frames_read : 0;
    return `running after ${startup} s; in ${seconds} s: ${stats.tracks ?? 0} tracks, ${dropped.toFixed(2)}% frames dropped, lag ${stats.lag_seconds ?? '?'} s`;
  } finally {
    await call('POST', `/api/v2/live-sessions/${session.id}/stop`).catch(() => {});
    await until(
      read,
      (s) => !['queued', 'starting', 'running', 'reconnecting', 'stopping'].includes(s.status),
      120,
      'stop',
    ).catch((error) => fail('stop the session', error.message));
  }
}

console.log(`Smoke check of ${API} (web ${WEB})`);
await step('API is up', async () => (await call('GET', '/health')).status);
await step(
  'database ready and migrations current',
  async () => (await call('GET', '/health/ready')).status,
);
await step('web app answers', async () => {
  const response = await fetch(WEB);
  if (!response.ok) throw new Error(`${WEB} -> ${response.status}`);
  return WEB;
});
const email = process.env.PLATE_SMOKE_EMAIL;
const password = process.env.PLATE_SMOKE_PASSWORD;
if (!email || !password) {
  fail('sign in', 'set PLATE_SMOKE_EMAIL and PLATE_SMOKE_PASSWORD');
} else if (
  await step('sign in', async () => {
    token = (await call('POST', '/api/v2/auth/login', { email, password })).access_token;
    const me = await call('GET', '/api/v2/auth/me');
    return `${me.email} (${me.role})`;
  })
) {
  let pipelines = [];
  await step('recognition models ready', async () => {
    pipelines = (await call('GET', '/api/v2/pipelines')).items;
    const ready = pipelines.filter((p) => p.ready && p.task === 'recognize');
    const missing = pipelines
      .filter((p) => !p.ready)
      .map((p) => `${p.id}: ${p.unavailable_reason}`);
    if (!ready.some((p) => p.media_types.includes('video')))
      throw new Error(`no ready video pipeline; ${missing.join('; ')}`);
    return ready.map((p) => p.id).join(', ');
  });
  await step('cameras', async () => {
    const cameras = (await call('GET', '/api/v2/stream-sources?limit=200')).items;
    const active = cameras.filter((c) => c.active_session).length;
    return `${cameras.length} configured, ${active} running: ${cameras.map((c) => `${c.name} (${c.source_type})`).join(', ')}`;
  });
  const file = option('upload');
  if (file) await step(`upload and recognize ${basename(file)}`, () => upload(file, pipelines));
  const camera = option('live');
  if (camera)
    await step(`live camera "${camera}"`, () =>
      live(camera, Number(option('seconds') ?? 90), pipelines),
    );
  await call('POST', '/api/v2/auth/logout').catch(() => {});
}
console.log(failures ? `${failures} check(s) failed.` : 'All checks passed.');
process.exitCode = failures ? 1 : 0;
