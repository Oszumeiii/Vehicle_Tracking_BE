import { Injectable, Logger } from '@nestjs/common';
import { Database } from '../database/database';

/** The parts of an Express request an audit row needs. */
export interface AuditRequest {
  user?: { id: string } | null;
  ip?: string;
}

export interface AuditEntry {
  /** Who acted when there is no signed-in user on the request (a sign-in). */
  userId?: string | null;
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

// Keys never written to details, whatever a caller passes.
const SECRET_KEYS = /pass(word)?|token|secret|authorization|cookie/i;

function clean(details: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details))
    if (value !== undefined && !SECRET_KEYS.test(key)) out[key] = value;
  return out;
}

export function auditRetentionDays() {
  const value = Number(process.env.PLATE_AUDIT_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(value) || value < 1)
    throw new Error('PLATE_AUDIT_RETENTION_DAYS must be at least 1');
  return Math.floor(value);
}

/**
 * Appends to audit_log. Recording never fails the request it describes: a failed
 * insert is logged and dropped. Call it after the action succeeded (or, for failed
 * sign-ins, before refusing).
 */
@Injectable()
export class AuditLog {
  private readonly logger = new Logger('Audit');
  constructor(private readonly db: Database) {}

  async record(req: AuditRequest, action: string, entry: AuditEntry = {}) {
    try {
      await this.db.query(
        `INSERT INTO audit_log(user_id,action,target_type,target_id,details,ip)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          entry.userId !== undefined ? entry.userId : (req.user?.id ?? null),
          action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          JSON.stringify(clean(entry.details)),
          req.ip?.slice(0, 64) ?? null,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Could not record ${action}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
