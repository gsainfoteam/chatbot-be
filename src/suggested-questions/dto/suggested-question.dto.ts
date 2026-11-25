import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
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

/**
 * 위젯 첫 화면에 출처별로 띄우는 개수. 카드가 2×2라 위 2개는 관리자가 직접 쓴 질문,
 * 아래 2개는 지글 공지에서 나온 질문이다. 요청마다 각 출처에서 무작위로 고른다.
 */
export const SUGGESTED_QUESTIONS_PER_SOURCE = 2;

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

/** active: 무기한이거나 기한 전, expired: 기한이 지남 */
export const EXPIRY_FILTERS = ['all', 'active', 'expired'] as const;
export type SuggestedQuestionExpiryFilter = (typeof EXPIRY_FILTERS)[number];

const EXPIRES_AT_DESCRIPTION =
  '첫 화면에 띄울 수 있는 마지막 시각(ISO-8601). null이면 무기한. 과거 시각은 받지 않습니다.';

const trimToDefault =
  (fallback: string) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || fallback : (value ?? fallback);

const trimOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

// ---------------------------------------------------------------- 위젯

/**
 * 위젯에 내보내는 추천 질문.
 *
 * 버튼에 보일 question과, 눌렀을 때 질문 대신 챗봇에 보낼 prompt를 한 쌍으로 준다.
 * 답변 경로는 바꾸지 않고 FE가 prompt를 보내는 것으로 정했다. prompt는 공지 번호·검색어·
 * 확인할 내용을 담은 요청문이라 브라우저에 노출돼도 문제가 없다.
 */
export class SuggestedQuestionDto {
  @ApiProperty({ description: '추천 질문 ID', format: 'uuid' })
  id: string;

  @ApiProperty({
    description:
      '버튼과 대화 말풍선에 보여줄 질문. 학생에게 보이는 문장은 이것이다.',
    maxLength: SUGGESTED_QUESTION_MAX_LENGTH,
    example: '2026 겨울행사 지네마는 언제 어디서 열리나요?',
  })
  question: string;

  @ApiProperty({
    description:
      '버튼을 눌렀을 때 question 대신 채팅 요청에 보낼 문장. 화면에는 보여주지 않는다. null이면(관리자 질문) question을 그대로 보낸다.',
    type: String,
    nullable: true,
    example:
      'GIST 지글 공지 #200986 「[하우스연합회] 2026 겨울행사」에 대한 질문입니다.\nsearch_notices로 "지네마", "겨울행사"를 검색하면 이 공지(#200986)가 나옵니다. 그 공지의 본문을 읽고 답해 주세요.\n확인할 내용: 지네마 상영 일시와 상영관 위치\n질문: 2026 겨울행사 지네마는 언제 어디서 열리나요?',
  })
  prompt: string | null;

  @ApiProperty({
    description:
      'ADMIN: 관리자가 직접 쓴 질문(위 칸), AI: 지글 공지에서 만든 질문(아래 칸)',
    enum: SUGGESTED_QUESTION_SOURCES,
  })
  source: SuggestedQuestionSource;
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

  @ApiPropertyOptional({
    description:
      '버튼을 눌렀을 때 질문 대신 보낼 문장. 학교 문서에 있는 내용이면 비워 두면 된다(질문을 그대로 보냄).',
    maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH,
  })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(SUGGESTED_QUESTION_PROMPT_MAX_LENGTH)
  prompt?: string;

  @ApiProperty({
    description: `${EXPIRES_AT_DESCRIPTION} 반드시 보내야 합니다(무기한이면 null).`,
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-12-31T23:59:59.000Z',
  })
  @IsDefined({ message: 'expiresAt is required (use null for no expiry)' })
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  expiresAt: string | null;
}

/**
 * 승인·거절과 내용·기한 수정을 함께 받는다. 최소 한 필드는 있어야 한다(서비스에서 검사).
 * APPROVED로 바꿀 때는 expiresAt도 같이 보내야 한다(서비스에서 검사).
 */
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

  @ApiPropertyOptional({
    description: 'null을 보내면 prompt를 지운다(질문을 그대로 보내게 됨).',
    maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH,
    type: String,
    nullable: true,
  })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUGGESTED_QUESTION_PROMPT_MAX_LENGTH)
  prompt?: string | null;

  @ApiPropertyOptional({
    description: `${EXPIRES_AT_DESCRIPTION} 빠지면 기한을 바꾸지 않습니다. status=APPROVED와 함께라면 필수입니다.`,
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-12-31T23:59:59.000Z',
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString()
  expiresAt?: string | null;
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
    description: 'active: 무기한이거나 기한 전, expired: 기한이 지남',
    enum: EXPIRY_FILTERS,
    default: 'all',
  })
  @Transform(trimToDefault('all'))
  @IsIn(EXPIRY_FILTERS)
  expiry: SuggestedQuestionExpiryFilter = 'all';

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

  @ApiProperty({
    description: '질문 대신 보낼 문장. 관리자 질문은 대개 null',
    maxLength: SUGGESTED_QUESTION_PROMPT_MAX_LENGTH,
    type: String,
    nullable: true,
  })
  prompt: string | null;

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

  @ApiPropertyOptional({
    description:
      '첫 화면에 띄울 수 있는 마지막 시각. null이면 무기한(승인 전 후보도 null)',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  expiresAt: Date | null;

  @ApiProperty({
    description: '기한이 지났는지. 지난 질문은 첫 화면에 뜨지 않는다',
  })
  expired: boolean;

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
