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
    ...overrides,
  };
}

function createService() {
  const repo = {
    createUploading: jest.fn<
      (...args: unknown[]) => Promise<Document>
    >(),
    markQueuedAfterUpload: jest.fn(),
    hardDelete: jest.fn(),
    cancelAndSoftDelete: jest.fn(),
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
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        'admin-1',
      ),
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
});
