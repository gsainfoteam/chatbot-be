import postgres from 'postgres';
import { buildDatabaseSslOptions } from '../../db/ssl-options';
import type { BackfillChunk, BackfillStore } from './backfill-runner';

// Distinct from the startup migration lock. Shared by CLI and all app replicas.
const LOCK_NAMESPACE = 1128352846;
const LOCK_KEY = 1701667428;

export class PostgresBackfillStore implements BackfillStore {
  constructor(
    private readonly sql: postgres.ReservedSql,
    private readonly signal: AbortSignal,
  ) {}

  async upperBound(): Promise<string | null> {
    this.signal.throwIfAborted();
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM document_chunks ORDER BY id DESC LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  async readBatch(
    after: string | null,
    through: string,
    limit: number,
    all: boolean,
  ): Promise<BackfillChunk[]> {
    this.signal.throwIfAborted();
    return this.sql<BackfillChunk[]>`
      SELECT c.id, c.path, c.description, c.content, d.title AS "documentTitle"
      FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE ${all ? this.sql`TRUE` : this.sql`c.embedding IS NULL`}
        AND c.id <= ${through}::uuid
        ${after ? this.sql`AND c.id > ${after}::uuid` : this.sql``}
      ORDER BY c.id LIMIT ${limit}
    `;
  }

  async saveBatch(
    rows: BackfillChunk[],
    vectors: number[][],
    all: boolean,
  ): Promise<number> {
    this.signal.throwIfAborted();
    // A short transaction only for writes; never hold row locks across API calls.
    await this.sql`BEGIN`;
    try {
      let saved = 0;
      for (let i = 0; i < rows.length; i += 1) {
        this.signal.throwIfAborted();
        const row = rows[i];
        const updated = await this.sql`
          UPDATE document_chunks c SET embedding = ${JSON.stringify(vectors[i])}::vector
          WHERE c.id = ${row.id}::uuid
            AND ${all ? this.sql`TRUE` : this.sql`c.embedding IS NULL`}
            AND c.path = ${row.path} AND c.description = ${row.description}
            AND c.content = ${row.content}
            AND EXISTS (SELECT 1 FROM documents d
                        WHERE d.id = c.document_id AND d.title = ${row.documentTitle})
          RETURNING c.id
        `;
        saved += updated.length;
      }
      this.signal.throwIfAborted();
      await this.sql`COMMIT`;
      return saved;
    } catch (error) {
      await this.sql`ROLLBACK`.catch(() => undefined);
      throw error;
    }
  }
}

export async function withBackfillLock<T>(
  options: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl: boolean;
  },
  signal: AbortSignal,
  operation: (store: BackfillStore, signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const disconnected = new AbortController();
  const combined = AbortSignal.any([signal, disconnected.signal]);
  const client = postgres({
    ...options,
    ssl: buildDatabaseSslOptions(options.ssl),
    max: 1,
    connect_timeout: 10,
    idle_timeout: 0,
    max_lifetime: null,
    connection: { statement_timeout: 15000 },
    // A lost session loses its advisory lock. Abort instead of continuing on a
    // reconnected session without ownership, including an in-flight API call.
    onclose: () =>
      disconnected.abort(new Error('Backfill database session closed')),
  });
  let session: postgres.ReservedSql | undefined;
  let locked = false;
  try {
    combined.throwIfAborted();
    session = await client.reserve();
    combined.throwIfAborted();
    const [row] = await session<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_KEY}) AS acquired
    `;
    locked = row.acquired;
    if (!locked) return null;
    return await operation(
      new PostgresBackfillStore(session, combined),
      combined,
    );
  } finally {
    try {
      if (locked && session && !disconnected.signal.aborted) {
        await session`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_KEY})`;
      }
    } finally {
      session?.release();
      await client.end({ timeout: 5 });
    }
  }
}
