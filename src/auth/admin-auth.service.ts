import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminAccessTokenJwtPayload } from './jwt/admin-jwt.payload';
import {
  InfoteamIdpService,
  AuthorizationCodeResponse,
} from '@lib/infoteam-idp';
import { DB_CONNECTION, Database, admins } from '../db';
import { eq } from 'drizzle-orm';

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly accessTokenExpiresInSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly idpService: InfoteamIdpService,
    @Inject(DB_CONNECTION) private readonly db: Database,
  ) {
    this.accessTokenExpiresInSeconds = this.configService.get<number>(
      'JWT_EXPIRES_IN',
      3600,
    );
  }

  /**
   * Authorization code를 사용하여 IDP 토큰 교환 후 자체 JWT 토큰 발급
   * @param code IDP로부터 받은 authorization code
   * @param redirectUri 인증 요청 시 사용한 redirect URI
   * @param codeVerifier PKCE code_verifier (optional)
   * @returns 자체 JWT access token, refresh token (optional), expires_in
   */
  async loginWithCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<LoginResult> {
    // 1. Authorization code를 IDP 토큰으로 교환
    const tokenResponse: AuthorizationCodeResponse =
      await this.idpService.exchangeCodeForToken(
        code,
        redirectUri,
        codeVerifier,
      );

    // 2. IDP access token으로 사용자 정보 가져오기
    const userInfo = await this.idpService.validateAccessToken(
      tokenResponse.access_token,
    );

    // 3. 자체 JWT 토큰 생성
    const payload: AdminAccessTokenJwtPayload = {
      email: userInfo.email,
      uuid: userInfo.uuid,
      name: userInfo.name,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.accessTokenExpiresInSeconds,
    });

    return {
      accessToken,
      refreshToken: tokenResponse.refresh_token,
      expiresIn: this.accessTokenExpiresInSeconds,
    };
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
        this.jwtService.verifyAsync<AdminAccessTokenJwtPayload>(accessToken);
      return payload;
    } catch (e) {
      this.logger.error('Invalid access token:', e);
      throw new UnauthorizedException('Invalid access token', { cause: e });
    }
  }
}
