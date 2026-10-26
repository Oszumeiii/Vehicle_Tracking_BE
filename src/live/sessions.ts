import type { QueryResult } from 'pg';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

/** Sessions holding (or about to hold) a live process; one per camera at a time. */
export const ACTIVE_STATUSES = ['queued', 'starting', 'running', 'reconnecting', 'stopping'];
export const ACTIVE_SQL = `(${ACTIVE_STATUSES.map((s) => `'${s}'`).join(',')})`;

export function sessionView(row: Record<string, any>) {
  const { pipeline_snapshot, owner_id: _owner, ...value } = row;
  return {
    ...value,
    // bigint sums arrive from pg as strings.
    ...(value.evidence_bytes == null ? {} : { evidence_bytes: Number(value.evidence_bytes) }),
    pipeline_id: pipeline_snapshot?.id ?? null,
    pipeline_version: pipeline_snapshot?.version ?? null,
    results_url: `/api/v2/recognition-results?live_session_id=${row.id}`,
  };
}

/** Durable session history; ids increase, so clients can resume after the last one seen. */
export async function recordEvent(
  c: Queryable,
  sessionId: string,
  type: 'status' | 'error' | 'track_rejected' | 'track' | 'alert',
  payload: Record<string, unknown>,
) {
  await c.query('INSERT INTO live_session_events(session_id,event_type,payload) VALUES($1,$2,$3)', [
    sessionId,
    type,
    JSON.stringify(payload),
  ]);
}
