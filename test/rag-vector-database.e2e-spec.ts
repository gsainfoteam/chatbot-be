import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  documentChunks,
  documents,
  organizations,
  runMigrations,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS } from '../src/embedding/embedding.constants';
import { DocumentEmbeddingService } from '../src/embedding/document-embedding.service';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { backfillDocumentEmbeddings } from '../src/scripts/document-embedding-backfill';

const describeRagDatabase =
  process.env.RAG_TEST_DB === 'true' ? describe : describe.skip;

function syntheticVector(x: number, y: number): number[] {
  const vector = new Array<number>(DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = x;
  vector[1] = y;
  return vector;
}

describeRagDatabase('pgvector RAG database (e2e)', () => {
  const prefix = `rag-e2e-${Date.now()}`;
  const model = `${prefix}-model`;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: RetrievalRepository;
  let organizationIds: string[] = [];
  let documentIds: string[] = [];

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error('RAG database E2E requires DB_NAME ending in _test');
    }
    const params = {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database,
      sslEnabled: process.env.DB_SSL === 'true',
    };
    await runMigrations(params);
    client = postgres({
      host: params.host,
      port: params.port,
      username: params.user,
      password: params.password,
      database: params.database,
      ssl: params.sslEnabled ? { rejectUnauthorized: false } : false,
      max: 3,
    });
    db = drizzle(client, { schema });
    repository = new RetrievalRepository(db as unknown as Database);
  }, 60_000);

  afterAll(async () => {
    if (db && documentIds.length > 0) {
      await db.delete(documents).where(inArray(documents.id, documentIds));
    }
    if (db && organizationIds.length > 0) {
      await db
        .delete(organizations)
        .where(inArray(organizations.id, organizationIds));
    }
    if (client) await client.end();
  });

  it('runs the migration and installs vector with vector(1536)', async () => {
    const extension = await client`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    const column = await client`
      SELECT format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'document_chunks' AND a.attname = 'embedding'
    `;

    expect(extension).toHaveLength(1);
    expect(column[0]?.data_type).toBe('vector(1536)');
  });

  it('orders exact cosine candidates and preserves global eligibility scope', async () => {
    const createdOrganizations = await db
      .insert(organizations)
      .values([
        { name: `${prefix} A`, slug: `${prefix}-a` },
        { name: `${prefix} B`, slug: `${prefix}-b` },
      ])
      .returning();
    organizationIds = createdOrganizations.map((row) => row.id);

    const insertedDocuments = await db
      .insert(documents)
      .values([
        {
          title: 'closest owner A',
          resourceName: `${prefix}-closest-a`,
          gcsPdfPath: `gs://test/${prefix}-closest-a.pdf`,
          status: 'ready',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[0],
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          title: 'second owner B',
          resourceName: `${prefix}-second-b`,
          gcsPdfPath: `gs://test/${prefix}-second-b.pdf`,
          status: 'ready',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[1],
        },
        {
          title: 'null embedding',
          resourceName: `${prefix}-null`,
          gcsPdfPath: `gs://test/${prefix}-null.pdf`,
          status: 'ready',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[0],
        },
        {
          title: 'inactive',
          resourceName: `${prefix}-inactive`,
          gcsPdfPath: `gs://test/${prefix}-inactive.pdf`,
          status: 'ready',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[0],
          isActive: false,
        },
        {
          title: 'expired',
          resourceName: `${prefix}-expired`,
          gcsPdfPath: `gs://test/${prefix}-expired.pdf`,
          status: 'ready',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[1],
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          title: 'queued',
          resourceName: `${prefix}-queued`,
          gcsPdfPath: `gs://test/${prefix}-queued.pdf`,
          status: 'queued',
          uploadedByIdpUuid: 'rag-e2e',
          ownerOrganizationId: organizationIds[1],
        },
      ])
      .returning();
    documentIds = insertedDocuments.map((row) => row.id);
    const now = new Date();
    await db.insert(documentChunks).values(
      insertedDocuments.map((document, index) => ({
        documentId: document.id,
        path: document.resourceName,
        description: document.title,
        content: document.title,
        sortOrder: 0,
        embedding:
          index === 2
            ? null
            : index === 1
              ? syntheticVector(0.8, 0.2)
              : syntheticVector(1, 0),
        embeddingModel: model,
        embeddingContentHash: 'a'.repeat(64),
        embeddedAt: now,
      })),
    );

    const candidates = await repository.findSimilarChunks(
      syntheticVector(1, 0),
      20,
      model,
    );

    expect(candidates.map((row) => row.documentId)).toEqual([
      insertedDocuments[0].id,
      insertedDocuments[1].id,
    ]);
    expect(candidates[0].distance).toBeLessThan(candidates[1].distance);
    expect(new Set(candidates.map((row) => row.documentId))).toEqual(
      new Set([insertedDocuments[0].id, insertedDocuments[1].id]),
    );
    expect(
      candidates.some((row) => row.documentId === insertedDocuments[2].id),
    ).toBe(false);
    expect(await repository.hasIncompleteReadyEmbeddings(model)).toBe(true);

    await db
      .update(documentChunks)
      .set({ embedding: syntheticVector(0.5, 0.5) })
      .where(eq(documentChunks.documentId, insertedDocuments[2].id));
    expect(await repository.hasIncompleteReadyEmbeddings(model)).toBe(false);
  });

  it('backfills stale ready chunks idempotently', async () => {
    let requests = 0;
    const embeddingService = new DocumentEmbeddingService({
      model,
      dimensions: DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS,
      embedTexts: async (inputs: string[]) => {
        requests += 1;
        return inputs.map((_input, index) => syntheticVector(1, index / 10));
      },
    });
    const logger = { log: () => undefined };

    const first = await backfillDocumentEmbeddings(
      db as unknown as Database,
      embeddingService,
      logger,
    );
    const second = await backfillDocumentEmbeddings(
      db as unknown as Database,
      embeddingService,
      logger,
    );

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(requests).toBe(1);
  });
});
