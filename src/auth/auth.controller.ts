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
  RefreshTokenRequestDto,
  RefreshTokenResponseDto,
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
  @ApiBearerAuth('bearerAuth')
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

  @Post('admin/refresh')
  @ApiOperation({
    summary: 'Admin 토큰 갱신',
    description: `Refresh token을 사용하여 새로운 access token을 발급받습니다.

**요청 흐름:**
1. 프론트엔드에서 refresh_token 전송
2. 백엔드가 IDP /oauth/token에 refresh_token 교환 요청
3. IDP에서 새로운 idp_token 받아 검증
4. 새로운 자체 access_token 발급 후 반환

**응답:**
- access_token: 새로운 자체 JWT access token
- refresh_token: 새로운 refresh token (IDP에서 발급된 경우)
- expires_in: access token 만료 시간 (초)`,
  })
  @ApiResponse({
    status: 200,
    description: '토큰 갱신 성공',
    type: RefreshTokenResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh token 검증 실패',
  })
  async refresh(
    @Body() dto: RefreshTokenRequestDto,
  ): Promise<RefreshTokenResponseDto> {
    const result = await this.adminAuthService.refresh(dto.refresh_token);
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: result.expiresIn,
    };
  }

  @Post('admin/logout')
  @UseGuards(AdminJwtGuard)
  @ApiBearerAuth('bearerAuth')
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
  async logout(@Body() _dto: LogoutRequestDto): Promise<LogoutResponseDto> {
    // TODO: IDP의 token revoke 엔드포인트 확인 필요
    // - 문서에는 /oauth2/revoke로 되어 있지만 404 발생
    // - /oauth/revoke도 404 발생
    // - IDP 관리자에게 올바른 revoke 엔드포인트 확인 필요

    // refresh_token이 제공된 경우 IDP에 revoke 요청 (현재 비활성화)
    // if (_dto.refresh_token) {
    //   await this.idpService.revokeToken(_dto.refresh_token, 'refresh_token');
    // }

    return {
      message: 'Successfully logged out',
    };
  }
}
