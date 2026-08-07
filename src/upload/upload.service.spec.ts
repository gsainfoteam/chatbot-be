import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Document } from '../db';
import type { OrganizationAccessService } from '../organizations/organization-access.service';
import {
  RepositoryAuthorizationError,
  type OrganizationsRepository,
} from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import type { DocumentsRepository } from '../pdf-processor/documents.repository';
import type { GcsStorageService } from '../pdf-processor/gcs-storage.service';
import { parseExpiresAt, UploadService } from './upload.service';

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000010';

function principal(overrides: Partial<AdminPrincipal> = {}): AdminPrincipal {
  return {
    uuid: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    ...overrides,
  };
}

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
    ownerOrganizationId: ORGANIZATION_ID,
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
    hardDelete: jest.fn<DocumentsRepository['hardDelete']>(),
    listByUploader: jest.fn<DocumentsRepository['listByUploader']>(async () => [
      document(),
    ]),
  };
  const gcs = {
    toGsPath: jest.fn((path: string) => `gs://bucket/${path}`),
    uploadPdf: jest.fn<GcsStorageService['uploadPdf']>(),
    deleteResourceArtifacts:
      jest.fn<GcsStorageService['deleteResourceArtifacts']>(),
  };
  const organizationsRepo = {
    findDocument: jest.fn(async () => document()),
    findOrganization: jest.fn(async (id: string) => ({
      id,
      name: '조직',
      slug: 'organization',
      isDefault: false,
      createdByIdpUuid: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    hydrateDocuments: jest.fn<OrganizationsRepository['hydrateDocuments']>(
      async (rows: Document[]) =>
        rows.map((row) => ({
          document: row,
          ownerOrganization: {
            id: row.ownerOrganizationId,
            name: '인포팀',
            slug: 'infoteam',
          },
          uploader: {
            idpUuid: row.uploadedByIdpUuid,
            email: 'admin@example.com',
            name: 'Admin',
          },
          sharedOrganizations: [],
        })),
    ),
    findAcceptedMemberships: jest.fn(
      async (_organizationIds: string[], _memberIdpUuid: string) => [
        {
          organizationId: ORGANIZATION_ID,
          role: 'MANAGER' as 'MANAGER' | 'MEMBER',
        },
      ],
    ),
    isCurrentSuperAdmin: jest.fn(async (actor: AdminPrincipal) =>
      Promise.resolve(actor.role === 'SUPER_ADMIN'),
    ),
    listAccessibleDocuments: jest.fn<
      OrganizationsRepository['listAccessibleDocuments']
    >(async () => ({ rows: [document()], filteredTotal: 1 })),
    summarizeAccessibleDocuments: jest.fn<
      OrganizationsRepository['summarizeAccessibleDocuments']
    >(async () => ({
      totalDocuments: 1,
      organizationCounts: { [ORGANIZATION_ID]: 1 },
    })),
    listOrganizationDocuments: jest.fn(async () => [document()]),
    createUploadingDocument: jest.fn<
      OrganizationsRepository['createUploadingDocument']
    >(async () => document()),
    finalizeUploadingDocument: jest.fn<
      OrganizationsRepository['finalizeUploadingDocument']
    >(async () => ({ kind: 'ok', document: document({ status: 'queued' }) })),
    cancelAndSoftDeleteDocument: jest.fn<
      OrganizationsRepository['cancelAndSoftDeleteDocument']
    >(async () => ({ kind: 'ok', document: document({ isActive: false }) })),
    updateDocumentExpiresAt: jest.fn<
      OrganizationsRepository['updateDocumentExpiresAt']
    >(async () => ({ kind: 'ok', document: document() })),
    enqueueDocumentReprocess: jest.fn<
      OrganizationsRepository['enqueueDocumentReprocess']
    >(async () => ({ kind: 'ok', document: document({ status: 'queued' }) })),
    setShare: jest.fn<OrganizationsRepository['setShare']>(async () => ({
      kind: 'ok',
      document: document(),
    })),
    removeShare: jest.fn<OrganizationsRepository['removeShare']>(async () => ({
      kind: 'ok',
      document: document(),
    })),
    transferDocument: jest.fn<OrganizationsRepository['transferDocument']>(
      async () => ({ kind: 'ok', document: document() }),
    ),
  };
  const accessDecision = (row = document()) => ({
    document: row,
    relation: 'OWNER' as const,
    ownerRole: 'MANAGER' as const,
    canView: true,
    canManage: true,
    canShare: true,
    canTransfer: true,
  });
  const access = {
    isSuperAdmin: jest.fn(
      (actor: AdminPrincipal) => actor.role === 'SUPER_ADMIN',
    ),
    resolveUploadOrganization: jest.fn<
      OrganizationAccessService['resolveUploadOrganization']
    >(async () => ({
      id: ORGANIZATION_ID,
      name: '인포팀',
      slug: 'infoteam',
      isDefault: true,
      createdByIdpUuid: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    requireDocumentView: jest.fn(async () => accessDecision()),
    requireDocumentManage: jest.fn(async () => accessDecision()),
    requireDocumentShare: jest.fn(async () => accessDecision()),
    requireOrganizationMember: jest.fn(async () => null),
    requireOrganizationManager: jest.fn(async () => null),
  };
  return {
    service: new UploadService(
      repo as unknown as DocumentsRepository,
      gcs as unknown as GcsStorageService,
      organizationsRepo as unknown as OrganizationsRepository,
      access as unknown as OrganizationAccessService,
    ),
    repo,
    gcs,
    organizationsRepo,
    access,
  };
}

describe('UploadService organization-aware transitions', () => {
  it('validates organization access before reserving or uploading', async () => {
    const { service, organizationsRepo, gcs, access } = createService();
    access.resolveUploadOrganization.mockRejectedValue(
      new ForbiddenException('membership required'),
    );

    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
        ORGANIZATION_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsRepo.createUploadingDocument).not.toHaveBeenCalled();
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
  });

  it('stops before GCS when membership is revoked before reservation', async () => {
    const { service, organizationsRepo, gcs } = createService();
    organizationsRepo.createUploadingDocument.mockRejectedValue(
      new RepositoryAuthorizationError(),
    );

    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
        ORGANIZATION_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
  });

  it('uses the default resolver only when organizationId is omitted', async () => {
    const { service, organizationsRepo, gcs, access } = createService();
    gcs.uploadPdf.mockResolvedValue('gs://bucket/test.pdf');

    await service.upload(
      Buffer.from('%PDF-test'),
      'test.pdf',
      '테스트',
      principal(),
    );

    expect(access.resolveUploadOrganization).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ uuid: 'admin-1' }),
    );
    expect(organizationsRepo.createUploadingDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerOrganizationId: ORGANIZATION_ID,
        actor: principal(),
      }),
    );
  });

  it('reauthorizes a direct read after hydration before returning data', async () => {
    const { service, access, organizationsRepo } = createService();
    access.requireDocumentView
      .mockResolvedValueOnce({
        document: document(),
        relation: 'OWNER',
        ownerRole: 'MANAGER',
        canView: true,
        canManage: true,
        canShare: true,
        canTransfer: true,
      })
      .mockRejectedValueOnce(new NotFoundException('Document not found'));

    await expect(
      service.getById(document().id, principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(organizationsRepo.hydrateDocuments).toHaveBeenCalled();
    expect(access.requireDocumentView).toHaveBeenCalledTimes(2);
  });

  it('does not fall back after an invalid supplied organizationId', async () => {
    const { service, organizationsRepo, access } = createService();
    access.resolveUploadOrganization.mockRejectedValue(
      new BadRequestException('invalid organization'),
    );
    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
        'invalid-id',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(organizationsRepo.createUploadingDocument).not.toHaveBeenCalled();
  });

  it('reserves before GCS upload and queues afterward', async () => {
    const { service, organizationsRepo, gcs } = createService();
    const calls: string[] = [];
    organizationsRepo.createUploadingDocument.mockImplementation(async () => {
      calls.push('reserve');
      return document();
    });
    gcs.uploadPdf.mockImplementation(async () => {
      calls.push('upload');
      return 'gs://bucket/test.pdf';
    });
    organizationsRepo.finalizeUploadingDocument.mockImplementation(async () => {
      calls.push('queue');
      return { kind: 'ok', document: document({ status: 'queued' }) };
    });

    await service.upload(
      Buffer.from('%PDF-test'),
      'test.pdf',
      '테스트',
      principal(),
    );
    expect(calls).toEqual(['reserve', 'upload', 'queue']);
  });

  it('returns conflict without GCS when resource name is reserved', async () => {
    const { service, organizationsRepo, gcs } = createService();
    organizationsRepo.createUploadingDocument.mockRejectedValue({
      code: '23505',
    });
    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
  });

  it('rolls back DB reservation and maps GCS upload failure to 503', async () => {
    const { service, repo, gcs } = createService();
    gcs.uploadPdf.mockRejectedValue(new Error('secret storage error'));
    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(gcs.deleteResourceArtifacts).toHaveBeenCalledWith('test');
    expect(repo.hardDelete).toHaveBeenCalled();
  });

  it('reauthorizes after GCS upload before publishing the document', async () => {
    const { service, repo, organizationsRepo, gcs } = createService();
    gcs.uploadPdf.mockResolvedValue('gs://bucket/test.pdf');
    organizationsRepo.finalizeUploadingDocument.mockResolvedValue({
      kind: 'forbidden',
    });

    await expect(
      service.upload(
        Buffer.from('%PDF-test'),
        'test.pdf',
        '테스트',
        principal(),
        ORGANIZATION_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsRepo.finalizeUploadingDocument).toHaveBeenCalledWith({
      documentId: document().id,
      expectedOwnerOrganizationId: ORGANIZATION_ID,
      actor: principal(),
    });
    expect(gcs.deleteResourceArtifacts).toHaveBeenCalledWith('test');
    expect(repo.hardDelete).toHaveBeenCalledWith(document().id);
  });

  it('uses expected owner organization in the soft-delete predicate', async () => {
    const { service, organizationsRepo, gcs } = createService();
    gcs.deleteResourceArtifacts.mockResolvedValue(undefined);
    await service.delete(document().id, principal());
    expect(organizationsRepo.cancelAndSoftDeleteDocument).toHaveBeenCalledWith({
      documentId: document().id,
      expectedOwnerOrganizationId: ORGANIZATION_ID,
      actor: principal(),
    });
  });

  it.each(['uploading', 'queued', 'processing'] as const)(
    'rejects reprocess while status is %s',
    async (status) => {
      const { service, organizationsRepo, access } = createService();
      access.requireDocumentManage.mockResolvedValue({
        document: document({ status }),
        relation: 'OWNER',
        ownerRole: 'MANAGER',
        canView: true,
        canManage: true,
        canShare: true,
        canTransfer: true,
      });
      await expect(
        service.reprocess(document().id, principal()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(organizationsRepo.enqueueDocumentReprocess).not.toHaveBeenCalled();
    },
  );

  it('preserves the reprocess cooldown and owner-state predicate', async () => {
    const { service, organizationsRepo, access } = createService();
    const current = document({
      status: 'ready',
      lastReprocessedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    access.requireDocumentManage.mockResolvedValue({
      document: current,
      relation: 'OWNER',
      ownerRole: 'MANAGER',
      canView: true,
      canManage: true,
      canShare: true,
      canTransfer: true,
    });
    organizationsRepo.enqueueDocumentReprocess.mockResolvedValue({
      kind: 'ok',
      document: document({ status: 'queued', lastReprocessedAt: new Date() }),
    });
    await service.reprocess(current.id, principal());
    expect(organizationsRepo.enqueueDocumentReprocess).toHaveBeenCalledWith({
      documentId: current.id,
      expectedOwnerOrganizationId: ORGANIZATION_ID,
      cooldownBefore: expect.any(Date),
      now: expect.any(Date),
      actor: principal(),
    });
  });

  it('shared viewers cannot mutate because access is checked first', async () => {
    const { service, organizationsRepo, access } = createService();
    access.requireDocumentManage.mockRejectedValue(
      new ForbiddenException('Document management permission required'),
    );
    await expect(
      service.delete(document().id, principal()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      organizationsRepo.cancelAndSoftDeleteDocument,
    ).not.toHaveBeenCalled();
  });

  it('sharing returns the committed result without a second authorization read', async () => {
    const { service, gcs, organizationsRepo, access } = createService();
    await service.shareDocument(
      document().id,
      '00000000-0000-0000-0000-000000000020',
      principal(),
    );
    expect(organizationsRepo.setShare).toHaveBeenCalled();
    expect(access.requireDocumentView).not.toHaveBeenCalled();
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
    expect(organizationsRepo.enqueueDocumentReprocess).not.toHaveBeenCalled();
  });

  it('does not let an unauthorized actor share a document', async () => {
    const { service, organizationsRepo, access } = createService();
    access.requireDocumentShare.mockRejectedValue(
      new ForbiddenException('Document sharing permission required'),
    );
    await expect(
      service.shareDocument(
        document().id,
        '00000000-0000-0000-0000-000000000020',
        principal(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsRepo.setShare).not.toHaveBeenCalled();
  });

  it('transfer returns the committed result without a second authorization read', async () => {
    const { service, gcs, organizationsRepo, access } = createService();
    const targetId = '00000000-0000-0000-0000-000000000020';
    organizationsRepo.transferDocument.mockResolvedValue({
      kind: 'ok',
      document: document({ ownerOrganizationId: targetId }),
    });
    await service.transferDocument(document().id, targetId, principal());
    expect(organizationsRepo.transferDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOwnerOrganizationId: ORGANIZATION_ID,
        targetOrganizationId: targetId,
      }),
    );
    expect(access.requireDocumentView).not.toHaveBeenCalled();
    expect(gcs.uploadPdf).not.toHaveBeenCalled();
    expect(organizationsRepo.enqueueDocumentReprocess).not.toHaveBeenCalled();
  });

  it('reports an uploading transfer as a conflict without mutating processing', async () => {
    const { service, organizationsRepo } = createService();
    organizationsRepo.transferDocument.mockResolvedValue({
      kind: 'state_changed',
      document: document({ status: 'uploading' }),
    });
    await expect(
      service.transferDocument(
        document().id,
        '00000000-0000-0000-0000-000000000020',
        principal(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('redacts uploader PII and other share recipients from shared viewers', async () => {
    const { service, organizationsRepo } = createService();
    const sharedOrganizationId = '00000000-0000-0000-0000-000000000020';
    organizationsRepo.findAcceptedMemberships.mockResolvedValue([
      {
        organizationId: sharedOrganizationId,
        role: 'MEMBER',
      },
    ]);
    organizationsRepo.hydrateDocuments.mockImplementation(async (rows) =>
      rows.map((row) => ({
        document: row,
        ownerOrganization: {
          id: row.ownerOrganizationId,
          name: 'Owner',
          slug: 'owner',
        },
        uploader: {
          idpUuid: 'owner-user',
          email: 'owner@example.com',
          name: 'Owner User',
        },
        sharedOrganizations: [
          { id: sharedOrganizationId, name: 'Viewer Org', slug: 'viewer' },
          {
            id: '00000000-0000-0000-0000-000000000030',
            name: 'Unrelated Recipient',
            slug: 'unrelated',
          },
        ],
      })),
    );

    const [item] = await service.listOrganizationDocuments(
      sharedOrganizationId,
      principal({ uuid: 'shared-user' }),
    );
    expect(item).toMatchObject({
      accessRelation: 'SHARED',
      canManage: false,
      uploader: null,
      sharedOrganizations: [],
    });
  });

  it('omits shared documents when the viewing membership has been removed', async () => {
    const { service, organizationsRepo } = createService();
    const sharedOrganizationId = '00000000-0000-0000-0000-000000000020';
    organizationsRepo.findAcceptedMemberships.mockResolvedValue([]);
    organizationsRepo.hydrateDocuments.mockImplementation(async (rows) =>
      rows.map((row) => ({
        document: row,
        ownerOrganization: {
          id: row.ownerOrganizationId,
          name: 'Owner',
          slug: 'owner',
        },
        uploader: null,
        sharedOrganizations: [
          { id: sharedOrganizationId, name: 'Viewer Org', slug: 'viewer' },
        ],
      })),
    );

    await expect(
      service.listOrganizationDocuments(
        sharedOrganizationId,
        principal({ uuid: 'removed-user' }),
      ),
    ).resolves.toEqual([]);
    expect(organizationsRepo.findAcceptedMemberships).toHaveBeenCalledWith(
      expect.arrayContaining([ORGANIZATION_ID, sharedOrganizationId]),
      'removed-user',
    );
  });

  it('requires target-organization membership for transfer', async () => {
    const { service, organizationsRepo, access } = createService();
    access.requireOrganizationMember.mockRejectedValue(
      new ForbiddenException('Accepted organization membership required'),
    );
    await expect(
      service.transferDocument(
        document().id,
        '00000000-0000-0000-0000-000000000020',
        principal(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsRepo.transferDocument).not.toHaveBeenCalled();
  });

  it('keeps the legacy list scoped to documents uploaded by the caller', async () => {
    const { service, repo, organizationsRepo } = createService();
    repo.listByUploader.mockResolvedValue([document()]);
    const result = await service.listMyUploads(principal());
    expect(repo.listByUploader).toHaveBeenCalledWith(principal(), {
      limit: 50,
      offset: 0,
    });
    expect(organizationsRepo.listAccessibleDocuments).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('returns paginated accessible documents with summary', async () => {
    const { service, organizationsRepo, access } = createService();
    organizationsRepo.listAccessibleDocuments.mockResolvedValue({
      rows: [document()],
      filteredTotal: 21,
    });
    organizationsRepo.summarizeAccessibleDocuments.mockResolvedValue({
      totalDocuments: 30,
      organizationCounts: {
        [ORGANIZATION_ID]: 20,
        '00000000-0000-0000-0000-000000000020': 15,
      },
    });

    const result = await service.listAccessibleDocuments(principal(), {
      organizationId: 'all',
      page: 2,
      size: 20,
      status: 'all',
      sort: 'recent',
    });

    expect(access.requireOrganizationMember).not.toHaveBeenCalled();
    expect(organizationsRepo.listAccessibleDocuments).toHaveBeenCalledWith(
      principal(),
      expect.objectContaining({
        organizationId: undefined,
        page: 2,
        size: 20,
      }),
    );
    expect(result).toMatchObject({
      items: [expect.objectContaining({ id: document().id })],
      page: {
        number: 2,
        size: 20,
        filteredTotal: 21,
        totalPages: 2,
        hasNext: false,
        hasPrevious: true,
      },
      summary: {
        totalDocuments: 30,
        organizationCounts: {
          [ORGANIZATION_ID]: 20,
          '00000000-0000-0000-0000-000000000020': 15,
        },
      },
    });
  });

  it('rejects inaccessible organization filters for accessible listing', async () => {
    const { service, access, organizationsRepo } = createService();
    access.requireOrganizationMember.mockRejectedValue(
      new ForbiddenException('Accepted organization membership required'),
    );
    await expect(
      service.listAccessibleDocuments(principal(), {
        organizationId: '00000000-0000-0000-0000-000000000099',
        page: 1,
        size: 20,
        status: 'all',
        sort: 'recent',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsRepo.listAccessibleDocuments).not.toHaveBeenCalled();
  });

  it('returns the updated document after unshare', async () => {
    const { service, organizationsRepo } = createService();
    organizationsRepo.removeShare.mockResolvedValue({
      kind: 'ok',
      document: document(),
    });
    const result = await service.unshareDocument(
      document().id,
      '00000000-0000-0000-0000-000000000020',
      principal(),
    );
    expect(result).toMatchObject({
      id: document().id,
      canShare: true,
      accessRelation: 'OWNER',
    });
  });
});

describe('parseExpiresAt', () => {
  it('treats empty/undefined as null', () => {
    expect(parseExpiresAt(undefined)).toBeNull();
    expect(parseExpiresAt(null)).toBeNull();
    expect(parseExpiresAt('')).toBeNull();
  });

  it('rejects invalid and past values', () => {
    expect(() => parseExpiresAt('not-a-date')).toThrow(BadRequestException);
    expect(() =>
      parseExpiresAt(new Date(Date.now() - 1000).toISOString()),
    ).toThrow(BadRequestException);
  });

  it('accepts a future ISO-8601 value', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(parseExpiresAt(future)?.toISOString()).toBe(future);
  });
});
