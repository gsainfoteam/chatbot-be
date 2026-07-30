import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Document } from '../db';
import type { DocumentsRepository } from './documents.repository';
import type { GcsStorageService } from './gcs-storage.service';
import type { PdfPipelineService } from './pdf-pipeline.service';
import { PdfProcessorWorker } from './pdf-processor.worker';

function processingDocument(): Document {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: '테스트',
    resourceName: 'test',
    summary: null,
    gcsPdfPath: 'gs://bucket/test.pdf',
    status: 'processing',
    errorMessage: null,
    processingToken: '00000000-0000-0000-0000-000000000002',
    uploadedByIdpUuid: 'admin-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
  };
}

function createWorker(completeProcessing: boolean) {
  const repo = {
    completeProcessing: jest.fn<
      (
        id: string,
        token: string,
        summary: string,
        chunks: unknown[],
      ) => Promise<boolean>
    >(() => Promise.resolve(completeProcessing)),
    markFailed: jest.fn(() => Promise.resolve(true)),
    requeueStaleProcessing: jest.fn(() => Promise.resolve(0)),
    claimQueued: jest.fn(() => Promise.resolve([])),
  };
  const gcs = {
    downloadPdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-test'))),
    uploadDocuments: jest.fn(() => Promise.resolve()),
    deleteProcessedArtifacts: jest.fn<(resourceName: string) => Promise<void>>(
      () => Promise.resolve(),
    ),
  };
  const pipeline = {
    processPdf: jest.fn(() =>
      Promise.resolve({
        documents: { 'test.md': '# test' },
        metadata: { description: 'summary', chunks: [] },
        summary: 'summary',
        chunks: [],
      }),
    ),
  };
  const config = {
    get: jest.fn((_key: string) => undefined),
  };

  return {
    worker: new PdfProcessorWorker(
      repo as unknown as DocumentsRepository,
      gcs as unknown as GcsStorageService,
      pipeline as unknown as PdfPipelineService,
      config as unknown as ConfigService,
    ),
    repo,
    gcs,
  };
}

describe('PdfProcessorWorker attempt ownership', () => {
  it('deletes generated artifacts when a delete/reprocess cancels the attempt', async () => {
    const { worker, repo, gcs } = createWorker(false);
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.completeProcessing).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'summary',
      [],
    );
    expect(gcs.deleteProcessedArtifacts).toHaveBeenCalledWith('test');
  });

  it('keeps generated artifacts when the attempt completes successfully', async () => {
    const { worker, gcs } = createWorker(true);
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(gcs.deleteProcessedArtifacts).not.toHaveBeenCalled();
  });
});
