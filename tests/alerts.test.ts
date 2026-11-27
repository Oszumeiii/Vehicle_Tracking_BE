import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { workerOptions } from '../src/recognition/engine';
import { ingestTrack } from '../src/live/ingest';
import { AlertNotifier } from '../src/notify/notifier';
import { privateAddress, telegramApi, webhookUrl } from '../src/notify/senders';
import { alertAlternativeMin, notifySettings } from '../src/notify/settings';
import { TelegramLinker } from '../src/notify/telegram';
import { alertText } from '../src/notify/message';
import { seedUser, startTestDatabase, TestDatabase } from './helpers';
import { livePipelines, until, writeTrack } from './live-fixtures';

const URL = 'https://www.youtube.com/watch?v=5Xl6pSgiy3A';
const TOKEN = 'test-bot-token';
let fixture: TestDatabase;
let app: INestApplication;
let api: ReturnType<typeof request>;
let dataDir: string;
const users = {} as Record<'admin' | 'owner' | 'stranger', { id: string; token: string }>;
const oldEnvironment = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'PLATE_DATA_DIR',
  'PLATE_PIPELINE_PYTHON',
  'PLATE_PIPELINES_CONFIG',
  'NODE_ENV',
  'PLATE_TELEGRAM_BOT_TOKEN',
  'PLATE_TELEGRAM_API_URL',
  'PLATE_WEBHOOK_ALLOW_PRIVATE',
  'PLATE_PUBLIC_URL',
];

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local server that records requests and answers queued statuses (200 when none). */
async function listen(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    handler(req, Buffer.concat(chunks), res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const telegram = {
  calls: [] as { method: string; chat: string; text: string; photo: boolean }[],
  updates: [] as Record<string, any>[],
  refuse: new Map<string, number>(), // chat id -> HTTP status
  base: '',
  server: undefined as http.Server | undefined,
};
const hook = {
  received: [] as Received[],
  statuses: [] as number[],
  base: '',
  server: undefined as http.Server | undefined,
};

before(async () => {
  const bot = await listen(async (req, body, res) => {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!match || match[1] !== TOKEN) return reply(401, { ok: false, description: 'Unauthorized' });
    const type = String(req.headers['content-type'] ?? '');
    let fields: Record<string, any> = {};
    let photo = false;
    if (type.includes('multipart/form-data')) {
      const form = await new Response(new Uint8Array(body), {
        headers: { 'content-type': type },
      }).formData();
      fields = { chat_id: form.get('chat_id'), text: form.get('caption') };
      photo = form.get('photo') instanceof Blob;
    } else if (body.length) fields = JSON.parse(body.toString());
    const method = match[2];
    if (method === 'getMe') return reply(200, { ok: true, result: { username: 'test_bot' } });
    if (method === 'getUpdates') {
      const due = telegram.updates.filter((u) => u.update_id >= Number(fields.offset ?? 0));
      telegram.updates = [];
      return reply(200, { ok: true, result: due });
    }
    const chat = String(fields.chat_id);
    telegram.calls.push({ method, chat, text: String(fields.text ?? ''), photo });
    const refused = telegram.refuse.get(chat);
    if (refused)
      return reply(refused, {
        ok: false,
        error_code: refused,
        description: 'Forbidden: bot was blocked by the user',
      });
    reply(200, { ok: true, result: { message_id: telegram.calls.length } });
  });
  Object.assign(telegram, bot);
  const receiver = await listen((req, body, res) => {
    hook.received.push({ path: req.url ?? '', headers: req.headers, body: body.toString() });
    res.writeHead(hook.statuses.shift() ?? 200);
    res.end();
  });
  Object.assign(hook, receiver);

  fixture = await startTestDatabase();
  dataDir = join(fixture.root, 'artifacts');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // File-readiness only; no inference runs.
    PLATE_PIPELINES_CONFIG: await livePipelines(fixture.root),
    PLATE_TELEGRAM_BOT_TOKEN: TOKEN,
    PLATE_TELEGRAM_API_URL: telegram.base,
    PLATE_WEBHOOK_ALLOW_PRIVATE: 'true',
    PLATE_PUBLIC_URL: 'https://plates.example/',
  });
  app = await createApp();
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
  telegram.server?.close();
  hook.server?.close();
  for (const key of ENV_KEYS) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
});

