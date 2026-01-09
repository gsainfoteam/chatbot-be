import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

export class ChatMessageInputDto {
  @ApiProperty({
    description: '메시지 역할',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  @IsNotEmpty()
  role: MessageRole;

  @ApiProperty({
    description: '메시지 내용',
    example: '안녕하세요, 도움이 필요합니다.',
  })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description: '토큰 사용량 등 부가 정보',
    example: { tokens: 150, model: 'gpt-4' },
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
