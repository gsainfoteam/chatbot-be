import { ApiProperty } from '@nestjs/swagger';
import type { DocumentStatus } from '../../db';

const DOCUMENT_STATUSES: DocumentStatus[] = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
];

export class DocumentOrganizationSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

export class DocumentUploaderSummaryDto {
  @ApiProperty()
  idpUuid: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;
}

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

  @ApiProperty({
    description: '문서 유효기간 (ISO-8601). null이면 무기한',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-12-31T23:59:59.000Z',
  })
  expiresAt: Date | null;

  @ApiProperty({
    description: '현재 시각 기준 만료 여부 (만료되어도 soft-delete되지 않음)',
    example: false,
  })
  isExpired: boolean;

  @ApiProperty({
    description: '문서 소유 조직',
    type: () => DocumentOrganizationSummaryDto,
    example: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: '인포팀',
      slug: 'infoteam',
    },
  })
  ownerOrganization: DocumentOrganizationSummaryDto;

  @ApiProperty({
    description:
      '업로더 IDP 식별자와 공개 관리자 정보 (관리자 레코드가 없으면 null)',
    type: () => DocumentUploaderSummaryDto,
    nullable: true,
    example: {
      idpUuid: 'idp-user-uuid',
      email: 'admin@example.com',
      name: '관리자',
    },
  })
  uploader: DocumentUploaderSummaryDto | null;

  @ApiProperty({
    description: '문서가 공유된 조직 목록',
    type: () => DocumentOrganizationSummaryDto,
    isArray: true,
    example: [],
  })
  sharedOrganizations: DocumentOrganizationSummaryDto[];

  @ApiProperty({ enum: ['OWNER', 'SHARED'] })
  accessRelation: 'OWNER' | 'SHARED';

  @ApiProperty({ description: '수정/삭제/재처리/유효기간 변경 가능 여부' })
  canManage: boolean;

  @ApiProperty({ description: '다른 조직으로 공유/공유 해제 가능 여부' })
  canShare: boolean;

  @ApiProperty({ description: '소유권 이전을 시작할 수 있는 권한 여부' })
  canTransfer: boolean;
}
