import { ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Document } from '../db';
import type { DocumentsRepository } from '../pdf-processor/documents.repository';
import type { GcsStorageService } from '../pdf-processor/gcs-storage.service';
import { UploadService } from './upload.service';

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: '테스트',
    resourceName: 'test',
    summary: null,
    gcsPdfPath: 'gs://bucket/test.pdf',
    status: 'uploading',
    errorMessage: null,
    processingToken: null,
    uploadedByIdpUuid: 'admin-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
    lastReprocessedAt: null,
    ...overrides,
  };
}

function createService() {
  const repo = {
    createUploading: jest.fn<(...args: unknown[]) => Promise<Document>>(),
    markQueuedAfterUpload: jest.fn(),
    hardDelete: jest.fn(),
    cancelAndSoftDelete: jest.fn(),
    findById: jest.fn<(id: string) => Promise<Document | null>>(),
    enqueueReprocess:
      jest.fn<
        (
          id: string,
          cooldownBefore: Date,
          now: Date,
        ) => Promise<Document | null>
      >(),
  };
  const gcs = {
    toGsPath: jest.fn((path: string) => `gs://bucket/${path}`),
    uploadPdf: jest.fn(),
    deleteResourceArtifacts: jest.fn(),
  };
  return {
    service: new UploadService(
      repo as unknown as DocumentsRepository,
      gcs as unknown as GcsStorageService,
    ),
    repo,
    gcs,
  };
}

describe('UploadService atomic transitions', () => {
  it('reserves the DB resource name before uploading to GCS', async () => {
    const { service, repo, gcs } = createService();
    const calls: string[] = [];
    const reserved = document();
    const queued = document({ status: 'queued' });

    repo.createUploading.mockImplementation(() => {
      calls.push('reserve');
      return Promise.resolve(reserved);
    });
    gcs.uploadPdf.mockImplementation(() => {
      calls.push('upload');
      return Promise.resolve('gs://bucket/test.pdf');
    });
    repo.markQueuedAfterUpload.mockImplementation(() => {
      calls.push('queue');
      return Promise.resolve(queued);
    });

    await service.upload(
      Buffer.from('%PDF-test'),
      'test.pdf',
      '테스트',
      'admin-1',
    );

    expect(calls).toEqual(['reserve', 'upload', 'queue']);
  });

  it('returns conflict without touching GCS when the name is already reserved', async () => {
    const { service, repo, gcs } = createService();
    repo.createUploading.mockRejectedValue({ code: '23505' });

    await expect(
      service.upload(Buffer.from('%PDF-test'), 'test.pdf', '테스트', 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
  });

  it('cancels the DB processing attempt before deleting GCS artifacts', async () => {
    const { service, repo, gcs } = createService();
    const calls: string[] = [];
    repo.cancelAndSoftDelete.mockImplementation(() => {
      calls.push('cancel');
      return Promise.resolve(document({ isActive: false }));
    });
    gcs.deleteResourceArtifacts.mockImplementation(() => {
      calls.push('delete-artifacts');
      return Promise.resolve();
    });

    await service.delete('00000000-0000-0000-0000-000000000001');

    expect(calls).toEqual(['cancel', 'delete-artifacts']);
  });

  it.each(['uploading', 'queued', 'processing'] as const)(
    'rejects reprocess while status is %s',
    async (status) => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(document({ status }));

      await expect(
        service.reprocess('00000000-0000-0000-0000-000000000001'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.enqueueReprocess).not.toHaveBeenCalled();
    },
  );

  it('rejects reprocess during the 24-hour cooldown', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(
      document({
        status: 'ready',
        lastReprocessedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
      }),
    );

    try {
      await service.reprocess('00000000-0000-0000-0000-000000000001');
      throw new Error('Expected reprocess to be rejected');
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining({
          status: 429,
          response: expect.objectContaining({
            retryAt: expect.any(String),
          }),
        }),
      );
    }
    expect(repo.enqueueReprocess).not.toHaveBeenCalled();
  });

  it('allows reprocess after the 24-hour cooldown', async () => {
    const { service, repo } = createService();
    const current = document({
      status: 'ready',
      lastReprocessedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    repo.findById.mockResolvedValue(current);
    repo.enqueueReprocess.mockResolvedValue(
      document({ status: 'queued', lastReprocessedAt: new Date() }),
    );

    await expect(service.reprocess(current.id)).resolves.toEqual(
      expect.objectContaining({ status: 'queued', canReprocess: false }),
    );
  });

  it.each(['ready', 'failed'] as const)(
    'atomically requeues a %s document',
    async (status) => {
      const { service, repo } = createService();
      const current = document({ status });
      const queued = document({
        status: 'queued',
        lastReprocessedAt: new Date(),
      });
      repo.findById.mockResolvedValue(current);
      repo.enqueueReprocess.mockResolvedValue(queued);

      const result = await service.reprocess(current.id);

      expect(repo.enqueueReprocess).toHaveBeenCalledWith(
        current.id,
        expect.any(Date),
        expect.any(Date),
      );
      expect(result.status).toBe('queued');
      expect(result.canReprocess).toBe(false);
    },
  );
});
