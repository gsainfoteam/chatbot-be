import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
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
  DocumentSourceType,
  DocumentStatus,
  UnansweredQuestionStatus,
} from '../../db';
import { TEXT_KNOWLEDGE_MAX_CHARS } from '../../pdf-processor/text-knowledge';
import {
  UNANSWERED_QUESTION_SORTS,
  type UnansweredQuestionSort,
} from '../unanswered-questions.repository';

export const UNANSWERED_QUESTION_STATUSES: UnansweredQuestionStatus[] = [
  'open',
  'resolved',
];

const STATUS_FILTERS = [...UNANSWERED_QUESTION_STATUSES, 'all'] as const;
const SORT_ORDERS = ['asc', 'desc'] as const;

const trimToDefault =
  (fallback: string) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || fallback : (value ?? fallback);

export class ListUnansweredQuestionsQueryDto {
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

  @ApiPropertyOptional({
    description: '질문 검색어 (NFC·대소문자·연속 공백 차이 무시)',
    maxLength: 255,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'open' })
  @Transform(trimToDefault('open'))
  @IsIn(STATUS_FILTERS)
  status: UnansweredQuestionStatus | 'all' = 'open';

  @ApiPropertyOptional({
    description: '특정 위젯 키로 제한 (접근 가능한 키만)',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  widgetKeyId?: string;

  @ApiPropertyOptional({
    description:
      'created: 최초 발생 시각, recent: 최근 발생 시각, count: 발생 횟수',
    enum: UNANSWERED_QUESTION_SORTS,
    default: 'created',
  })
  @Transform(trimToDefault('created'))
  @IsIn(UNANSWERED_QUESTION_SORTS)
  sort: UnansweredQuestionSort = 'created';

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @Transform(trimToDefault('desc'))
  @IsIn(SORT_ORDERS)
  order: 'asc' | 'desc' = 'desc';
}

export class InjectedKnowledgeDto {
  @ApiProperty({ enum: ['text', 'pdf'] })
  type: DocumentSourceType;

  @ApiProperty({
    description: '지식을 등록한 시각',
    type: String,
    format: 'date-time',
  })
  injectedAt: Date;

  @ApiPropertyOptional({ description: 'type=text일 때 등록한 지식 본문' })
  text?: string;

  @ApiPropertyOptional({
    description: 'type=pdf일 때 등록된 PDF 파일명',
    example: '유학생 은행 계좌 안내.pdf',
  })
  fileName?: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty()
  documentTitle: string;

  @ApiProperty({
    description: '문서 처리 상태. ready가 되어야 답변에 사용됩니다.',
    enum: ['uploading', 'queued', 'processing', 'ready', 'failed'],
  })
  documentStatus: DocumentStatus;

  @ApiProperty({ description: 'false면 문서 관리에서 삭제된 문서' })
  documentActive: boolean;
}

export class UnansweredQuestionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: '가장 최근에 들어온 질문 원문',
    example: '부산에서 외국인도 은행 계좌를 만들 수 있나요?',
  })
  question: string;

  @ApiProperty({
    description: '처음 발생한 시각',
    type: String,
    format: 'date-time',
  })
  createdAt: Date;

  @ApiProperty({ enum: UNANSWERED_QUESTION_STATUSES })
  status: UnansweredQuestionStatus;

  @ApiProperty({ description: '같은 질문(정규화 기준)이 발생한 횟수' })
  occurrenceCount: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({
    description: '질문에 등록한 지식. 지식 없이 해결했거나 미해결이면 null',
    type: () => InjectedKnowledgeDto,
    nullable: true,
  })
  injectedKnowledge: InjectedKnowledgeDto | null;

  @ApiProperty({
    description: '가장 최근에 발생한 시각',
    type: String,
    format: 'date-time',
  })
  lastAskedAt: Date;

  @ApiProperty({
    description:
      '해결 이후 같은 질문이 다시 발생했는지 (lastAskedAt > resolvedAt)',
  })
  askedAgainAfterResolved: boolean;

  @ApiProperty({ format: 'uuid' })
  widgetKeyId: string;

  @ApiProperty({ example: '학생 포털' })
  widgetKeyName: string;

  @ApiProperty({ enum: ['KO', 'EN', 'OTHER'], example: 'KO' })
  language: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  lastSessionId: string | null;

  @ApiProperty({ nullable: true })
  resolvedByIdpUuid: string | null;
}

export class UnansweredQuestionAnswerDto {
  @ApiProperty({ format: 'uuid' })
  messageId: string;

  @ApiProperty({ description: '참고 문서 없이 생성된 답변' })
  content: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class UnansweredQuestionDetailDto extends UnansweredQuestionDto {
  @ApiProperty({
    type: () => UnansweredQuestionAnswerDto,
    nullable: true,
  })
  lastAnswer: UnansweredQuestionAnswerDto | null;
}

export class UnansweredQuestionsPageDto {
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

export class UnansweredQuestionsResponseDto {
  @ApiProperty({ type: UnansweredQuestionDto, isArray: true })
  items: UnansweredQuestionDto[];

  @ApiProperty({ type: UnansweredQuestionsPageDto })
  page: UnansweredQuestionsPageDto;
}

export class UpdateUnansweredQuestionDto {
  @ApiProperty({
    description:
      'resolved: 지식 없이 해결 처리(이미 해결됐으면 그대로). open: 해결 정보와 지식 연결을 해제',
    enum: UNANSWERED_QUESTION_STATUSES,
  })
  @IsIn(UNANSWERED_QUESTION_STATUSES)
  status: UnansweredQuestionStatus;
}

export class InjectTextKnowledgeDto {
  @ApiProperty({
    description: '질문에 답할 수 있는 지식 본문 (마크다운 가능)',
    maxLength: TEXT_KNOWLEDGE_MAX_CHARS,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_KNOWLEDGE_MAX_CHARS)
  text: string;

  @ApiPropertyOptional({
    description: '문서 제목. 생략하면 질문 내용을 제목으로 사용',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: '소유 조직 UUID. 생략하면 기본 조직',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: '문서 유효기간 (ISO-8601). null/생략이면 무기한',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  expiresAt?: string | null;
}
