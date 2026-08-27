import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../db/schema';
import { DocumentEmbeddingService } from '../embedding/document-embedding.service';
import { DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS } from '../embedding/embedding.constants';
import { OpenAiCompatibleEmbeddingClient } from '../embedding/openai-compatible-embedding.client';
import { backfillDocumentEmbeddings } from './document-embedding-backfill';

async function main(): Promise<void> {
  const config = new ConfigService(process.env);
  const embeddingClient = new OpenAiCompatibleEmbeddingClient(config);
  if (embeddingClient.dimensions !== DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must match vector(${DOCUMENT_CHUNK_EMBEDDING_DIMENSIONS})`,
    );
  }

  const dbHost = config.get<string>('DB_HOST', 'localhost');
  const dbPort = config.get<string>('DB_PORT', '5432');
  const dbName = config.getOrThrow<string>('DB_NAME');
  const dbUser = config.get<string>('DB_USER', 'postgres');
  const dbCredential = config.getOrThrow<string>('DB_PASSWORD');
  const authority = `${encodeURIComponent(dbUser)}:${encodeURIComponent(dbCredential)}@${dbHost}:${dbPort}`;
  const client = postgres(
    `postgresql://${authority}/${encodeURIComponent(dbName)}`,
    {
      ssl:
        config.get<string>('DB_SSL', 'false') === 'true'
          ? { rejectUnauthorized: false }
          : false,
      max: 2,
    },
  );
  const db = drizzle(client, { schema });
  const embeddingService = new DocumentEmbeddingService(embeddingClient);

  try {
    const updated = await backfillDocumentEmbeddings(
      db as never,
      embeddingService,
    );
    console.log(`Embedding backfill complete: ${updated} row(s) updated`);
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `Embedding backfill failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
