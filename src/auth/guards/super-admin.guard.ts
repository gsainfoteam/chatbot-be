import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AdminContext } from '../context/admin-context.entity';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user: AdminContext }>();
    const admin = request.user;

    if (!admin || admin.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super admin role required');
    }

    return true;
  }
}
