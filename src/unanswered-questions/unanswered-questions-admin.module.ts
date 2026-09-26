import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UploadModule } from '../upload/upload.module';
import { UnansweredQuestionsController } from './unanswered-questions.controller';
import { UnansweredQuestionsModule } from './unanswered-questions.module';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@Module({
  imports: [
    AuthModule,
    OrganizationsModule,
    UploadModule,
    UnansweredQuestionsModule,
  ],
  controllers: [UnansweredQuestionsController],
  providers: [UnansweredQuestionsService],
})
export class UnansweredQuestionsAdminModule {}
