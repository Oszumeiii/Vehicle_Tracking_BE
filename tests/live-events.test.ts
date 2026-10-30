import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { ingestTrack } from '../src/live/ingest';
import { youtubeVideoId } from '../src/live/payload';
import { recordEvent } from '../src/live/sessions';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines, until, writeTrack } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
const ENV = {
  PLATE_SSE_HEARTBEAT_SECONDS: '0.2',
  PLATE_SSE_MAX_CLIENTS: '4',
  NODE_ENV: 'test',
};
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let port: number;
let dataDir: string;
const users = {} as Record<'admin' | 'owner' | 'stranger', { id: string; token: string }>;
const oldEnvironment = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'PLATE_DATA_DIR',
  'PLATE_PIPELINE_PYTHON',
  'PLATE_PIPELINES_CONFIG',
  ...Object.keys(ENV),
];

before(async () => {
  fixture = await startTestDatabase();
  dataDir = join(fixture.root, 'artifacts');
  Object.assign(process.env, ENV, {
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // File-readiness only; no inference runs.
    PLATE_PIPELINES_CONFIG: await livePipelines(fixture.root),
  });
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
  api = request(app.getHttpServer());
  for (const role of ['admin', 'owner', 'stranger'] as const) {
    const user = await seedUser(fixture.database, role === 'admin' ? 'admin' : 'user');
    const login = await api
      .post('/api/v2/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    users[role] = { id: user.id, token: login.body.access_token };
  }
});

after(async () => {
  if (app) await app.close();
  if (fixture) await fixture.dispose();
  for (const key of ENV_KEYS) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

const as = (role: keyof typeof users) => ({ Authorization: `Bearer ${users[role].token}` });

async function liveSession(role: keyof typeof users = 'owner') {
  const source = (
    await api
      .post('/api/v2/stream-sources')
      .set(as(role))
      .send({ name: 'cam', url: URL })
      .expect(201)
  ).body;
  const session = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as(role))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  const row = (
    await fixture.database.query('SELECT * FROM live_sessions WHERE id=$1', [session.id])
  ).rows[0];
  return { source, session: row };
}

const ingest = async (session: Record<string, any>, key: string, text: string) => {
  await writeTrack(dataDir, session.id, key, { text });
  return ingestTrack(fixture.database, workerOptions(), session, key);
};

interface Event {
  id?: string;
  event?: string;
  data?: any;
  comment?: string;
}
interface Stream {
  status: number;
  events: Event[];
  ended: Promise<void>;
  close(): void;
  next(match: (event: Event) => boolean, what: string): Promise<Event>;
}

/** Minimal SSE client over http (supertest buffers whole responses). */
function openStream(path: string, role: keyof typeof users, headers: Record<string, string> = {}) {
  return new Promise<Stream>((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { ...as(role), ...headers } },
      (res) => {
        const events: Event[] = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const event: Event = {};
            for (const line of buffer.slice(0, end).split('\n')) {
              if (line.startsWith(':')) event.comment = line.slice(1).trim();
              else {
                const at = line.indexOf(': ');
                const [key, value] = [line.slice(0, at), line.slice(at + 2)];
                if (key === 'data') event.data = JSON.parse(value);
                else (event as Record<string, string>)[key] = value;
              }
            }
            events.push(event);
            buffer = buffer.slice(end + 2);
          }
        });
        const ended = new Promise<void>((done) => res.on('end', () => done()));
        resolve({
          status: res.statusCode ?? 0,
          events,
          ended,
          close: () => req.destroy(),
          next: async (match, what) =>
            (await until(
              async () => events.find(match),
              (found) => found !== undefined,
              what,
            )) as Event,
        });
      },
    );
    req.on('error', reject);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test('watchlist entries are normalized, unique per user and private', async () => {
  const created = await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: ' abc-1d23 ', note: 'stolen' })
    .expect(201);
  assert.equal(created.body.plate, 'ABC1D23');
  await api.post('/api/v2/watchlist').set(as('owner')).send({ plate: 'ABC 1D23' }).expect(409);
  await api.post('/api/v2/watchlist').set(as('stranger')).send({ plate: 'ABC1D23' }).expect(201);
  for (const plate of [' - ', 'A'.repeat(17)])
    await api.post('/api/v2/watchlist').set(as('owner')).send({ plate }).expect(422);
  const mine = await api.get('/api/v2/watchlist').set(as('owner')).expect(200);
  assert.deepEqual(
    mine.body.items.map((item: any) => item.plate),
    ['ABC1D23'],
  );
  await api.delete(`/api/v2/watchlist/${created.body.id}`).set(as('stranger')).expect(404);
  await api.delete(`/api/v2/watchlist/${created.body.id}`).set(as('owner')).expect(204);
  assert.equal((await api.get('/api/v2/watchlist').set(as('owner'))).body.total, 0);
});

