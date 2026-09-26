import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';
import {
  PDF_UPLOAD_FORM_SCHEMA,
  readPdfUploadForm,
} from '../upload/pdf-upload-form';
import { UnansweredQuestionsService } from './unanswered-questions.service';
import {
  CreateTextKnowledgeDto,
  ListUnansweredQuestionsQueryDto,
  RegisteredKnowledgeDocumentDto,
  UnansweredQuestionDetailDto,
  UnansweredQuestionDto,
  UnansweredQuestionsResponseDto,
  UpdateUnansweredQuestionDto,
} from './dto/unanswered-question.dto';

@ApiTags('Unanswered Questions')
@Controller('api/v1/admin/unanswered-questions')
@UseGuards(AdminJwtGuard)
@ApiBearerAuth('bearerAuth')
export class UnansweredQuestionsController {
  constructor(private readonly service: UnansweredQuestionsService) {}

  @Get()
  @ApiOperation({
    summary: '미답변 질문 목록',
    description:
      '참고 문서 0개로 답변된 질문을 위젯 키·질문 단위로 모아 반환합니다. SUPER_ADMIN은 전체, 그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키의 질문만 조회합니다.',
  })
  @ApiResponse({ status: 200, type: UnansweredQuestionsResponseDto })
  @ApiResponse({ status: 400, description: '잘못된 쿼리 파라미터' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  list(
    @CurrentAdmin() admin: AdminContext,
    @Query() query: ListUnansweredQuestionsQueryDto,
  ): Promise<UnansweredQuestionsResponseDto> {
    return this.service.list(admin, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '미답변 질문 상세',
    description: '질문 정보와 가장 최근에 문서 없이 생성된 답변을 반환합니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiResponse({ status: 200, type: UnansweredQuestionDetailDto })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '질문 없음 또는 접근 권한 없음' })
  getOne(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnansweredQuestionDetailDto> {
    return this.service.getDetail(id, admin);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '미답변 질문 상태 변경',
    description:
      'OPEN(다시 열기), DISMISSED(무시), RESOLVED(문서 없이 해결 처리)로 변경합니다. OPEN/DISMISSED는 연결된 문서와 해결 정보를 해제합니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiBody({ type: UpdateUnansweredQuestionDto })
  @ApiResponse({ status: 200, type: UnansweredQuestionDto })
  @ApiResponse({ status: 400, description: '잘못된 status' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '질문 없음 또는 접근 권한 없음' })
  updateStatus(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateUnansweredQuestionDto,
  ): Promise<UnansweredQuestionDto> {
    return this.service.updateStatus(id, body.status, admin);
  }

  @Post(':id/documents/text')
  @ApiOperation({
    summary: '질문에 텍스트 지식 문서 등록',
    description:
      '관리자가 직접 입력한 텍스트를 지식 문서로 만들어 처리 큐에 등록하고 질문을 RESOLVED로 연결합니다. 텍스트 문서는 답변 참조 목록(PDF 링크)에 노출되지 않습니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiBody({ type: CreateTextKnowledgeDto })
  @ApiResponse({ status: 201, type: RegisteredKnowledgeDocumentDto })
  @ApiResponse({ status: 400, description: '잘못된 요청' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '조직 멤버십 필요' })
  @ApiResponse({ status: 404, description: '질문 또는 조직 없음' })
  @ApiResponse({
    status: 409,
    description: '같은 제목(resource_name)의 활성 문서가 이미 존재',
  })
  registerText(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateTextKnowledgeDto,
  ): Promise<RegisteredKnowledgeDocumentDto> {
    return this.service.registerTextDocument(id, body, admin);
  }

  @Post(':id/documents')
  @ApiOperation({
    summary: '질문에 PDF 지식 문서 등록',
    description:
      '문서 업로드(POST /api/v1/admin/upload)와 같은 방식으로 PDF를 등록하고 질문을 RESOLVED로 연결합니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: PDF_UPLOAD_FORM_SCHEMA })
  @ApiResponse({ status: 201, type: RegisteredKnowledgeDocumentDto })
  @ApiResponse({ status: 400, description: '잘못된 요청 (PDF 아님 등)' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '조직 멤버십 필요' })
  @ApiResponse({ status: 404, description: '질문 또는 조직 없음' })
  @ApiResponse({
    status: 409,
    description: '동일 resource_name 문서가 이미 존재',
  })
  @ApiResponse({ status: 503, description: '문서 저장소(GCS) 일시 장애' })
  async registerPdf(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ): Promise<RegisteredKnowledgeDocumentDto> {
    const form = await readPdfUploadForm(req);
    return this.service.registerPdfDocument(id, form, admin);
  }
}
