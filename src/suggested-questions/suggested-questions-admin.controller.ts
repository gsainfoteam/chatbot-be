import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';
import { SuggestedQuestionsAdminService } from './suggested-questions-admin.service';
import {
  AdminSuggestedQuestionDto,
  AdminSuggestedQuestionsResponseDto,
  CreateSuggestedQuestionDto,
  ListAdminSuggestedQuestionsQueryDto,
  UpdateSuggestedQuestionDto,
} from './dto/suggested-question.dto';

@ApiTags('Suggested Questions')
@Controller('api/v1/admin/suggested-questions')
@UseGuards(AdminJwtGuard)
@ApiBearerAuth('bearerAuth')
export class SuggestedQuestionsAdminController {
  constructor(private readonly service: SuggestedQuestionsAdminService) {}

  @Post()
  @ApiOperation({
    summary: '추천 질문 등록',
    description:
      '질문과 프롬프트를 직접 등록합니다. 사람이 보고 넣은 것이므로 바로 승인(APPROVED) 상태가 되어 위젯에 노출됩니다.',
  })
  @ApiBody({ type: CreateSuggestedQuestionDto })
  @ApiResponse({ status: 201, type: AdminSuggestedQuestionDto })
  @ApiResponse({ status: 400, description: '잘못된 요청' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '위젯 키 없음 또는 접근 권한 없음' })
  @ApiResponse({
    status: 409,
    description: '같은 위젯 키에 같은 질문이 이미 존재',
  })
  create(
    @CurrentAdmin() admin: AdminContext,
    @Body() body: CreateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    return this.service.create(admin, body);
  }

  @Get()
  @ApiOperation({
    summary: '추천 질문 목록',
    description:
      '검수할 질문을 찾습니다. 기본값은 검수 대기(PENDING), 최신순입니다. source=AI로 주기 작업이 만든 후보만 볼 수 있습니다. SUPER_ADMIN은 전체, 그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키의 질문만 조회합니다.',
  })
  @ApiResponse({ status: 200, type: AdminSuggestedQuestionsResponseDto })
  @ApiResponse({ status: 400, description: '잘못된 쿼리 파라미터' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '위젯 키 없음 또는 접근 권한 없음' })
  list(
    @CurrentAdmin() admin: AdminContext,
    @Query() query: ListAdminSuggestedQuestionsQueryDto,
  ): Promise<AdminSuggestedQuestionsResponseDto> {
    return this.service.list(admin, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '추천 질문 상세',
    description: '프롬프트와 출처 공지를 포함해 반환합니다.',
  })
  @ApiParam({ name: 'id', description: '추천 질문 UUID' })
  @ApiResponse({ status: 200, type: AdminSuggestedQuestionDto })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '질문 없음 또는 접근 권한 없음' })
  getOne(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminSuggestedQuestionDto> {
    return this.service.getDetail(admin, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '추천 질문 검수·수정',
    description:
      'status로 승인(APPROVED)·거절(REJECTED)하고, question과 prompt를 고칠 수 있습니다. 셋 중 최소 하나는 있어야 합니다. status를 바꿀 때만 검수자와 검수 시각이 기록됩니다.',
  })
  @ApiParam({ name: 'id', description: '추천 질문 UUID' })
  @ApiBody({ type: UpdateSuggestedQuestionDto })
  @ApiResponse({ status: 200, type: AdminSuggestedQuestionDto })
  @ApiResponse({ status: 400, description: '바꿀 내용이 없거나 값이 잘못됨' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 404, description: '질문 없음 또는 접근 권한 없음' })
  @ApiResponse({
    status: 409,
    description: '같은 위젯 키에 같은 질문이 이미 존재',
  })
  update(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    return this.service.update(admin, id, body);
  }
}
