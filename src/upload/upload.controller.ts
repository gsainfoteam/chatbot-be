import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiConsumes,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UploadService, PDF_MIME } from './upload.service';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';
import { Readable } from 'stream';
import { DocumentListItemDto } from './dto/document-list-item.dto';
import { UpdateExpiresAtDto } from './dto/update-expires-at.dto';
import { TransferDocumentDto } from './dto/transfer-document.dto';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

@ApiTags('Upload')
@Controller('api/v1/admin/upload')
@UseGuards(AdminJwtGuard)
@ApiBearerAuth('bearerAuth')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Get()
  @ApiOperation({
    summary: '내가 업로드한 문서 목록',
    description:
      '현재 로그인한 사용자가 직접 업로드한 활성 문서만 최신순으로 반환합니다.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '최대 개수 (기본 50, 최대 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: '건너뛸 개수 (페이지네이션)',
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: DocumentListItemDto,
    isArray: true,
  })
  @ApiResponse({ status: 400, description: '잘못된 limit 또는 offset' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async listMyUploads(
    @CurrentAdmin() admin: AdminContext,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit != null ? parseInt(limit, 10) : undefined;
    const offsetNum = offset != null ? parseInt(offset, 10) : undefined;
    if (limit != null && (Number.isNaN(limitNum) || (limitNum as number) < 1)) {
      throw new BadRequestException('limit must be a positive number');
    }
    if (
      offset != null &&
      (Number.isNaN(offsetNum as number) || (offsetNum as number) < 0)
    ) {
      throw new BadRequestException('offset must be a non-negative number');
    }
    return this.uploadService.listMyUploads(admin, {
      limit: limitNum,
      offset: offsetNum,
    });
  }

  @Get('manageable')
  @ApiOperation({
    summary: '현재 사용자가 관리 가능한 문서 목록',
    description:
      'SUPER_ADMIN의 전체 문서와, 소유 조직에 ACCEPTED 멤버십(MANAGER/MEMBER)이 있는 문서를 중복 없이 반환합니다.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '최대 개수 (기본 50, 최대 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: '건너뛸 개수 (페이지네이션)',
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: DocumentListItemDto,
    isArray: true,
  })
  @ApiResponse({ status: 400, description: '잘못된 limit 또는 offset' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async listManageableDocuments(
    @CurrentAdmin() admin: AdminContext,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit != null ? parseInt(limit, 10) : undefined;
    const offsetNum = offset != null ? parseInt(offset, 10) : undefined;
    if (limit != null && (Number.isNaN(limitNum) || (limitNum as number) < 1)) {
      throw new BadRequestException('limit must be a positive number');
    }
    if (
      offset != null &&
      (Number.isNaN(offsetNum as number) || (offsetNum as number) < 0)
    ) {
      throw new BadRequestException('offset must be a non-negative number');
    }
    return this.uploadService.listManageableDocuments(admin, {
      limit: limitNum,
      offset: offsetNum,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: '문서 단건 조회 (상태 포함)',
    description: '업로드한 문서의 처리 상태를 조회합니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID' })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: DocumentListItemDto,
  })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '문서 없음' })
  async getOne(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploadService.getById(id, admin);
  }

  @Post()
  @ApiOperation({
    summary: '조직 소유 PDF 파일 업로드',
    description:
      'PDF를 GCS에 저장하고 비동기 처리 큐에 등록합니다. 처리 완료를 기다리지 않으며 status=queued로 즉시 응답합니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'title'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF 파일' },
        title: { type: 'string', description: '파일 제목' },
        expiresAt: {
          type: 'string',
          format: 'date-time',
          description:
            '문서 유효기간 (ISO-8601, optional). 미전송/빈 값이면 무기한. 과거 시각은 400.',
          nullable: true,
        },
        organizationId: {
          type: 'string',
          format: 'uuid',
          description:
            '소유 조직 UUID. 생략한 경우에만 출시 호환성을 위해 기본 조직을 사용하며, 빈 값은 잘못된 입력입니다.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: '업로드 성공 (queued)',
    type: DocumentListItemDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 요청 (PDF 아님, 필드 누락, 과거 expiresAt 등)',
  })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '조직 멤버십 필요' })
  @ApiResponse({ status: 404, description: '지정 조직 없음' })
  @ApiResponse({
    status: 409,
    description: '동일 resource_name 문서가 이미 존재',
  })
  @ApiResponse({
    status: 503,
    description: '문서 저장소(GCS) 일시 장애',
  })
  async upload(
    @CurrentAdmin() admin: AdminContext,
    @Req() req: FastifyRequest,
  ) {
    const fastifyReq = req as FastifyRequest & {
      isMultipart: () => boolean;
      parts: () => AsyncIterable<MultipartPart>;
    };
    if (!fastifyReq.isMultipart?.()) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = fastifyReq.parts();
    let title = '';
    let expiresAt: string | undefined;
    let organizationId: string | undefined;
    let fileBuffer: Buffer | null = null;
    let filename = 'document.pdf';
    let mimetype = '';

    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'title') {
          const v = part.value;
          title = typeof v === 'string' ? v : '';
        } else if (part.fieldname === 'expiresAt') {
          const v = part.value;
          expiresAt = typeof v === 'string' ? v : undefined;
        } else if (part.fieldname === 'organizationId') {
          const v = part.value;
          organizationId = typeof v === 'string' ? v : undefined;
        }
      } else if (part.type === 'file' && part.fieldname === 'file') {
        const filePart = part;
        mimetype = filePart.mimetype ?? '';
        filename = filePart.filename ?? 'document.pdf';
        fileBuffer = filePart.toBuffer
          ? await filePart.toBuffer()
          : await streamToBuffer(filePart.file);
      }
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new BadRequestException('title is required');
    }
    if (!fileBuffer) {
      throw new BadRequestException('file is required');
    }
    if (mimetype !== PDF_MIME) {
      throw new BadRequestException('Only PDF files are allowed');
    }

    return this.uploadService.upload(
      fileBuffer,
      filename,
      title.trim(),
      admin,
      organizationId,
      expiresAt,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: '문서 유효기간 변경',
    description:
      'expiresAt을 ISO-8601로 연장/변경하거나 null로 무기한 전환합니다. 과거 시각은 허용하지 않습니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID' })
  @ApiBody({ type: UpdateExpiresAtDto })
  @ApiResponse({
    status: 200,
    description: '유효기간 변경 성공',
    type: DocumentListItemDto,
  })
  @ApiResponse({ status: 400, description: '잘못된 expiresAt' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '문서 관리 권한 없음' })
  @ApiResponse({ status: 404, description: '문서 없음' })
  async updateExpiresAt(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateExpiresAtDto,
  ) {
    return this.uploadService.updateExpiresAt(id, admin, body.expiresAt);
  }

  @Post(':id/reprocess')
  @ApiOperation({
    summary: '문서 재처리',
    description:
      '기존 청크를 비우고 status를 queued로 되돌려 워커가 다시 처리하도록 합니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID' })
  @ApiResponse({
    status: 201,
    description: '재처리 큐 등록',
    type: DocumentListItemDto,
  })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '문서 관리 권한 없음' })
  @ApiResponse({ status: 404, description: '문서 없음' })
  @ApiResponse({
    status: 409,
    description: '현재 문서 상태가 재처리를 허용하지 않음',
  })
  @ApiResponse({
    status: 429,
    description: '문서별 24시간 재처리 쿨다운 적용 중',
    schema: {
      example: {
        statusCode: 429,
        message: 'Document reprocess cooldown is active',
        error: 'Too Many Requests',
        retryAt: '2026-07-31T13:00:00.000Z',
      },
    },
  })
  async reprocess(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploadService.reprocess(id, admin);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '업로드 파일 삭제',
    description:
      '문서 관리 권한을 확인한 뒤 GCS 산출물을 삭제하고 DB에서 soft-delete 합니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID', type: String })
  @ApiResponse({ status: 204, description: '삭제 성공' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '문서 관리 권한 없음' })
  @ApiResponse({
    status: 404,
    description: '문서 없음 또는 이미 삭제됨',
  })
  @ApiResponse({
    status: 503,
    description: '문서 저장소(GCS) 일시 장애',
  })
  async delete(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.uploadService.delete(id, admin);
  }

  @Put(':id/shares/:organizationId')
  @ApiOperation({
    summary: '문서를 다른 조직에 공유',
    description:
      '소유 조직 멤버(MANAGER/MEMBER) 또는 SUPER_ADMIN만 가능하며 PDF/청크를 복제하지 않습니다.',
  })
  @ApiResponse({ status: 200, type: DocumentListItemDto })
  @ApiResponse({ status: 400, description: '소유 조직으로 공유 시도' })
  @ApiResponse({ status: 403, description: '공유 권한 없음' })
  share(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
  ) {
    return this.uploadService.shareDocument(id, organizationId, admin);
  }

  @Delete(':id/shares/:organizationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '조직 문서 공유 해제' })
  @ApiResponse({ status: 204, description: '공유 해제 성공' })
  @ApiResponse({ status: 403, description: '공유 권한 없음' })
  async unshare(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
  ): Promise<void> {
    await this.uploadService.unshareDocument(id, organizationId, admin);
  }

  @Post(':id/transfer')
  @ApiOperation({
    summary: '문서 소유권 이전',
    description:
      'SUPER_ADMIN 또는 출발/대상 양쪽 조직의 멤버(MANAGER/MEMBER)만 가능하며 공유 정리와 감사 로그를 원자적으로 기록합니다.',
  })
  @ApiResponse({ status: 201, type: DocumentListItemDto })
  @ApiResponse({
    status: 403,
    description: '출발 또는 대상 조직 멤버십 없음',
  })
  @ApiResponse({ status: 409, description: '동시 소유권 변경' })
  transfer(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TransferDocumentDto,
  ) {
    return this.uploadService.transferDocument(
      id,
      body.targetOrganizationId,
      admin,
    );
  }
}

