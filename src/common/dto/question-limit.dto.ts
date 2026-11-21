import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/** 사용자 한 명이 최근 windowSeconds초 동안 보낼 수 있는 질문 수 */
export class QuestionLimitDto {
  @ApiProperty({
    description: '기간 안에 사용자 한 명이 보낼 수 있는 질문 수',
    minimum: 1,
    maximum: 10000,
    example: 20,
  })
  @IsInt()
  @Min(1)
  @Max(10000)
  maxQuestions: number;

  @ApiProperty({
    description: '한도를 세는 기간(초). 최근 이 기간 안의 질문만 셉니다.',
    minimum: 60,
    maximum: 2592000,
    example: 86400,
  })
  @IsInt()
  @Min(60)
  @Max(2592000)
  windowSeconds: number;
}
