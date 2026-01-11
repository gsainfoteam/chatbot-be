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
import { DB_CONNECTION, admins } from '../db';
import type { Database } from '../db';

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
    this.accessTokenExpiresInSeconds = this.getJwtExpiresIn();
  }

  /**
   * JWT 만료 시간을 안전하게 파싱하고 검증
   * @returns JWT 만료 시간 (초 단위)
   */
  private getJwtExpiresIn(): number {
    const value = this.configService.get<string | number>(
      'JWT_EXPIRES_IN',
      '3600',
    );

    if (typeof value === 'number') {
      if (value < 60 || value > 86400) {
        this.logger.warn(
          `JWT_EXPIRES_IN value ${value} is out of range (60-86400), using default 3600`,
        );
        return 3600;
      }
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        this.logger.warn(
          `JWT_EXPIRES_IN value "${value}" is not a valid number, using default 3600`,
        );
        return 3600;
      }
      if (parsed < 60 || parsed > 86400) {
        this.logger.warn(
          `JWT_EXPIRES_IN value ${parsed} is out of range (60-86400), using default 3600`,
        );
        return 3600;
      }
      return parsed;
    }

    this.logger.warn(`JWT_EXPIRES_IN has unexpected type, using default 3600`);
    return 3600;
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

    // 3. Admin 정보 upsert (없으면 생성, 있으면 업데이트)
    await this.upsertAdmin(userInfo.uuid, userInfo.email, userInfo.name);

    // 4. 자체 JWT 토큰 생성
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
   * Refresh token을 사용하여 새로운 access token 발급
   * @param refreshToken IDP에서 발급받은 refresh token
   * @returns 새로운 자체 JWT access token, refresh token (optional), expires_in
   */
  async refresh(refreshToken: string): Promise<LoginResult> {
    // 1. Refresh token으로 IDP 토큰 교환
    const tokenResponse: AuthorizationCodeResponse =
      await this.idpService.refreshToken(refreshToken);

    // 2. IDP access token으로 사용자 정보 가져오기
    const userInfo = await this.idpService.validateAccessToken(
      tokenResponse.access_token,
    );

    // 3. Admin 정보 업데이트 (lastLoginAt)
    await this.upsertAdmin(userInfo.uuid, userInfo.email, userInfo.name);

    // 4. 자체 JWT 토큰 생성
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
   * Admin 정보 upsert (없으면 생성, 있으면 lastLoginAt 업데이트)
   */
  private async upsertAdmin(
    idpUuid: string,
    email: string,
    name: string,
  ): Promise<void> {
    const now = new Date();
    // DB-level upsert으로 race condition 방지
    await this.db
      .insert(admins)
      .values({
        idpUuid,
        email,
        name,
        lastLoginAt: now,
      })
      .onConflictDoUpdate({
        target: admins.idpUuid,
        set: {
          lastLoginAt: now,
          updatedAt: now,
          name,
          email,
        },
      });

    // PII 최소화: email 대신 idpUuid 로깅
    this.logger.log(`Admin login processed: ${idpUuid}`);
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
        await this.jwtService.verifyAsync<AdminAccessTokenJwtPayload>(
          accessToken,
        );
      return payload;
    } catch (e) {
      this.logger.error('Invalid access token:', e);
      throw new UnauthorizedException('Invalid access token', { cause: e });
    }
  }
}
