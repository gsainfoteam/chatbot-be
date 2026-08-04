import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { OrganizationAccessService } from './organization-access.service';
import {
  AmbiguousAdminEmailError,
  RepositoryAuthorizationError,
  type OrganizationsRepository,
} from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import type { AdminPrincipal } from './organization.types';

const ORG_ID = '00000000-0000-0000-0000-000000000010';

function actor(overrides: Partial<AdminPrincipal> = {}): AdminPrincipal {
  return {
    uuid: 'manager',
    email: 'Manager@Example.com ',
    role: 'ADMIN',
    ...overrides,
  };
}

function pendingMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000011',
    organizationId: ORG_ID,
    inviteeEmail: 'invitee@example.com',
    memberIdpUuid: null,
    role: 'MEMBER' as const,
    status: 'PENDING' as const,
    invitedByIdpUuid: 'manager',
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup() {
  const repo = {
    createOrganization: jest.fn<OrganizationsRepository['createOrganization']>(
      async () => ({
        id: ORG_ID,
        name: 'Org',
        slug: 'org',
        isDefault: false,
        createdByIdpUuid: 'root',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ),
    listAccessibleOrganizations: jest.fn<
      OrganizationsRepository['listAccessibleOrganizations']
    >(async () => []),
    listMembers: jest.fn(async () => []),
    findAdminByEmail: jest.fn(async () => null as { idpUuid: string } | null),
    createInvitation: jest.fn<OrganizationsRepository['createInvitation']>(
      async () => pendingMembership(),
    ),
    updateMembershipRole: jest.fn<
      OrganizationsRepository['updateMembershipRole']
    >(async () => ({
      kind: 'updated' as const,
      membership: pendingMembership(),
    })),
    removeMembership: jest.fn<OrganizationsRepository['removeMembership']>(
      async () => ({
        kind: 'updated' as const,
        membership: pendingMembership(),
      }),
    ),
    listPendingInvitations: jest.fn(async () => []),
    findMembershipById: jest.fn(async () => pendingMembership()),
    acceptInvitation: jest.fn<OrganizationsRepository['acceptInvitation']>(
      async () =>
        pendingMembership({
          memberIdpUuid: 'invitee',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        }),
    ),
    rejectInvitation: jest.fn(async () => pendingMembership()),
  };
  const access = {
    isSuperAdmin: jest.fn(
      (principal: AdminPrincipal) => principal.role === 'SUPER_ADMIN',
    ),
    requireOrganizationManager: jest.fn(async () => null),
  };
  return {
    repo,
    access,
    service: new OrganizationsService(
      repo as unknown as OrganizationsRepository,
      access as unknown as OrganizationAccessService,
    ),
  };
}

describe('OrganizationsService', () => {
  it('returns every accepted organization for a multi-organization user', async () => {
    const { service, repo } = setup();
    repo.listAccessibleOrganizations.mockResolvedValue([
      {
        organization: {
          id: ORG_ID,
          name: 'Org A',
          slug: 'org-a',
          isDefault: false,
          createdByIdpUuid: 'root',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        membershipRole: 'MANAGER',
      },
      {
        organization: {
          id: '00000000-0000-0000-0000-000000000020',
          name: 'Org B',
          slug: 'org-b',
          isDefault: false,
          createdByIdpUuid: 'root',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        membershipRole: 'MEMBER',
      },
    ]);
    await expect(service.listOrganizations(actor())).resolves.toEqual([
      expect.objectContaining({ slug: 'org-a', effectiveRole: 'MANAGER' }),
      expect.objectContaining({ slug: 'org-b', effectiveRole: 'MEMBER' }),
    ]);
  });

  it('rejects organization creation by non-SUPER_ADMIN', async () => {
    const { service, repo } = setup();
    await expect(
      service.createOrganization({ name: 'Org', slug: 'org' }, actor()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.createOrganization).not.toHaveBeenCalled();
  });

  it('uses the repository atomic create-with-manager operation', async () => {
    const { service, repo } = setup();
    const root = actor({ role: 'SUPER_ADMIN', uuid: 'root' });
    await expect(
      service.createOrganization({ name: ' Org ', slug: 'org' }, root),
    ).resolves.toMatchObject({ effectiveRole: 'SUPER_ADMIN' });
    expect(repo.createOrganization).toHaveBeenCalledWith('Org', 'org', root);
  });

  it('returns only fields declared by the organization DTO', async () => {
    const { service } = setup();
    const result = await service.createOrganization(
      { name: 'Org', slug: 'org' },
      actor({ role: 'SUPER_ADMIN', uuid: 'root' }),
    );
    expect(result).toEqual({
      id: ORG_ID,
      name: 'Org',
      slug: 'org',
      isDefault: false,
      effectiveRole: 'SUPER_ADMIN',
      createdAt: expect.any(Date),
    });
  });

  it('rejects a stale SUPER_ADMIN claim at transaction time', async () => {
    const { service, repo } = setup();
    repo.createOrganization.mockRejectedValue(
      new RepositoryAuthorizationError(),
    );
    await expect(
      service.createOrganization(
        { name: 'Org', slug: 'org' },
        actor({ role: 'SUPER_ADMIN', uuid: 'demoted-root' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invites an unknown email as normalized PENDING', async () => {
    const { service, repo } = setup();
    const result = await service.inviteMember(
      ORG_ID,
      { inviteeEmail: ' Invitee@Example.COM ', role: 'MEMBER' },
      actor(),
    );
    expect(repo.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeEmail: 'invitee@example.com',
        inviteeIdpUuid: null,
      }),
    );
    expect(result.status).toBe('PENDING');
    expect(result).not.toHaveProperty('invitedByIdpUuid');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('stores a known admin UUID but keeps the invite PENDING', async () => {
    const { service, repo } = setup();
    repo.findAdminByEmail.mockResolvedValue({ idpUuid: 'known-user' });
    repo.createInvitation.mockResolvedValue(
      pendingMembership({ memberIdpUuid: 'known-user' }),
    );
    const result = await service.inviteMember(
      ORG_ID,
      { inviteeEmail: 'invitee@example.com', role: 'MEMBER' },
      actor(),
    );
    expect(result).toMatchObject({
      memberIdpUuid: 'known-user',
      status: 'PENDING',
    });
  });

  it('rejects invitations when a normalized email maps to multiple identities', async () => {
    const { service, repo } = setup();
    repo.findAdminByEmail.mockRejectedValue(new AmbiguousAdminEmailError());
    await expect(
      service.inviteMember(
        ORG_ID,
        { inviteeEmail: 'invitee@example.com', role: 'MEMBER' },
        actor(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.createInvitation).not.toHaveBeenCalled();
  });

  it('does not allow a MEMBER through member management access', async () => {
    const { service, repo, access } = setup();
    access.requireOrganizationManager.mockRejectedValue(
      new ForbiddenException('Organization manager role required'),
    );
    await expect(
      service.inviteMember(
        ORG_ID,
        { inviteeEmail: 'invitee@example.com', role: 'MEMBER' },
        actor(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects an invitation if manager access is revoked before insertion', async () => {
    const { service, repo } = setup();
    repo.createInvitation.mockRejectedValue(new RepositoryAuthorizationError());
    await expect(
      service.inviteMember(
        ORG_ID,
        { inviteeEmail: 'invitee@example.com', role: 'MEMBER' },
        actor(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps final-manager demotion/removal protection', async () => {
    const { service, repo } = setup();
    repo.updateMembershipRole.mockResolvedValue({ kind: 'last_manager' });
    await expect(
      service.updateMember(ORG_ID, 'membership', { role: 'MEMBER' }, actor()),
    ).rejects.toBeInstanceOf(BadRequestException);

    repo.removeMembership.mockResolvedValue({ kind: 'last_manager' });
    await expect(
      service.removeMember(ORG_ID, 'membership', actor()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids another email from accepting an invitation', async () => {
    const { service, repo } = setup();
    repo.findMembershipById.mockResolvedValue(pendingMembership());
    await expect(
      service.acceptInvitation(
        pendingMembership().id,
        actor({ email: 'other@example.com' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.acceptInvitation).not.toHaveBeenCalled();
  });

  it('forbids a different UUID with the same normalized email', async () => {
    const { service, repo } = setup();
    repo.findMembershipById.mockResolvedValue(
      pendingMembership({ memberIdpUuid: 'known-user' }),
    );
    await expect(
      service.acceptInvitation(
        pendingMembership().id,
        actor({ uuid: 'case-variant-user', email: 'INVITEE@example.com' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.acceptInvitation).not.toHaveBeenCalled();
  });

  it('maps a transaction-time invitation identity change to forbidden', async () => {
    const { service, repo } = setup();
    repo.acceptInvitation.mockRejectedValue(new RepositoryAuthorizationError());
    await expect(
      service.acceptInvitation(
        pendingMembership().id,
        actor({ uuid: 'invitee', email: 'invitee@example.com' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps a transaction-time invitation rejection identity change to forbidden', async () => {
    const { service, repo } = setup();
    repo.rejectInvitation.mockRejectedValue(new RepositoryAuthorizationError());
    await expect(
      service.rejectInvitation(
        pendingMembership().id,
        actor({ uuid: 'invitee', email: 'invitee@example.com' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts only explicitly and sets the current IDP UUID through repository', async () => {
    const { service, repo } = setup();
    const invitee = actor({
      uuid: 'invitee',
      email: 'INVITEE@example.com',
    });
    await service.acceptInvitation(pendingMembership().id, invitee);
    expect(repo.acceptInvitation).toHaveBeenCalledWith(
      pendingMembership().id,
      'invitee@example.com',
      'invitee',
    );
  });
});
