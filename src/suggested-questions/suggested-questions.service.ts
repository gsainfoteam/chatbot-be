import { Injectable } from '@nestjs/common';
import { SuggestedQuestionsRepository } from './suggested-questions.repository';
import { SuggestedQuestionDto } from './dto/suggested-question.dto';

@Injectable()
export class SuggestedQuestionsService {
  constructor(private readonly repository: SuggestedQuestionsRepository) {}

  /** 세션이 속한 위젯 키의 승인된 추천 질문 */
  async listForWidget(
    widgetKeyId: string,
    limit: number,
  ): Promise<SuggestedQuestionDto[]> {
    const rows = await this.repository.listApproved(widgetKeyId, limit);
    return rows.map((row) => ({ id: row.id, question: row.question }));
  }
}
