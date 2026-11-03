import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, checkDates, instant, pagination } from '../common/http';
import { ApiFailures, ApiPage, ApiPageResponse, ApiTimeRange } from '../common/openapi';
import { AuthGuard } from '../auth/auth.guard';

const filter = pagination
  .extend({
    user_id: z.string().max(32).optional(),
    action: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]*)?$/, 'An action like auth.login, or a prefix like auth.')
      .optional(),
    from: instant,
    to: instant,
  })
  .strict();

export class AuditEntryResponse {
  @ApiProperty({ type: 'integer' }) id!: number;
  @ApiProperty({ type: String, nullable: true }) user_id!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Email of user_id, if it still exists.',
  })
  user_email!: string | null;
  @ApiProperty({ description: 'e.g. auth.login, results.search, journey.view, camera.delete' })
  action!: string;
  @ApiProperty({ type: String, nullable: true }) target_type!: string | null;
  @ApiProperty({ type: String, nullable: true }) target_id!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) details!: Record<string, unknown>;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) created_at!: string;
}

@ApiTags('Accounts')
@ApiFailures(401, 403, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class AuditController {
  constructor(private db: Database) {}

  @Get('audit-logs')
  @ApiPageResponse(AuditEntryResponse)
  @ApiPage()
  @ApiQuery({ name: 'user_id', required: false, type: String })
  @ApiQuery({
    name: 'action',
    required: false,
    type: String,
    description: 'Exact action (`auth.login`) or a prefix ending with a dot (`auth.`).',
  })
  @ApiTimeRange('from', 'to')
  async list(@Req() req: { user: Actor }, @Query() input: unknown) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator access required.');
    const f = filter.parse(input);
    checkDates(f.from, f.to);
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (f.user_id) add('l.user_id=?', f.user_id);
    if (f.action?.endsWith('.')) add('l.action LIKE ?', `${f.action}%`);
    else if (f.action) add('l.action=?', f.action);
    if (f.from) add('l.created_at>=?', f.from);
    if (f.to) add('l.created_at<=?', f.to);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(
      (await this.db.query(`SELECT count(*) FROM audit_log l ${where}`, values)).rows[0].count,
    );
    const items = await this.db.query(
      `SELECT l.*, u.email AS user_email FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
      ${where} ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, f.limit, f.offset],
    );
    return {
      total,
      limit: f.limit,
      offset: f.offset,
      items: items.rows.map((row) => ({ ...row, id: Number(row.id) })),
    };
  }
}
