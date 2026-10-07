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
  PDF_KNOWLEDGE_FORM_SCHEMA,
  readPdfUploadForm,
} from '../upload/pdf-upload-form';
import { UnansweredQuestionsService } from './unanswered-questions.service';
import {
  InjectTextKnowledgeDto,
  ListUnansweredQuestionsQueryDto,
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
      '참고 문서 0개로 답변된 질문을 위젯 키·질문 단위로 모아 반환합니다. 기본값은 미해결(open), 최초 발생 시각 내림차순입니다. SUPER_ADMIN은 전체, 그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키의 질문만 조회합니다.',
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
      'resolved: 지식 없이 해결됨으로 표시합니다(이미 해결됐으면 그대로). open: 다시 미해결로 되돌리며 해결 정보와 지식 연결을 해제합니다.',
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

  @Post(':id/knowledge/text')
  @ApiOperation({
    summary: '질문에 텍스트 지식 주입',
    description:
      '입력한 텍스트를 지식 문서로 만들어 처리 큐에 등록하고 질문을 해결됨(resolved)으로 연결합니다. title을 생략하면 질문 내용을 제목으로 씁니다. 텍스트 문서는 답변 참조 목록(PDF 링크)에 노출되지 않습니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiBody({ type: InjectTextKnowledgeDto })
  @ApiResponse({
    status: 201,
    description: '갱신된 질문',
    type: UnansweredQuestionDto,
  })
  @ApiResponse({ status: 400, description: '잘못된 요청' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '조직 멤버십 필요' })
  @ApiResponse({ status: 404, description: '질문 또는 조직 없음' })
  @ApiResponse({
    status: 409,
    description: '같은 제목(resource_name)의 활성 문서가 이미 존재',
  })
  injectText(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: InjectTextKnowledgeDto,
  ): Promise<UnansweredQuestionDto> {
    return this.service.injectTextKnowledge(id, body, admin);
  }

  @Post(':id/knowledge/pdf')
  @ApiOperation({
    summary: '질문에 PDF 지식 주입',
    description:
      '문서 업로드(POST /api/v1/admin/upload)와 같은 방식으로 PDF를 등록하고 질문을 해결됨(resolved)으로 연결합니다. title을 생략하면 파일명을 제목으로 씁니다.',
  })
  @ApiParam({ name: 'id', description: '미답변 질문 UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: PDF_KNOWLEDGE_FORM_SCHEMA })
  @ApiResponse({
    status: 201,
    description: '갱신된 질문',
    type: UnansweredQuestionDto,
  })
  @ApiResponse({ status: 400, description: '잘못된 요청 (PDF 아님 등)' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '조직 멤버십 필요' })
  @ApiResponse({ status: 404, description: '질문 또는 조직 없음' })
  @ApiResponse({
    status: 409,
    description: '동일 resource_name 문서가 이미 존재',
  })
  @ApiResponse({ status: 503, description: '문서 저장소(GCS) 일시 장애' })
  async injectPdf(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ): Promise<UnansweredQuestionDto> {
    const form = await readPdfUploadForm(req, { titleFromFilename: true });
    return this.service.injectPdfKnowledge(id, form, admin);
  }
}
