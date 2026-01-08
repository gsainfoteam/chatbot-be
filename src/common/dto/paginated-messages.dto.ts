import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChatMessageDto } from './chat-message.dto';

export class PaginatedMessagesDto {
  @ApiProperty({
    description: '메시지 목록',
    type: [ChatMessageDto],
  })
  messages: ChatMessageDto[];

  @ApiPropertyOptional({
    description: '다음 메시지를 불러오기 위한 커서 ID (null이면 더 이상 없음)',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  nextCursor: string | null;
}
