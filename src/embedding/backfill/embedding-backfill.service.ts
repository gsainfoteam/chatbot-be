import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../embedding.service';
import { runBackfill } from './backfill-runner';
import { withBackfillLock } from './postgres-backfill-store';

@Injectable()
export class EmbeddingBackfillService {
  private readonly logger = new Logger(EmbeddingBackfillService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
  ) {}

  isEnabled(): boolean {
    return this.embedding.isEnabled();
  }

  async run(signal: AbortSignal, all = false) {
    if (!this.isEnabled()) throw new Error('Embedding API is not configured');
    const started = Date.now();
    const ssl = this.config.get<boolean | string>('DB_SSL');
    const batchSize = Number(
      this.config.get('EMBEDDING_BACKFILL_BATCH_SIZE', 64),
    );
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
      throw new Error(
        'EMBEDDING_BACKFILL_BATCH_SIZE must be an integer between 1 and 64',
      );
    }
    const result = await withBackfillLock(
      {
        host: this.config.getOrThrow<string>('DB_HOST'),
        port: Number(this.config.get('DB_PORT', 5432)),
        database: this.config.getOrThrow<string>('DB_NAME'),
        username: this.config.getOrThrow<string>('DB_USER'),
        password: this.config.getOrThrow<string>('DB_PASSWORD'),
        ssl: ssl === true || ssl === 'true',
      },
      signal,
      (store, lockedSignal) =>
        runBackfill(
          store,
          (texts, requestSignal) =>
            this.embedding.embedTexts(texts, requestSignal),
          {
            batchSize,
            all,
            signal: lockedSignal,
            onProgress: (progress) =>
              this.logger.log(
                `Embedding backfill progress: ${JSON.stringify(progress)}`,
              ),
            onInputFailure: (id) =>
              this.logger.warn(
                `Embedding rejected for chunk ${id}; will retry next pass`,
              ),
          },
        ),
    );
    if (result) {
      this.logger.log(
        `Embedding backfill complete (mode=${all ? 'all' : 'missing-only'}, model=${this.embedding.getModel()}, elapsedMs=${Date.now() - started}): ${JSON.stringify(result)}`,
      );
    } else {
      this.logger.debug(
        'Embedding backfill skipped: another runner holds the lock',
      );
    }
    return result;
  }
}
