import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Database } from '../database/database';
import { assetTokenValid, hashToken, parseAssetToken } from './security';

const SESSION_USER = `SELECT u.id,u.email,u.display_name,u.role,u.is_active,u.created_at,s.id AS session_id,s.token_hash
  FROM auth_sessions s JOIN users u ON u.id=s.user_id
  WHERE s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active`;

// Files opened by <img>/<video> tags, which cannot send an Authorization header.
const ASSET_PATH =
  /^\/api\/v2\/(?:media\/[^/]+\/content|detections\/[^/]+\/artifacts\/(?:crop|frame|enhanced)|recognition-results\/[^/]+\/video|stream-sources\/[^/]+\/(?:recording|demo-video|live\.m3u8|live\/[0-9a-f]{32}\/e\d{3}\/\d{6}\.ts))\/?$/;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization ?? '';
    const assetRequest = ['GET', 'HEAD'].includes(request.method) && ASSET_PATH.test(request.path);
    let row;
    if (!authHeader && assetRequest && typeof request.query?.asset_token === 'string') {
      // Signed, short-lived token from POST /auth/asset-token.
      const parsed = parseAssetToken(request.query.asset_token);
      if (parsed) {
        row = (await this.db.query(`${SESSION_USER} AND s.id=$1`, [parsed.sessionId])).rows[0];
        if (row && !assetTokenValid(parsed, row.token_hash)) row = undefined;
      }
      if (!row) throw new UnauthorizedException('Invalid or expired asset link.');
    } else {
      let token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authHeader)?.[1];
      // Deprecated: the bearer token itself in the URL. Kept until clients use asset tokens.
      if (!authHeader && assetRequest && typeof request.query?.token === 'string') {
        token = request.query.token;
      }
      if (!token) throw new UnauthorizedException('Authentication required.');
      row = (await this.db.query(`${SESSION_USER} AND s.token_hash=$1`, [hashToken(token)]))
        .rows[0];
      if (!row) throw new UnauthorizedException('Invalid or expired session.');
    }
    const { token_hash, ...user } = row;
    request.user = user;
    return true;
  }
}
