import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DocumentListItemDto } from './document-list-item.dto';

export const ACCESSIBLE_DOCUMENT_STATUSES = [
  'all',
  'active',
  'processing',
  'failed',
  'expired',
] as const;

export const ACCESSIBLE_DOCUMENT_SORTS = ['recent', 'name', 'expiry'] as const;

export type AccessibleDocumentStatusFilter =
  (typeof ACCESSIBLE_DOCUMENT_STATUSES)[number];

export type AccessibleDocumentSort =
  (typeof ACCESSIBLE_DOCUMENT_SORTS)[number];

export class ListAccessibleDocumentsQueryDto {
  @ApiPropertyOptional({
    description:
      '조직 UUID 또는 all. all이면 접근 가능한 모든 조직의 문서를 조회합니다.',
    example: 'all',
    default: 'all',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || 'all' : (value ?? 'all'),
  )
  @IsString()
  organizationId: string = 'all';

  @ApiPropertyOptional({
    description: '1부터 시작하는 페이지 번호',
    minimum: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: '페이지 크기',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;

  @ApiPropertyOptional({
    description: '문서 제목 검색어',
    maxLength: 255,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;

  @ApiPropertyOptional({
    enum: ACCESSIBLE_DOCUMENT_STATUSES,
    default: 'all',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || 'all' : (value ?? 'all'),
  )
  @IsIn(ACCESSIBLE_DOCUMENT_STATUSES)
  status: AccessibleDocumentStatusFilter = 'all';

  @ApiPropertyOptional({
    enum: ACCESSIBLE_DOCUMENT_SORTS,
    default: 'recent',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || 'recent' : (value ?? 'recent'),
  )
  @IsIn(ACCESSIBLE_DOCUMENT_SORTS)
  sort: AccessibleDocumentSort = 'recent';
}

export class AccessibleDocumentsPageDto {
  @ApiProperty({ description: '현재 페이지 번호 (1-based)', example: 1 })
  number: number;

  @ApiProperty({ description: '페이지 크기', example: 20 })
  size: number;

  @ApiProperty({
    description: '현재 필터(조직/검색/상태)에 맞는 문서 수',
    example: 137,
  })
  filteredTotal: number;

  @ApiProperty({ description: '전체 페이지 수', example: 7 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNext: boolean;

  @ApiProperty({ example: false })
  hasPrevious: boolean;
}

export class AccessibleDocumentsSummaryDto {
  @ApiProperty({
    description: '검색·상태 필터와 무관한 접근 가능 고유 문서 수',
    example: 152,
  })
  totalDocuments: number;

  @ApiProperty({
    description:
      '접근 가능한 조직별 문서 수(소유+공유). 같은 문서가 여러 조직에 있으면 각각 포함됩니다.',
    type: 'object',
    additionalProperties: { type: 'number' },
    example: {
      '550e8400-e29b-41d4-a716-446655440010': 84,
      '550e8400-e29b-41d4-a716-446655440020': 76,
    },
  })
  organizationCounts: Record<string, number>;
}

export class AccessibleDocumentsResponseDto {
  @ApiProperty({ type: DocumentListItemDto, isArray: true })
  items: DocumentListItemDto[];

  @ApiProperty({ type: AccessibleDocumentsPageDto })
  page: AccessibleDocumentsPageDto;

  @ApiProperty({ type: AccessibleDocumentsSummaryDto })
  summary: AccessibleDocumentsSummaryDto;
}