const as = (role: keyof typeof users) => ({ Authorization: `Bearer ${users[role].token}` });
const db = () => fixture.database;
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

async function ownerSession() {
  const source = (
    await api
      .post('/api/v2/stream-sources')
      .set(as('owner'))
      .send({ name: 'Cổng A', url: URL })
      .expect(201)
  ).body;
  const session = (
    await api
      .post(`/api/v2/stream-sources/${source.id}/sessions`)
      .set(as('owner'))
      .send({ pipeline_id: 'joint' })
      .expect(202)
  ).body;
  return (await db().query('SELECT * FROM live_sessions WHERE id=$1', [session.id])).rows[0];
}

let tracks = 0;
async function ingest(
  session: Record<string, any>,
  text: string,
  times: { capturedFrom?: string; capturedTo?: string } = {},
  candidates?: { text: string; probability: number }[],
) {
  const key = `e000-t${String(++tracks).padStart(6, '0')}`;
  await writeTrack(dataDir, session.id, key, { text, ...times, candidates });
  return ingestTrack(db(), workerOptions(), session, key);
}

async function alertsOf(jobId: string) {
  return (
    await db().query(
      "SELECT payload FROM live_session_events WHERE event_type='alert' AND payload->>'job_id'=$1 ORDER BY id",
      [jobId],
    )
  ).rows.map((row) => row.payload);
}

async function clearWatchlists() {
  await db().query('DELETE FROM plate_watchlist');
}

test('watchlist entries carry a reason, a priority and an expiry; only admins share them', async () => {
  const created = await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({
      plate: 'abc-1234',
      reason: 'stolen',
      priority: 'high',
      expires_at: soon(48),
      note: 'Tin báo 12',
    })
    .expect(201);
  assert.equal(created.body.plate, 'ABC1234');
  assert.equal(created.body.reason, 'stolen');
  assert.equal(created.body.priority, 'high');
  assert.equal(created.body.expired, false);
  assert.equal(created.body.shared, false);
  assert.equal(created.body.can_edit, true);
  assert.equal(created.body.owner_name, 'Test user');
  const defaults = await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: 'DEF5678' })
    .expect(201);
  assert.equal(defaults.body.reason, 'other');
  assert.equal(defaults.body.priority, 'normal');
  assert.equal(defaults.body.expires_at, null);

  await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: 'GHI1234', shared: true })
    .expect(403);
  await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: 'GHI1234', expires_at: soon(-1) })
    .expect(422);
  await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: 'GHI1234', priority: 'urgent' })
    .expect(422);
  const shared = await api
    .post('/api/v2/watchlist')
    .set(as('admin'))
    .send({ plate: 'SHR1234', shared: true, reason: 'wanted' })
    .expect(201);

  // Everyone sees shared entries; only administrators change them. Personal ones stay private.
  const theirs = await api.get('/api/v2/watchlist').set(as('stranger')).expect(200);
  assert.deepEqual(
    theirs.body.items.map((item: any) => [item.plate, item.can_edit]),
    [['SHR1234', false]],
  );
  await api
    .patch(`/api/v2/watchlist/${shared.body.id}`)
    .set(as('stranger'))
    .send({ priority: 'low' })
    .expect(404);
  await api.delete(`/api/v2/watchlist/${shared.body.id}`).set(as('stranger')).expect(404);
  await api
    .patch(`/api/v2/watchlist/${created.body.id}`)
    .set(as('admin'))
    .send({ priority: 'low' })
    .expect(404);
  const mine = await api.get('/api/v2/watchlist?scope=mine').set(as('owner')).expect(200);
  assert.deepEqual(mine.body.items.map((item: any) => item.plate).sort(), ['ABC1234', 'DEF5678']);
  const onlyShared = await api.get('/api/v2/watchlist?scope=shared').set(as('owner')).expect(200);
  assert.deepEqual(
    onlyShared.body.items.map((item: any) => item.plate),
    ['SHR1234'],
  );
  assert.equal((await api.get('/api/v2/watchlist').set(as('owner'))).body.total, 3);

  const changed = await api
    .patch(`/api/v2/watchlist/${created.body.id}`)
    .set(as('owner'))
    .send({ priority: 'normal', expires_at: null, note: '' })
    .expect(200);
  assert.equal(changed.body.priority, 'normal');
  assert.equal(changed.body.expires_at, null);
  assert.equal(changed.body.note, null);
  assert.ok(changed.body.updated_at);
  await api
    .patch(`/api/v2/watchlist/${created.body.id}`)
    .set(as('owner'))
    .send({ shared: true })
    .expect(403);
  await api.patch(`/api/v2/watchlist/${created.body.id}`).set(as('owner')).send({}).expect(422);
  await api
    .patch(`/api/v2/watchlist/${created.body.id}`)
    .set(as('owner'))
    .send({ plate: 'X' })
    .expect(422);
  await api.delete(`/api/v2/watchlist/${shared.body.id}`).set(as('admin')).expect(204);
  await clearWatchlists();
});

