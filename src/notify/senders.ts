import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import * as path from 'node:path';
import { safeStorage } from '../recognition/engine';
import { alertText, webhookBody, type AlertPayload } from './message';
import type { NotifySettings } from './settings';

/** A failed send. Permanent ones are not retried: a wrong chat, a webhook that refuses it. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Telegram Bot API calls; the token is in the URL, so it never goes into an error message. */
export class TelegramApi {
  constructor(
    private token: string,
    private base = 'https://api.telegram.org',
  ) {}

  async call(
    method: string,
    body: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ) {
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      const reason = deadline.aborted ? 'timed out' : String((error as Error)?.message ?? error);
      throw new DeliveryError(`Telegram unreachable: ${reason.split(this.token).join('***')}`);
    }
    const data = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.ok && data?.ok) return data.result;
    const description = String(data?.description ?? `HTTP ${response.status}`).slice(0, 300);
    const retryAfter = Number(data?.parameters?.retry_after);
    // 400 (chat not found), 401 (bad token), 403 (bot blocked by the user): retrying cannot help.
    throw new DeliveryError(
      `Telegram: ${description}`,
      [400, 401, 403, 404].includes(response.status),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
}

export function telegramApi(settings: Pick<NotifySettings, 'telegramToken' | 'telegramApi'>) {
  if (!settings.telegramToken)
    throw new DeliveryError('The Telegram bot is not configured (PLATE_TELEGRAM_BOT_TOKEN).', true);
  return new TelegramApi(settings.telegramToken, settings.telegramApi);
}

/** The scene frame (else the plate crop) of an alert, if still on disk. */
async function picture(dataDir: string, payload: AlertPayload) {
  for (const key of [payload.image, payload.crop]) {
    if (!key) continue;
    try {
      const data = await readFile(safeStorage(dataDir, key));
      const type = path.extname(key).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      return { data, type, name: path.basename(key) };
    } catch {
      // Pruned or moved to the cloud: try the next picture, else send text only.
    }
  }
  return null;
}

export async function sendTelegram(
  chatId: string,
  payload: AlertPayload,
  settings: NotifySettings,
  dataDir: string,
) {
  const api = telegramApi(settings);
  const text = alertText(payload, settings);
  const photo = payload.kind === 'alert' ? await picture(dataDir, payload) : null;
  if (photo) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', text.length > 1024 ? `${text.slice(0, 1021)}...` : text);
    form.set('photo', new Blob([photo.data], { type: photo.type }), photo.name);
    await api.call('sendPhoto', form);
  } else
    await api.call('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    });
}

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, also Tailscale addresses
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(network, prefix, 'ipv6');

/** Loopback, private, link-local, multicast or otherwise not a public internet address. */
export function privateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return privateAddress(mapped[1]);
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) return PRIVATE.check(address, 'ipv6');
  return true;
}

/**
 * A webhook address users may register: https (http only with PLATE_WEBHOOK_ALLOW_PRIVATE),
 * no credentials in it, and not a private address. Host names are checked again when
 * resolved, at every send, so a name pointing inside the network is refused too.
 */
export function webhookUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeliveryError('The webhook address is not a URL.', true);
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
    throw new DeliveryError('The webhook address must use https.', true);
  if (url.username || url.password)
    throw new DeliveryError('Put no user name or password in the webhook address.', true);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !allowPrivate &&
    (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && privateAddress(host)))
  )
    throw new DeliveryError('The webhook address is a private or local address.', true);
  return url;
}

export function sendWebhook(
  target: string,
  secret: string,
  body: string,
  headers: Record<string, string>,
  settings: Pick<NotifySettings, 'allowPrivateWebhooks'>,
  timeoutMs = 10_000,
): Promise<void> {
  const url = webhookUrl(target, settings.allowPrivateWebhooks);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const lookup = (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (error: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
  ) =>
    dnsLookup(
      hostname,
      { family: options.family ?? 0, all: true },
      (error, addresses: LookupAddress[]) => {
        if (error) return callback(error);
        const allowed = settings.allowPrivateWebhooks
          ? addresses
          : addresses.filter((entry) => !privateAddress(entry.address));
        if (!allowed.length)
          return callback(
            Object.assign(new Error('the webhook host resolves to a private address'), {
              code: 'EPRIVATE',
            }),
          );
        if (options.all) callback(null, allowed);
        else callback(null, allowed[0].address, allowed[0].family);
      },
    );
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'POST',
        lookup: lookup as any,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'VehicleTracking-Alerts/1',
          'x-plate-signature': signature,
          ...headers,
        },
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve();
        // A redirect is not followed (it could lead inside the network); 4xx other than
        // 408/429 means the receiver refuses this request, so retrying cannot help.
        const retry = status === 408 || status === 429 || status >= 500;
        reject(new DeliveryError(`The webhook answered HTTP ${status}.`, !retry));
      },
    );
    request.on('timeout', () =>
      request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
    );
    request.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        new DeliveryError(
          `The webhook is unreachable: ${error.code === 'EPRIVATE' ? error.message : (error.code ?? error.message)}`,
          error.code === 'EPRIVATE',
        ),
      ),
    );
    request.end(body);
  });
}

export interface ChannelTarget {
  kind: string;
  target: string;
  secret: string | null;
}

/** Send one delivery to its channel; throws DeliveryError on failure. */
export async function sendDelivery(
  channel: ChannelTarget,
  delivery: { id: string; payload: AlertPayload },
  settings: NotifySettings,
  dataDir: string,
) {
  if (channel.kind === 'telegram')
    return sendTelegram(channel.target, delivery.payload, settings, dataDir);
  if (channel.kind === 'webhook' && channel.secret)
    return sendWebhook(
      channel.target,
      channel.secret,
      webhookBody(delivery, settings),
      {
        'x-plate-event': delivery.payload.kind === 'test' ? 'test' : 'watchlist.alert',
        'x-plate-delivery': delivery.id,
      },
      settings,
    );
  throw new DeliveryError(`Unknown channel kind: ${channel.kind}`, true);
}
