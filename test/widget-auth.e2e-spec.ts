import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { DB_CONNECTION } from '../src/db';

describe('Widget Auth (e2e)', () => {
  let app: INestApplication;
  let mockDb: any;

  beforeAll(async () => {
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
          id: 'session-123',
          widgetKeyId: 'key-123',
          sessionToken: '',
          pageUrl: 'https://example.com',
          origin: 'https://example.com',
          expiresAt: new Date(Date.now() + 3600000),
        },
      ]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DB_CONNECTION)
      .useValue(mockDb)
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

  describe('POST /api/v1/widget/auth/session', () => {
    it('should create session with valid widget key', async () => {
      const mockWidgetKey = {
        id: 'key-123',
        secretKey: 'wk_live_abc123',
        status: 'ACTIVE',
        allowedDomains: ['example.com'],
        name: 'Test Key',
        createdAt: new Date(),
      };

      mockDb.limit.mockResolvedValueOnce([mockWidgetKey]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/widget/auth/session',
        headers: {
          origin: 'https://example.com',
        },
        payload: {
          widgetKey: 'wk_live_abc123',
          pageUrl: 'https://example.com/page',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('sessionToken');
      expect(body).toHaveProperty('expiresIn');
    });

    it('should return 404 when widget key not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/widget/auth/session',
        payload: {
          widgetKey: 'wk_live_invalid',
          pageUrl: 'https://example.com/page',
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 403 when widget key is REVOKED', async () => {
      const mockWidgetKey = {
        id: 'key-123',
        secretKey: 'wk_live_abc123',
        status: 'REVOKED',
        allowedDomains: ['example.com'],
      };

      mockDb.limit.mockResolvedValueOnce([mockWidgetKey]);

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/widget/auth/session',
        payload: {
          widgetKey: 'wk_live_abc123',
          pageUrl: 'https://example.com/page',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 400 when pageUrl is invalid', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/api/v1/widget/auth/session',
        payload: {
          widgetKey: 'wk_live_abc123',
          pageUrl: 'invalid-url',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
