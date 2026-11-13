import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Database } from '../database/database';
import { Actor } from '../common/http';
import { settings } from '../common/config';
import { diskLow } from '../common/disk';
import { ApiFailures } from '../common/openapi';
import { AuthGuard } from '../auth/auth.guard';
import { ACTIVE_SQL } from '../live/sessions';
import { PipelineRegistry } from '../recognition/registry';

/** The worker's advisory lock (src/worker.ts): held for as long as a worker runs. */
export const WORKER_LOCK = 762143901;
const HOUR = 3600_000;

/** Hours between database backups (PLATE_BACKUP_HOURS, default 24; 0: backups not expected). */
export function backupHours() {
  const value = Number(process.env.PLATE_BACKUP_HOURS ?? 24);
  if (!Number.isFinite(value) || value < 0) throw new Error('PLATE_BACKUP_HOURS must be >= 0');
  return value;
}

/** Minutes a job may wait in the queue before it is reported (PLATE_HEALTH_QUEUE_MINUTES, default 30). */
function queueMinutes() {
  const value = Number(process.env.PLATE_HEALTH_QUEUE_MINUTES ?? 30);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('PLATE_HEALTH_QUEUE_MINUTES must be positive');
  return value;
}

const CODES = [
  'WORKER_DOWN',
  'CAMERA_DOWN',
  'BACKUP_OVERDUE',
  'PIPELINE_UNAVAILABLE',
  'JOBS_WAITING',
  'DISK_LOW',
] as const;

class HealthIssue {
  @ApiProperty({ enum: CODES }) code!: (typeof CODES)[number];
  @ApiProperty({ enum: ['error', 'warning'] }) severity!: 'error' | 'warning';
  @ApiProperty({ nullable: true, description: 'Camera or pipeline the issue is about.' })
  subject!: string | null;
  @ApiProperty({ nullable: true, description: 'Cause as the system reported it.' })
  detail!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  since!: string | null;
}

class SystemHealthResponse {
  @ApiProperty({ description: 'No issue of any severity.' }) ok!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) checked_at!: string;
  @ApiProperty() worker_running!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_backup_at!: string | null;
  @ApiProperty({ type: [HealthIssue] }) issues!: HealthIssue[];
}

/**
 * What an operator must know without reading logs: the worker is gone, an always-on
 * camera does not restart, backups stopped, a model is missing, jobs pile up, the disk
 * is full. Each of these used to fail silently.
 */
@ApiTags('Accounts')
@ApiFailures(401, 403)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/system')
export class SystemHealthController {
  // Listing pipelines hashes every checkpoint; the banner polls once a minute.
  private pipelines?: { at: number; issues: HealthIssue[] };

  constructor(
    private db: Database,
    private registry: PipelineRegistry,
  ) {}

  @Get('health')
  @ApiResponse({ status: 200, type: SystemHealthResponse })
  async health(@Req() req: { user: Actor }): Promise<SystemHealthResponse> {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator access required.');
    const issues: HealthIssue[] = [];
    const worker = await this.workerRunning();
    if (!worker)
      issues.push({
        code: 'WORKER_DOWN',
        severity: 'error',
        subject: null,
        detail: 'No recognition worker holds the database lock.',
        since: null,
      });
    issues.push(...(await this.cameras()));
    const backup = await this.lastBackup();
    const hours = backupHours();
    if (hours && (!backup || Date.now() - backup.getTime() > 2 * hours * HOUR))
      issues.push({
        code: 'BACKUP_OVERDUE',
        severity: 'warning',
        subject: null,
        detail: backup
          ? `No database backup for more than ${2 * hours} hours.`
          : 'No database backup was found.',
        since: backup?.toISOString() ?? null,
      });
    issues.push(...(await this.pipelineIssues()));
    issues.push(...(await this.waitingJobs()));
    const disk = await diskLow(settings().dataDir);
    if (disk.low)
      issues.push({
        code: 'DISK_LOW',
        severity: 'error',
        subject: null,
        detail: `Less than ${Math.round(disk.floor / 2 ** 30)} GB free: cameras are paused and uploads refused.`,
        since: null,
      });
    return {
      ok: issues.length === 0,
      checked_at: new Date().toISOString(),
      worker_running: worker,
      last_backup_at: backup?.toISOString() ?? null,
      issues,
    };
  }

