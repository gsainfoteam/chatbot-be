import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { documentChunks, documents, type Database } from '../db';
import { DocumentEmbeddingService } from '../embedding/document-embedding.service';

const BACKFILL_PAGE_SIZE = 500;

export type EmbeddingBackfillLogger = Pick<Console, 'log'>;

/** Idempotently refresh missing or stale embeddings for every ready document. */
export async function backfillDocumentEmbeddings(
  db: Database,
  embeddingService: DocumentEmbeddingService,
  logger: EmbeddingBackfillLogger = console,
): Promise<number> {
  let cursor: string | undefined;
  let updated = 0;

  while (true) {
    const rows = await db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        documentTitle: documents.title,
        documentSummary: documents.summary,
        path: documentChunks.path,
        description: documentChunks.description,
        content: documentChunks.content,
        sortOrder: documentChunks.sortOrder,
        hasEmbedding: sql<boolean>`${documentChunks.embedding} IS NOT NULL`,
        embeddingModel: documentChunks.embeddingModel,
        embeddingContentHash: documentChunks.embeddingContentHash,
        embeddedAt: documentChunks.embeddedAt,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documents.status, 'ready'),
          cursor ? gt(documentChunks.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(documentChunks.id))
      .limit(BACKFILL_PAGE_SIZE);

    if (rows.length === 0) break;
    cursor = rows.at(-1)!.id;

    const stale = rows
      .map((row) => {
        const prepared = embeddingService.prepareChunks(
          {
            title: row.documentTitle,
            summary: row.documentSummary,
          },
          [row],
        )[0];
        const needsUpdate =
          !row.hasEmbedding ||
          row.embeddingModel !== embeddingService.model ||
          row.embeddingContentHash !== prepared.embeddingContentHash ||
          row.embeddedAt == null;
        return needsUpdate ? { row, prepared } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item != null);

    if (stale.length > 0) {
      const embedded = await embeddingService.embedPreparedChunks(
        stale.map((item) => item.prepared),
      );
      const batchUpdated = await db.transaction(async (tx) => {
        let affected = 0;
        for (let index = 0; index < stale.length; index += 1) {
          const current = stale[index];
          const replacement = embedded[index];
          const changed = await tx
            .update(documentChunks)
            .set({
              embedding: replacement.embedding,
              embeddingModel: replacement.embeddingModel,
              embeddingContentHash: replacement.embeddingContentHash,
              embeddedAt: replacement.embeddedAt,
            })
            .where(
              and(
                eq(documentChunks.id, current.row.id),
                eq(documentChunks.documentId, current.row.documentId),
                eq(documentChunks.path, current.row.path),
                eq(documentChunks.description, current.row.description),
                eq(documentChunks.content, current.row.content),
                eq(documentChunks.sortOrder, current.row.sortOrder),
                sql`EXISTS (
                  SELECT 1 FROM ${documents}
                  WHERE ${documents.id} = ${current.row.documentId}
                    AND ${documents.title} = ${current.row.documentTitle}
                    AND ${documents.summary} IS NOT DISTINCT FROM ${current.row.documentSummary}
                )`,
              ),
            )
            .returning({ id: documentChunks.id });
          affected += changed.length;
        }
        return affected;
      });
      updated += batchUpdated;
      logger.log(`Backfilled ${updated} document chunk embedding(s) so far`);
    }

    if (rows.length < BACKFILL_PAGE_SIZE) break;
  }

  return updated;
}
