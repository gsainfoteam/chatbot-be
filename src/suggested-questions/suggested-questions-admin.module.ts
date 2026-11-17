import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SuggestedQuestionsModule } from './suggested-questions.module';
import { SuggestedQuestionsAdminController } from './suggested-questions-admin.controller';
import { SuggestedQuestionsAdminService } from './suggested-questions-admin.service';

/**
 * 추천 질문 관리자 API.
 * SUPER_ADMIN 판별 때문에 OrganizationsModule이 필요한데, 위젯 조회까지 그 의존성을
 * 지고 가지 않도록 SuggestedQuestionsModule과 분리한다.
 */
@Module({
  imports: [AuthModule, OrganizationsModule, SuggestedQuestionsModule],
  controllers: [SuggestedQuestionsAdminController],
  providers: [SuggestedQuestionsAdminService],
})
export class SuggestedQuestionsAdminModule {}
