/**
 * Manual entry point for the same locked, paginated backfill used by the app.
 * Run after migrations. --all explicitly re-embeds existing vectors too.
 */
import 'reflect-metadata';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../embedding/embedding.service';
import { EmbeddingBackfillService } from '../embedding/backfill/embedding-backfill.service';

async function main(): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const config = new ConfigService(process.env);
    const embedding = new EmbeddingService(new HttpService(), config);
    const result = await new EmbeddingBackfillService(config, embedding).run(
      abort.signal,
      process.argv.includes('--all'),
    );
    if (!result) {
      throw new Error(
        'Another embedding backfill is running; try again after it completes',
      );
    }
    if (result.failed) {
      throw new Error(
        `${result.failed} chunk(s) rejected by the embedding API; saved chunks are retained`,
      );
    }
    console.log('Backfill complete');
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

main().catch((error: unknown) => {
  console.error(
    'Backfill failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
