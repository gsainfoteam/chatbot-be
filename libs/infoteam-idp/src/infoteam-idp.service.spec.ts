import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InfoteamIdpService } from './infoteam-idp.service';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosResponse } from 'axios';
import * as crypto from 'crypto';

describe('InfoteamIdpService', () => {
  let service: InfoteamIdpService;
  let httpService: jest.Mocked<HttpService>;
  let configService: jest.Mocked<ConfigService>;
  let jwtService: jest.Mocked<JwtService>;

  const mockIdpUrl = 'https://idp.test.com';
  const mockClientId = 'test-client-id';
  const mockClientSecret = 'test-client-secret';

  beforeEach(async () => {
    const mockHttpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const mockConfigService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'IDP_URL') return mockIdpUrl;
        if (key === 'IDP_CLIENT_ID') return mockClientId;
        if (key === 'IDP_CLIENT_SECRET') return mockClientSecret;
        return undefined;
      }),
    };

    const mockJwtService = {
      verifyAsync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InfoteamIdpService,
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
      ],
    }).compile();

    service = module.get<InfoteamIdpService>(InfoteamIdpService);
    httpService = module.get(HttpService);
    configService = module.get(ConfigService);
    jwtService = module.get(JwtService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should fetch OpenID public key on initialization', async () => {
      const mockJwk = {
        kty: 'RSA',
        n: 'test-n',
        e: 'AQAB',
      };

      const mockResponse: AxiosResponse = {
        data: { keys: [mockJwk] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(of(mockResponse) as any);

      await service.onModuleInit();

      expect(httpService.get).toHaveBeenCalledWith(
        mockIdpUrl + '/oauth/certs',
      );
    });

    it('should throw InternalServerErrorException when fetching key fails', async () => {
      httpService.get.mockReturnValue(
        throwError(() => new Error('Network error')) as any,
      );

      await expect(service.onModuleInit()).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException when no keys found', async () => {
      const mockResponse: AxiosResponse = {
        data: { keys: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(of(mockResponse) as any);

      await expect(service.onModuleInit()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('validateAccessToken', () => {
    it('should return user info with valid access token', async () => {
      const mockUserInfo = {
        sub: 'user-uuid-123',
        name: 'Test User',
        email: 'test@example.com',
        picture: 'https://example.com/avatar.jpg',
        profile: 'https://example.com/profile',
        student_id: '2024123456',
      };

      const mockResponse: AxiosResponse = {
        data: mockUserInfo,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(of(mockResponse) as any);

      const result = await service.validateAccessToken('valid-token');

      expect(result).toEqual({
        uuid: 'user-uuid-123',
        name: 'Test User',
        email: 'test@example.com',
        picture: 'https://example.com/avatar.jpg',
        profile: 'https://example.com/profile',
        studentId: '2024123456',
      });

      expect(httpService.get).toHaveBeenCalledWith(
        mockIdpUrl + '/oauth/userinfo',
        {
          headers: {
            Authorization: 'Bearer valid-token',
          },
        },
      );
    });

    it('should throw UnauthorizedException with invalid access token', async () => {
      const axiosError = new AxiosError('Unauthorized');
      axiosError.response = {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(throwError(() => axiosError) as any);

      await expect(
        service.validateAccessToken('invalid-token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw InternalServerErrorException on other errors', async () => {
      httpService.get.mockReturnValue(
        throwError(() => new Error('Network error')) as any,
      );

      await expect(
        service.validateAccessToken('some-token'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('validateIdToken', () => {
    beforeEach(async () => {
      // onModuleInit을 먼저 호출하여 openidPk 초기화
      const mockJwk = {
        kty: 'RSA',
        n: 'test-n',
        e: 'AQAB',
      };

      const mockResponse: AxiosResponse = {
        data: { keys: [mockJwk] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(of(mockResponse) as any);
      await service.onModuleInit();
      jest.clearAllMocks();
    });

    it('should return user info with valid id token', async () => {
      const mockPayload = {
        sub: 'user-uuid-456',
        aud: 'test-client',
        scope: 'openid profile email',
        nonce: 'test-nonce',
        name: 'ID Token User',
        email: 'idtoken@example.com',
        picture: 'https://example.com/id-avatar.jpg',
        profile: 'https://example.com/id-profile',
        student_id: '2024654321',
      };

      jwtService.verifyAsync.mockResolvedValue(mockPayload);

      const result = await service.validateIdToken('valid-id-token');

      expect(result).toEqual({
        uuid: 'user-uuid-456',
        name: 'ID Token User',
        email: 'idtoken@example.com',
        picture: 'https://example.com/id-avatar.jpg',
        profile: 'https://example.com/id-profile',
        studentId: '2024654321',
      });
    });

    it('should return null with invalid id token', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('Invalid token'));

      const result = await service.validateIdToken('invalid-id-token');

      expect(result).toBeNull();
    });
  });

  describe('getUserInfo', () => {
    beforeEach(async () => {
      // onModuleInit을 먼저 호출하여 초기화
      const mockJwk = {
        kty: 'RSA',
        n: 'test-n',
        e: 'AQAB',
      };

      const mockResponse: AxiosResponse = {
        data: { keys: [mockJwk] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.get.mockReturnValue(of(mockResponse) as any);
      await service.onModuleInit();
      jest.clearAllMocks();
    });

    it('should fetch client access token and return user info', async () => {
      const mockTokenResponse: AxiosResponse = {
        data: {
          access_token: 'client-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'profile email',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      const mockUserInfo = {
        sub: 'user-uuid-789',
        name: 'Client User',
        email: 'client@example.com',
        picture: 'https://example.com/client-avatar.jpg',
        profile: 'https://example.com/client-profile',
        student_id: '2024789012',
      };

      const mockUserResponse: AxiosResponse = {
        data: mockUserInfo,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.post.mockReturnValue(of(mockTokenResponse) as any);
      httpService.get.mockReturnValue(of(mockUserResponse) as any);

      const result = await service.getUserInfo('user-uuid-789');

      expect(result).toEqual({
        uuid: 'user-uuid-789',
        name: 'Client User',
        email: 'client@example.com',
        picture: 'https://example.com/client-avatar.jpg',
        profile: 'https://example.com/client-profile',
        studentId: '2024789012',
      });

      expect(httpService.post).toHaveBeenCalledWith(
        mockIdpUrl + '/oauth/token',
        {
          grant_type: 'client_credentials',
          client_id: mockClientId,
          client_secret: mockClientSecret,
          scope: 'profile email',
        },
      );

      expect(httpService.get).toHaveBeenCalledWith(
        mockIdpUrl + '/oauth/userinfo',
        {
          headers: {
            Authorization: 'Bearer client-access-token',
          },
          params: {
            sub: 'user-uuid-789',
          },
        },
      );
    });

    it('should reuse client access token if not expired', async () => {
      // 첫 번째 호출 - 토큰 발급
      const mockTokenResponse: AxiosResponse = {
        data: {
          access_token: 'client-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'profile email',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      const mockUserInfo = {
        sub: 'user-uuid',
        name: 'User',
        email: 'user@example.com',
        picture: 'https://example.com/avatar.jpg',
        profile: 'https://example.com/profile',
        student_id: '2024000000',
      };

      const mockUserResponse: AxiosResponse = {
        data: mockUserInfo,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      httpService.post.mockReturnValue(of(mockTokenResponse) as any);
      httpService.get.mockReturnValue(of(mockUserResponse) as any);

      await service.getUserInfo('user-uuid');

      // 두 번째 호출 - 토큰 재사용
      httpService.post.mockClear();
      await service.getUserInfo('user-uuid');

      // 토큰이 재사용되어 post가 다시 호출되지 않아야 함
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException when client token fetch fails', async () => {
      httpService.post.mockReturnValue(
        throwError(() => new AxiosError('Token fetch failed')) as any,
      );

      await expect(service.getUserInfo('user-uuid')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
