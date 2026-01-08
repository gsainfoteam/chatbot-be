import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DB_CONNECTION } from '../src/db/db.module';
import { ConfigService } from '@nestjs/config';

describe('Admin (e2e)', () => {
  let app: INestApplication;
  let mockDb: any;
  const ADMIN_TOKEN = 'test-admin-token';

  beforeAll(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DB_CONNECTION)
      .useValue(mockDb)
      .overrideProvider(ConfigService)
      .useValue({
        get: jest.fn((key: string, defaultValue?: any) => {
          if (key === 'ADMIN_BEARER_TOKEN') return ADMIN_TOKEN;
          if (key === 'JWT_SECRET') return 'test-secret';
          if (key === 'JWT_EXPIRES_IN') return '3600';
          return defaultValue;
        }),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/admin/widget-keys', () => {
    it('should return all widget keys with valid admin token', async () => {
      const mockKeys = [
        {
          id: 'key-1',
          name: 'Test Key',
          secretKey: 'wk_live_abc123',
          status: 'ACTIVE',
          allowedDomains: ['example.com'],
          createdAt: new Date(),
        },
      ];

      mockDb.select.mockResolvedValueOnce(mockKeys);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/api/v1/admin/widget-keys',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it('should return 401 without admin token', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/api/v1/admin/widget-keys',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 401 with invalid admin token', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/api/v1/admin/widget-keys',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/admin/widget-keys', () => {
    it('should create widget key with valid data', async () => {
      const mockKey = {
        id: 'key-new',
        name: 'New Key',
        secretKey: 'wk_live_newkey123',
        status: 'ACTIVE',
        allowedDomains: ['example.com'],
        createdAt: new Date(),
      };

      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([mockKey]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/admin/widget-keys',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        payload: {
          name: 'New Key',
          allowedDomains: ['example.com'],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('New Key');
      expect(body.secretKey).toMatch(/^wk_live_/);
    });

    it('should return 400 when domain contains protocol', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/admin/widget-keys',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        payload: {
          name: 'Invalid Key',
          allowedDomains: ['https://example.com'],
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/admin/widget-keys/:widgetKeyId/revoke', () => {
    it('should revoke widget key', async () => {
      const mockKey = {
        id: 'key-123',
        name: 'Test Key',
        secretKey: 'wk_live_abc123',
        status: 'ACTIVE',
        allowedDomains: ['example.com'],
        createdAt: new Date(),
      };

      const revokedKey = { ...mockKey, status: 'REVOKED' };

      mockDb.limit.mockResolvedValueOnce([mockKey]);
      mockDb.returning.mockResolvedValueOnce([revokedKey]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: '/api/v1/admin/widget-keys/key-123/revoke',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('REVOKED');
    });

    it('should return 404 when key not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'PATCH',
        url: '/api/v1/admin/widget-keys/invalid-id/revoke',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
