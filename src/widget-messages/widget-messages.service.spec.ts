import { Test, TestingModule } from '@nestjs/testing';
import { WidgetMessagesService } from './widget-messages.service';
import { DB_CONNECTION } from '../db';
import { MessageRole } from '../common/dto/chat-message-input.dto';

describe('WidgetMessagesService', () => {
  let service: WidgetMessagesService;
  let mockDb: any;

  beforeEach(async () => {
    mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WidgetMessagesService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<WidgetMessagesService>(WidgetMessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMessages', () => {
    it('should return paginated messages without cursor', async () => {
      const mockMessages = [
        {
          id: 'msg-1',
          sessionId: 'session-123',
          role: 'user',
          content: 'Hello',
          metadata: null,
          createdAt: new Date(),
        },
        {
          id: 'msg-2',
          sessionId: 'session-123',
          role: 'assistant',
          content: 'Hi there!',
          metadata: null,
          createdAt: new Date(),
        },
      ];

      mockDb.limit.mockResolvedValueOnce(mockMessages);

      const result = await service.getMessages('session-123', undefined, 20);

      expect(result.messages).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('should return paginated messages with nextCursor when more data exists', async () => {
      const mockMessages = Array.from({ length: 21 }, (_, i) => ({
        id: `msg-${i}`,
        sessionId: 'session-123',
        role: 'user',
        content: `Message ${i}`,
        metadata: null,
        createdAt: new Date(),
      }));

      mockDb.limit.mockResolvedValueOnce(mockMessages);

      const result = await service.getMessages('session-123', undefined, 20);

      expect(result.messages).toHaveLength(20);
      expect(result.nextCursor).toBe('msg-19');
    });

    it('should handle cursor-based pagination', async () => {
      const mockCursorMessage = {
        id: 'msg-cursor',
        createdAt: new Date(),
      };

      mockDb.limit
        .mockResolvedValueOnce([mockCursorMessage])
        .mockResolvedValueOnce([
          {
            id: 'msg-next',
            sessionId: 'session-123',
            role: 'user',
            content: 'Next message',
            metadata: null,
            createdAt: new Date(),
          },
        ]);

      const result = await service.getMessages('session-123', 'msg-cursor', 20);

      expect(mockDb.where).toHaveBeenCalled();
      expect(result.messages).toHaveLength(1);
    });
  });

  describe('createMessage', () => {
    it('should create a new message', async () => {
      const mockMessage = {
        id: 'msg-new',
        sessionId: 'session-123',
        role: 'user',
        content: 'Hello World',
        metadata: { tokens: 10 },
        createdAt: new Date(),
      };

      mockDb.returning.mockResolvedValueOnce([mockMessage]);

      const result = await service.createMessage('session-123', {
        role: MessageRole.USER,
        content: 'Hello World',
        metadata: { tokens: 10 },
      });

      expect(result.id).toBe('msg-new');
      expect(result.content).toBe('Hello World');
      expect(result.role).toBe('user');
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should create message without metadata', async () => {
      const mockMessage = {
        id: 'msg-new',
        sessionId: 'session-123',
        role: 'assistant',
        content: 'Response',
        metadata: null,
        createdAt: new Date(),
      };

      mockDb.returning.mockResolvedValueOnce([mockMessage]);

      const result = await service.createMessage('session-123', {
        role: MessageRole.ASSISTANT,
        content: 'Response',
      });

      // null이 undefined로 변환되는지 확인
      expect(result.metadata).toBeUndefined();
    });
  });
});
