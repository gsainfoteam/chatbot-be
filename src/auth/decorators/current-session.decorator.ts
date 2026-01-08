import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface SessionPayload {
  sessionId: string;
  widgetKeyId: string;
}

/**
 * 현재 세션 정보를 추출하는 커스텀 데코레이터
 * @UseGuards(WidgetSessionGuard)와 함께 사용해야 합니다
 */
export const CurrentSession = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): SessionPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.session;
  },
);