  private async workerRunning() {
    // A one-key advisory lock is stored as (classid, objid) = (high, low 32 bits), objsubid 1.
    const { rows } = await this.db.query(
      `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid=l.database
      WHERE d.datname=current_database() AND l.locktype='advisory' AND l.granted
        AND l.classid=0 AND l.objid=$1 AND l.objsubid=1 LIMIT 1`,
      [WORKER_LOCK],
    );
    return rows.length > 0;
  }

  /** Always-on cameras without a session for three minutes (the worker queues one in seconds). */
  private async cameras(): Promise<HealthIssue[]> {
    const { rows } = await this.db.query(
      `SELECT c.name, last.finished_at, last.error_code,
        (SELECT e.payload->>'message' FROM live_session_events e
          WHERE e.session_id=last.id AND e.event_type='error'
            AND e.payload->>'code'='AUTO_RESTART_FAILED'
          ORDER BY e.id DESC LIMIT 1) AS restart_error
      FROM stream_sources c
      LEFT JOIN LATERAL (SELECT s.id, s.finished_at, s.error_code FROM live_sessions s
        WHERE s.stream_source_id=c.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) last ON true
      WHERE c.always_on
        AND NOT EXISTS (SELECT 1 FROM live_sessions s
          WHERE s.stream_source_id=c.id AND s.status IN ${ACTIVE_SQL})
        AND coalesce(last.finished_at, c.updated_at) < now() - interval '3 minutes'
      ORDER BY c.name`,
    );
    return rows.map((row) => ({
      code: 'CAMERA_DOWN' as const,
      severity: 'error' as const,
      subject: row.name,
      detail: row.restart_error ?? row.error_code ?? null,
      since: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    }));
  }

  private async lastBackup() {
    const folder = path.join(settings().dataDir, 'backups');
    let latest = 0;
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith('.dump')) continue;
      const info = await stat(path.join(folder, name)).catch(() => null);
      if (info?.isFile() && info.size > 0) latest = Math.max(latest, info.mtimeMs);
    }
    return latest ? new Date(latest) : null;
  }

  private async pipelineIssues() {
    if (this.pipelines && Date.now() - this.pipelines.at < 5 * 60_000) return this.pipelines.issues;
    let issues: HealthIssue[];
    try {
      const list = await this.registry.list();
      issues = list
        .filter((item) => !item.ready)
        .map((item) => ({
          code: 'PIPELINE_UNAVAILABLE' as const,
          severity: 'error' as const,
          subject: item.name,
          detail: item.unavailable_reason,
          since: null,
        }));
      if (!list.some((item) => item.task === 'recognize'))
        issues.push({
          code: 'PIPELINE_UNAVAILABLE',
          severity: 'error',
          subject: null,
          detail: 'No recognition pipeline is configured.',
          since: null,
        });
    } catch (error) {
      issues = [
        {
          code: 'PIPELINE_UNAVAILABLE',
          severity: 'error',
          subject: null,
          detail: error instanceof Error ? error.message : 'Pipeline configuration is unavailable',
          since: null,
        },
      ];
    }
    this.pipelines = { at: Date.now(), issues };
    return issues;
  }

  /** Uploaded jobs queued for too long; live tracks are ingested already recognized. */
  private async waitingJobs(): Promise<HealthIssue[]> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS waiting, min(created_at) AS oldest FROM recognition_jobs
      WHERE status='queued' AND created_at < now() - $1 * interval '1 minute'`,
      [queueMinutes()],
    );
    if (!rows[0].waiting) return [];
    return [
      {
        code: 'JOBS_WAITING',
        severity: 'warning',
        subject: null,
        detail: `${rows[0].waiting} job(s) queued for more than ${queueMinutes()} minutes.`,
        since: new Date(rows[0].oldest).toISOString(),
      },
    ];
  }
}
