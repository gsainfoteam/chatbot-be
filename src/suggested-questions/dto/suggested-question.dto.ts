import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  SuggestedQuestionSource,
  SuggestedQuestionStatus,
} from '../../db';

/**
 * 질문 길이 상한. 추천 질문은 버튼 제목으로 쓰이므로 한 줄에 들어가야 한다.
 * DB의 suggested_questions_question_length 제약과 같은 값을 유지한다.
 */
export const SUGGESTED_QUESTION_MAX_LENGTH = 100;

/** 프롬프트 길이 상한. 답변 지침이라 질문보다 길지만 무제한은 막는다. */
export const SUGGESTED_QUESTION_PROMPT_MAX_LENGTH = 4000;

/** 위젯 첫 화면에 한 번에 노출할 수 있는 최대 개수 */
export const SUGGESTED_QUESTION_MAX_LIMIT = 20;
export const SUGGESTED_QUESTION_DEFAULT_LIMIT = 5;

export const SUGGESTED_QUESTION_STATUSES: SuggestedQuestionStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
];
export const SUGGESTED_QUESTION_SOURCES: SuggestedQuestionSource[] = [
  'ADMIN',
  'AI',
];

const STATUS_FILTERS = [...SUGGESTED_QUESTION_STATUSES, 'all'] as const;
const SOURCE_FILTERS = [...SUGGESTED_QUESTION_SOURCES, 'all'] as const;

const trimToDefault =
  (fallback: string) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || fallback : (value ?? fallback);

const trimOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

// ---------------------------------------------------------------- 위젯

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

// ---------------------------------------------------------------- 관리자

export class CreateSuggestedQuestionDto {
  @ApiProperty({ description: '질문을 노출할 위젯 키 ID', format: 'uuid' })
  @IsUUID()
  widgetKeyId: string;

  @ApiProperty({
    description: '버튼에 표시할 질문',
    maxLength: SUGGESTED_QUESTION_MAX_LENGTH,
    example: '국가장학금 언제까지 신청해요?',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUGGESTED_QUESTION_MAX_LENGTH)
  question: string;

  @ApiProperty({
    description: '이 질문에 답할 때 쓰는 프롬프트',
    maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUGGESTED_QUESTION_PROMPT_MAX_LENGTH)
  prompt: string;
}

/** 승인·거절과 내용 수정을 함께 받는다. 최소 한 필드는 있어야 한다(서비스에서 검사). */
export class UpdateSuggestedQuestionDto {
  @ApiPropertyOptional({
    description: 'APPROVED: 위젯에 노출, REJECTED: 숨김, PENDING: 검수 대기',
    enum: SUGGESTED_QUESTION_STATUSES,
  })
  @IsOptional()
  @IsIn(SUGGESTED_QUESTION_STATUSES)
  status?: SuggestedQuestionStatus;

  @ApiPropertyOptional({ maxLength: SUGGESTED_QUESTION_MAX_LENGTH })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUGGESTED_QUESTION_MAX_LENGTH)
  question?: string;

  @ApiPropertyOptional({ maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUGGESTED_QUESTION_PROMPT_MAX_LENGTH)
  prompt?: string;
}

export class ListAdminSuggestedQuestionsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'PENDING' })
  @Transform(trimToDefault('PENDING'))
  @IsIn(STATUS_FILTERS)
  status: SuggestedQuestionStatus | 'all' = 'PENDING';

  @ApiPropertyOptional({ enum: SOURCE_FILTERS, default: 'all' })
  @Transform(trimToDefault('all'))
  @IsIn(SOURCE_FILTERS)
  source: SuggestedQuestionSource | 'all' = 'all';

  @ApiPropertyOptional({
    description: '특정 위젯 키로 제한 (접근 가능한 키만)',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  widgetKeyId?: string;
}

/** 관리자 화면용. 검수해야 하므로 prompt와 출처 공지까지 모두 내보낸다. */
export class AdminSuggestedQuestionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  widgetKeyId: string;

  @ApiProperty()
  widgetKeyName: string;

  @ApiProperty({ maxLength: SUGGESTED_QUESTION_MAX_LENGTH })
  question: string;

  @ApiProperty({ maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH })
  prompt: string;

  @ApiProperty({ enum: SUGGESTED_QUESTION_SOURCES })
  source: SuggestedQuestionSource;

  @ApiProperty({ enum: SUGGESTED_QUESTION_STATUSES })
  status: SuggestedQuestionStatus;

  @ApiPropertyOptional({
    description: '이 질문을 만들어 낸 지글 공지 id. 직접 등록했으면 null',
    nullable: true,
  })
  noticeId: number | null;

  @ApiPropertyOptional({
    description:
      '질문을 만든 시점의 공지 제목. 공지가 바뀌어도 갱신하지 않는다',
    nullable: true,
  })
  noticeTitle: string | null;

  @ApiPropertyOptional({
    description: '공지 원문 링크. noticeId가 없으면 null',
    nullable: true,
  })
  noticeUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedByIdpUuid: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class AdminSuggestedQuestionsPageDto {
  @ApiProperty({ example: 1 })
  number: number;

  @ApiProperty({ example: 20 })
  size: number;

  @ApiProperty({ example: 18 })
  filteredTotal: number;

  @ApiProperty({ example: 1 })
  totalPages: number;

  @ApiProperty()
  hasNext: boolean;

  @ApiProperty()
  hasPrevious: boolean;
}

export class AdminSuggestedQuestionsResponseDto {
  @ApiProperty({ type: AdminSuggestedQuestionDto, isArray: true })
  items: AdminSuggestedQuestionDto[];

  @ApiProperty({ type: AdminSuggestedQuestionsPageDto })
  page: AdminSuggestedQuestionsPageDto;
}