test('a shared entry alerts everyone who sees the camera; expired entries stay silent', async () => {
  const session = await ownerSession();
  await api
    .post('/api/v2/watchlist')
    .set(as('admin'))
    .send({
      plate: 'SHA1234',
      shared: true,
      priority: 'high',
      reason: 'stolen',
      note: 'Xe của vụ 7',
    })
    .expect(201);
  const expiring = await api
    .post('/api/v2/watchlist')
    .set(as('owner'))
    .send({ plate: 'EXP1234', expires_at: soon(1) })
    .expect(201);
  await db().query(
    "UPDATE plate_watchlist SET expires_at=now() - interval '1 minute' WHERE id=$1",
    [expiring.body.id],
  );
  assert.equal(
    (await api.get('/api/v2/watchlist?scope=mine').set(as('owner'))).body.items[0].expired,
    true,
  );

  const hit = await ingest(session, 'SHA1234');
  const alerts = await alertsOf(hit);
  assert.deepEqual(
    alerts.map((a) => a.owner_id).sort(),
    [users.admin.id, users.owner.id].sort(),
    'the camera owner and the administrators; not the stranger',
  );
  for (const alert of alerts) {
    assert.equal(alert.shared, true);
    assert.equal(alert.priority, 'high');
    assert.equal(alert.reason, 'stolen');
    assert.equal(alert.note, 'Xe của vụ 7');
    assert.equal(alert.watchlist_owner_id, users.admin.id);
  }
  const quiet = await ingest(session, 'EXP1234');
  assert.deepEqual(await alertsOf(quiet), []);
  const flags = (
    await db().query('SELECT id, alerted FROM recognition_jobs WHERE id = ANY($1)', [[hit, quiet]])
  ).rows;
  assert.deepEqual(Object.fromEntries(flags.map((row) => [row.id, row.alerted])), {
    [hit]: true,
    [quiet]: false,
  });
  await clearWatchlists();
});

test('a watched plate alerts when the model weighed it, and on its Mercosul or look-alike reads', async () => {
  const session = await ownerSession();
  for (const plate of ['WAT5495', 'OLD1234', 'QOD7777'])
    await api.post('/api/v2/watchlist').set(as('owner')).send({ plate }).expect(201);
  // Read WAT9480 (3 characters off), but the model weighed WAT5495 at 35%: "có thể là".
  const maybe = await ingest(session, 'WAT9480', {}, [
    { text: 'WAT9480', probability: 0.6 },
    { text: 'WAT5495', probability: 0.35 },
  ]);
  const [alert, ...others] = await alertsOf(maybe);
  assert.deepEqual(others, []);
  assert.equal(alert.watch_plate, 'WAT5495');
  assert.equal(alert.plate, 'WAT9480');
  assert.equal(alert.match_reason, 'alternative');
  assert.equal(Number(alert.match_probability.toFixed(2)), 0.35);
  // Weighed below PLATE_ALERT_ALTERNATIVE_MIN (0.3): no alert.
  const weak = await ingest(session, 'WAT9481', {}, [
    { text: 'WAT9481', probability: 0.75 },
    { text: 'WAT5495', probability: 0.2 },
  ]);
  assert.deepEqual(await alertsOf(weak), []);
  // The Mercosul plate of a watched old plate; a read with two look-alikes (Q/0, O/0), which
  // the raw one-character rule missed.
  const mercosul = await ingest(session, 'OLD1C34');
  assert.deepEqual(
    (await alertsOf(mercosul)).map((a) => [a.watch_plate, a.match_reason, a.distance]),
    [['OLD1234', 'same', 1]],
  );
  const lookalike = await ingest(session, '00D7777');
  assert.deepEqual(
    (await alertsOf(lookalike)).map((a) => [a.watch_plate, a.match_reason, a.distance]),
    [['QOD7777', 'near', 2]],
  );
  assert.equal(alertAlternativeMin({}), 0.3);
  assert.equal(alertAlternativeMin({ PLATE_ALERT_ALTERNATIVE_MIN: '1' }), 1);
  assert.throws(() => alertAlternativeMin({ PLATE_ALERT_ALTERNATIVE_MIN: '0' }), /above 0/);
  await clearWatchlists();
});