test('ingested tracks record a track event and alerts for matching watchlists of owners and admins', async () => {
  const { session } = await liveSession();
  for (const [role, plate] of [
    ['owner', 'QRS1234'],
    ['owner', 'QRS1235'],
    ['owner', 'QR12'],
    ['admin', 'QRT1234'],
    ['stranger', 'QRS1234'],
  ] as const)
    await api.post('/api/v2/watchlist').set(as(role)).send({ plate }).expect(201);
  const jobId = await ingest(session, 'e000-t000001', 'QRS1234');
  await ingest(session, 'e000-t000002', 'QR13'); // one off, but too short to alert
  const events = (
    await fixture.database.query(
      'SELECT event_type, payload FROM live_session_events WHERE session_id=$1 ORDER BY id',
      [session.id],
    )
  ).rows.filter((row) => row.event_type !== 'status');
  assert.deepEqual(
    events.map((e) => e.event_type),
    ['track', 'alert', 'alert', 'alert', 'track'],
  );
  const track = events[0].payload;
  assert.equal(track.job_id, jobId);
  assert.equal(track.text, 'QRS1234');
  assert.equal(track.confidence_status, 'readable');
  assert.equal(track.detection_ids.length, 5);
  await api
    .get(`/api/v2/detections/${track.detection_ids[0]}/artifacts/crop`)
    .set(as('owner'))
    .expect(200);
  const alerts = events.filter((e) => e.event_type === 'alert').map((e) => e.payload);
  assert.deepEqual(
    alerts.map((a) => [a.watch_plate, a.owner_id, a.distance]).sort(),
    [
      ['QRS1234', users.owner.id, 0],
      ['QRS1235', users.owner.id, 1],
      ['QRT1234', users.admin.id, 1],
    ].sort(),
  );
  assert.ok(alerts.every((a) => a.result_id === track.result_id && a.plate === 'QRS1234'));
  assert.equal(alerts[0].stream_source_id, session.stream_source_id);

  await writeTrack(dataDir, session.id, 'e000-t000003', { text: 'QRS1234', missingCrop: true });
  await assert.rejects(ingestTrack(fixture.database, workerOptions(), session, 'e000-t000003'));
  const after = await fixture.database.query(
    'SELECT count(*)::int AS n FROM live_session_events WHERE session_id=$1',
    [session.id],
  );
  assert.equal(after.rows[0].n, events.length + 1, 'a rejected track records nothing');
});

