import { Inject, Injectable } from '@nestjs/common';
import {
  inArray,
  notInArray,
  sql,
  eq,
  and,
  or,
  isNull,
  lte,
  desc,
  asc,
  lt,
} from 'drizzle-orm';
import { DB_CONNECTION, documents, documentChunks } from '../db';
import type { Database, Document, DocumentChunk } from '../db';

export type CreateDocumentInput = {
  title: string;
  resourceName: string;
  gcsPdfPath: string;
  uploadedByIdpUuid: string;
  expiresAt?: Date | null;
};

export type ReplaceChunksInput = {
  path: string;
  description: string;
  content: string;
  sortOrder: number;
};

@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * Atomically reserve an active resource name before uploading to GCS.
   * The worker only claims `queued`, so it cannot observe a partial upload.
   */
  async createUploading(input: CreateDocumentInput): Promise<Document> {
    const [row] = await this.db
      .insert(documents)
      .values({
        title: input.title,
        resourceName: input.resourceName,
        gcsPdfPath: input.gcsPdfPath,
        uploadedByIdpUuid: input.uploadedByIdpUuid,
        expiresAt: input.expiresAt ?? null,
        status: 'uploading',
        isActive: true,
      })
      .returning();
    if (!row) throw new Error('Failed to insert document');
    return row;
  }

  async updateExpiresAt(id: string, expiresAt: Date | null) {
    const [row] = await this.db
      .update(documents)
      .set({
        expiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, id), eq(documents.isActive, true)))
      .returning();
    return row ?? null;
  }

  async markQueuedAfterUpload(id: string) {
    const [row] = await this.db
      .update(documents)
      .set({
        status: 'queued',
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.status, 'uploading'),
          eq(documents.isActive, true),
        ),
      )
      .returning();
    return row ?? null;
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.delete(documents).where(eq(documents.id, id));
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row ?? null;
  }

  async findActiveByResourceName(resourceName: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.resourceName, resourceName),
          eq(documents.isActive, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listByUploader(
    idpUuid: string,
    options: { limit: number; offset: number },
  ): Promise<Document[]> {
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.uploadedByIdpUuid, idpUuid),
          eq(documents.isActive, true),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(options.limit)
      .offset(options.offset);
  }

  /**
   * Claim up to `limit` queued documents using SKIP LOCKED.
   */
  async claimQueued(limit: number): Promise<Document[]> {
    if (limit < 1) return [];

    return this.db.transaction(async (tx) => {
      const selected = await tx.execute(
        sql`SELECT id FROM documents
            WHERE status = 'queued' AND is_active = true
            ORDER BY created_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED`,
      );
      const rawRows = Array.isArray(selected)
        ? selected
        : ((selected as { rows?: { id: string }[] }).rows ?? []);
      const ids = rawRows
        .map((r) => (r as { id: string }).id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return [];

      return tx
        .update(documents)
        .set({
          status: 'processing',
          processingToken: sql`gen_random_uuid()`,
          updatedAt: new Date(),
          errorMessage: null,
        })
        .where(inArray(documents.id, ids))
        .returning();
    });
  }

  async requeueStaleProcessing(
    staleBefore: Date,
    excludedDocumentIds: string[] = [],
  ): Promise<number> {
    const conditions = [
      eq(documents.status, 'processing'),
      eq(documents.isActive, true),
      lt(documents.updatedAt, staleBefore),
    ];
    if (excludedDocumentIds.length > 0) {
      conditions.push(notInArray(documents.id, excludedDocumentIds));
    }

    const result = await this.db
      .update(documents)
      .set({
        status: 'queued',
        processingToken: null,
        updatedAt: new Date(),
        errorMessage: 'Requeued after stuck processing timeout',
      })
      .where(and(...conditions))
      .returning({ id: documents.id });
    return result.length;
  }

  /**
   * Persist chunks and mark ready only if this exact processing attempt still
   * owns the document. A delete/reprocess/stale recovery clears the token.
   */
  async completeProcessing(
    documentId: string,
    processingToken: string,
    summary: string,
    chunks: ReplaceChunksInput[],
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [completed] = await tx
        .update(documents)
        .set({
          status: 'ready',
          summary,
          errorMessage: null,
          processingToken: null,
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.status, 'processing'),
            eq(documents.processingToken, processingToken),
            eq(documents.isActive, true),
          ),
        )
        .returning({ id: documents.id });
      if (!completed) return false;

      await tx
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, documentId));
      if (chunks.length > 0) {
        await tx.insert(documentChunks).values(
          chunks.map((c) => ({
            documentId,
            path: c.path,
            description: c.description,
            content: c.content,
            sortOrder: c.sortOrder,
          })),
        );
      }
      return true;
    });
  }

  async markFailed(
    id: string,
    processingToken: string,
    errorMessage: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(documents)
      .set({
        status: 'failed',
        errorMessage: errorMessage.slice(0, 4000),
        processingToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.status, 'processing'),
          eq(documents.processingToken, processingToken),
          eq(documents.isActive, true),
        ),
      )
      .returning({ id: documents.id });
    return result.length > 0;
  }

  /**
   * Cancel the current attempt before deleting external artifacts.
   */
  async cancelAndSoftDelete(id: string) {
    const [row] = await this.db
      .update(documents)
      .set({
        isActive: false,
        processingToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, id), eq(documents.isActive, true)))
      .returning();
    return row ?? null;
  }

  async enqueueReprocess(id: string, cooldownBefore: Date, now: Date) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(documents)
        .set({
          status: 'queued',
          errorMessage: null,
          processingToken: null,
          processedAt: null,
          lastReprocessedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.isActive, true),
            inArray(documents.status, ['ready', 'failed']),
            or(
              isNull(documents.lastReprocessedAt),
              lte(documents.lastReprocessedAt, cooldownBefore),
            ),
          ),
        )
        .returning();
      if (!row) return null;

      await tx.delete(documentChunks).where(eq(documentChunks.documentId, id));
      return row;
    });
  }

  async listChunks(documentId: string): Promise<DocumentChunk[]> {
    return this.db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(asc(documentChunks.sortOrder));
  }
}
