import { Module } from '@nestjs/common';
import { DocumentEmbeddingService } from './document-embedding.service';
import { EMBEDDING_CLIENT } from './embedding-client.interface';
import { OpenAiCompatibleEmbeddingClient } from './openai-compatible-embedding.client';

@Module({
  providers: [
    {
      provide: EMBEDDING_CLIENT,
      useClass: OpenAiCompatibleEmbeddingClient,
    },
    DocumentEmbeddingService,
  ],
  exports: [EMBEDDING_CLIENT, DocumentEmbeddingService],
})
export class EmbeddingModule {}
