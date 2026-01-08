import { Controller, Post, Body, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { WidgetAuthService } from './widget-auth.service';
import { WidgetSessionRequestDto } from '../common/dto/widget-session-request.dto';
import { WidgetSessionResponseDto } from '../common/dto/widget-session-response.dto';

@ApiTags('Widget Auth')
@Controller('api/v1/widget/auth')
export class WidgetAuthController {
  constructor(private readonly widgetAuthService: WidgetAuthService) {}

  @Post('session')
  @ApiOperation({
    summary: '위젯 세션 토큰 발급',
    description: `위젯 키와 현재 페이지의 도메인을 검증하여 세션 토큰을 발급합니다.

**검증 로직 상세:**
1. 요청 헤더의 Origin이 존재하면 이를 우선 검증값으로 사용합니다.
2. Origin이 없는 경우(일부 환경) body의 pageUrl에서 도메인을 추출합니다.
3. 두 값이 모두 존재하는데 서로 다르다면 요청은 거부(Spoofing 의심)됩니다.
4. 추출된 도메인(프로토콜 제거)이 DB의 allowedDomains 규칙과 매칭되는지 확인합니다.
5. 해당 widgetKey가 REVOKED 상태라면 발급을 거부합니다.`,
  })
  @ApiHeader({
    name: 'Origin',
    description: '요청 Origin (브라우저가 자동으로 추가)',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: '세션 발급 성공',
    type: WidgetSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 요청 (Origin/PageUrl 불일치 등)',
  })
  @ApiResponse({
    status: 403,
    description: '도메인 검증 실패 또는 REVOKED 된 키',
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 widgetKey',
  })
  async createSession(
    @Body() dto: WidgetSessionRequestDto,
    @Headers('origin') origin?: string,
  ): Promise<WidgetSessionResponseDto> {
    return this.widgetAuthService.createSession(dto, origin);
  }
}
