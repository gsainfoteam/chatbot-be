import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Document } from '../db';
import {
  evaluateDocumentAccess,
  OrganizationAccessService,
} from './organization-access.service';
import type { OrganizationsRepository } from './organizations.repository';
import type { AdminPrincipal } from './organization.types';

const ORG_ID = '550e8400-e29b-41d4-a716-446655440010';

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Document',
    resourceName: 'document',
    summary: null,
    gcsPdfPath: 'gs://bucket/document.pdf',
    status: 'ready',
    errorMessage: null,
    processingToken: null,
    uploadedByIdpUuid: 'uploader',
    ownerOrganizationId: ORG_ID,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: new Date(),
    lastReprocessedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function principal(overrides: Partial<AdminPrincipal> = {}): AdminPrincipal {
  return {
    uuid: 'uploader',
    email: 'user@example.com',
    role: 'ADMIN',
    ...overrides,
  };
}

describe('evaluateDocumentAccess', () => {
  it('allows an owner MEMBER to manage/share/transfer every owned document', () => {
    expect(
      evaluateDocumentAccess({
        document: document(),
        actorIdpUuid: 'other-member',
        ownerRole: 'MEMBER',
        shared: false,
      }),
    ).toMatchObject({
      relation: 'OWNER',
      canView: true,
      canManage: true,
      canShare: true,
      canTransfer: true,
    });
  });

  it('allows an owner MANAGER to manage/share/transfer every owned document', () => {
    expect(
      evaluateDocumentAccess({
        document: document(),
        actorIdpUuid: 'manager',
        ownerRole: 'MANAGER',
        shared: false,
      }),
    ).toMatchObject({
      relation: 'OWNER',
      canView: true,
      canManage: true,
      canShare: true,
      canTransfer: true,
    });
  });

  it('grants shared organizations view-only access', () => {
    expect(
      evaluateDocumentAccess({
        document: document(),
        actorIdpUuid: 'shared-member',
        ownerRole: null,
        shared: true,
      }),
    ).toMatchObject({
      relation: 'SHARED',
      canView: true,
      canManage: false,
      canShare: false,
      canTransfer: false,
    });
  });

  it('removes all derived rights when no accepted membership remains', () => {
    expect(
      evaluateDocumentAccess({
        document: document(),
        actorIdpUuid: 'uploader',
        ownerRole: null,
        shared: false,
      }),
    ).toMatchObject({ canView: false, canManage: false });
  });
});

describe('OrganizationAccessService', () => {
  function setup() {
    const repo = {
      findOrganization: jest.fn(async (id: string) =>
        id === 'invalid'
          ? undefined
          : {
              id,
              name: 'Org',
              slug: 'org',
              isDefault: false,
              createdByIdpUuid: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
      ),
      findDefaultOrganization: jest.fn(async () => ({
        id: ORG_ID,
        name: '인포팀',
        slug: 'infoteam',
        isDefault: true,
        createdByIdpUuid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      isCurrentSuperAdmin: jest.fn(async (actor: AdminPrincipal) =>
        Promise.resolve(actor.role === 'SUPER_ADMIN'),
      ),
      findAcceptedMembership: jest.fn<
        OrganizationsRepository['findAcceptedMembership']
      >(async () => ({
        id: 'membership',
        organizationId: ORG_ID,
        inviteeEmail: 'user@example.com',
        memberIdpUuid: 'uploader',
        role: 'MEMBER' as const,
        status: 'ACCEPTED' as const,
        invitedByIdpUuid: 'manager',
        acceptedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      findDocumentAccessState: jest.fn(
        async (_id: string, actor: AdminPrincipal) => ({
          document: document(),
          ownerRole: actor.uuid === 'uploader' ? ('MEMBER' as const) : null,
          shared: false,
          isSuperAdmin: actor.role === 'SUPER_ADMIN',
        }),
      ),
    };
    return {
      repo,
      service: new OrganizationAccessService(
        repo as unknown as OrganizationsRepository,
      ),
    };
  }

  it('uses the default organization only when organizationId is omitted', async () => {
    const { service, repo } = setup();
    await service.resolveUploadOrganization(undefined, principal());
    expect(repo.findDefaultOrganization).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicitly supplied blank organizationId without fallback', async () => {
    const { service, repo } = setup();
    await expect(
      service.resolveUploadOrganization('   ', principal()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findDefaultOrganization).not.toHaveBeenCalled();
  });

  it('does not fall back for a nonempty invalid organization id', async () => {
    const { service, repo } = setup();
    await expect(
      service.resolveUploadOrganization('invalid', principal()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.findDefaultOrganization).not.toHaveBeenCalled();
  });

  it('rejects upload for a non-member before storage work', async () => {
    const { service, repo } = setup();
    repo.findAcceptedMembership.mockResolvedValue(null);
    await expect(
      service.resolveUploadOrganization(ORG_ID, principal()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('conceals active documents from unrelated organizations', async () => {
    const { service, repo } = setup();
    repo.findDocumentAccessState.mockResolvedValue({
      document: document(),
      ownerRole: null,
      shared: false,
      isSuperAdmin: false,
    });
    await expect(
      service.requireDocumentView(document().id, principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.requireDocumentManage(document().id, principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gives SUPER_ADMIN global organization and document access', async () => {
    const { service, repo } = setup();
    const actor = principal({ role: 'SUPER_ADMIN', uuid: 'root' });
    await expect(
      service.requireOrganizationManager(ORG_ID, actor),
    ).resolves.toBeNull();
    await expect(
      service.requireDocumentShare(document().id, actor),
    ).resolves.toMatchObject({
      canManage: true,
      canShare: true,
      canTransfer: true,
    });
    expect(repo.findAcceptedMembership).not.toHaveBeenCalled();
  });

  it('does not trust a stale SUPER_ADMIN claim after database demotion', async () => {
    const { service, repo } = setup();
    const actor = principal({ role: 'SUPER_ADMIN', uuid: 'demoted-root' });
    repo.isCurrentSuperAdmin.mockResolvedValue(false);
    repo.findAcceptedMembership.mockResolvedValue(null);
    repo.findDocumentAccessState.mockResolvedValue({
      document: document(),
      ownerRole: null,
      shared: false,
      isSuperAdmin: false,
    });

    await expect(
      service.requireOrganizationManager(ORG_ID, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.requireDocumentShare(document().id, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
