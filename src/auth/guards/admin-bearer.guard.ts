import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminBearerGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No admin token provided');
    }

    const adminToken = this.configService.get<string>('ADMIN_BEARER_TOKEN');

    if (!adminToken) {
      throw new UnauthorizedException('Admin authentication not configured');
    }

    // 타이밍 공격 방지를 위한 안전한 문자열 비교
    if (!this.secureCompare(token, adminToken)) {
      throw new UnauthorizedException('Invalid admin token');
    }

    return true;
  }

  /**
   * 타이밍 공격을 방지하는 안전한 문자열 비교
   * @param a - 비교할 첫 번째 문자열
   * @param b - 비교할 두 번째 문자열
   * @returns 일치 여부
   */
  private secureCompare(a: string, b: string): boolean {
    try {
      const bufferA = Buffer.from(a, 'utf8');
      const bufferB = Buffer.from(b, 'utf8');

      // 길이가 다르면 즉시 false 반환 (하지만 타이밍은 일정하게)
      if (bufferA.length !== bufferB.length) {
        // 길이가 다르더라도 타이밍 공격을 방지하기 위해 동일한 길이의 더미 비교 수행
        timingSafeEqual(
          Buffer.alloc(bufferA.length),
          Buffer.alloc(bufferA.length),
        );
        return false;
      }

      return timingSafeEqual(bufferA, bufferB);
    } catch (error) {
      // 비교 중 에러 발생 시 false 반환
      return false;
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
