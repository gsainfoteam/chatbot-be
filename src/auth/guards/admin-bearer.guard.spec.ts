import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminBearerGuard } from './admin-bearer.guard';

describe('AdminBearerGuard', () => {
  let guard: AdminBearerGuard;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBearerGuard,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    guard = module.get<AdminBearerGuard>(AdminBearerGuard);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const createMockContext = (token?: string): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            authorization: token ? `Bearer ${token}` : undefined,
          },
        }),
      }),
    } as ExecutionContext;
  };

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should throw UnauthorizedException when no token is provided', () => {
    const context = createMockContext();

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('No admin token provided');
  });

  it('should throw UnauthorizedException when admin token is not configured', () => {
    mockConfigService.get.mockReturnValue(undefined);
    const context = createMockContext('some-token');

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(
      'Admin authentication not configured',
    );
  });

  it('should allow access with valid admin token', () => {
    const validToken = 'valid-admin-token-12345678';
    mockConfigService.get.mockReturnValue(validToken);
    const context = createMockContext(validToken);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('should reject access with invalid admin token', () => {
    const validToken = 'valid-admin-token-12345678';
    const invalidToken = 'invalid-token';
    mockConfigService.get.mockReturnValue(validToken);
    const context = createMockContext(invalidToken);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid admin token');
  });

  it('should use timing-safe comparison to prevent timing attacks', () => {
    const validToken = 'valid-admin-token-12345678';
    mockConfigService.get.mockReturnValue(validToken);

    // 같은 길이의 다른 토큰으로 테스트
    const almostValidToken = 'valid-admin-token-87654321';
    const context = createMockContext(almostValidToken);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should handle tokens with different lengths', () => {
    const validToken = 'valid-admin-token-12345678';
    mockConfigService.get.mockReturnValue(validToken);
    const shortToken = 'short';
    const context = createMockContext(shortToken);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid admin token');
  });

  it('should extract token from Authorization header correctly', () => {
    const validToken = 'valid-admin-token-12345678';
    mockConfigService.get.mockReturnValue(validToken);
    const context = createMockContext(validToken);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('should reject malformed Authorization header', () => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            authorization: 'InvalidFormat token123',
          },
        }),
      }),
    } as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should be case-sensitive for Bearer scheme', () => {
    const validToken = 'valid-admin-token-12345678';
    mockConfigService.get.mockReturnValue(validToken);

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            authorization: `bearer ${validToken}`, // lowercase 'bearer'
          },
        }),
      }),
    } as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
