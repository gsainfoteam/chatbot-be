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
  or,
  SQL,
} from 'drizzle-orm';
import { DB_CONNECTION, documents, documentChunks } from '../db';
import type { Database } from '../db';

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

  /**
   * 질의 임베딩과의 코사인 거리 기준 상위 chunk 검색.
   * embedding이 없는 chunk(미백필)는 후보에서 제외됩니다.
   */
  async searchChunksByEmbedding(
    embedding: number[],
    limit: number,
  ): Promise<Array<{ path: string; resourceName: string; distance: number }>> {
    if (embedding.length === 0 || limit < 1) return [];

    const distance = cosineDistance(documentChunks.embedding, embedding);
    const rows = await this.db
      .select({
        path: documentChunks.path,
        resourceName: documents.resourceName,
        distance,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          isNotNull(documentChunks.embedding),
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      )
      .orderBy(distance)
      .limit(limit);

    return rows.map((row) => ({
      path: row.path,
      resourceName: row.resourceName,
      distance: Number(row.distance),
    }));
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
}
