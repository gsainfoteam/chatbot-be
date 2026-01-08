import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { WidgetAuthService } from './widget-auth.service';
import { DB_CONNECTION } from '../db/db.module';

describe('WidgetAuthService', () => {
  let service: WidgetAuthService;
  let mockDb: any;
  let jwtService: JwtService;
  let configService: ConfigService;

  beforeEach(async () => {
    // Mock Database
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([
        {
          id: 'session-id-123',
          widgetKeyId: 'key-id-123',
          sessionToken: '',
          pageUrl: 'https://example.com',
          origin: 'https://example.com',
          expiresAt: new Date(),
        },
      ]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WidgetAuthService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'JWT_EXPIRES_IN') return '3600';
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WidgetAuthService>(WidgetAuthService);
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createSession', () => {
    const mockWidgetKey = {
      id: 'key-id-123',
      secretKey: 'wk_live_abc123',
      status: 'ACTIVE',
      allowedDomains: ['example.com'],
      name: 'Test Key',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should create session with valid widget key and domain', async () => {
      // Mock DB responses
      mockDb.limit.mockResolvedValueOnce([mockWidgetKey]);

      const result = await service.createSession(
        {
          widgetKey: 'wk_live_abc123',
          pageUrl: 'https://example.com/page',
        },
        'https://example.com',
      );

      expect(result).toEqual({
        sessionToken: 'mock-jwt-token',
        expiresIn: 3600,
      });
      expect(jwtService.signAsync).toHaveBeenCalled();
    });

    it('should throw NotFoundException when widget key not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        service.createSession(
          {
            widgetKey: 'wk_live_invalid',
            pageUrl: 'https://example.com/page',
          },
          'https://example.com',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when widget key is REVOKED', async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ...mockWidgetKey, status: 'REVOKED' },
      ]);

      await expect(
        service.createSession(
          {
            widgetKey: 'wk_live_abc123',
            pageUrl: 'https://example.com/page',
          },
          'https://example.com',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when domain not allowed', async () => {
      mockDb.limit.mockResolvedValueOnce([mockWidgetKey]);

      await expect(
        service.createSession(
          {
            widgetKey: 'wk_live_abc123',
            pageUrl: 'https://other.com/page',
          },
          'https://other.com',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when origin and pageUrl mismatch', async () => {
      await expect(
        service.createSession(
          {
            widgetKey: 'wk_live_abc123',
            pageUrl: 'https://example.com/page',
          },
          'https://other.com',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
