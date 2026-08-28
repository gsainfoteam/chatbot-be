import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EmbeddingService } from './embedding.service';

@Module({
  imports: [HttpModule],
  providers: [EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
