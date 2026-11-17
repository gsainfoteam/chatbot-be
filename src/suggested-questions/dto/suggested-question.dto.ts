import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * 질문 길이 상한. 추천 질문은 버튼 제목으로 쓰이므로 한 줄에 들어가야 한다.
 * DB의 suggested_questions_question_length 제약과 같은 값을 유지한다.
 */
export const SUGGESTED_QUESTION_MAX_LENGTH = 100;

/** 위젯 첫 화면에 한 번에 노출할 수 있는 최대 개수 */
export const SUGGESTED_QUESTION_MAX_LIMIT = 20;
export const SUGGESTED_QUESTION_DEFAULT_LIMIT = 5;

export class ListSuggestedQuestionsQueryDto {
  @ApiPropertyOptional({
    description: '받아올 질문 수',
    minimum: 1,
    maximum: SUGGESTED_QUESTION_MAX_LIMIT,
    default: SUGGESTED_QUESTION_DEFAULT_LIMIT,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUGGESTED_QUESTION_MAX_LIMIT)
  limit: number = SUGGESTED_QUESTION_DEFAULT_LIMIT;
}

/**
 * 위젯에 내보내는 추천 질문.
 * 답변 생성에 쓰는 prompt는 포함하지 않는다. 노출되면 프롬프트를 그대로 흉내 낼 수 있다.
 */
export class SuggestedQuestionDto {
  @ApiProperty({ description: '추천 질문 ID', format: 'uuid' })
  id: string;

  @ApiProperty({
    description: '버튼에 표시할 질문. 누르면 그대로 채팅 입력란에 들어간다.',
    maxLength: SUGGESTED_QUESTION_MAX_LENGTH,
    example: '국가장학금 언제까지 신청해요?',
  })
  question: string;
}
