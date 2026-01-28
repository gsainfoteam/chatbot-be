import { Injectable, Inject } from '@nestjs/common';
import { DB_CONNECTION, type Database, messages } from '../../db';
import { eq, and, lt, desc, count } from 'drizzle-orm';
import {
  ChatMessageInputDto,
  MessageRole,
} from '../../common/dto/chat-message-input.dto';
import { ChatMessageDto } from '../../common/dto/chat-message.dto';
import { PaginatedMessagesDto } from '../../common/dto/paginated-messages.dto';

@Injectable()
export class ChatService {
  constructor(@Inject(DB_CONNECTION) private db: Database) {}

  async getUserMessageCount(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
    return Number(row?.count ?? 0);
  }

  async getMessages(
    sessionId: string,
    cursor?: string,
    limit: number = 20,
  ): Promise<PaginatedMessagesDto> {
    // cursor 기반 페이징 쿼리 구성
    const conditions = [eq(messages.sessionId, sessionId)];

    if (cursor) {
      // cursor보다 오래된 메시지만 조회 (createdAt 기준)
      const [cursorMessage] = await this.db
        .select()
        .from(messages)
        .where(eq(messages.id, cursor))
        .limit(1);

      if (cursorMessage) {
        conditions.push(lt(messages.createdAt, cursorMessage.createdAt));
      }
    }

    // limit + 1개를 조회하여 다음 페이지 존재 여부 확인
    const result = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);

    // 다음 페이지 존재 여부 확인
    const hasMore = result.length > limit;
    const messageList = hasMore ? result.slice(0, limit) : result;

    // DTO로 변환
    const messageDtos: ChatMessageDto[] = messageList.map((msg) => ({
      id: msg.id,
      role: msg.role as MessageRole,
      content: msg.content,
      metadata: msg.metadata as Record<string, any> | undefined,
      createdAt: msg.createdAt,
    }));

    // nextCursor 설정
    const nextCursor =
      hasMore && messageList.length > 0
        ? messageList[messageList.length - 1].id
        : null;

    return {
      messages: messageDtos,
      nextCursor,
    };
  }

  async createMessage(
    sessionId: string,
    dto: ChatMessageInputDto,
  ): Promise<ChatMessageDto> {
    const [newMessage] = await this.db
      .insert(messages)
      .values({
        sessionId,
        role: dto.role,
        content: dto.content,
        metadata: dto.metadata || null,
      })
      .returning();

    return {
      id: newMessage.id,
      role: newMessage.role as MessageRole,
      content: newMessage.content,
      metadata: (newMessage.metadata as Record<string, any>) || undefined,
      createdAt: newMessage.createdAt,
    };
  }
}
