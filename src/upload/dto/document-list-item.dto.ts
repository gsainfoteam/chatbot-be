import { ApiProperty } from '@nestjs/swagger';
import type { DocumentStatus } from '../../db';

const DOCUMENT_STATUSES: DocumentStatus[] = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
];

export class DocumentListItemDto {
  @ApiProperty({
    description: '문서 UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: '관리자가 입력한 문서 제목',
    example: '2026년 학생 학사편람',
  })
  title: string;

  @ApiProperty({
    description: '원본 PDF 파일명에서 확장자를 제거한 리소스 이름',
    example: '2026년 학생 학사편람',
  })
  resourceName: string;

  @ApiProperty({
    description: 'PDF 업로드 및 비동기 처리 상태',
    enum: DOCUMENT_STATUSES,
    example: 'ready',
  })
  status: DocumentStatus;

  @ApiProperty({
    description: '처리 완료 후 생성된 문서 전체 요약',
    nullable: true,
    example: '학사 일정, 수강 신청 및 졸업 요건 안내',
  })
  summary: string | null;

  @ApiProperty({
    description: 'GCS에 저장된 원본 PDF 경로',
    example: 'gs://ziggle-resources/2026년 학생 학사편람.pdf',
  })
  gcsPdfPath: string;

  @ApiProperty({
    description: '처리 실패 시 오류 메시지',
    nullable: true,
    example: null,
  })
  errorMessage: string | null;

  @ApiProperty({
    description: '업로드 일시',
    type: String,
    format: 'date-time',
    example: '2026-07-30T12:00:00.000Z',
  })
  uploadedAt: Date;

  @ApiProperty({
    description: '처리 완료 일시',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-07-30T12:02:30.000Z',
  })
  processedAt: Date | null;

  @ApiProperty({
    description: '마지막 재처리 요청 일시',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-07-30T13:00:00.000Z',
  })
  lastReprocessedAt: Date | null;

  @ApiProperty({
    description: '24시간 쿨다운 기준 다음 재처리 가능 일시',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-07-31T13:00:00.000Z',
  })
  reprocessAvailableAt: Date | null;

  @ApiProperty({
    description: '현재 상태와 쿨다운을 반영한 재처리 가능 여부',
    example: true,
  })
  canReprocess: boolean;
}
