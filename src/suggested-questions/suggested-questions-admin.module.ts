import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SuggestedQuestionsModule } from './suggested-questions.module';
import { SuggestedQuestionsAdminController } from './suggested-questions-admin.controller';
import { SuggestedQuestionsAdminService } from './suggested-questions-admin.service';

/**
 * 추천 질문 관리자 API.
 * 컨트롤러에서 SuperAdminGuard로 막으므로 SUPER_ADMIN만 호출한다.
 * 위젯 조회 API가 이 의존성을 지고 가지 않도록 SuggestedQuestionsModule과 분리한다.
 */
@Module({
  imports: [AuthModule, SuggestedQuestionsModule],
  controllers: [SuggestedQuestionsAdminController],
  providers: [SuggestedQuestionsAdminService],
})
export class SuggestedQuestionsAdminModule {}
