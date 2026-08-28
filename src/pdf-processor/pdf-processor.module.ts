import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { DbModule } from '../db/db.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { DocumentsRepository } from './documents.repository';
import { GcsStorageService } from './gcs-storage.service';
import { PdfTextService } from './pdf-text.service';
import { PdfPipelineService } from './pdf-pipeline.service';
import { PdfProcessorWorker } from './pdf-processor.worker';

@Module({
  imports: [DbModule, ChatModule, EmbeddingModule],
  providers: [
    GcsStorageService,
    DocumentsRepository,
    PdfTextService,
    PdfPipelineService,
    PdfProcessorWorker,
  ],
  exports: [GcsStorageService, DocumentsRepository, PdfPipelineService],
})
export class PdfProcessorModule {}
