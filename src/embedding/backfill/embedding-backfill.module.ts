import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding.module';
import { EmbeddingBackfillService } from './embedding-backfill.service';
import { EmbeddingBackfillWorker } from './embedding-backfill.worker';

@Module({
  imports: [EmbeddingModule],
  providers: [EmbeddingBackfillService, EmbeddingBackfillWorker],
  exports: [EmbeddingBackfillWorker],
})
export class EmbeddingBackfillModule {}
