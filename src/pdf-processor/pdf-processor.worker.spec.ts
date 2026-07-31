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
    lastReprocessedAt: null,
    expiresAt: null,
  };
}

function createWorker(options: {
  completeProcessing: boolean;
  chunks?: Array<{
    path: string;
    description: string;
    content: string;
    sortOrder: number;
  }>;
  processPdfError?: Error;
}) {
  const chunks = options.chunks ?? [
    {
      path: 'test',
      description: '개요',
      content: '# test',
      sortOrder: 0,
    },
    {
      path: 'test/section',
      description: '섹션',
      content: '## section',
      sortOrder: 1,
    },
  ];

  const repo = {
    completeProcessing: jest.fn<
      (
        id: string,
        token: string,
        summary: string,
        chunks: unknown[],
      ) => Promise<boolean>
    >(() => Promise.resolve(options.completeProcessing)),
    markFailed: jest.fn<
      (
        id: string,
        processingToken: string,
        errorMessage: string,
      ) => Promise<boolean>
    >(() => Promise.resolve(true)),
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
    processPdf: options.processPdfError
      ? jest.fn(() => Promise.reject(options.processPdfError))
      : jest.fn(() =>
          Promise.resolve({
            documents: {
              'test.md': '# test',
              'test/section.md': '## section',
            },
            metadata: {
              description: 'summary',
              chunks: chunks.map((c) => ({
                path: c.path,
                description: c.description,
              })),
            },
            summary: 'summary',
            chunks,
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
    pipeline,
  };
}

describe('PdfProcessorWorker attempt ownership', () => {
  it('deletes generated artifacts when a delete/reprocess cancels the attempt', async () => {
    const { worker, repo, gcs } = createWorker({ completeProcessing: false });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.completeProcessing).toHaveBeenCalled();
    expect(gcs.deleteProcessedArtifacts).toHaveBeenCalledWith('test');
  });

  it('keeps generated artifacts when the attempt completes successfully', async () => {
    const { worker, gcs, repo } = createWorker({ completeProcessing: true });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.completeProcessing).toHaveBeenCalled();
    expect(gcs.deleteProcessedArtifacts).not.toHaveBeenCalled();
  });

  it('marks failed when pipeline throws (e.g. LLM timeout)', async () => {
    const { worker, repo, gcs } = createWorker({
      completeProcessing: true,
      processPdfError: new Error('timeout of 120000ms exceeded'),
    });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.markFailed).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      expect.stringContaining('timeout'),
    );
    expect(repo.completeProcessing).not.toHaveBeenCalled();
    expect(gcs.uploadDocuments).not.toHaveBeenCalled();
  });

  it('marks failed when pipeline returns 0 chunks', async () => {
    const { worker, repo, gcs } = createWorker({
      completeProcessing: true,
      chunks: [],
    });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.markFailed).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      expect.stringContaining('0 chunks'),
    );
    expect(repo.completeProcessing).not.toHaveBeenCalled();
    expect(gcs.uploadDocuments).not.toHaveBeenCalled();
  });
});
