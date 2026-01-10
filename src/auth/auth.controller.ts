import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminLoginRequestDto,
  AdminLoginResponseDto,
  AdminVerifyResponseDto,
  LogoutRequestDto,
  LogoutResponseDto,
} from './dto/admin-login.dto';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { AdminContext } from './context/admin-context.entity';
import { InfoteamIdpService } from '@lib/infoteam-idp';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly idpService: InfoteamIdpService,
  ) {}

  @Post('admin/login')
  @ApiOperation({
    summary: 'Admin 로그인',
    description: `IDP Authorization Code를 사용하여 로그인하고 자체 JWT 토큰을 발급받습니다.

**요청 흐름:**
1. 프론트엔드에서 IDP authorization code와 redirect_uri를 전송
2. 백엔드가 저장된 client_id, client_secret으로 IDP /oauth/token 호출
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

  @Get('admin/verify')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin 토큰 검증',
    description:
      'JWT 토큰이 유효한지 확인하고 현재 로그인된 Admin 정보를 반환합니다.',
  })
  @ApiResponse({
    status: 200,
    description: '토큰 유효함',
    type: AdminVerifyResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: '토큰이 유효하지 않음',
  })
  verify(@CurrentAdmin() admin: AdminContext): AdminVerifyResponseDto {
    return {
      uuid: admin.uuid,
      email: admin.email,
      name: admin.name,
    };
  }

  @Post('admin/logout')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin 로그아웃',
    description: `로그아웃 처리합니다.

**동작:**
- refresh_token이 제공된 경우: IDP에 토큰 revoke 요청
- 클라이언트에서 저장된 토큰들을 삭제해야 합니다.`,
  })
  @ApiResponse({
    status: 200,
    description: '로그아웃 성공',
    type: LogoutResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: '토큰이 유효하지 않음',
  })
  async logout(@Body() dto: LogoutRequestDto): Promise<LogoutResponseDto> {
    // refresh_token이 제공된 경우 IDP에 revoke 요청
    if (dto.refresh_token) {
      await this.idpService.revokeToken(dto.refresh_token, 'refresh_token');
    }

    return {
      message: 'Successfully logged out',
    };
  }
}
