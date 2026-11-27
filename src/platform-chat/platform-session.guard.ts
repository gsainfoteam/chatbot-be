import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { DB_CONNECTION, type Database, sessions, widgetKeys } from '../db';
import type { SessionPayload } from '../auth/decorators/current-session.decorator';

@Injectable()
export class PlatformSessionGuard implements CanActivate {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { session: SessionPayload }>();
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
    if (!match)
      throw new UnauthorizedException('No platform session token provided');
    try {
      const payload = await this.jwt.verifyAsync<{
        sessionId: string;
        widgetKeyId: string;
        channel: string;
      }>(match[1]);
      if (
        payload.channel !== 'platform' ||
        !payload.widgetKeyId ||
        !payload.sessionId
      )
        throw new Error('Wrong channel');
      const [session] = await this.db
        .select({ id: sessions.id, widgetKeyId: sessions.widgetKeyId })
        .from(sessions)
        .innerJoin(widgetKeys, eq(widgetKeys.id, sessions.widgetKeyId))
        .where(
          and(
            eq(sessions.id, payload.sessionId),
            eq(sessions.widgetKeyId, payload.widgetKeyId),
            eq(sessions.channel, 'platform'),
            eq(sessions.sessionToken, match[1]),
            gt(sessions.expiresAt, new Date()),
            eq(widgetKeys.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!session) throw new Error('Expired session');
      req.session = { sessionId: session.id, widgetKeyId: session.widgetKeyId };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired platform session');
    }
  }
}
