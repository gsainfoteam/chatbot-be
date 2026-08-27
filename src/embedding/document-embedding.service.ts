import { Inject, Injectable } from '@nestjs/common';
import {
  EMBEDDING_CLIENT,
  type EmbeddingClient,
} from './embedding-client.interface';
import {
  buildCanonicalEmbeddingText,
  hashEmbeddingContent,
} from './embedding-text';

export type EmbeddableDocumentChunk = {
  path: string;
  description: string;
  content: string;
  sortOrder: number;
};

export type EmbeddedDocumentChunk = EmbeddableDocumentChunk & {
  embedding: number[];
  embeddingModel: string;
  embeddingContentHash: string;
  embeddedAt: Date;
};

export type PreparedDocumentChunk = EmbeddableDocumentChunk & {
  canonicalText: string;
  embeddingContentHash: string;
};

@Injectable()
export class DocumentEmbeddingService {
  constructor(
    @Inject(EMBEDDING_CLIENT)
    private readonly embeddingClient: EmbeddingClient,
  ) {}

  get model(): string {
    return this.embeddingClient.model;
  }

  prepareChunks(
    document: { title: string; summary: string | null | undefined },
    chunks: EmbeddableDocumentChunk[],
  ): PreparedDocumentChunk[] {
    return chunks.map((chunk) => {
      const canonicalText = buildCanonicalEmbeddingText({
        documentTitle: document.title,
        documentSummary: document.summary,
        path: chunk.path,
        description: chunk.description,
        content: chunk.content,
      });
      return {
        ...chunk,
        canonicalText,
        embeddingContentHash: hashEmbeddingContent(canonicalText),
      };
    });
  }

  async embedChunks(
    document: { title: string; summary: string | null | undefined },
    chunks: EmbeddableDocumentChunk[],
  ): Promise<EmbeddedDocumentChunk[]> {
    if (chunks.length === 0) return [];
    const prepared = this.prepareChunks(document, chunks);
    return this.embedPreparedChunks(prepared);
  }

  async embedPreparedChunks(
    prepared: PreparedDocumentChunk[],
  ): Promise<EmbeddedDocumentChunk[]> {
    if (prepared.length === 0) return [];
    const embeddings = await this.embeddingClient.embedTexts(
      prepared.map((chunk) => chunk.canonicalText),
    );
    if (embeddings.length !== prepared.length) {
      throw new Error('Embedding client did not preserve chunk count');
    }
    const embeddedAt = new Date();
    return prepared.map(
      ({ canonicalText: _canonicalText, ...chunk }, index) => ({
        ...chunk,
        embedding: embeddings[index],
        embeddingModel: this.embeddingClient.model,
        embeddedAt,
      }),
    );
  }
}
