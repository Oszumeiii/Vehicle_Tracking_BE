import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, normalizePlate, pagination } from '../common/http';
import { ApiFailures, ApiPage, ApiPageResponse } from '../common/openapi';
import { WatchlistResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { AuditLog } from '../audit/audit';
import { PRIORITIES, REASONS } from '../notify/settings';

const future = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) > Date.now(), 'expires_at must be in the future.');

const fields = {
  note: z.string().max(500),
  reason: z.enum(REASONS),
  priority: z.enum(PRIORITIES),
  expires_at: future.nullable(),
  shared: z.boolean(),
};

const createEntry = z
  .object({
    plate: z.string().max(32),
    note: fields.note.optional(),
    reason: fields.reason.optional(),
    priority: fields.priority.optional(),
    expires_at: fields.expires_at.optional(),
    shared: fields.shared.optional(),
  })
  .strict();

const updateEntry = z
  .object({
    note: fields.note.nullable().optional(),
    reason: fields.reason.optional(),
    priority: fields.priority.optional(),
    expires_at: fields.expires_at.optional(),
    shared: fields.shared.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

const listQuery = pagination
  .extend({ scope: z.enum(['all', 'mine', 'shared']).default('all') })
  .strict();

const ENTRY = `SELECT w.*, u.display_name AS owner_name,
  (w.expires_at IS NOT NULL AND w.expires_at <= now()) AS expired
  FROM plate_watchlist w JOIN users u ON u.id=w.owner_id`;

const entrySchema = {
  note: { type: 'string', maxLength: 500, nullable: true },
  reason: {
    type: 'string',
    enum: [...REASONS],
    description: 'Why the plate is watched (default other).',
  },
  priority: {
    type: 'string',
    enum: [...PRIORITIES],
    description: 'How urgent its alerts are (default normal).',
  },
  expires_at: {
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'The entry stops alerting after this time; null: never.',
  },
  shared: {
    type: 'boolean',
    description: 'Administrators only: alert everyone who sees the camera, not only the owner.',
  },
};

/** Who may change or remove an entry: its owner, and any administrator for a shared one. */
function canEdit(row: Record<string, any>, actor: Actor) {
  return row.owner_id === actor.id || (row.shared && actor.role === 'admin');
}

/**
 * Plates to be alerted about. Each finished live track is compared with them (exact or
 * one character off): a user's entries alert on that user's cameras, an administrator's
 * on every camera, and a shared entry alerts everyone who sees the camera. Alerts are
 * `alert` events on the live event stream and messages to the recipients' notification
 * channels (Telegram, webhook).
 */
@ApiTags('Live streams')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/watchlist')
export class WatchlistController {
  constructor(
    private db: Database,
    private audit: AuditLog,
  ) {}

  @Get()
  @ApiPageResponse(WatchlistResponse)
  @ApiPage()
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['all', 'mine', 'shared'],
    description: 'all (default): own and shared entries; mine: own only; shared: shared only.',
  })
  async list(@Req() req: { user: Actor }, @Query() input: unknown) {
    const { limit, offset, scope } = listQuery.parse(input);
    const where =
      scope === 'mine'
        ? 'w.owner_id=$1'
        : scope === 'shared'
          ? 'w.shared'
          : '(w.owner_id=$1 OR w.shared)';
    const values = scope === 'shared' ? [] : [req.user.id];
    const count = await this.db.query(
      `SELECT count(*) FROM plate_watchlist w WHERE ${where}`,
      values,
    );
    const items = await this.db.query(
      `${ENTRY} WHERE ${where} ORDER BY w.created_at DESC, w.id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return {
      total: Number(count.rows[0].count),
      limit,
      offset,
      items: items.rows.map((row) => ({ ...row, can_edit: canEdit(row, req.user) })),
    };
  }

  @Post()
  @ApiResponse({ status: 201, type: WatchlistResponse })
  @ApiFailures(403, 409)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['plate'],
      additionalProperties: false,
      properties: {
        plate: { type: 'string', description: 'Normalized to uppercase without spaces/hyphens' },
        ...entrySchema,
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    const body = createEntry.parse(input);
    const plate = normalizePlate(body.plate);
    if (!plate || plate.length > 16)
      throw new UnprocessableEntityException('Plate must have 1-16 characters.');
    if (body.shared && req.user.role !== 'admin')
      throw new ForbiddenException('Only administrators can share watchlist entries.');
    const id = newId();
    try {
      await this.db.query(
        `INSERT INTO plate_watchlist(id,owner_id,plate,note,reason,priority,expires_at,shared)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          req.user.id,
          plate,
          body.note || null,
          body.reason ?? 'other',
          body.priority ?? 'normal',
          body.expires_at ?? null,
          body.shared ?? false,
        ],
      );
    } catch (error) {
      if ((error as any)?.code === '23505')
        throw new ConflictException('This plate is already on your watchlist.');
      throw error;
    }
    await this.audit.record(req, 'watchlist.add', {
      targetType: 'watchlist',
      targetId: id,
      details: { plate, priority: body.priority ?? 'normal', shared: body.shared ?? false },
    });
    return this.entry(id, req.user);
  }

  @Patch(':id')
  @ApiResponse({ status: 200, type: WatchlistResponse })
  @ApiFailures(403, 404)
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: entrySchema,
    },
  })
  async update(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = updateEntry.parse(input);
    const row = (await this.db.query('SELECT * FROM plate_watchlist WHERE id=$1', [id])).rows[0];
    if (!row || !canEdit(row, req.user)) throw new NotFoundException('Watchlist entry not found.');
    if (body.shared !== undefined && req.user.role !== 'admin')
      throw new ForbiddenException('Only administrators can share watchlist entries.');
    const changes = Object.entries(body).map(([key, value]) => [
      key,
      key === 'note' ? value || null : value,
    ]);
    await this.db.query(
      `UPDATE plate_watchlist SET ${changes.map(([key], i) => `${key}=$${i + 2}`).join(', ')}, updated_at=now()
      WHERE id=$1`,
      [id, ...changes.map(([, value]) => value)],
    );
    await this.audit.record(req, 'watchlist.update', {
      targetType: 'watchlist',
      targetId: id,
      details: { plate: row.plate, changed: changes.map(([key]) => key) },
    });
    return this.entry(id, req.user);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Watchlist entry removed.' })
  @ApiFailures(404)
  async remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    const result = await this.db.query(
      'DELETE FROM plate_watchlist WHERE id=$1 AND (owner_id=$2 OR (shared AND $3)) RETURNING plate',
      [id, req.user.id, req.user.role === 'admin'],
    );
    if (!result.rowCount) throw new NotFoundException('Watchlist entry not found.');
    await this.audit.record(req, 'watchlist.delete', {
      targetType: 'watchlist',
      targetId: id,
      details: { plate: result.rows[0].plate },
    });
  }

  private async entry(id: string, actor: Actor) {
    const row = (await this.db.query(`${ENTRY} WHERE w.id=$1`, [id])).rows[0];
    return { ...row, can_edit: canEdit(row, actor) };
  }
}
