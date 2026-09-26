import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';

/**
 * 채팅 흐름에서 미답변 질문을 기록하는 저장소만 제공한다.
 * 관리자 API는 UploadModule → PdfProcessorModule → ChatModule 순환을 피하려고
 * UnansweredQuestionsAdminModule로 분리했다.
 */
@Module({
  imports: [DbModule],
  providers: [UnansweredQuestionsRepository],
  exports: [UnansweredQuestionsRepository],
})
export class UnansweredQuestionsModule {}
