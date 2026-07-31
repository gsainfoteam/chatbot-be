import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
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
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';
import { Readable } from 'stream';
import { DocumentListItemDto } from './dto/document-list-item.dto';
import { UpdateExpiresAtDto } from './dto/update-expires-at.dto';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

@ApiTags('Upload')
@Controller('api/v1/admin/upload')
@UseGuards(AdminJwtGuard, SuperAdminGuard)
@ApiBearerAuth('bearerAuth')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Get()
  @ApiOperation({
    summary: '내가 업로드한 문서 목록 조회 (Super Admin 전용)',
    description:
      '현재 로그인한 Super Admin이 업로드한 문서 목록을 최신순으로 반환합니다. 삭제되지 않은 문서만 포함되며, 처리 상태(status)를 포함합니다.',
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
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
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
    return this.uploadService.listMyUploads(admin.uuid, {
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
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
  @ApiResponse({ status: 404, description: '문서 없음' })
  async getOne(@CurrentAdmin() admin: AdminContext, @Param('id') id: string) {
    return this.uploadService.getById(id, admin.uuid);
  }

  @Post()
  @ApiOperation({
    summary: 'PDF 파일 업로드 (Super Admin 전용)',
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
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
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
      admin.uuid,
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
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
  @ApiResponse({ status: 404, description: '문서 없음' })
  async updateExpiresAt(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body() body: UpdateExpiresAtDto,
  ) {
    return this.uploadService.updateExpiresAt(id, admin.uuid, body.expiresAt);
  }

  @Post(':id/reprocess')
  @ApiOperation({
    summary: '문서 재처리',
    description:
      '기존 청크를 비우고 status를 queued로 되돌려 워커가 다시 처리하도록 합니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID' })
  @ApiResponse({
    status: 200,
    description: '재처리 큐 등록',
    type: DocumentListItemDto,
  })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
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
  async reprocess(@Param('id') id: string) {
    return this.uploadService.reprocess(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '업로드 파일 삭제 (Super Admin 전용)',
    description:
      'GCS 산출물을 삭제하고 DB에서 soft-delete 합니다. Super Admin 역할만 호출 가능합니다.',
  })
  @ApiParam({ name: 'id', description: '문서 UUID', type: String })
  @ApiResponse({ status: 204, description: '삭제 성공' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: 'Super Admin 권한 필요' })
  @ApiResponse({
    status: 404,
    description: '문서 없음 또는 이미 삭제됨',
  })
  @ApiResponse({
    status: 503,
    description: '문서 저장소(GCS) 일시 장애',
  })
  async delete(@Param('id') id: string): Promise<void> {
    await this.uploadService.delete(id);
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
