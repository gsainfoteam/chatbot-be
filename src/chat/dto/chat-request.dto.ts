import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class ChatRequestDto {
  @ApiProperty({
    description: '사용자 질문',
    example: '오늘 날씨가 어때?',
  })
  @IsString()
  @IsNotEmpty()
  question: string;
}
