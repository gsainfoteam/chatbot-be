import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingBackfillService } from './embedding-backfill.service';

@Injectable()
export class EmbeddingBackfillWorker implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingBackfillWorker.name);
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private failures = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly backfill: EmbeddingBackfillService,
  ) {}

  /** Explicitly called after app.listen(): migrations and HTTP startup precede work. */
  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    if (
      this.config.get('EMBEDDING_BACKFILL_ENABLED', true) === false ||
      !this.backfill.isEnabled()
    ) {
      this.logger.log('Automatic embedding backfill disabled');
      return;
    }
    this.logger.log('Automatic embedding backfill started');
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.abort.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const interval = this.config.get<number>(
      'EMBEDDING_BACKFILL_INTERVAL_MS',
      300000,
    );
    try {
      await this.backfill.run(this.abort.signal);
      this.failures = 0;
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.failures += 1;
      this.logger.warn(
        `Embedding backfill failed; retrying later: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Completion-based scheduling prevents overlapping passes. Back off on
    // provider/DB outages, capped at an hour (or the configured longer interval).
    this.schedule(
      Math.min(
        interval * 2 ** Math.min(this.failures, 10),
        Math.max(interval, 3600000),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    // API cancellation plus DB statement/connection timeouts bound shutdown.
    await this.running;
  }
}