test('alerts reach the channels: signed webhooks with retries, Telegram photos, priority filters', async () => {
  const session = await ownerSession();
  await api
    .post('/api/v2/watchlist')
    .set(as('admin'))
    .send({ plate: 'DLV1234', shared: true, priority: 'high' })
    .expect(201);
  await api.post('/api/v2/watchlist').set(as('owner')).send({ plate: 'NRM1234' }).expect(201);
  const webhook = await api
    .post('/api/v2/notification-channels')
    .set(as('admin'))
    .send({ kind: 'webhook', target: `${hook.base}/hooks/plates`, label: 'Trung tâm' })
    .expect(201);
  assert.match(webhook.body.secret, /^[0-9a-f]{64}$/);
  const listed = await api.get('/api/v2/notification-channels').set(as('admin')).expect(200);
  assert.equal(listed.body.items[0].secret, undefined, 'the secret is shown only once');
  assert.deepEqual(listed.body.telegram, { configured: true });
  assert.deepEqual(listed.body.webhook, { allowed: true });
  for (const [chat, min] of [
    ['1001', 'low'],
    ['1002', 'high'],
  ])
    await db().query(
      `INSERT INTO notification_channels(id, owner_id, kind, target, label, min_priority)
      VALUES (md5(random()::text), $1, 'telegram', $2, $3, $4)`,
      [users.owner.id, chat, `chat ${chat}`, min],
    );
  hook.statuses.push(503); // the receiver is down once

  const urgent = await ingest(session, 'DLV1234');
  const normal = await ingest(session, 'NRM1234');
  // The same car tracked again half a minute later: the app shows it, no second message.
  const again = await ingest(session, 'DLV1234', {
    capturedFrom: '2026-10-24T10:00:30.000Z',
    capturedTo: '2026-10-24T10:00:34.000Z',
  });
  const sightings = (
    await db().query('SELECT id, sighting_id FROM recognition_jobs WHERE id = ANY($1)', [
      [urgent, again],
    ])
  ).rows;
  assert.equal(new Set(sightings.map((row) => row.sighting_id)).size, 1, 'one passage');
  assert.equal((await alertsOf(again)).length, 2);
  const queued = (
    await db().query(
      `SELECT c.target, d.job_id FROM alert_deliveries d JOIN notification_channels c ON c.id=d.channel_id
      WHERE d.status='pending' ORDER BY c.target, d.job_id`,
    )
  ).rows;
  assert.deepEqual(
    queued.map((row) => [row.target, row.job_id === urgent ? 'urgent' : 'normal']).sort(),
    [
      ['1001', 'normal'],
      ['1001', 'urgent'],
      ['1002', 'urgent'], // min_priority high: the normal entry does not reach it
      [`${hook.base}/hooks/plates`, 'urgent'],
    ].sort(),
  );

  const notifier = new AlertNotifier(db(), dataDir, notifySettings());
  assert.equal(await notifier.deliverDue(), 4);
  const photos = telegram.calls.filter((call) => call.method === 'sendPhoto');
  assert.deepEqual(photos.map((call) => call.chat).sort(), ['1001', '1001', '1002']);
  const caption = photos.find((call) => call.chat === '1002')!.text;
  for (const part of [
    'DLV1234',
    'Mức ưu tiên: CAO',
    'Camera: Cổng A',
    'Danh sách theo dõi chung',
    'https://plates.example/results?plate=DLV1234&match=exact',
  ])
    assert.ok(caption.includes(part), `caption has ${part}: ${caption}`);
  let pending = (
    await db().query(
      "SELECT attempts, last_error, next_attempt_at > now() AS later FROM alert_deliveries WHERE status='pending'",
    )
  ).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.match(pending[0].last_error, /HTTP 503/);
  assert.equal(pending[0].later, true, 'retried later, not at once');
  assert.equal(await notifier.deliverDue(), 0);

  await db().query("UPDATE alert_deliveries SET next_attempt_at=now() WHERE status='pending'");
  assert.equal(await notifier.deliverDue(), 1);
  pending = (await db().query("SELECT id FROM alert_deliveries WHERE status<>'sent'")).rows;
  assert.equal(pending.length, 0);
  const [first, second] = hook.received;
  assert.equal(hook.received.length, 2);
  assert.equal(second.path, '/hooks/plates');
  assert.equal(second.headers['x-plate-event'], 'watchlist.alert');
  assert.equal(
    second.headers['x-plate-signature'],
    `sha256=${createHmac('sha256', webhook.body.secret).update(second.body).digest('hex')}`,
  );
  assert.equal(
    first.headers['x-plate-delivery'],
    second.headers['x-plate-delivery'],
    'the same delivery, retried',
  );
  const body = JSON.parse(second.body);
  assert.equal(body.event, 'watchlist.alert');
  assert.equal(body.alert.plate, 'DLV1234');
  assert.equal(body.alert.priority, 'high');
  assert.equal(body.alert.shared, true);
  assert.equal(body.alert.camera.name, 'Cổng A');
  assert.equal(body.alert.url, 'https://plates.example/results?plate=DLV1234&match=exact');
  assert.ok(
    !second.body.includes('storage') && !second.body.includes('keyframes'),
    'no storage keys leave',
  );
  const channel = (await api.get('/api/v2/notification-channels').set(as('admin'))).body.items[0];
  assert.equal(channel.last_error, null);
  assert.ok(channel.last_sent_at);

  const history = await api
    .get('/api/v2/notification-channels/deliveries')
    .set(as('owner'))
    .expect(200);
  assert.equal(history.body.total, 3);
  assert.ok(
    history.body.items.every((item: any) => item.status === 'sent' && item.kind === 'alert'),
  );
  assert.deepEqual(
    new Set(history.body.items.map((item: any) => item.plate)),
    new Set(['DLV1234', 'NRM1234']),
  );
  await clearWatchlists();
});

