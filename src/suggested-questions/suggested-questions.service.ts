import { Injectable } from '@nestjs/common';
import { SuggestedQuestionsRepository } from './suggested-questions.repository';
import {
  SUGGESTED_QUESTIONS_PER_SOURCE,
  SuggestedQuestionDto,
} from './dto/suggested-question.dto';

@Injectable()
export class SuggestedQuestionsService {
  constructor(private readonly repository: SuggestedQuestionsRepository) {}

  /**
   * 첫 화면 질문. 위젯 키와 무관하게 모든 승인 질문에서 고른다.
   *
   * 관리자가 직접 쓴 질문(ADMIN)과 지글 공지에서 만든 질문(AI)을 각각 무작위로 2개씩
   * 골라 관리자 질문부터 돌려준다. 요청마다 결과가 달라진다.
   * 한쪽이 모자라면 그만큼 적게 돌려주고 다른 쪽으로 채우지 않는다. 카드 자리가
   * 출처별로 나뉘어 있어서다.
   */
  async listForWidget(): Promise<SuggestedQuestionDto[]> {
    const now = new Date();
    const [admin, ai] = await Promise.all([
      this.repository.pickActive('ADMIN', SUGGESTED_QUESTIONS_PER_SOURCE, now),
      this.repository.pickActive('AI', SUGGESTED_QUESTIONS_PER_SOURCE, now),
    ]);
    return [...admin, ...ai].map((row) => ({
      id: row.id,
      question: row.question,
      prompt: row.prompt,
      source: row.source,
    }));
  }
}
