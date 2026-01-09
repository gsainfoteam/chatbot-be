import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminAccessTokenJwtPayload } from './jwt/admin-jwt.payload';
import { InfoteamIdpService } from '@lib/infoteam-idp';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly accessTokenExpiresIn: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly idpService: InfoteamIdpService,
  ) {
    this.accessTokenExpiresIn = this.configService.get<string>(
      'JWT_EXPIRES_IN',
      '3600s',
    );
  }

  /**
   * IDP 토큰을 검증하고 자체 JWT 토큰 발급
   * @param idpToken Infoteam IDP access token
   * @returns 자체 JWT access token
   */
  async loginWithIdp(idpToken: string): Promise<{ accessToken: string }> {
    // IDP에서 토큰 검증 및 사용자 정보 가져오기
    const userInfo = await this.idpService.validateAccessToken(idpToken);

    // @gistory.me 이메일만 허용
    if (!userInfo.email.endsWith('@gistory.me')) {
      throw new UnauthorizedException('Admin access denied');
    }

    // 자체 JWT 토큰 생성
    const payload: AdminAccessTokenJwtPayload = {
      email: userInfo.email,
      uuid: userInfo.uuid,
      name: userInfo.name,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.accessTokenExpiresIn,
    });

    return { accessToken };
  }

  /**
   * 자체 JWT 토큰 검증
   * @param accessToken 자체 JWT access token
   * @returns JWT payload
   */
  async validateAccessToken(
    accessToken: string,
  ): Promise<AdminAccessTokenJwtPayload> {
    try {
      const payload =
        this.jwtService.verify<AdminAccessTokenJwtPayload>(accessToken);
      return payload;
    } catch (e) {
      this.logger.error('Invalid access token:', e);
      throw new UnauthorizedException('Invalid access token', { cause: e });
    }
  }
}
