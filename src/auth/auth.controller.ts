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
    description: `Infoteam IDP access token을 사용하여 로그인하고 자체 JWT 토큰을 발급받습니다.

**인증 요구사항:**
- Infoteam IDP에서 발급받은 valid access token
- @gistory.me 이메일 도메인

**응답:**
- 자체 JWT access token (이후 Admin API 호출 시 사용)`,
  })
  @ApiResponse({
    status: 200,
    description: '로그인 성공',
    type: AdminLoginResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'IDP 토큰 검증 실패 또는 권한 없음',
  })
  async login(
    @Body() dto: AdminLoginRequestDto,
  ): Promise<AdminLoginResponseDto> {
    const { accessToken } = await this.adminAuthService.loginWithIdp(
      dto.idp_token,
    );
    return { access_token: accessToken };
  }
}
