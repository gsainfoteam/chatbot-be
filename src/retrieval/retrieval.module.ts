import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { RetrievalRepository } from './retrieval.repository';
import { RetrievalService } from './retrieval.service';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [DbModule, EmbeddingModule],
  providers: [RetrievalRepository, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