@ApiTags('Organizations', 'Upload')
@Controller('api/v1/admin/organizations')
@UseGuards(AdminJwtGuard)
@ApiBearerAuth('bearerAuth')
export class OrganizationDocumentsController {
  constructor(private readonly uploadService: UploadService) {}

  @Get(':organizationId/documents')
  @ApiOperation({
    summary: '조직 문서 목록',
    description: '조직이 소유한 문서와 조직에 공유된 문서를 함께 반환합니다.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({ status: 200, type: DocumentListItemDto, isArray: true })
  @ApiResponse({ status: 403, description: '조직 접근 권한 없음' })
  async list(
    @CurrentAdmin() admin: AdminContext,
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit != null ? parseInt(limit, 10) : undefined;
    const offsetNum = offset != null ? parseInt(offset, 10) : undefined;
    if (limit != null && (Number.isNaN(limitNum) || (limitNum as number) < 1)) {
      throw new BadRequestException('limit must be a positive number');
    }
    if (
      offset != null &&
      (Number.isNaN(offsetNum as number) || (offsetNum as number) < 0)
    ) {
      throw new BadRequestException('offset must be a non-negative number');
    }
    return this.uploadService.listOrganizationDocuments(organizationId, admin, {
      limit: limitNum,
      offset: offsetNum,
    });
  }
}

interface FieldPart {
  type: 'field';
  fieldname: string;
  value: string;
}

interface FilePart {
  type: 'file';
  fieldname: string;
  filename: string;
  mimetype: string;
  file: NodeJS.ReadableStream;
  toBuffer?: () => Promise<Buffer>;
}

type MultipartPart = FieldPart | FilePart;
