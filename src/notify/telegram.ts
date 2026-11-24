import { randomBytes } from 'node:crypto';
import { newId } from '../common/http';
import { Database } from '../database/database';
import { telegramApi, type TelegramApi } from './senders';
import { notifySettings, type NotifySettings } from './settings';

const LINK_MINUTES = 10;
// Telegram keeps undelivered updates for a day: commands older than this are not answered.
const STALE_SECONDS = 15 * 60;
const COMMAND = /^\/(start|stop)(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/;

let botName: { at: number; key: string; name: string } | undefined;

/** The bot's @username (PLATE_TELEGRAM_BOT_USERNAME, else getMe, cached for an hour). */
export async function botUsername(settings: NotifySettings) {
  if (settings.telegramUsername) return settings.telegramUsername;
  const key = `${settings.telegramApi}|${settings.telegramToken}`;
  if (botName && botName.key === key && Date.now() - botName.at < 3600_000) return botName.name;
  const me = await telegramApi(settings).call('getMe');
  botName = { at: Date.now(), key, name: String(me.username) };
  return botName.name;
}

/** A one-time code for t.me/<bot>?start=<code>, valid for ten minutes. */
export async function createLinkCode(database: Database, ownerId: string) {
  const code = randomBytes(18).toString('base64url');
  const { rows } = await database.query(
    `INSERT INTO telegram_link_codes(code, owner_id, expires_at)
    VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`,
    [code, ownerId, LINK_MINUTES],
  );
  return { code, expires_at: rows[0].expires_at as Date };
}

function chatLabel(chat: Record<string, any>) {
  const name =
    chat.type === 'private'
      ? chat.username
        ? `@${chat.username}`
        : [chat.first_name, chat.last_name].filter(Boolean).join(' ')
      : chat.title;
  return String(name || chat.id).slice(0, 100);
}

/**
 * Links Telegram chats to users, in the worker. A user opens t.me/<bot>?start=<code>
 * from the settings page and presses Start; this polls the bot's updates (getUpdates,
 * long polling: no public address needed) and turns "/start <code>" into a Telegram
 * channel of that user. "/stop" turns off every channel of that chat. It polls only
 * while a link code is open or a Telegram channel is on, and does nothing without a bot.
 */
export class TelegramLinker {
  private offset = 0;

  constructor(
    private database: Database,
    private settings: NotifySettings = notifySettings(),
  ) {}

  async run(signal: AbortSignal) {
    if (!this.settings.telegramToken) return;
    const api = telegramApi(this.settings);
    while (!signal.aborted) {
      try {
        if (!(await this.wanted())) {
          await pause(5000, signal);
          continue;
        }
        const updates = await api.call(
          'getUpdates',
          { offset: this.offset, timeout: 20, allowed_updates: ['message'] },
          signal,
          35_000,
        );
        for (const update of updates as Record<string, any>[]) {
          this.offset = Math.max(this.offset, Number(update.update_id) + 1);
          await this.handle(api, update).catch((error) =>
            console.error(
              'Telegram command failed:',
              error instanceof Error ? error.message : error,
            ),
          );
        }
      } catch (error) {
        if (signal.aborted) break;
        console.error('Telegram polling failed:', error instanceof Error ? error.message : error);
        await pause(10_000, signal);
      }
    }
  }

  private async wanted() {
    const { rows } = await this.database.query(
      `SELECT EXISTS (SELECT 1 FROM telegram_link_codes WHERE used_at IS NULL AND expires_at > now())
        OR EXISTS (SELECT 1 FROM notification_channels WHERE kind='telegram' AND enabled) AS wanted`,
    );
    return Boolean(rows[0].wanted);
  }

  /** One update: answers /start <code> and /stop, ignores everything else. */
  async handle(api: TelegramApi, update: Record<string, any>) {
    const message = update.message;
    if (!message?.chat?.id || typeof message.text !== 'string') return;
    if (Date.now() / 1000 - Number(message.date) > STALE_SECONDS) return;
    const command = COMMAND.exec(message.text.trim());
    if (!command) return;
    const chat = String(message.chat.id);
    const reply = (text: string) => api.call('sendMessage', { chat_id: chat, text });
    if (command[1] === 'stop') {
      const { rowCount } = await this.database.query(
        "UPDATE notification_channels SET enabled=false WHERE kind='telegram' AND target=$1 AND enabled",
        [chat],
      );
      await reply(
        rowCount
          ? 'Đã ngừng gửi cảnh báo vào cuộc trò chuyện này. Có thể bật lại trong trang Cài đặt của Vehicle Tracking.'
          : 'Cuộc trò chuyện này không nhận cảnh báo nào.',
      );
      return;
    }
    if (!command[2]) {
      await reply(
        'Mở liên kết "Kết nối Telegram" trong trang Cài đặt của Vehicle Tracking để nhận cảnh báo tại đây.',
      );
      return;
    }
    const code = command[2];
    const label = chatLabel(message.chat);
    const linked = await this.database.transaction(async (c) => {
      const owner = (
        await c.query(
          `SELECT t.owner_id, u.display_name FROM telegram_link_codes t JOIN users u ON u.id=t.owner_id
          WHERE t.code=$1 AND t.used_at IS NULL AND t.expires_at > now() AND u.is_active FOR UPDATE OF t`,
          [code],
        )
      ).rows[0];
      if (!owner) return null;
      await c.query('UPDATE telegram_link_codes SET used_at=now() WHERE code=$1', [code]);
      const channel = (
        await c.query(
          `INSERT INTO notification_channels(id, owner_id, kind, target, label) VALUES ($1, $2, 'telegram', $3, $4)
          ON CONFLICT (owner_id, kind, target) DO UPDATE SET enabled=true, label=EXCLUDED.label
          RETURNING id`,
          [newId(), owner.owner_id, chat, label],
        )
      ).rows[0];
      await c.query(
        `INSERT INTO audit_log(user_id, action, target_type, target_id, details)
        VALUES ($1, 'notification.link', 'notification_channel', $2, $3)`,
        [owner.owner_id, channel.id, JSON.stringify({ kind: 'telegram', label })],
      );
      return owner;
    });
    await reply(
      linked
        ? `Đã kết nối với tài khoản ${linked.display_name}. Cảnh báo biển số theo dõi sẽ được gửi vào đây. Gửi /stop để ngừng nhận.`
        : 'Liên kết không hợp lệ hoặc đã hết hạn. Hãy tạo liên kết mới trong trang Cài đặt.',
    );
  }
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
