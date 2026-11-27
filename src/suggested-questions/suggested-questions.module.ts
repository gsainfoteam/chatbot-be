import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthModule } from '../auth/auth.module';
import { SuggestedQuestionsController } from './suggested-questions.controller';
import { SuggestedQuestionsRepository } from './suggested-questions.repository';
import { SuggestedQuestionsService } from './suggested-questions.service';

/**
 * 추천 질문의 저장소와 위젯용 조회 API.
 *
 * 관리자 API와 주기 작업은 별도 모듈로 나눈다. 관리자 쪽은 조직·업로드 모듈에,
 * 주기 작업 쪽은 LLM 클라이언트에 기대기 때문에, 한 모듈에 넣으면 위젯 조회까지
 * 그 의존성을 끌고 오게 된다. UnansweredQuestionsModule이 같은 이유로 쪼개져 있다.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [SuggestedQuestionsController],
  providers: [SuggestedQuestionsService, SuggestedQuestionsRepository],
  exports: [SuggestedQuestionsRepository],
})
export class SuggestedQuestionsModule {}
