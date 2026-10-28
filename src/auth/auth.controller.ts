import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, pagination } from '../common/http';
import { settings } from '../common/config';
import { ApiFailures, ApiPage, ApiPageResponse } from '../common/openapi';
import { LoginResponse, UserResponse } from '../common/api-models';
import { AuthGuard } from './auth.guard';
import { hashPassword, verifyPassword, makeToken, hashToken } from './security';
import { LoginThrottle } from './throttle';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const loginSchema = z.object({ email, password: z.string().min(1).max(1024) }).strict();
const userSchema = loginSchema.extend({
  password: z.string().min(12).max(1024),
  display_name: z.string().trim().min(1).max(120),
  role: z.enum(['admin', 'user']).default('user'),
});
const patchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(12).max(1024).optional(),
    role: z.enum(['admin', 'user']).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const publicFields = 'id,email,display_name,role,is_active,created_at';
const dummyHash = hashPassword('comparison-only-no-user');
const admin = (actor: Actor) => {
  if (actor.role !== 'admin') throw new ForbiddenException('Administrator access required.');
};

@ApiTags('Accounts')
@ApiFailures(401, 422)
@Controller('api/v2')
export class AuthController {
  private readonly window = settings().loginWindowMinutes * 60000;
  private readonly perAccount = new LoginThrottle(settings().loginMaxFailures, this.window);
  private readonly perAddress = new LoginThrottle(
    settings().loginMaxFailuresPerAddress,
    this.window,
  );

  constructor(private readonly db: Database) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({
    status: 429,
    description: 'Too many failed sign-ins from this address (for this email); see Retry-After.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password'],
      additionalProperties: false,
      properties: {
        email: { type: 'string', format: 'email', maxLength: 254 },
        password: { type: 'string', format: 'password', minLength: 1, maxLength: 1024 },
      },
    },
  })
  async login(
    @Body() input: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = loginSchema.parse(input);
    const address = req.ip ?? 'unknown';
    const account = `${body.email}|${address}`;
    const wait = Math.max(this.perAccount.retryAfter(account), this.perAddress.retryAfter(address));
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpException(
        `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = (await this.db.query('SELECT * FROM users WHERE email=$1', [body.email])).rows[0];
    const valid = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash));
    if (!valid || !user?.is_active) {
      this.perAccount.fail(account);
      this.perAddress.fail(address);
      throw new UnauthorizedException('Invalid email or password.');
    }
    this.perAccount.succeed(account);
    const token = makeToken();
    const expiry = new Date(Date.now() + settings().sessionHours * 3600000);
    // Lock the account while creating a session so disabling it cannot race login.
    await this.db.transaction(async (c) => {
      const current = (
        await c.query('SELECT is_active,password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])
      ).rows[0];
      if (!current?.is_active || current.password_hash !== user.password_hash)
        throw new UnauthorizedException('Account changed; sign in again.');
      await c.query(
        'INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
        [newId(), user.id, hashToken(token), expiry],
      );
    });
    return { access_token: token, token_type: 'bearer', expires_at: expiry };
  }

  @Post('auth/logout')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Current session revoked.' })
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async logout(@Req() req: { user: Actor }) {
    await this.db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [
      req.user.session_id,
    ]);
  }

  @Get('auth/me')
  @ApiResponse({ status: 200, type: UserResponse })
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  me(@Req() req: { user: Actor }) {
    const { session_id, ...user } = req.user;
    return user;
  }

  @Get('users')
  @ApiPageResponse(UserResponse)
  @ApiFailures(403)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiPage()
  async users(@Req() req: { user: Actor }, @Query() query: unknown) {
    admin(req.user);
    const { limit, offset } = pagination.parse(query);
    const [count, items] = await Promise.all([
      this.db.query('SELECT count(*) FROM users'),
      this.db.query(`SELECT ${publicFields} FROM users ORDER BY created_at,id LIMIT $1 OFFSET $2`, [
        limit,
        offset,
      ]),
    ]);
    return { total: Number(count.rows[0].count), limit, offset, items: items.rows };
  }

  @Post('users')
  @ApiResponse({ status: 201, type: UserResponse })
  @ApiFailures(403, 409)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password', 'display_name'],
      additionalProperties: false,
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', format: 'password', minLength: 12, maxLength: 1024 },
        display_name: { type: 'string', minLength: 1, maxLength: 120 },
        role: { type: 'string', enum: ['admin', 'user'], default: 'user' },
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    admin(req.user);
    const body = userSchema.parse(input);
    return (
      await this.db.query(
        `INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5) RETURNING ${publicFields}`,
        [newId(), body.email, await hashPassword(body.password), body.display_name, body.role],
      )
    ).rows[0];
  }

  @Patch('users/:id')
  @ApiResponse({ status: 200, type: UserResponse })
  @ApiFailures(403, 404, 409)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiBody({
    schema: {
      type: 'object',
      minProperties: 1,
      additionalProperties: false,
      properties: {
        password: { type: 'string', format: 'password', minLength: 12, maxLength: 1024 },
        display_name: { type: 'string', minLength: 1, maxLength: 120 },
        role: { type: 'string', enum: ['admin', 'user'] },
        is_active: { type: 'boolean' },
      },
    },
  })
  async patch(@Req() req: { user: Actor }, @Param('id') targetId: string, @Body() input: unknown) {
    admin(req.user);
    const body = patchSchema.parse(input);
    const password = body.password ? await hashPassword(body.password) : null;
    return this.db.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(781921)');
      const target = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [targetId]))
        .rows[0];
      if (!target) throw new NotFoundException('User not found.');
      if (
        target.role === 'admin' &&
        target.is_active &&
        (body.role === 'user' || body.is_active === false)
      ) {
        const active = await c.query("SELECT count(*) FROM users WHERE role='admin' AND is_active");
        if (Number(active.rows[0].count) <= 1)
          throw new ConflictException('Cannot disable or demote the last administrator.');
      }
      const result = await c.query(
        `UPDATE users SET display_name=COALESCE($2,display_name),role=COALESCE($3,role),is_active=COALESCE($4,is_active),password_hash=COALESCE($5,password_hash) WHERE id=$1 RETURNING ${publicFields}`,
        [targetId, body.display_name, body.role, body.is_active, password],
      );
      if (password || body.is_active === false)
        await c.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [targetId],
        );
      return result.rows[0];
    });
  }
}
