import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WidgetSessionGuard } from '../auth/guards/widget-session.guard';
import { SuggestedQuestionsService } from './suggested-questions.service';
import { SuggestedQuestionDto } from './dto/suggested-question.dto';

@ApiTags('Widget Suggested Questions')
@Controller('api/v1/widget/suggested-questions')
@UseGuards(WidgetSessionGuard)
@ApiBearerAuth('widgetSessionAuth')
export class SuggestedQuestionsController {
  constructor(private readonly service: SuggestedQuestionsService) {}

  @Get()
  @ApiOperation({
    summary: '추천 질문 목록',
    description: [
      '첫 화면 카드(2×2)에 띄울 질문을 반환합니다. 승인됐고 기한이 지나지 않은 질문만 나옵니다. 위젯 키와 무관하게 같은 질문 풀에서 고릅니다.',
      '',
      '- 관리자가 직접 쓴 질문(`source: ADMIN`) 최대 2개, 지글 공지에서 만든 질문(`source: AI`) 최대 2개를 각각 무작위로 고릅니다. 요청마다 결과가 달라집니다.',
      '- 배열은 ADMIN이 먼저, AI가 뒤입니다. `source`로 위 칸·아래 칸을 나누면 됩니다.',
      '- 버튼과 말풍선에는 `question`을 보여주고, 누르면 채팅 요청의 `question` 자리에 `prompt`를 보내면 됩니다.',
      '- 한쪽 질문이 모자라면 그만큼 적게 옵니다(빈 배열일 수도 있음). 다른 쪽으로 채우지 않습니다.',
    ].join('\n'),
  })
  @ApiResponse({ status: 200, type: [SuggestedQuestionDto] })
  @ApiResponse({ status: 401, description: '세션 없음 또는 만료' })
  list(): Promise<SuggestedQuestionDto[]> {
    return this.service.listForWidget();
  }
}
