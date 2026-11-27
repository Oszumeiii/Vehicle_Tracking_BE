import type { NotifySettings, Priority, Reason } from './settings';

/** What a delivery says, fixed when the alert fired (alert_deliveries.payload). */
export interface AlertPayload {
  kind: 'alert' | 'test';
  /** Channel name shown in a test message. */
  label?: string | null;
  plate?: string;
  watch_plate?: string;
  distance?: number;
  /** How the read matched the watched plate (plate-match matchReason); absent on older alerts. */
  match_reason?: 'same' | 'alternative' | 'confusable' | 'near';
  /** match_reason=alternative: the probability the model gave the watched plate. */
  match_probability?: number | null;
  priority?: Priority;
  reason?: Reason;
  note?: string | null;
  shared?: boolean;
  camera?: { id: string; name: string; latitude: number | null; longitude: number | null };
  captured_from?: string;
  confidence_status?: string;
  confidence?: number | null;
  job_id?: string;
  result_id?: string;
  session_id?: string;
  /** Storage keys of a scene frame and of the plate crop (pictures for Telegram). */
  image?: string | null;
  crop?: string | null;
}

const PRIORITY_TEXT: Record<string, string> = { high: 'CAO', normal: 'thường', low: 'thấp' };
const REASON_TEXT: Record<string, string> = {
  stolen: 'xe mất cắp',
  wanted: 'truy tìm',
  suspect: 'nghi vấn',
  vip: 'xe ưu tiên',
  other: 'khác',
};
const STATUS_TEXT: Record<string, string> = {
  readable: 'đọc rõ',
  low_confidence: 'tin cậy thấp',
  unreadable: 'không đọc được',
};

/** "11:00:03 21/11/2026 (GMT+7)" in the given time zone. */
export function formatTime(iso: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute}:${parts.second} ${parts.day}/${parts.month}/${parts.year} (${parts.timeZoneName})`;
}

/** Page of the web app listing the reads of this plate, when PLATE_PUBLIC_URL is set. */
export function resultsUrl(plate: string | undefined, settings: Pick<NotifySettings, 'publicUrl'>) {
  return settings.publicUrl && plate
    ? `${settings.publicUrl}/results?plate=${encodeURIComponent(plate)}&match=exact`
    : null;
}

/** How the read relates to the watched plate, unless it is that plate. */
function matchLine(payload: AlertPayload) {
  if (payload.match_reason === 'alternative' && typeof payload.match_probability === 'number')
    return (
      `Máy đọc ra ${payload.plate}, nhưng cũng có thể là ${payload.watch_plate} ` +
      `(model cân nhắc ${Math.round(payload.match_probability * 100)}%)`
    );
  if (!payload.distance) return null;
  if (payload.match_reason === 'same')
    return `Cùng xe với ${payload.watch_plate} (biển cũ và biển Mercosul)`;
  return `Khớp gần đúng với ${payload.watch_plate} (lệch ${payload.distance} ký tự)`;
}

/** The message text (Vietnamese, plain text: no markup to escape). */
export function alertText(
  payload: AlertPayload,
  settings: Pick<NotifySettings, 'publicUrl' | 'timeZone'>,
) {
  if (payload.kind === 'test')
    return [
      '✅ Tin thử từ Vehicle Tracking.',
      `Kênh "${payload.label || 'không tên'}" nhận được tin: cảnh báo biển số theo dõi sẽ được gửi tới đây.`,
    ].join('\n');
  const camera = payload.camera;
  const url = resultsUrl(payload.plate, settings);
  const lines = [
    `🚨 Biển số theo dõi: ${payload.plate}`,
    matchLine(payload),
    `Mức ưu tiên: ${PRIORITY_TEXT[payload.priority ?? 'normal']} · Lý do: ${REASON_TEXT[payload.reason ?? 'other']}`,
    camera ? `Camera: ${camera.name}` : null,
    payload.captured_from ? `Lúc: ${formatTime(payload.captured_from, settings.timeZone)}` : null,
    payload.confidence_status
      ? `Máy đọc: ${STATUS_TEXT[payload.confidence_status] ?? payload.confidence_status}` +
        (typeof payload.confidence === 'number'
          ? ` (độ tin cậy ${payload.confidence.toFixed(2).replace('.', ',')})`
          : '')
      : null,
    payload.note ? `Ghi chú: ${payload.note}` : null,
    payload.shared ? 'Danh sách theo dõi chung của đơn vị' : null,
    camera && camera.latitude !== null && camera.longitude !== null
      ? `Bản đồ: https://www.google.com/maps?q=${camera.latitude},${camera.longitude}`
      : null,
    url ? `Xem: ${url}` : null,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

/** JSON a webhook receives; storage keys stay internal. */
export function webhookBody(
  delivery: { id: string; payload: AlertPayload },
  settings: Pick<NotifySettings, 'publicUrl'>,
  now = new Date(),
) {
  const p = delivery.payload;
  return JSON.stringify({
    event: p.kind === 'test' ? 'test' : 'watchlist.alert',
    delivery_id: delivery.id,
    sent_at: now.toISOString(),
    ...(p.kind === 'test'
      ? {}
      : {
          alert: {
            plate: p.plate,
            watch_plate: p.watch_plate,
            distance: p.distance,
            match_reason: p.match_reason ?? null,
            match_probability: p.match_probability ?? null,
            priority: p.priority,
            reason: p.reason,
            note: p.note ?? null,
            shared: p.shared ?? false,
            captured_from: p.captured_from,
            confidence_status: p.confidence_status,
            confidence: p.confidence ?? null,
            camera: p.camera ?? null,
            result_id: p.result_id,
            job_id: p.job_id,
            url: resultsUrl(p.plate, settings),
          },
        }),
  });
}