test('the event stream replays by id, follows commits, keeps alerts private and ends with its session', async () => {
  const { source, session } = await liveSession();
  await api
    .get(`/api/v2/live-events/stream?live_session_id=${session.id}`)
    .set(as('stranger'))
    .expect(404);
  await api.get('/api/v2/live-events/stream?after=x').set(as('owner')).expect(422);

  const owner = await openStream('/api/v2/live-events/stream', 'owner');
  const admin = await openStream('/api/v2/live-events/stream', 'admin');
  const stranger = await openStream('/api/v2/live-events/stream', 'stranger');
  assert.equal(owner.status, 200);
  const opened = await owner.next(
    (e) => e.event === 'session' && e.data.id === session.id,
    'session snapshot on connect',
  );
  assert.equal(opened.data.status, 'queued');
  assert.equal(opened.data.pipeline_snapshot, undefined);
  await owner.next((e) => e.comment === 'ping', 'heartbeat');

  await api.post('/api/v2/watchlist').set(as('owner')).send({ plate: 'LMN4567' }).expect(201);
  await fixture.database.query(
    `UPDATE live_sessions SET status='running',stats='{"frames_read":42}' WHERE id=$1`,
    [session.id],
  );
  const update = await owner.next(
    (e) => e.event === 'session' && e.data.stats?.frames_read === 42,
    'stats update',
  );
  assert.equal(update.data.status, 'running');
  await ingest(session, 'e000-t000001', 'LMN4567');
  const track = await owner.next((e) => e.event === 'track', 'track event');
  assert.ok(track.id);
  assert.equal(track.data.live_session_id, session.id);
  assert.equal(track.data.stream_source_id, source.id);
  assert.equal(track.data.payload.text, 'LMN4567');
  const alert = await owner.next((e) => e.event === 'alert', 'alert for the watchlist owner');
  assert.equal(alert.data.payload.owner_id, users.owner.id);
  await admin.next((e) => e.event === 'track', 'admin sees every camera');
  await settle();
  assert.ok(!admin.events.some((e) => e.event === 'alert'), 'alerts stay with their owner');
  assert.ok(
    !stranger.events.some((e) => e.id || (e.event === 'session' && e.data.id === session.id)),
    'nothing from other users leaks',
  );
  stranger.close();

  // Resume after the track: only later events arrive, nothing twice.
  await recordEvent(fixture.database, session.id, 'error', { code: 'TEST', message: 'later' });
  const resumed = await openStream(
    `/api/v2/live-events/stream?live_session_id=${session.id}`,
    'owner',
    { 'Last-Event-ID': track.id! },
  );
  await resumed.next((e) => e.event === 'error', 'replayed error');
  const replayed = resumed.events.filter((e) => e.id).map((e) => e.event);
  assert.deepEqual(replayed, ['alert', 'error']);
  const all = await openStream(
    `/api/v2/live-events/stream?stream_source_id=${source.id}&after=0`,
    'owner',
  );
  await all.next((e) => e.event === 'error', 'full replay');
  assert.deepEqual(
    all.events.filter((e) => e.id).map((e) => e.event),
    ['status', 'track', 'alert', 'error'],
  );

  // Losing the LISTEN connection loses nothing: the hub reconnects and catches up.
  await fixture.database.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN live_sessions%'",
  );
  await recordEvent(fixture.database, session.id, 'error', { code: 'AFTER_RECONNECT' });
  await resumed.next((e) => e.data?.payload?.code === 'AFTER_RECONNECT', 'event after reconnect');

  await api.post(`/api/v2/live-sessions/${session.id}/stop`).set(as('owner')).expect(202);
  await fixture.database.query("UPDATE live_sessions SET status='stopping' WHERE id=$1", [
    session.id,
  ]);
  await fixture.database.query(
    "UPDATE live_sessions SET status='stopped',finished_at=now() WHERE id=$1",
    [session.id],
  );
  await recordEvent(fixture.database, session.id, 'status', { status: 'stopped' });
  await resumed.next((e) => e.event === 'end', 'end of the session stream');
  await resumed.ended;
  const finished = await openStream(
    `/api/v2/live-events/stream?live_session_id=${session.id}`,
    'owner',
  );
  await finished.ended; // a finished session closes at once
  assert.equal(finished.events.at(-1)?.event, 'end');
  for (const stream of [owner, admin, all]) stream.close();
});

test('open streams are limited per API process', async () => {
  await settle();
  const streams = [];
  for (let i = 0; i < 4; i++) streams.push(await openStream('/api/v2/live-events/stream', 'owner'));
  assert.deepEqual(
    streams.map((s) => s.status),
    [200, 200, 200, 200],
  );
  await api.get('/api/v2/live-events/stream').set(as('owner')).expect(503);
  for (const stream of streams) stream.close();
  await settle();
  const again = await openStream('/api/v2/live-events/stream', 'owner');
  assert.equal(again.status, 200);
  again.close();
});

test('cameras expose an embeddable player and their latest frame for drawing zones', async () => {
  for (const [url, id] of [
    ['https://www.youtube.com/watch?v=5Xl6pSgiy3A&t=10', '5Xl6pSgiy3A'],
    ['https://youtu.be/NwbOe1Mb__M', 'NwbOe1Mb__M'],
    ['https://www.youtube.com/live/nVlgbW-WrpI?si=x', 'nVlgbW-WrpI'],
    ['https://www.youtube.com/@channel/live', null],
  ])
    assert.equal(youtubeVideoId(url as string), id);
  const { source, session } = await liveSession();
  assert.equal(source.video_id, '5Xl6pSgiy3A');
  assert.equal(source.embed_url, 'https://www.youtube-nocookie.com/embed/5Xl6pSgiy3A');
  const listed = await api.get('/api/v2/stream-sources').set(as('owner')).expect(200);
  assert.ok(listed.body.items.every((item: any) => item.embed_url));
  await api.get(`/api/v2/stream-sources/${source.id}/snapshot`).set(as('owner')).expect(204);
  await ingest(session, 'e000-t000001', 'SNP1234');
  const frame = await api
    .get(`/api/v2/stream-sources/${source.id}/snapshot`)
    .set(as('owner'))
    .expect(200);
  assert.match(frame.headers['content-type'], /image\/png/);
  await api.get(`/api/v2/stream-sources/${source.id}/snapshot`).set(as('stranger')).expect(404);
});
