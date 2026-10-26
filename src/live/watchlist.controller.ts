import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, normalizePlate, pagination } from '../common/http';
import { ApiFailures, ApiPage, ApiPageResponse } from '../common/openapi';
import { WatchlistResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';

const createEntry = z
  .object({ plate: z.string().max(32), note: z.string().max(500).optional() })
  .strict();

/**
 * Plates a user wants to be alerted about. Each finished live track on a camera the
 * user can see is compared with them (exact or one character off) and matches are
 * pushed as `alert` events on the live event stream.
 */
@ApiTags('Live streams')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/watchlist')
export class WatchlistController {
  constructor(private db: Database) {}

  @Get()
  @ApiPageResponse(WatchlistResponse)
  @ApiPage()
  async list(@Req() req: { user: Actor }, @Query() input: unknown) {
    const { limit, offset } = pagination.strict().parse(input);
    const count = await this.db.query('SELECT count(*) FROM plate_watchlist WHERE owner_id=$1', [
      req.user.id,
    ]);
    const items = await this.db.query(
      'SELECT * FROM plate_watchlist WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
      [req.user.id, limit, offset],
    );
    return { total: Number(count.rows[0].count), limit, offset, items: items.rows };
  }

  @Post()
  @ApiResponse({ status: 201, type: WatchlistResponse })
  @ApiFailures(409)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['plate'],
      additionalProperties: false,
      properties: {
        plate: { type: 'string', description: 'Normalized to uppercase without spaces/hyphens' },
        note: { type: 'string', maxLength: 500 },
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    const body = createEntry.parse(input);
    const plate = normalizePlate(body.plate);
    if (!plate || plate.length > 16)
      throw new UnprocessableEntityException('Plate must have 1-16 characters.');
    try {
      return (
        await this.db.query(
          'INSERT INTO plate_watchlist(id,owner_id,plate,note) VALUES($1,$2,$3,$4) RETURNING *',
          [newId(), req.user.id, plate, body.note ?? null],
        )
      ).rows[0];
    } catch (error) {
      if ((error as any)?.code === '23505')
        throw new ConflictException('This plate is already on your watchlist.');
      throw error;
    }
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Watchlist entry removed.' })
  @ApiFailures(404)
  async remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    const result = await this.db.query('DELETE FROM plate_watchlist WHERE id=$1 AND owner_id=$2', [
      id,
      req.user.id,
    ]);
    if (!result.rowCount) throw new NotFoundException('Watchlist entry not found.');
  }
}
