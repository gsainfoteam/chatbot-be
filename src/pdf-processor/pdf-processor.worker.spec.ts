import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Document } from '../db';
import type { DocumentsRepository } from './documents.repository';
import type { GcsStorageService } from './gcs-storage.service';
import type { PdfPipelineService } from './pdf-pipeline.service';
import { PdfProcessorWorker } from './pdf-processor.worker';
import type { DocumentEmbeddingService } from '../embedding/document-embedding.service';

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
    ownerOrganizationId: '00000000-0000-0000-0000-000000000010',
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
  uploadDocumentsError?: Error;
  embeddingError?: Error;
  heartbeatOwned?: boolean;
  markFailed?: boolean;
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
    >(() => Promise.resolve(options.markFailed ?? true)),
    heartbeatProcessing: jest.fn<
      (id: string, processingToken: string) => Promise<boolean>
    >(() => Promise.resolve(options.heartbeatOwned ?? true)),
    requeueStaleProcessing: jest.fn(() => Promise.resolve(0)),
    claimQueued: jest.fn(() => Promise.resolve([])),
  };
  const gcs = {
    downloadPdf: jest.fn(() => Promise.resolve(Buffer.from('%PDF-test'))),
    uploadDocuments: options.uploadDocumentsError
      ? jest.fn(() => Promise.reject(options.uploadDocumentsError!))
      : jest.fn(() => Promise.resolve()),
    deleteProcessedArtifacts: jest.fn<(resourceName: string) => Promise<void>>(
      () => Promise.resolve(),
    ),
  };
  const pipeline = {
    processPdf: options.processPdfError
      ? jest.fn(() => Promise.reject(options.processPdfError!))
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
  const documentEmbeddingService = {
    embedChunks: options.embeddingError
      ? jest.fn(() => Promise.reject(options.embeddingError!))
      : jest.fn(async (_document: unknown, inputChunks: typeof chunks) =>
          inputChunks.map((chunk, index) => ({
            ...chunk,
            embedding: [index + 1],
            embeddingModel: 'embedding-test-model',
            embeddingContentHash: `hash-${index}`,
            embeddedAt: new Date('2026-08-24T00:00:00.000Z'),
          })),
        ),
  };

  return {
    worker: new PdfProcessorWorker(
      repo as unknown as DocumentsRepository,
      gcs as unknown as GcsStorageService,
      pipeline as unknown as PdfPipelineService,
      documentEmbeddingService as unknown as DocumentEmbeddingService,
      config as unknown as ConfigService,
    ),
    repo,
    gcs,
    pipeline,
    documentEmbeddingService,
  };
}

describe('PdfProcessorWorker attempt ownership', () => {
  it('does not delete shared artifacts when completion loses ownership', async () => {
    const { worker, repo, gcs } = createWorker({ completeProcessing: false });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.completeProcessing).toHaveBeenCalled();
    expect(gcs.deleteProcessedArtifacts).not.toHaveBeenCalled();
  });

  it('keeps generated artifacts when the attempt completes successfully', async () => {
    const { worker, gcs, repo, documentEmbeddingService } = createWorker({
      completeProcessing: true,
    });
    const callable = worker as unknown as {
      processDocument(doc: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.completeProcessing).toHaveBeenCalled();
    expect(documentEmbeddingService.embedChunks).toHaveBeenCalledWith(
      { title: '테스트', summary: 'summary' },
      expect.any(Array),
    );
    expect(repo.completeProcessing).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'summary',
      expect.arrayContaining([
        expect.objectContaining({
          embeddingModel: 'embedding-test-model',
          embeddingContentHash: 'hash-0',
        }),
      ]),
    );
    expect(gcs.deleteProcessedArtifacts).not.toHaveBeenCalled();
  });

  it('does not upload, complete, or leave ready state when embedding fails', async () => {
    const { worker, repo, gcs } = createWorker({
      completeProcessing: true,
      embeddingError: new Error('embedding endpoint unavailable'),
    });
    const callable = worker as unknown as {
      processDocument(document: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(gcs.uploadDocuments).not.toHaveBeenCalled();
    expect(repo.completeProcessing).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining('embedding endpoint unavailable'),
    );
  });

  it('heartbeats the processing token while an attempt is active', async () => {
    const { worker, repo } = createWorker({ completeProcessing: true });
    const doc = processingDocument();
    const callable = worker as unknown as {
      processDocument(document: Document): Promise<void>;
    };

    await callable.processDocument(doc);

    expect(repo.heartbeatProcessing).toHaveBeenCalledWith(
      doc.id,
      '00000000-0000-0000-0000-000000000002',
    );
  });

  it('does not upload when the heartbeat reports ownership loss', async () => {
    const { worker, repo, gcs } = createWorker({
      completeProcessing: false,
      heartbeatOwned: false,
    });
    const callable = worker as unknown as {
      processDocument(document: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.heartbeatProcessing).toHaveBeenCalled();
    expect(gcs.uploadDocuments).not.toHaveBeenCalled();
    expect(repo.completeProcessing).not.toHaveBeenCalled();
  });

  it('skips cleanup when markFailed reports ownership loss', async () => {
    const { worker, repo, gcs } = createWorker({
      completeProcessing: true,
      uploadDocumentsError: new Error('upload interrupted'),
      markFailed: false,
    });
    const callable = worker as unknown as {
      processDocument(document: Document): Promise<void>;
    };

    await callable.processDocument(processingDocument());

    expect(repo.markFailed).toHaveBeenCalled();
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
