import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ZiggleNoticeClient } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import { llmClientProvider } from '../../chat/llm/llm-client.provider';
import { SuggestedQuestionsModule } from '../suggested-questions.module';
import { NoticeFeedService } from './notice-feed.service';
import { NoticeIngestionService } from './notice-ingestion.service';
import { QuestionGenerationService } from './question-generation.service';

/**
 * 지글 공지를 모아 추천 질문을 만드는 주기 작업.
 *
 * ZiggleNoticeClient와 LLM 클라이언트는 ChatModule에도 있지만 거기서 가져오지 않는다.
 * ChatModule은 검색·임베딩·retrieval을 전부 끌고 오는데 여기서 필요한 건 둘뿐이다.
 * 둘 다 설정으로 만들어지는 무상태 클래스라 따로 등록해도 동작이 달라지지 않는다.
 */
@Module({
  imports: [HttpModule, SuggestedQuestionsModule],
  providers: [
    llmClientProvider,
    ZiggleNoticeClient,
    NoticeFeedService,
    QuestionGenerationService,
    NoticeIngestionService,
  ],
  exports: [NoticeIngestionService],
})
export class SuggestedQuestionsGenerationModule {}
