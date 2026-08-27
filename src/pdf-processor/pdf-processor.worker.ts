import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsRepository } from './documents.repository';
import { GcsStorageService } from './gcs-storage.service';
import { parseFiniteNumber } from './parse-finite-number';
import { PdfPipelineService } from './pdf-pipeline.service';
import type { Document } from '../db';
import { DocumentEmbeddingService } from '../embedding/document-embedding.service';

@Injectable()
export class PdfProcessorWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PdfProcessorWorker.name);
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly staleProcessingMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleCheckIntervalMs = 60_000;
  private activeCount = 0;
  private readonly activeDocumentIds = new Set<string>();
  private lastStaleCheckAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickInFlight = false;

  constructor(
    private readonly documentsRepo: DocumentsRepository,
    private readonly gcs: GcsStorageService,
    private readonly pipeline: PdfPipelineService,
    private readonly documentEmbeddingService: DocumentEmbeddingService,
    private readonly configService: ConfigService,
  ) {
    this.concurrency = parseFiniteNumber(
      this.configService.get<string>('PDF_PROCESSOR_CONCURRENCY'),
      1,
      { min: 1 },
    );
    this.pollIntervalMs = parseFiniteNumber(
      this.configService.get<string>('PDF_PROCESSOR_POLL_INTERVAL_MS'),
      2000,
      { min: 500 },
    );
    // Default: requeue if stuck in processing > 30 minutes
    this.staleProcessingMs = parseFiniteNumber(
      this.configService.get<string>('PDF_PROCESSOR_STALE_PROCESSING_MS'),
      30 * 60 * 1000,
      { min: 60_000 },
    );
    this.heartbeatIntervalMs = Math.max(
      10_000,
      Math.min(60_000, Math.floor(this.staleProcessingMs / 3)),
    );
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `PDF processor worker started (concurrency=${this.concurrency}, poll=${this.pollIntervalMs}ms)`,
    );
    await this.requeueStale();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Avoid keeping the process alive solely because of the timer in tests
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    void this.tick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async requeueStale(): Promise<void> {
    try {
      const staleBefore = new Date(Date.now() - this.staleProcessingMs);
      const count = await this.documentsRepo.requeueStaleProcessing(
        staleBefore,
        [...this.activeDocumentIds],
      );
      this.lastStaleCheckAt = Date.now();
      if (count > 0) {
        this.logger.warn(`Requeued ${count} stale processing document(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to requeue stale jobs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      if (Date.now() - this.lastStaleCheckAt >= this.staleCheckIntervalMs) {
        await this.requeueStale();
      }

      const slots = this.concurrency - this.activeCount;
      if (slots <= 0) return;

      const claimed = await this.documentsRepo.claimQueued(slots);
      for (const doc of claimed) {
        this.activeCount += 1;
        this.activeDocumentIds.add(doc.id);
        void this.processDocument(doc).finally(() => {
          this.activeCount -= 1;
          this.activeDocumentIds.delete(doc.id);
        });
      }
    } catch (error) {
      this.logger.error(
        `Worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.tickInFlight = false;
    }
  }

  private async processDocument(doc: Document): Promise<void> {
    const resourceName = doc.resourceName;
    const processingToken = doc.processingToken;
    this.logger.log(`Processing document id=${doc.id} name=${resourceName}`);

    if (!processingToken) {
      this.logger.error(
        `Claimed document has no processing token: id=${doc.id}`,
      );
      return;
    }

    const heartbeat = this.startHeartbeat(doc.id, processingToken);
    let generatedArtifactsMayExist = false;
    try {
      const pdfBytes = await this.gcs.downloadPdf(resourceName);
      const result = await this.pipeline.processPdf(
        pdfBytes,
        `${resourceName}.pdf`,
      );

      if (!result.chunks.length) {
        throw new Error(
          `PDF pipeline produced 0 chunks for resource=${resourceName}`,
        );
      }

      const embeddedChunks = await this.documentEmbeddingService.embedChunks(
        { title: doc.title, summary: result.summary },
        result.chunks,
      );

      if (heartbeat.hasLostOwnership()) {
        this.logger.warn(
          `Discarding processing result after ownership loss: id=${doc.id} token=${processingToken}`,
        );
        return;
      }

      generatedArtifactsMayExist = true;
      await this.gcs.uploadDocuments(result.documents);
      const completed = await this.documentsRepo.completeProcessing(
        doc.id,
        processingToken,
        result.summary,
        embeddedChunks,
      );
      if (!completed) {
        this.logger.warn(
          `Discarding cancelled processing result: id=${doc.id} token=${processingToken}`,
        );
        // Paths are shared by attempts. A newer owner may already have
        // uploaded its artifacts, so an attempt that lost ownership must not
        // delete them.
        return;
      }

      this.logger.log(
        `Processing complete: ${resourceName} (${Object.keys(result.documents).length} files, ${result.chunks.length} chunks)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Processing failed id=${doc.id} name=${resourceName}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      let markedFailed = false;
      try {
        markedFailed = await this.documentsRepo.markFailed(
          doc.id,
          processingToken,
          message,
        );
      } catch (markError) {
        this.logger.error(
          `Failed to persist processing error id=${doc.id}: ${markError instanceof Error ? markError.message : String(markError)}`,
        );
      }
      if (generatedArtifactsMayExist && markedFailed) {
        await this.cleanupGeneratedArtifacts(resourceName);
      } else if (generatedArtifactsMayExist) {
        this.logger.warn(
          `Skipping artifact cleanup after ownership loss: id=${doc.id} token=${processingToken}`,
        );
      }
    } finally {
      heartbeat.stop();
    }
  }

  private startHeartbeat(
    documentId: string,
    processingToken: string,
  ): {
    stop: () => void;
    hasLostOwnership: () => boolean;
  } {
    let stopped = false;
    let ownershipLost = false;
    let inFlight = false;

    const beat = async (): Promise<void> => {
      if (stopped || ownershipLost || inFlight) return;
      inFlight = true;
      try {
        const owned = await this.documentsRepo.heartbeatProcessing(
          documentId,
          processingToken,
        );
        if (stopped) return;
        if (!owned) {
          ownershipLost = true;
          this.logger.warn(
            `Processing heartbeat lost ownership: id=${documentId} token=${processingToken}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Processing heartbeat failed id=${documentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => void beat(), this.heartbeatIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    void beat();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
      hasLostOwnership: () => ownershipLost,
    };
  }

  private async cleanupGeneratedArtifacts(resourceName: string): Promise<void> {
    try {
      await this.gcs.deleteProcessedArtifacts(resourceName);
    } catch (error) {
      this.logger.error(
        `Failed to clean cancelled artifacts for ${resourceName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
