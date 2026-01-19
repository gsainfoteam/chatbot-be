import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminContext } from '../context/admin-context.entity';

export const CurrentAdmin = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AdminContext => {
    const request = ctx.switchToHttp().getRequest<{ user: AdminContext }>();
    return request.user;
  },
);
