import { Inject, Injectable } from '@nestjs/common';
import {
  inArray,
  notInArray,
  sql,
  eq,
  and,
  or,
  desc,
  asc,
  lt,
} from 'drizzle-orm';
import {
  admins,
  DB_CONNECTION,
  documents,
  documentChunks,
  organizationMemberships,
} from '../db';
import type { Database, Document, DocumentChunk } from '../db';
import type { AdminPrincipal } from '../organizations/organization.types';

export type ReplaceChunksInput = {
  path: string;
  description: string;
  content: string;
  sortOrder: number;
};

@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

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
    principal: AdminPrincipal,
    options: { limit: number; offset: number },
  ): Promise<Document[]> {
    const currentSuperAdmin =
      principal.role === 'SUPER_ADMIN'
        ? sql<boolean>`EXISTS (
            SELECT 1
            FROM ${admins}
            WHERE ${admins.idpUuid} = ${principal.uuid}
              AND ${admins.role} = 'SUPER_ADMIN'
          )`
        : sql<boolean>`false`;
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.uploadedByIdpUuid, principal.uuid),
          eq(documents.isActive, true),
          or(
            currentSuperAdmin,
            sql<boolean>`EXISTS (
              SELECT 1
              FROM ${organizationMemberships}
              WHERE ${organizationMemberships.organizationId} = ${documents.ownerOrganizationId}
                AND ${organizationMemberships.memberIdpUuid} = ${principal.uuid}
                AND ${organizationMemberships.status} = 'ACCEPTED'
            )`,
          ),
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
   * Refresh the stale-processing lease only while this exact attempt owns it.
   */
  async heartbeatProcessing(
    documentId: string,
    processingToken: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(documents)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.status, 'processing'),
          eq(documents.processingToken, processingToken),
          eq(documents.isActive, true),
        ),
      )
      .returning({ id: documents.id });
    return result.length > 0;
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

  async listChunks(documentId: string): Promise<DocumentChunk[]> {
    return this.db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId))
      .orderBy(asc(documentChunks.sortOrder));
  }
}
