import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationAccessService } from './organization-access.service';
import {
  AmbiguousAdminEmailError,
  normalizeEmail,
  OrganizationsRepository,
  RepositoryAuthorizationError,
} from './organizations.repository';
import type { AdminPrincipal } from './organization.types';
import type {
  InviteOrganizationMemberDto,
  OrganizationInvitationDto,
  OrganizationMembershipDto,
  UpdateOrganizationMemberDto,
} from './dto/membership.dto';
import type {
  CreateOrganizationDto,
  OrganizationDto,
} from './dto/organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly access: OrganizationAccessService,
  ) {}

  async createOrganization(
    dto: CreateOrganizationDto,
    principal: AdminPrincipal,
  ): Promise<OrganizationDto> {
    if (!this.access.isSuperAdmin(principal)) {
      throw new ForbiddenException('Super admin role required');
    }
    try {
      const organization = await this.organizationsRepo.createOrganization(
        dto.name.trim(),
        dto.slug,
        principal,
      );
      return this.toOrganizationDto(organization, 'SUPER_ADMIN');
    } catch (error) {
      if (error instanceof RepositoryAuthorizationError) {
        throw new ForbiddenException('Super admin role required');
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException('Organization slug already exists');
      }
      throw error;
    }
  }

  async listOrganizations(
    principal: AdminPrincipal,
  ): Promise<OrganizationDto[]> {
    const rows =
      await this.organizationsRepo.listAccessibleOrganizations(principal);
    return rows.map((row) =>
      this.toOrganizationDto(
        row.organization,
        row.membershipRole ?? 'SUPER_ADMIN',
      ),
    );
  }

  async listMembers(
    organizationId: string,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembershipDto[]> {
    await this.access.requireOrganizationManager(organizationId, principal);
    const rows = await this.organizationsRepo.listMembers(
      organizationId,
      principal,
    );
    return rows.map((row) =>
      this.toMembershipDto(row.membership, row.memberName),
    );
  }

  async inviteMember(
    organizationId: string,
    dto: InviteOrganizationMemberDto,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembershipDto> {
    await this.access.requireOrganizationManager(organizationId, principal);
    const inviteeEmail = normalizeEmail(dto.inviteeEmail);
    if (inviteeEmail === normalizeEmail(principal.email)) {
      throw new BadRequestException('Cannot invite yourself');
    }
    try {
      const knownAdmin =
        await this.organizationsRepo.findAdminByEmail(inviteeEmail);
      const membership = await this.organizationsRepo.createInvitation({
        organizationId,
        inviteeEmail,
        inviteeIdpUuid: knownAdmin?.idpUuid ?? null,
        role: dto.role,
        invitedByIdpUuid: principal.uuid,
        actor: principal,
      });
      return this.toMembershipDto(membership, null);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'This email already has an invitation or membership',
        );
      }
      if (error instanceof AmbiguousAdminEmailError) {
        throw new ConflictException(
          'Multiple administrator identities use this normalized email',
        );
      }
      if (error instanceof RepositoryAuthorizationError) {
        throw new ForbiddenException('Organization manager role required');
      }
      throw error;
    }
  }

  async updateMember(
    organizationId: string,
    membershipId: string,
    dto: UpdateOrganizationMemberDto,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembershipDto> {
    await this.access.requireOrganizationManager(organizationId, principal);
    const result = await this.organizationsRepo.updateMembershipRole(
      organizationId,
      membershipId,
      dto.role,
      principal,
    );
    if (result.kind === 'not_found') {
      throw new NotFoundException('Organization membership not found');
    }
    if (result.kind === 'forbidden') {
      throw new ForbiddenException('Organization manager role required');
    }
    if (result.kind === 'last_manager') {
      throw new BadRequestException(
        'Cannot demote the final accepted organization manager',
      );
    }
    return this.toMembershipDto(result.membership, null);
  }

  async removeMember(
    organizationId: string,
    membershipId: string,
    principal: AdminPrincipal,
  ): Promise<void> {
    await this.access.requireOrganizationManager(organizationId, principal);
    const result = await this.organizationsRepo.removeMembership(
      organizationId,
      membershipId,
      principal,
    );
    if (result.kind === 'not_found') {
      throw new NotFoundException('Organization membership not found');
    }
    if (result.kind === 'forbidden') {
      throw new ForbiddenException('Organization manager role required');
    }
    if (result.kind === 'last_manager') {
      throw new BadRequestException(
        'Cannot remove the final accepted organization manager',
      );
    }
  }

  async listInvitations(
    principal: AdminPrincipal,
  ): Promise<OrganizationInvitationDto[]> {
    const rows = await this.organizationsRepo.listPendingInvitations(
      normalizeEmail(principal.email),
      principal.uuid,
    );
    return rows.map((row) => ({
      ...this.toMembershipDto(row.membership, null),
      organizationName: row.organizationName,
      organizationSlug: row.organizationSlug,
    }));
  }

  async acceptInvitation(
    membershipId: string,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembershipDto> {
    await this.assertInvitationOwner(membershipId, principal);
    try {
      const membership = await this.organizationsRepo.acceptInvitation(
        membershipId,
        normalizeEmail(principal.email),
        principal.uuid,
      );
      if (!membership) {
        throw new ConflictException('Invitation is no longer pending');
      }
      return this.toMembershipDto(membership, null);
    } catch (error) {
      if (error instanceof RepositoryAuthorizationError) {
        throw new ForbiddenException('Invitation belongs to another identity');
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'An accepted membership already exists for this organization',
        );
      }
      throw error;
    }
  }

  async rejectInvitation(
    membershipId: string,
    principal: AdminPrincipal,
  ): Promise<void> {
    await this.assertInvitationOwner(membershipId, principal);
    try {
      const removed = await this.organizationsRepo.rejectInvitation(
        membershipId,
        normalizeEmail(principal.email),
        principal.uuid,
      );
      if (!removed)
        throw new ConflictException('Invitation is no longer pending');
    } catch (error) {
      if (error instanceof RepositoryAuthorizationError) {
        throw new ForbiddenException('Invitation belongs to another identity');
      }
      throw error;
    }
  }

  private async assertInvitationOwner(
    membershipId: string,
    principal: AdminPrincipal,
  ): Promise<void> {
    const membership =
      await this.organizationsRepo.findMembershipById(membershipId);
    if (!membership) throw new NotFoundException('Invitation not found');
    if (membership.inviteeEmail !== normalizeEmail(principal.email)) {
      throw new ForbiddenException('Only the invited email may respond');
    }
    if (
      membership.memberIdpUuid &&
      membership.memberIdpUuid !== principal.uuid
    ) {
      throw new ForbiddenException('Invitation belongs to another identity');
    }
    if (membership.status !== 'PENDING') {
      throw new ConflictException('Invitation is no longer pending');
    }
  }

  private toOrganizationDto(
    organization: {
      id: string;
      name: string;
      slug: string;
      isDefault: boolean;
      createdAt: Date;
    },
    effectiveRole: OrganizationDto['effectiveRole'],
  ): OrganizationDto {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      isDefault: organization.isDefault,
      effectiveRole,
      createdAt: organization.createdAt,
    };
  }

  private toMembershipDto(
    membership: {
      id: string;
      organizationId: string;
      inviteeEmail: string;
      memberIdpUuid: string | null;
      role: 'MANAGER' | 'MEMBER';
      status: 'PENDING' | 'ACCEPTED';
      acceptedAt: Date | null;
      createdAt: Date;
    },
    memberName: string | null,
  ): OrganizationMembershipDto {
    return {
      id: membership.id,
      organizationId: membership.organizationId,
      inviteeEmail: membership.inviteeEmail,
      memberIdpUuid: membership.memberIdpUuid,
      role: membership.role,
      status: membership.status,
      memberName,
      acceptedAt: membership.acceptedAt,
      createdAt: membership.createdAt,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      current.code === '23505'
    ) {
      return true;
    }
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? current.cause
        : null;
  }
  return false;
}
