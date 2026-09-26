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
import { DocumentListItemDto } from '../../upload/dto/document-list-item.dto';
import { TEXT_KNOWLEDGE_MAX_CHARS } from '../../pdf-processor/text-knowledge';
import {
  UNANSWERED_QUESTION_SORTS,
  type UnansweredQuestionSort,
} from '../unanswered-questions.repository';

export const UNANSWERED_QUESTION_STATUSES: UnansweredQuestionStatus[] = [
  'OPEN',
  'RESOLVED',
  'DISMISSED',
];

const STATUS_FILTERS = ['all', ...UNANSWERED_QUESTION_STATUSES] as const;
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

  @ApiPropertyOptional({ description: '질문 내용 검색어', maxLength: 255 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'all' })
  @Transform(trimToDefault('all'))
  @IsIn(STATUS_FILTERS)
  status: UnansweredQuestionStatus | 'all' = 'all';

  @ApiPropertyOptional({
    description: '특정 위젯 키로 제한 (접근 가능한 키만)',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  widgetKeyId?: string;

  @ApiPropertyOptional({
    description: 'recent: 최근 질문일, count: 반복 질문 수, first: 최초 질문일',
    enum: UNANSWERED_QUESTION_SORTS,
    default: 'recent',
  })
  @Transform(trimToDefault('recent'))
  @IsIn(UNANSWERED_QUESTION_SORTS)
  sort: UnansweredQuestionSort = 'recent';

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @Transform(trimToDefault('desc'))
  @IsIn(SORT_ORDERS)
  order: 'asc' | 'desc' = 'desc';
}

export class UnansweredQuestionDocumentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    enum: ['uploading', 'queued', 'processing', 'ready', 'failed'],
  })
  status: DocumentStatus;

  @ApiProperty({ enum: ['pdf', 'text'] })
  sourceType: DocumentSourceType;

  @ApiProperty({ description: 'false면 삭제된 문서' })
  isActive: boolean;
}

export class UnansweredQuestionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  widgetKeyId: string;

  @ApiProperty({ example: '학생 포털' })
  widgetKeyName: string;

  @ApiProperty({
    description: '가장 최근에 들어온 질문 원문',
    example: '부산에서 외국인도 은행 계좌를 만들 수 있나요?',
  })
  question: string;

  @ApiProperty({ enum: ['KO', 'EN', 'OTHER'], example: 'KO' })
  language: string;

  @ApiProperty({ description: '같은 질문(정규화 기준)이 들어온 횟수' })
  askCount: number;

  @ApiProperty({ enum: UNANSWERED_QUESTION_STATUSES })
  status: UnansweredQuestionStatus;

  @ApiProperty({ format: 'uuid', nullable: true })
  lastSessionId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  firstAskedAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  lastAskedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ nullable: true })
  resolvedByIdpUuid: string | null;

  @ApiProperty({
    description:
      '해결 이후 같은 질문이 다시 들어왔는지 (lastAskedAt > resolvedAt)',
  })
  askedAgainAfterResolved: boolean;

  @ApiProperty({
    description: '질문에 연결된 지식 문서',
    type: () => UnansweredQuestionDocumentDto,
    nullable: true,
  })
  document: UnansweredQuestionDocumentDto | null;
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
      'OPEN/DISMISSED로 바꾸면 해결 정보와 문서 연결이 해제됩니다. RESOLVED는 문서 없이 해결 처리할 때 사용합니다.',
    enum: UNANSWERED_QUESTION_STATUSES,
  })
  @IsIn(UNANSWERED_QUESTION_STATUSES)
  status: UnansweredQuestionStatus;
}

export class CreateTextKnowledgeDto {
  @ApiProperty({ description: '문서 제목', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    description: '질문에 대한 지식 본문 (마크다운 가능)',
    maxLength: TEXT_KNOWLEDGE_MAX_CHARS,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_KNOWLEDGE_MAX_CHARS)
  content: string;

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

export class RegisteredKnowledgeDocumentDto {
  @ApiProperty({ type: UnansweredQuestionDto })
  question: UnansweredQuestionDto;

  @ApiProperty({ type: DocumentListItemDto })
  document: DocumentListItemDto;
}
