/** Why a plate is watched; shown in alerts and messages. */
export const REASONS = ['stolen', 'wanted', 'suspect', 'vip', 'other'] as const;
export type Reason = (typeof REASONS)[number];

export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const priorityRank = (priority: string) =>
  Math.max(0, PRIORITIES.indexOf(priority as Priority));

function flag(value: string | undefined) {
  return /^(1|true|yes)$/i.test((value ?? '').trim());
}

/**
 * Alert delivery settings.
 *
 * PLATE_TELEGRAM_BOT_TOKEN   token of a bot made with @BotFather (Telegram off without it)
 * PLATE_TELEGRAM_BOT_USERNAME  its @username, else asked from Telegram (getMe)
 * PLATE_TELEGRAM_API_URL     Bot API base (default https://api.telegram.org; tests use a stub)
 * PLATE_PUBLIC_URL           address of the web app, for "open" links in messages
 * PLATE_ALERT_TIMEZONE       time zone of times in messages (default Asia/Ho_Chi_Minh)
 * PLATE_WEBHOOK_ALLOW_PRIVATE  true: webhooks may use http and private or local addresses
 * PLATE_ALERT_POLL_SECONDS   how often the worker looks for deliveries due (default 2)
 */
export function notifySettings(env: NodeJS.ProcessEnv = process.env) {
  const timeZone = env.PLATE_ALERT_TIMEZONE?.trim() || 'Asia/Ho_Chi_Minh';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new Error(`PLATE_ALERT_TIMEZONE is not a time zone: ${timeZone}`);
  }
  const poll = Number(env.PLATE_ALERT_POLL_SECONDS ?? 2);
  if (!Number.isFinite(poll) || poll <= 0)
    throw new Error('PLATE_ALERT_POLL_SECONDS must be positive');
  const publicUrl = env.PLATE_PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  if (publicUrl && !/^https?:\/\/[^\s/]+/i.test(publicUrl))
    throw new Error('PLATE_PUBLIC_URL must be an http(s) address such as https://example.org');
  return {
    telegramToken: env.PLATE_TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramUsername: env.PLATE_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || null,
    telegramApi: (env.PLATE_TELEGRAM_API_URL?.trim() || 'https://api.telegram.org').replace(
      /\/+$/,
      '',
    ),
    publicUrl,
    timeZone,
    allowPrivateWebhooks: flag(env.PLATE_WEBHOOK_ALLOW_PRIVATE),
    pollMs: poll * 1000,
    // 30 s, 1, 2, 4, 8, 16, 30, 30 min: about an hour and a half before giving up.
    maxAttempts: 8,
  };
}

export type NotifySettings = ReturnType<typeof notifySettings>;

/** Wait before the next attempt after `attempts` failures. */
export function retryDelayMs(attempts: number) {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * PLATE_ALERT_ALTERNATIVE_MIN: a watched plate alerts when the model weighed it as an
 * alternative reading with at least this probability (default 0.3; 1 turns it off, as an
 * alternative never reaches it). On ICPR, alternatives at 30-50% were the true plate about
 * one time in three, so these alerts say "có thể là" (docs/EVALUATION.md "Tìm kiếm xấp xỉ").
 */
export function alertAlternativeMin(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.PLATE_ALERT_ALTERNATIVE_MIN ?? 0.3);
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new Error('PLATE_ALERT_ALTERNATIVE_MIN must be above 0 and at most 1');
  return value;
}
