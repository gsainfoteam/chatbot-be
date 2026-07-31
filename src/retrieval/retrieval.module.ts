import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { RetrievalRepository } from './retrieval.repository';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [DbModule],
  providers: [RetrievalRepository, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
