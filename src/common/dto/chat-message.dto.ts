import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageRole } from './chat-message-input.dto';

export class ChatMessageDto {
  @ApiProperty({
    description: '메시지 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: '메시지 역할',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  role: MessageRole;

  @ApiProperty({
    description: '메시지 내용',
    example: '안녕하세요, 도움이 필요합니다.',
  })
  content: string;

  @ApiPropertyOptional({
    description: '토큰 사용량 등 부가 정보',
    example: { tokens: 150, model: 'gpt-4' },
  })
  metadata?: Record<string, any>;

  @ApiProperty({
    description: '메시지 생성 일시',
    example: '2024-01-08T10:30:00.000Z',
  })
  createdAt: Date;
}