test('permanent failures stop at once and show in system health; turned-off channels get nothing', async () => {
  const session = await ownerSession();
  await api.post('/api/v2/watchlist').set(as('owner')).send({ plate: 'BLK1234' }).expect(201);
  await db().query('DELETE FROM notification_channels');
  await db().query(
    `INSERT INTO notification_channels(id, owner_id, kind, target, label)
    VALUES (md5(random()::text), $1, 'telegram', '2001', 'Bị chặn'), (md5(random()::text), $1, 'telegram', '2002', 'Đã tắt')`,
    [users.owner.id],
  );
  const off = (await api.get('/api/v2/notification-channels').set(as('owner'))).body.items.find(
    (item: any) => item.target === '2002',
  );
  await api
    .patch(`/api/v2/notification-channels/${off.id}`)
    .set(as('owner'))
    .send({ enabled: false })
    .expect(200);
  telegram.refuse.set('2001', 403);

  await ingest(session, 'BLK1234');
  const deliveries = (await db().query('SELECT channel_id FROM alert_deliveries')).rows;
  assert.equal(deliveries.length, 1, 'nothing for the turned-off channel');
  await new AlertNotifier(db(), dataDir, notifySettings()).deliverDue();
  const failed = (await db().query('SELECT status, attempts, last_error FROM alert_deliveries'))
    .rows[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1, 'a blocked bot is not retried');
  assert.match(failed.last_error, /blocked/);
  const health = await api.get('/api/v2/system/health').set(as('admin')).expect(200);
  const issue = health.body.issues.find((item: any) => item.code === 'ALERTS_FAILING');
  assert.ok(issue, JSON.stringify(health.body.issues));
  assert.equal(issue.subject, 'telegram: Bị chặn');
  assert.match(issue.detail, /1 alert message\(s\) not delivered: Telegram: Forbidden/);

  // Webhooks: administrators only, https and public addresses unless allowed for testing.
  await api
    .post('/api/v2/notification-channels')
    .set(as('owner'))
    .send({ kind: 'webhook', target: 'https://hooks.example/x' })
    .expect(403);
  process.env.PLATE_WEBHOOK_ALLOW_PRIVATE = 'false';
  try {
    for (const target of [
      `${hook.base}/x`,
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://u:p@hooks.example/x',
    ])
      await api
        .post('/api/v2/notification-channels')
        .set(as('admin'))
        .send({ kind: 'webhook', target })
        .expect(422);
  } finally {
    process.env.PLATE_WEBHOOK_ALLOW_PRIVATE = 'true';
  }
  assert.throws(() => webhookUrl('https://10.1.2.3/x', false), /private/);
  assert.ok(webhookUrl('https://hooks.example/x', false));
  for (const address of [
    '127.0.0.1',
    '10.0.0.8',
    '100.101.102.103',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:192.168.1.4',
  ])
    assert.equal(privateAddress(address), true, address);
  for (const address of ['8.8.8.8', '2001:4860:4860::8888'])
    assert.equal(privateAddress(address), false, address);
  telegram.refuse.clear();
  await db().query('DELETE FROM alert_deliveries');
  await clearWatchlists();
});

