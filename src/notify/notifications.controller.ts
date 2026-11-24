import {
  BadGatewayException,
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
import { ApiBearerAuth, ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuditLog } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import {
  AlertDeliveryResponse,
  ChannelTestResponse,
  CreatedWebhookResponse,
  NotificationChannelListResponse,
  NotificationChannelResponse,
  TelegramLinkResponse,
} from '../common/api-models';
import { settings } from '../common/config';
import { Actor, newId, pagination } from '../common/http';
import { ApiFailures, ApiPage, ApiPageResponse } from '../common/openapi';
import { Database } from '../database/database';
import type { AlertPayload } from './message';
import { DeliveryError, sendDelivery, webhookUrl, type ChannelTarget } from './senders';
import { notifySettings, PRIORITIES } from './settings';
import { botUsername, createLinkCode } from './telegram';

const createWebhook = z
  .object({
    kind: z.literal('webhook'),
    target: z.string().trim().min(1).max(2000),
    label: z.string().trim().min(1).max(100).optional(),
    min_priority: z.enum(PRIORITIES).optional(),
  })
  .strict();

const updateChannel = z
  .object({
    label: z.string().trim().min(1).max(100).nullable().optional(),
    min_priority: z.enum(PRIORITIES).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

const CHANNEL = `SELECT id, kind, target, label, min_priority, enabled, created_at, last_sent_at,
  last_error, last_error_at FROM notification_channels`;

/**
 * Where a user's watchlist alerts go besides the live page: Telegram chats (linked through
 * the bot) and, for administrators, HTTPS webhooks that other systems receive. Messages
 * leave the system with the plate, camera, time and a picture: only add channels the
 * organisation may send that to.
 */
@ApiTags('Notifications')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/notification-channels')
export class NotificationsController {
  constructor(
    private db: Database,
    private audit: AuditLog,
  ) {}

  @Get()
  @ApiResponse({ status: 200, type: NotificationChannelListResponse })
  async list(@Req() req: { user: Actor }) {
    const { rows } = await this.db.query(`${CHANNEL} WHERE owner_id=$1 ORDER BY created_at, id`, [
      req.user.id,
    ]);
    return {
      items: rows,
      telegram: { configured: Boolean(notifySettings().telegramToken) },
      webhook: { allowed: req.user.role === 'admin' },
    };
  }

  @Get('deliveries')
  @ApiPageResponse(AlertDeliveryResponse)
  @ApiPage()
  async deliveries(@Req() req: { user: Actor }, @Query() input: unknown) {
    const { limit, offset } = pagination.strict().parse(input);
    const count = await this.db.query(
      `SELECT count(*) FROM alert_deliveries d JOIN notification_channels c ON c.id=d.channel_id
      WHERE c.owner_id=$1`,
      [req.user.id],
    );
    const { rows } = await this.db.query(
      `SELECT d.id, d.channel_id, c.kind AS channel_kind, c.label AS channel_label,
        d.payload->>'kind' AS kind, d.payload->>'plate' AS plate, d.payload->>'priority' AS priority,
        d.status, d.attempts, d.last_error, d.created_at, d.sent_at
      FROM alert_deliveries d JOIN notification_channels c ON c.id=d.channel_id
      WHERE c.owner_id=$1 ORDER BY d.created_at DESC, d.id LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );
    return { total: Number(count.rows[0].count), limit, offset, items: rows };
  }

  @Post('telegram/link')
  @HttpCode(201)
  @ApiResponse({ status: 201, type: TelegramLinkResponse })
  @ApiFailures(502)
  async link(@Req() req: { user: Actor }) {
    const config = notifySettings();
    if (!config.telegramToken)
      throw new UnprocessableEntityException(
        'Telegram is not set up: an administrator must add PLATE_TELEGRAM_BOT_TOKEN.',
      );
    let username: string;
    try {
      username = await botUsername(config);
    } catch (error) {
      throw new BadGatewayException(
        `Could not reach Telegram: ${error instanceof Error ? error.message : error}`,
      );
    }
    const { code, expires_at } = await createLinkCode(this.db, req.user.id);
    await this.audit.record(req, 'notification.link_requested', {
      targetType: 'notification_channel',
    });
    return { url: `https://t.me/${username}?start=${code}`, bot_username: username, expires_at };
  }

  @Post()
  @ApiResponse({ status: 201, type: CreatedWebhookResponse })
  @ApiFailures(403, 409)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['kind', 'target'],
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['webhook'],
          description: 'Telegram chats are added through /telegram/link.',
        },
        target: {
          type: 'string',
          maxLength: 2000,
          description: 'https URL that receives POSTed JSON.',
        },
        label: { type: 'string', maxLength: 100 },
        min_priority: { type: 'string', enum: [...PRIORITIES] },
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    if (req.user.role !== 'admin')
      throw new ForbiddenException('Only administrators can add webhooks.');
    const body = createWebhook.parse(input);
    try {
      webhookUrl(body.target, notifySettings().allowPrivateWebhooks);
    } catch (error) {
      throw new UnprocessableEntityException((error as Error).message);
    }
    const id = newId();
    const secret = randomBytes(32).toString('hex');
    try {
      await this.db.query(
        `INSERT INTO notification_channels(id, owner_id, kind, target, label, secret, min_priority)
        VALUES ($1, $2, 'webhook', $3, $4, $5, $6)`,
        [id, req.user.id, body.target, body.label ?? null, secret, body.min_priority ?? 'low'],
      );
    } catch (error) {
      if ((error as any)?.code === '23505')
        throw new ConflictException('This webhook is already added.');
      throw error;
    }
    await this.audit.record(req, 'notification.create', {
      targetType: 'notification_channel',
      targetId: id,
      details: { kind: 'webhook', host: new URL(body.target).host },
    });
    return { ...(await this.channel(id, req.user)), secret };
  }

  @Patch(':id')
  @ApiResponse({ status: 200, type: NotificationChannelResponse })
  @ApiFailures(404)
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        label: { type: 'string', maxLength: 100, nullable: true },
        min_priority: { type: 'string', enum: [...PRIORITIES] },
        enabled: { type: 'boolean' },
      },
    },
  })
  async update(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = updateChannel.parse(input);
    await this.channel(id, req.user);
    const changes = Object.entries(body);
    await this.db.query(
      `UPDATE notification_channels SET ${changes.map(([key], i) => `${key}=$${i + 2}`).join(', ')} WHERE id=$1`,
      [id, ...changes.map(([, value]) => value)],
    );
    await this.audit.record(req, 'notification.update', {
      targetType: 'notification_channel',
      targetId: id,
      details: body,
    });
    return this.channel(id, req.user);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Channel removed with its delivery history.' })
  @ApiFailures(404)
  async remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    const { rows } = await this.db.query(
      'DELETE FROM notification_channels WHERE id=$1 AND owner_id=$2 RETURNING kind',
      [id, req.user.id],
    );
    if (!rows.length) throw new NotFoundException('Notification channel not found.');
    await this.audit.record(req, 'notification.delete', {
      targetType: 'notification_channel',
      targetId: id,
      details: { kind: rows[0].kind },
    });
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiResponse({ status: 200, type: ChannelTestResponse })
  @ApiFailures(404)
  async test(@Req() req: { user: Actor }, @Param('id') id: string) {
    const channel = (
      await this.db.query('SELECT * FROM notification_channels WHERE id=$1 AND owner_id=$2', [
        id,
        req.user.id,
      ])
    ).rows[0] as (ChannelTarget & { label: string | null }) | undefined;
    if (!channel) throw new NotFoundException('Notification channel not found.');
    const payload: AlertPayload = { kind: 'test', label: channel.label };
    const deliveryId = newId();
    let error: string | null = null;
    try {
      await sendDelivery(
        channel,
        { id: deliveryId, payload },
        notifySettings(),
        settings().dataDir,
      );
    } catch (failure) {
      error =
        failure instanceof DeliveryError || failure instanceof Error
          ? failure.message
          : String(failure);
    }
    await this.db.query(
      `INSERT INTO alert_deliveries(id, channel_id, payload, status, attempts, last_error, sent_at)
      VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [
        deliveryId,
        id,
        JSON.stringify(payload),
        error ? 'failed' : 'sent',
        error,
        error ? null : new Date(),
      ],
    );
    await this.db.query(
      error
        ? 'UPDATE notification_channels SET last_error=$2, last_error_at=now() WHERE id=$1'
        : 'UPDATE notification_channels SET last_sent_at=now(), last_error=NULL, last_error_at=NULL WHERE id=$1',
      error ? [id, error] : [id],
    );
    await this.audit.record(req, 'notification.test', {
      targetType: 'notification_channel',
      targetId: id,
      details: { kind: channel.kind, ok: !error },
    });
    return { ok: !error, error, delivery_id: deliveryId };
  }

  private async channel(id: string, actor: Actor) {
    const row = (await this.db.query(`${CHANNEL} WHERE id=$1 AND owner_id=$2`, [id, actor.id]))
      .rows[0];
    if (!row) throw new NotFoundException('Notification channel not found.');
    return row;
  }
}
