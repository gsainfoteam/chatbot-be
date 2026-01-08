import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';

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

    if (token !== adminToken) {
      throw new UnauthorizedException('Invalid admin token');
    }

    return true;
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
