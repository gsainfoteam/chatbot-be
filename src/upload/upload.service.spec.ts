import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Document } from '../db';
import type { DocumentsRepository } from '../pdf-processor/documents.repository';
import type { GcsStorageService } from '../pdf-processor/gcs-storage.service';
import { parseExpiresAt, UploadService } from './upload.service';

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
    expiresAt: null,
    ...overrides,
  };
}

function createService() {
  const repo = {
    createUploading: jest.fn<(...args: unknown[]) => Promise<Document>>(),
    markQueuedAfterUpload: jest.fn<(id: string) => Promise<Document | null>>(),
    hardDelete: jest.fn<(id: string) => Promise<void>>(),
    cancelAndSoftDelete:
      jest.fn<(id: string, idpUuid: string) => Promise<Document | null>>(),
    findById: jest.fn<(id: string) => Promise<Document | null>>(),
    updateExpiresAt:
      jest.fn<
        (
          id: string,
          idpUuid: string,
          expiresAt: Date | null,
        ) => Promise<Document | null>
      >(),
    enqueueReprocess:
      jest.fn<
        (
          id: string,
          idpUuid: string,
          cooldownBefore: Date,
          now: Date,
        ) => Promise<Document | null>
      >(),
  };
  const gcs = {
    toGsPath: jest.fn((path: string) => `gs://bucket/${path}`),
    uploadPdf:
      jest.fn<(resourceName: string, pdfBytes: Buffer) => Promise<string>>(),
    deleteResourceArtifacts: jest.fn<(resourceName: string) => Promise<void>>(),
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

  it('maps GCS upload failures to 503 without exposing the raw error', async () => {
    const { service, repo, gcs } = createService();
    repo.createUploading.mockResolvedValue(document());
    gcs.uploadPdf.mockRejectedValue(new Error('bucket ACL denied xyz'));
    repo.hardDelete.mockResolvedValue(undefined);

    await expect(
      service.upload(Buffer.from('%PDF-test'), 'test.pdf', '테스트', 'admin-1'),
    ).rejects.toMatchObject({
      response: {
        statusCode: 503,
        message: 'Document storage is temporarily unavailable',
      },
    });
    expect(repo.hardDelete).toHaveBeenCalled();
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

    await service.delete(
      '00000000-0000-0000-0000-000000000001',
      'admin-1',
    );

    expect(calls).toEqual(['cancel', 'delete-artifacts']);
    expect(repo.cancelAndSoftDelete).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'admin-1',
    );
  });

  it('maps GCS delete failures to 503 without exposing the raw error', async () => {
    const { service, repo, gcs } = createService();
    repo.cancelAndSoftDelete.mockResolvedValue(document({ isActive: false }));
    gcs.deleteResourceArtifacts.mockRejectedValue(
      new Error('Permission denied on objects/test/'),
    );

    await expect(
      service.delete(
        '00000000-0000-0000-0000-000000000001',
        'admin-1',
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 503,
        message: 'Document storage is temporarily unavailable',
      },
    });
  });

  it('returns 404 without touching GCS when delete ownership does not match', async () => {
    const { service, repo, gcs } = createService();
    repo.cancelAndSoftDelete.mockResolvedValue(null);

    await expect(
      service.delete(
        '00000000-0000-0000-0000-000000000001',
        'other-admin',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.cancelAndSoftDelete).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'other-admin',
    );
    expect(gcs.deleteResourceArtifacts).not.toHaveBeenCalled();
  });

  it('returns 404 when reprocess ownership does not match', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(document({ uploadedByIdpUuid: 'admin-1' }));

    await expect(
      service.reprocess(
        '00000000-0000-0000-0000-000000000001',
        'other-admin',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.enqueueReprocess).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'queued', 'processing'] as const)(
    'rejects reprocess while status is %s',
    async (status) => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(document({ status }));

      await expect(
        service.reprocess(
          '00000000-0000-0000-0000-000000000001',
          'admin-1',
        ),
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
      await service.reprocess(
        '00000000-0000-0000-0000-000000000001',
        'admin-1',
      );
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

    await expect(service.reprocess(current.id, 'admin-1')).resolves.toEqual(
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

      const result = await service.reprocess(current.id, 'admin-1');

      expect(repo.enqueueReprocess).toHaveBeenCalledWith(
        current.id,
        'admin-1',
        expect.any(Date),
        expect.any(Date),
      );
      expect(result.status).toBe('queued');
      expect(result.canReprocess).toBe(false);
    },
  );

  it('passes expiresAt into createUploading and returns isExpired=false', async () => {
    const { service, repo, gcs } = createService();
    const future = new Date(Date.now() + 60_000);
    const reserved = document({ expiresAt: future });
    const queued = document({ status: 'queued', expiresAt: future });
    repo.createUploading.mockResolvedValue(reserved);
    gcs.uploadPdf.mockResolvedValue('gs://bucket/test.pdf');
    repo.markQueuedAfterUpload.mockResolvedValue(queued);

    const result = await service.upload(
      Buffer.from('%PDF-test'),
      'test.pdf',
      '테스트',
      'admin-1',
      future.toISOString(),
    );

    expect(repo.createUploading).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: expect.any(Date) }),
    );
    expect(result.expiresAt).toEqual(future);
    expect(result.isExpired).toBe(false);
  });

  it('updates expiresAt for the owner and clears with null', async () => {
    const { service, repo } = createService();
    const current = document({ status: 'ready' });
    const cleared = document({ status: 'ready', expiresAt: null });
    repo.findById.mockResolvedValue(current);
    repo.updateExpiresAt.mockResolvedValue(cleared);

    const result = await service.updateExpiresAt(current.id, 'admin-1', null);

    expect(repo.updateExpiresAt).toHaveBeenCalledWith(
      current.id,
      'admin-1',
      null,
    );
    expect(result.expiresAt).toBeNull();
    expect(result.isExpired).toBe(false);
  });

  it('marks isExpired when expiresAt is in the past', async () => {
    const { service, repo } = createService();
    const past = new Date(Date.now() - 60_000);
    repo.findById.mockResolvedValue(
      document({ status: 'ready', expiresAt: past }),
    );

    const result = await service.getById(
      '00000000-0000-0000-0000-000000000001',
      'admin-1',
    );
    expect(result.isExpired).toBe(true);
    expect(result.expiresAt).toEqual(past);
  });
});

describe('parseExpiresAt', () => {
  it('treats empty/undefined as null', () => {
    expect(parseExpiresAt(undefined)).toBeNull();
    expect(parseExpiresAt(null)).toBeNull();
    expect(parseExpiresAt('')).toBeNull();
    expect(parseExpiresAt('   ')).toBeNull();
  });

  it('rejects invalid and past values', () => {
    expect(() => parseExpiresAt('not-a-date')).toThrow(BadRequestException);
    expect(() =>
      parseExpiresAt(new Date(Date.now() - 1000).toISOString()),
    ).toThrow(BadRequestException);
  });

  it('accepts future ISO-8601', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(parseExpiresAt(future)?.toISOString()).toBe(future);
  });
});
