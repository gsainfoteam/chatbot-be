import { Module } from '@nestjs/common';
import { ZiggleNoticeClient } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import { SuggestedQuestionsModule } from '../suggested-questions.module';
import { NoticeFeedService } from './notice-feed.service';
import { NoticeIngestionService } from './notice-ingestion.service';

/**
 * 지글 공지를 모아 추천 질문을 만드는 주기 작업.
 *
 * ZiggleNoticeClient는 ChatModule에도 등록돼 있지만 거기서 가져오지 않는다.
 * ChatModule은 LLM·검색·임베딩을 전부 끌고 오는데, 이 모듈에 필요한 건 MCP 호출
 * 래퍼 하나뿐이다. ConfigService만 쓰는 무상태 클래스라 따로 만들어도 문제가 없다.
 */
@Module({
  imports: [SuggestedQuestionsModule],
  providers: [ZiggleNoticeClient, NoticeFeedService, NoticeIngestionService],
  exports: [NoticeIngestionService],
})
export class SuggestedQuestionsGenerationModule {}
