import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WidgetSessionGuard } from '../auth/guards/widget-session.guard';
import { CurrentSession } from '../auth/decorators/current-session.decorator';
import type { SessionPayload } from '../auth/decorators/current-session.decorator';
import { SuggestedQuestionsService } from './suggested-questions.service';
import {
  ListSuggestedQuestionsQueryDto,
  SuggestedQuestionDto,
} from './dto/suggested-question.dto';

@ApiTags('Widget Suggested Questions')
@Controller('api/v1/widget/suggested-questions')
@UseGuards(WidgetSessionGuard)
@ApiBearerAuth('widgetSessionAuth')
export class SuggestedQuestionsController {
  constructor(private readonly service: SuggestedQuestionsService) {}

  @Get()
  @ApiOperation({
    summary: '추천 질문 목록',
    description:
      '위젯 첫 화면에 버튼으로 보여줄 질문을 반환합니다. 관리자가 승인한 질문만, 세션의 위젯 키 기준으로 최신순입니다. 질문을 누르면 그 문장을 그대로 채팅 입력란에 넣으면 됩니다.',
  })
  @ApiResponse({ status: 200, type: [SuggestedQuestionDto] })
  @ApiResponse({ status: 400, description: '잘못된 쿼리 파라미터' })
  @ApiResponse({ status: 401, description: '세션 없음 또는 만료' })
  list(
    @CurrentSession() session: SessionPayload,
    @Query() query: ListSuggestedQuestionsQueryDto,
  ): Promise<SuggestedQuestionDto[]> {
    return this.service.listForWidget(session.widgetKeyId, query.limit);
  }
}
