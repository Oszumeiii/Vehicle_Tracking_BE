import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Database } from '../database/database';
import { hashToken } from './security';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization ?? '';
    let token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authHeader)?.[1];
    const assetRequest =
      ['GET', 'HEAD'].includes(request.method) &&
      /^\/api\/v2\/(?:media\/[^/]+\/content|detections\/[^/]+\/artifacts\/(?:crop|frame|enhanced))\/?$/.test(
        request.path,
      );
    if (!authHeader && assetRequest && typeof request.query?.token === 'string') {
      token = request.query.token;
    }
    if (!token) throw new UnauthorizedException('Authentication required.');
    const { rows } = await this.db.query(
      `SELECT u.id,u.email,u.display_name,u.role,u.is_active,u.created_at,s.id AS session_id
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new UnauthorizedException('Invalid or expired session.');
    request.user = rows[0];
    return true;
  }
}
