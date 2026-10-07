import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { EmbeddingBackfillModule } from '../src/embedding/backfill/embedding-backfill.module';
import { EmbeddingBackfillService } from '../src/embedding/backfill/embedding-backfill.service';
import { EmbeddingBackfillWorker } from '../src/embedding/backfill/embedding-backfill.worker';
import { runBackfill } from '../src/embedding/backfill/backfill-runner';
import { withBackfillLock } from '../src/embedding/backfill/postgres-backfill-store';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../src/db/schema';

const describeDatabase =
  process.env.EMBEDDING_BACKFILL_TEST_DB === 'true' ? describe : describe.skip;
const vector = () =>
  Array.from({ length: CHUNK_EMBEDDING_DIMENSIONS }, (_, i) =>
    i === 0 ? 1 : 0,
  );
const ids = [1, 2, 3, 4].map(
  (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
);
const describeOptions = () => ({
  batchSize: 2,
  signal: new AbortController().signal,
});

/** Requires a dedicated empty DB ending in _test; never runs against the app DB. */
describeDatabase('Embedding backfill PostgreSQL integration', () => {
  let sql: postgres.Sql;
  let documentId: string;
  let organizationId: string;
  const database = process.env.DB_NAME ?? '';
  const connection = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database,
    ssl: false,
  };
  const signal = () => new AbortController().signal;
  const embed = jest.fn(async (texts: string[]) => texts.map(vector));

  beforeAll(async () => {
    if (!database.endsWith('_test'))
      throw new Error('Backfill integration requires DB_NAME ending in _test');
    sql = postgres({ ...connection, max: 5 });
    const existing =
      await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    if (existing.length)
      throw new Error(
        'Backfill migration test requires an empty dedicated test database',
      );
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
    const indexes =
      await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'document_chunks_missing_embedding_idx'`;
    expect(indexes[0].indexdef).toContain('WHERE (embedding IS NULL)');
    const [organization] =
      await sql`INSERT INTO organizations (name, slug) VALUES ('backfill-test', 'backfill-test') RETURNING id`;
    organizationId = organization.id as string;
    const [document] = await sql`
      INSERT INTO documents (title, resource_name, summary, gcs_pdf_path, uploaded_by_idp_uuid, owner_organization_id)
      VALUES ('test document', 'backfill-test', '', 'test.pdf', 'test-uploader', ${organizationId}) RETURNING id
    `;
    documentId = document.id as string;
  });

  beforeEach(async () => {
    embed.mockClear();
    await sql`DELETE FROM document_chunks WHERE document_id = ${documentId}`;
    for (const [i, id] of ids.entries()) {
      await sql`INSERT INTO document_chunks (id, document_id, path, description, content, sort_order)
        VALUES (${id}, ${documentId}, ${`path-${i}`}, '', ${`content-${i}`}, ${i})`;
    }
  });

  afterAll(async () => {
    if (sql) {
      if (documentId) await sql`DELETE FROM documents WHERE id = ${documentId}`;
      if (organizationId)
        await sql`DELETE FROM organizations WHERE id = ${organizationId}`;
      await sql.end();
    }
  });

  it('migrates an empty DB, pages missing chunks, and makes reruns a no-op', async () => {
    const first = await withBackfillLock(connection, signal(), (store, s) =>
      runBackfill(store, embed, { ...describeOptions(), signal: s }),
    );
    expect(first).toEqual({ selected: 4, saved: 4, failed: 0 });
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([2, 2]);
    embed.mockClear();
    await withBackfillLock(connection, signal(), (store, s) =>
      runBackfill(store, embed, { ...describeOptions(), signal: s }),
    );
    expect(embed).not.toHaveBeenCalled();
    await withBackfillLock(connection, signal(), (store, s) =>
      runBackfill(store, embed, { ...describeOptions(), signal: s, all: true }),
    );
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('allows only one runner and releases ownership after an exception', async () => {
    await expect(
      withBackfillLock(connection, signal(), async () => {
        const competing = jest.fn();
        expect(
          await withBackfillLock(connection, signal(), competing),
        ).toBeNull();
        expect(competing).not.toHaveBeenCalled();
        throw new Error('simulated outage');
      }),
    ).rejects.toThrow('simulated outage');
    expect(
      await withBackfillLock(connection, signal(), async () => 'recovered'),
    ).toBe('recovered');
  });

  it('does not overwrite concurrent embeddings or changed input, and tolerates deletion', async () => {
    await withBackfillLock(connection, signal(), async (store) => {
      const batch = await store.readBatch(null, ids[3], 4, false);
      const otherVector = vector();
      otherVector[1] = 0.5;
      await sql`UPDATE document_chunks SET embedding = ${JSON.stringify(otherVector)}::vector WHERE id = ${ids[0]}`;
      await sql`UPDATE document_chunks SET content = 'changed during request' WHERE id = ${ids[1]}`;
      await sql`DELETE FROM document_chunks WHERE id = ${ids[2]}`;
      expect(await store.saveBatch(batch, batch.map(vector), false)).toBe(1);
      const [existing] =
        await sql`SELECT embedding::text AS embedding FROM document_chunks WHERE id = ${ids[0]}`;
      expect(JSON.parse(existing.embedding as string)[1]).toBe(0.5);
    });
  });

  it('skips stale results when the document title changes', async () => {
    await withBackfillLock(connection, signal(), async (store) => {
      const batch = await store.readBatch(null, ids[3], 4, false);
      await sql`UPDATE documents SET title = 'changed title' WHERE id = ${documentId}`;
      expect(await store.saveBatch(batch, batch.map(vector), false)).toBe(0);
    });
    await sql`UPDATE documents SET title = 'test document' WHERE id = ${documentId}`;
  });

  it('rolls back all writes in a batch when one vector is invalid', async () => {
    await withBackfillLock(connection, signal(), async (store) => {
      const batch = await store.readBatch(null, ids[3], 2, false);
      await expect(
        store.saveBatch(batch, [vector(), [1]], false),
      ).rejects.toThrow();
      const [row] =
        await sql`SELECT count(*)::int AS count FROM document_chunks WHERE embedding IS NOT NULL`;
      expect(row.count).toBe(0);
    });
  });

  it('aborts an in-flight operation when its reserved session loses the lock', async () => {
    await withBackfillLock(
      connection,
      signal(),
      async (_store, lockedSignal) => {
        const sessions =
          await sql`SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
        WHERE a.datname = ${database} AND l.locktype = 'advisory' AND l.granted`;
        expect(sessions).toHaveLength(1);
        const aborted = new Promise<void>((resolve) =>
          lockedSignal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        await sql`SELECT pg_terminate_backend(${sessions[0].pid})`;
        await aborted;
        expect(lockedSignal.aborted).toBe(true);
        await expect(_store.upperBound()).rejects.toThrow('session closed');
      },
    );
  });

  it('runs the production CLI using the same lock and batch processor', async () => {
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (part: string) => {
        body += part;
      });
      request.on('end', () => {
        const payload = JSON.parse(body) as { input: string[] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            data: payload.input.map((_, index) => ({
              index,
              embedding: vector(),
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address() as { port: number };
      const execute = () =>
        promisify(execFile)('bun', ['dist/backfill-chunk-embeddings.js'], {
          timeout: 15000,
          env: {
            ...process.env,
            DB_HOST: connection.host,
            DB_PORT: String(connection.port),
            DB_NAME: database,
            DB_USER: connection.username,
            DB_PASSWORD: connection.password,
            DB_SSL: 'false',
            LETSUR_AI_GATEWAY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            LETSUR_AI_GATEWAY_API_KEY: 'test-only',
            EMBEDDING_BACKFILL_BATCH_SIZE: '2',
          },
        });
      const result = await execute();
      expect(result.stdout).toContain('Backfill complete');
      const [row] =
        await sql`SELECT count(*)::int AS count FROM document_chunks WHERE embedding IS NOT NULL`;
      expect(row.count).toBe(4);
      await withBackfillLock(connection, signal(), async () => {
        await expect(execute()).rejects.toMatchObject({ code: 1 });
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps HTTP responsive while the explicitly started worker is blocked', async () => {
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = jest.fn(async () => {
      await blocked;
      return { selected: 0, saved: 0, failed: 0 };
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EmbeddingBackfillModule,
      ],
    })
      .overrideProvider(EmbeddingBackfillService)
      .useValue({ isEnabled: () => true, run })
      .compile();
    const app = module.createNestApplication(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    expect(run).not.toHaveBeenCalled();
    app.get(EmbeddingBackfillWorker).start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledTimes(1);
    const response = await fetch(`${await app.getUrl()}/missing-route`);
    expect(response.status).toBe(404);
    finish();
    await app.close();
  });
});
