import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, IsNotEmpty } from 'class-validator';

export class ChatRequestDto {
  @ApiProperty({
    description: '사용자 질문',
    example: 'GIST 장학금 신청 공지 알려줘',
  })
  @MaxLength(4000)
  @IsString()
  @IsNotEmpty()
  question: string;
}
