import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminLoginRequestDto,
  AdminLoginResponseDto,
} from './dto/admin-login.dto';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('admin/login')
  @ApiOperation({
    summary: 'Admin 로그인',
    description: `IDP Authorization Code를 사용하여 로그인하고 자체 JWT 토큰을 발급받습니다.

**요청 흐름:**
1. 프론트엔드에서 IDP authorization code와 redirect_uri를 전송
2. 백엔드가 저장된 client_id, client_secret으로 IDP /oauth2/token 호출
3. IDP에서 idp_token을 받아 검증
4. 자체 access_token 발급 후 반환

**응답:**
- access_token: 자체 JWT access token (이후 Admin API 호출 시 사용)
- refresh_token: IDP에서 발급된 경우 포함
- expires_in: access token 만료 시간 (초)`,
  })
  @ApiResponse({
    status: 200,
    description: '로그인 성공',
    type: AdminLoginResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Authorization code 검증 실패 또는 권한 없음',
  })
  async login(
    @Body() dto: AdminLoginRequestDto,
  ): Promise<AdminLoginResponseDto> {
    const result = await this.adminAuthService.loginWithCode(
      dto.code,
      dto.redirect_uri,
      dto.code_verifier,
    );
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: result.expiresIn,
    };
  }
}
