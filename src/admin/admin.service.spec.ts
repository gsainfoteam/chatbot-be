import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { DB_CONNECTION } from '../db/db.module';

describe('AdminService', () => {
  let service: AdminService;
  let mockDb: any;

  beforeEach(async () => {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAllWidgetKeys', () => {
    it('should return all widget keys', async () => {
      const mockKeys = [
        {
          id: 'key-1',
          name: 'Test Key 1',
          secretKey: 'wk_live_abc123',
          status: 'ACTIVE',
          allowedDomains: ['example.com'],
          createdAt: new Date(),
        },
        {
          id: 'key-2',
          name: 'Test Key 2',
          secretKey: 'wk_live_xyz789',
          status: 'REVOKED',
          allowedDomains: ['other.com'],
          createdAt: new Date(),
        },
      ];

      // mockDb 체인 수정
      const selectChain = {
        from: jest.fn().mockResolvedValue(mockKeys),
      };
      mockDb.select.mockReturnValueOnce(selectChain);

      const result = await service.getAllWidgetKeys();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Test Key 1');
      expect(result[1].status).toBe('REVOKED');
    });

    it('should return empty array when no keys exist', async () => {
      const selectChain = {
        from: jest.fn().mockResolvedValue([]),
      };
      mockDb.select.mockReturnValueOnce(selectChain);

      const result = await service.getAllWidgetKeys();

      expect(result).toEqual([]);
    });
  });

  describe('createWidgetKey', () => {
    it('should create a new widget key', async () => {
      const mockKey = {
        id: 'key-new',
        name: 'New Key',
        secretKey: 'wk_live_newkey123',
        status: 'ACTIVE',
        allowedDomains: ['example.com'],
        createdAt: new Date(),
      };

      mockDb.limit.mockResolvedValueOnce([]); // 중복 없음
      mockDb.returning.mockResolvedValueOnce([mockKey]);

      const result = await service.createWidgetKey({
        name: 'New Key',
        allowedDomains: ['example.com'],
      });

      expect(result.name).toBe('New Key');
      expect(result.secretKey).toMatch(/^wk_live_/);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should throw BadRequestException when domain contains protocol', async () => {
      await expect(
        service.createWidgetKey({
          name: 'Invalid Key',
          allowedDomains: ['https://example.com'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when domain starts with http', async () => {
      await expect(
        service.createWidgetKey({
          name: 'Invalid Key',
          allowedDomains: ['http://example.com'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle duplicate key generation by retrying', async () => {
      const mockKey = {
        id: 'key-new',
        name: 'New Key',
        secretKey: 'wk_live_unique',
        status: 'ACTIVE',
        allowedDomains: ['example.com'],
        createdAt: new Date(),
      };

      // 첫 번째 시도는 중복, 두 번째는 성공
      mockDb.limit
        .mockResolvedValueOnce([{ secretKey: 'duplicate' }])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([mockKey]);

      const result = await service.createWidgetKey({
        name: 'New Key',
        allowedDomains: ['example.com'],
      });

      expect(result.secretKey).toBeDefined();
    });
  });

  describe('revokeWidgetKey', () => {
    it('should revoke an existing widget key', async () => {
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

      const result = await service.revokeWidgetKey('key-123');

      expect(result.status).toBe('REVOKED');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when key does not exist', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(service.revokeWidgetKey('invalid-key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
