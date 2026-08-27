import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  cosineDistance,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  SQL,
} from 'drizzle-orm';
import { DB_CONNECTION, documents, documentChunks } from '../db';
import type { Database } from '../db';
import type { VectorChunkCandidate, VectorRootChunk } from './retrieval.types';

export type ReadyDocumentWithChunks = {
  id: string;
  title: string;
  resourceName: string;
  summary: string | null;
  chunks: Array<{
    path: string;
    description: string;
    sortOrder: number;
  }>;
};

/**
 * Chat catalog/content eligibility: null expiresAt = never expires.
 */
export function notExpiredCondition(now: Date = new Date()): SQL | undefined {
  return or(isNull(documents.expiresAt), gt(documents.expiresAt, now));
}

export function isExpiredAt(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

@Injectable()
export class RetrievalRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * Ready + active + not-expired documents that have at least one chunk.
   */
  async listReadyWithChunks(): Promise<ReadyDocumentWithChunks[]> {
    const rows = await this.db
      .select({
        documentId: documents.id,
        title: documents.title,
        resourceName: documents.resourceName,
        summary: documents.summary,
        chunkId: documentChunks.id,
        chunkPath: documentChunks.path,
        chunkDescription: documentChunks.description,
        chunkSortOrder: documentChunks.sortOrder,
      })
      .from(documents)
      .innerJoin(documentChunks, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      )
      .orderBy(asc(documents.createdAt), asc(documentChunks.sortOrder));

    const byId = new Map<string, ReadyDocumentWithChunks>();
    for (const row of rows) {
      let doc = byId.get(row.documentId);
      if (!doc) {
        doc = {
          id: row.documentId,
          title: row.title,
          resourceName: row.resourceName,
          summary: row.summary,
          chunks: [],
        };
        byId.set(row.documentId, doc);
      }
      doc.chunks.push({
        path: row.chunkPath,
        description: row.chunkDescription,
        sortOrder: row.chunkSortOrder,
      });
    }

    return [...byId.values()];
  }

  async findChunkContentsByPaths(
    paths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    if (paths.length === 0) return [];

    const uniquePaths = [...new Set(paths)];
    const rows = await this.db
      .select({
        path: documentChunks.path,
        content: documentChunks.content,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          inArray(documentChunks.path, uniquePaths),
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      );

    return rows;
  }

  async hasIncompleteReadyEmbeddings(model: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
          or(
            isNull(documentChunks.embedding),
            isNull(documentChunks.embeddingModel),
            ne(documentChunks.embeddingModel, model),
            isNull(documentChunks.embeddingContentHash),
            isNull(documentChunks.embeddedAt),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findSimilarChunks(
    queryEmbedding: number[],
    limit: number,
    model: string,
  ): Promise<VectorChunkCandidate[]> {
    if (limit < 1) return [];
    const distance = cosineDistance(documentChunks.embedding, queryEmbedding);
    const rows = await this.db
      .select({
        chunkId: documentChunks.id,
        documentId: documents.id,
        title: documents.title,
        resourceName: documents.resourceName,
        summary: documents.summary,
        path: documentChunks.path,
        description: documentChunks.description,
        sortOrder: documentChunks.sortOrder,
        distance,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
          isNotNull(documentChunks.embedding),
          eq(documentChunks.embeddingModel, model),
        ),
      )
      .orderBy(distance)
      .limit(limit);

    return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  }

  async findRootChunksForDocuments(
    documentIds: string[],
  ): Promise<VectorRootChunk[]> {
    if (documentIds.length === 0) return [];
    return this.db
      .select({
        chunkId: documentChunks.id,
        documentId: documents.id,
        title: documents.title,
        resourceName: documents.resourceName,
        summary: documents.summary,
        path: documentChunks.path,
        description: documentChunks.description,
        sortOrder: documentChunks.sortOrder,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          inArray(documents.id, [...new Set(documentIds)]),
          eq(documentChunks.path, documents.resourceName),
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      );
  }
}