test('a Telegram chat links with a one-time code, gets test messages and /stop turns it off', async () => {
  await db().query('DELETE FROM notification_channels');
  const link = await api
    .post('/api/v2/notification-channels/telegram/link')
    .set(as('owner'))
    .expect(201);
  assert.equal(link.body.bot_username, 'test_bot');
  const code = new globalThis.URL(link.body.url).searchParams.get('start')!;
  assert.match(link.body.url, /^https:\/\/t\.me\/test_bot\?start=[\w-]{24}$/);

  const linker = new TelegramLinker(db(), notifySettings());
  const bot = telegramApi(notifySettings());
  const message = (text: string, chat = 555) => ({
    update_id: Date.now(),
    message: {
      chat: { id: chat, type: 'private', username: 'tuan' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
  await linker.handle(bot, message(`/start ${code}`));
  const channels = (await api.get('/api/v2/notification-channels').set(as('owner'))).body.items;
  assert.deepEqual(
    channels.map((item: any) => [item.kind, item.target, item.label, item.enabled]),
    [['telegram', '555', '@tuan', true]],
  );
  assert.match(telegram.calls.at(-1)!.text, /Đã kết nối với tài khoản Test user/);
  await linker.handle(bot, message(`/start ${code}`, 556));
  assert.match(telegram.calls.at(-1)!.text, /không hợp lệ hoặc đã hết hạn/);
  assert.equal(
    (await api.get('/api/v2/notification-channels').set(as('owner'))).body.items.length,
    1,
  );
  const stale = message(`/start ${code}`, 557);
  stale.message.date -= 3600;
  const calls = telegram.calls.length;
  await linker.handle(bot, stale);
  assert.equal(telegram.calls.length, calls, 'commands older than 15 minutes are ignored');

  const tested = await api
    .post(`/api/v2/notification-channels/${channels[0].id}/test`)
    .set(as('owner'))
    .expect(200);
  assert.deepEqual([tested.body.ok, tested.body.error], [true, null]);
  assert.match(telegram.calls.at(-1)!.text, /Tin thử từ Vehicle Tracking/);
  telegram.refuse.set('555', 400);
  const broken = await api
    .post(`/api/v2/notification-channels/${channels[0].id}/test`)
    .set(as('owner'))
    .expect(200);
  assert.equal(broken.body.ok, false);
  assert.match(broken.body.error, /Telegram:/);
  telegram.refuse.clear();
  await api
    .post(`/api/v2/notification-channels/${channels[0].id}/test`)
    .set(as('stranger'))
    .expect(404);

  await linker.handle(bot, message('/stop'));
  assert.equal(
    (await api.get('/api/v2/notification-channels').set(as('owner'))).body.items[0].enabled,
    false,
  );
  assert.match(telegram.calls.at(-1)!.text, /Đã ngừng gửi cảnh báo/);

  // The worker loop: long-polls getUpdates and links a second code.
  const second = await api
    .post('/api/v2/notification-channels/telegram/link')
    .set(as('stranger'))
    .expect(201);
  telegram.updates.push(
    message(`/start ${new globalThis.URL(second.body.url).searchParams.get('start')}`, 777),
  );
  const stop = new AbortController();
  const running = linker.run(stop.signal);
  await until(
    async () =>
      (await db().query("SELECT owner_id FROM notification_channels WHERE target='777'")).rows,
    (rows) => rows.length === 1 && rows[0].owner_id === users.stranger.id,
    'the polled /start to link the chat',
  );
  stop.abort();
  await running;

  const saved = process.env.PLATE_TELEGRAM_BOT_TOKEN;
  delete process.env.PLATE_TELEGRAM_BOT_TOKEN;
  try {
    await api.post('/api/v2/notification-channels/telegram/link').set(as('owner')).expect(422);
    assert.deepEqual(
      (await api.get('/api/v2/notification-channels').set(as('owner'))).body.telegram,
      {
        configured: false,
      },
    );
  } finally {
    process.env.PLATE_TELEGRAM_BOT_TOKEN = saved;
  }
  const audit = (
    await db().query("SELECT action FROM audit_log WHERE action LIKE 'notification.%' ORDER BY id")
  ).rows;
  assert.ok(audit.some((row) => row.action === 'notification.link'));
  assert.ok(audit.some((row) => row.action === 'notification.test'));
});

test('message text: Vietnamese, local time, map and link; test messages name the channel', () => {
  const text = alertText(
    {
      kind: 'alert',
      plate: 'ABC1D23',
      watch_plate: 'ABC1D28',
      distance: 1,
      priority: 'low',
      reason: 'suspect',
      camera: { id: 'c', name: 'Cầu Rồng', latitude: 16.06, longitude: 108.22 },
      captured_from: '2026-11-24T03:04:05.000Z',
      confidence_status: 'low_confidence',
      confidence: 0.912,
    },
    { publicUrl: null, timeZone: 'Asia/Ho_Chi_Minh' },
  );
  assert.equal(
    text,
    [
      '🚨 Biển số theo dõi: ABC1D23',
      'Khớp gần đúng với ABC1D28 (lệch 1 ký tự)',
      'Mức ưu tiên: thấp · Lý do: nghi vấn',
      'Camera: Cầu Rồng',
      'Lúc: 10:04:05 24/11/2026 (GMT+7)',
      'Máy đọc: tin cậy thấp (độ tin cậy 0,91)',
      'Bản đồ: https://www.google.com/maps?q=16.06,108.22',
    ].join('\n'),
  );
  assert.match(
    alertText({ kind: 'test', label: 'Nhóm trực' }, { publicUrl: null, timeZone: 'UTC' }),
    /Kênh "Nhóm trực"/,
  );
  const plain = { publicUrl: null, timeZone: 'UTC' };
  assert.match(
    alertText(
      {
        kind: 'alert',
        plate: 'WAT9480',
        watch_plate: 'WAT5495',
        distance: 3,
        match_reason: 'alternative',
        match_probability: 0.35,
      },
      plain,
    ),
    /\nMáy đọc ra WAT9480, nhưng cũng có thể là WAT5495 \(model cân nhắc 35%\)\n/,
  );
  assert.match(
    alertText(
      {
        kind: 'alert',
        plate: 'OLD1C34',
        watch_plate: 'OLD1234',
        distance: 1,
        match_reason: 'same',
      },
      plain,
    ),
    /\nCùng xe với OLD1234 \(biển cũ và biển Mercosul\)\n/,
  );
  assert.throws(() => notifySettings({ PLATE_ALERT_TIMEZONE: 'Mars/Base' }), /time zone/);
});
