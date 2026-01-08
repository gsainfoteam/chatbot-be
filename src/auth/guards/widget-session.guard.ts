import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { DB_CONNECTION, type Database } from '../../db';
import { sessions } from '../../db/schema';
import { eq, and, gt } from 'drizzle-orm';

@Injectable()
export class WidgetSessionGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    @Inject(DB_CONNECTION) private db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No session token provided');
    }

    try {
      // JWT 검증
      const payload = await this.jwtService.verifyAsync(token);

      // DB에서 세션 확인 (만료 여부 포함)
      const [session] = await this.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, payload.sessionId),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!session) {
        throw new UnauthorizedException('Invalid or expired session');
      }

      // request에 세션 정보 추가
      (request as any).session = {
        sessionId: session.id,
        widgetKeyId: session.widgetKeyId,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid session token');
    }
  }

  private extractTokenFromHeader(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization) {
      return undefined;
    }

    const [type, token] = authorization.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
