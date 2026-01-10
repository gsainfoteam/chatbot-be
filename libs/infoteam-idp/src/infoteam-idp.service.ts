import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuthorizationCodeResponse,
  ClientAccessTokenRequest,
  ClientAccessTokenResponse,
  IdpUserInfoRes,
  IdTokenPayload,
} from './types/idp.type';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { UserInfo } from './types/userInfo.type';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';

/**
 * This is the helper Class for infoteam idp service
 */
@Injectable()
export class InfoteamIdpService implements OnModuleInit {
  /** The object for logging */
  private readonly logger = new Logger(InfoteamIdpService.name);
  /** The url of infoteam idp service */
  private idpUrl: string;
  /** The pk of the openid key */
  private openidPk: crypto.KeyObject;
  /** The client idp access token */
  private clientAccessToken: string;
  /** The expire time of the client idp access token */
  private clientAccessTokenExpireAt: Date;
  /** setting the idpUrl and Using httpService and configService */
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    this.idpUrl = this.configService.getOrThrow<string>('IDP_URL');
    this.clientAccessTokenExpireAt = new Date();
  }

  /**
   * This method is called when the module is initialized to fetch the OpenID public key from Infoteam IdP.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('InfoteamIdpService initialized');
    const openidResponse = await firstValueFrom(
      this.httpService
        .get<{ keys: crypto.JsonWebKey[] }>(this.idpUrl + '/oauth/certs')
        .pipe(
          catchError(() => {
            this.logger.error('Error fetching OpenID public key');
            throw new InternalServerErrorException();
          }),
        ),
    );
    if (!openidResponse.data.keys[0]) {
      this.logger.error('No OpenID public key found');
      throw new InternalServerErrorException('No OpenID public key found');
    }
    this.openidPk = crypto.createPublicKey({
      format: 'jwk',
      key: openidResponse.data.keys[0],
    });
    // Client access token은 getUserInfo 메서드에서 필요할 때만 업데이트
    // this.updateClientAccessToken();
  }

  /**
   * this method is used to validate the access token and get user info from the idp
   * @param accessToken this is the access token that is returned from the idp
   * @returns user info
   */
  async validateAccessToken(accessToken: string): Promise<UserInfo> {
    const userInfoResponse = await firstValueFrom(
      this.httpService
        .get<IdpUserInfoRes>(this.idpUrl + '/oauth/userinfo', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        })
        .pipe(
          catchError((err) => {
            if (err instanceof AxiosError && err.response?.status === 401) {
              this.logger.debug('user invalid access token');
              throw new UnauthorizedException();
            }
            this.logger.error(err);
            throw new InternalServerErrorException();
          }),
        ),
    );
    const {
      sub: uuid,
      name,
      email,
      picture,
      profile,
      student_id: studentId,
    } = userInfoResponse.data;
    return { name, email, uuid, picture, profile, studentId };
  }

  /**
   * this method is used to validate the id token and get user info from the idp
   * @param idToken this is the id token that is returned from the idp
   * @returns user info
   */
  async validateIdToken(idToken: string): Promise<UserInfo | null> {
    return this.jwtService
      .verifyAsync<IdTokenPayload>(idToken, {
        publicKey: this.openidPk.export({ format: 'pem', type: 'spki' }),
        issuer: this.idpUrl,
      })
      .then(
        ({
          sub: uuid,
          name,
          email,
          picture,
          profile,
          student_id: studentId,
        }) => ({
          uuid,
          name,
          email,
          picture,
          profile,
          studentId,
        }),
      )
      .catch(() => {
        return null;
      });
  }

  /**
   * This method is used to get user info from the idp with client access token
   * @param userUuid the uuid of the user
   * @returns user info
   */
  async getUserInfo(userUuid: string): Promise<UserInfo | null> {
    // Client access token이 만료되었으면 갱신
    await this.updateClientAccessToken();
    const userInfoResponse = await firstValueFrom(
      this.httpService
        .get<IdpUserInfoRes>(this.idpUrl + '/oauth/userinfo', {
          headers: {
            Authorization: `Bearer ${this.clientAccessToken}`,
          },
          params: {
            sub: userUuid,
          },
        })
        .pipe(
          catchError((err) => {
            if (err instanceof AxiosError && err.response?.status === 401) {
              this.logger.debug('user invalid access token');
              throw new UnauthorizedException();
            }
            this.logger.error(err);
            throw new InternalServerErrorException();
          }),
        ),
    );
    const {
      sub: uuid,
      name,
      email,
      picture,
      profile,
      student_id: studentId,
    } = userInfoResponse.data;
    return { name, email, uuid, picture, profile, studentId };
  }

  /**
   * This method is used to update the client access token
   * It will fetch a new token if the current one is expired
   */
  private async updateClientAccessToken(): Promise<void> {
    if (this.clientAccessTokenExpireAt > new Date()) {
      return;
    }
    this.logger.log('Client access token is expired, fetching a new one');
    const clientTokenResponse = await firstValueFrom(
      this.httpService
        .post<ClientAccessTokenResponse, ClientAccessTokenRequest>(
          this.idpUrl + '/oauth/token',
          {
            grant_type: 'client_credentials',
            client_id: this.configService.getOrThrow<string>('IDP_CLIENT_ID'),
            client_secret:
              this.configService.getOrThrow<string>('IDP_CLIENT_SECRET'),
            scope: ['profile', 'email'].join(' '),
          },
        )
        .pipe(
          catchError((err: AxiosError) => {
            this.logger.error('Error fetching client access token', err);
            throw new InternalServerErrorException(
              'Failed to fetch client access token',
            );
          }),
        ),
    );
    this.clientAccessToken = clientTokenResponse.data.access_token;
    this.clientAccessTokenExpireAt = new Date(
      Date.now() + clientTokenResponse.data.expires_in * 1000,
    );
  }

  /**
   * Exchange authorization code for tokens
   * @param code Authorization code from IDP
   * @param redirectUri Redirect URI used in the authorization request
   * @param codeVerifier PKCE code_verifier (optional, required if code_challenge was used)
   * @returns Token response with access_token, refresh_token (optional), expires_in
   */
  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<AuthorizationCodeResponse> {
    const requestBody: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.configService.getOrThrow<string>('IDP_CLIENT_ID'),
      client_secret: this.configService.getOrThrow<string>('IDP_CLIENT_SECRET'),
    };

    // PKCE: code_verifier가 있으면 추가
    if (codeVerifier) {
      requestBody.code_verifier = codeVerifier;
    }

    const tokenResponse = await firstValueFrom(
      this.httpService
        .post<AuthorizationCodeResponse>(
          this.idpUrl + '/oauth/token',
          requestBody,
        )
        .pipe(
          catchError((err: AxiosError) => {
            this.logger.error('Error exchanging authorization code');
            this.logger.error('Status:', err.response?.status);
            if (err.response?.status === 400 || err.response?.status === 401) {
              throw new UnauthorizedException(
                'Invalid authorization code or redirect URI',
              );
            }
            throw new InternalServerErrorException(
              'Failed to exchange authorization code',
            );
          }),
        ),
    );

    return tokenResponse.data;
  }

  /**
   * Revoke access token or refresh token
   * @param token Token to revoke (access_token or refresh_token)
   * @param tokenTypeHint Optional hint about token type
   */
  async revokeToken(
    token: string,
    tokenTypeHint?: 'access_token' | 'refresh_token',
  ): Promise<void> {
    const clientId = this.configService.getOrThrow<string>('IDP_CLIENT_ID');
    const clientSecret =
      this.configService.getOrThrow<string>('IDP_CLIENT_SECRET');

    // HTTP Basic Auth header 생성
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
      'base64',
    );

    // application/x-www-form-urlencoded 형식으로 데이터 생성
    const formData = new URLSearchParams({
      token,
      ...(tokenTypeHint && { token_type_hint: tokenTypeHint }),
    }).toString();

    await firstValueFrom(
      this.httpService
        .post(this.idpUrl + '/oauth/revoke', formData, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
          },
        })
        .pipe(
          catchError((err: AxiosError) => {
            // Revocation 실패는 로깅만 하고 에러를 throw하지 않음
            // (이미 만료된 토큰 등의 경우)
            console.log('err', err);
            this.logger.warn('Token revocation failed', err.response?.data);
            return [];
          }),
        ),
    );
    this.logger.log('Token revoked successfully');
  }
}
