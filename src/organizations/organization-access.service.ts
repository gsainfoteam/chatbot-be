import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrganizationMembership } from '../db';
import { isUUID } from 'class-validator';
import { evaluateDocumentAccess } from './organization-access.policy';
import { OrganizationsRepository } from './organizations.repository';
import type {
  AdminPrincipal,
  DocumentAccessDecision,
} from './organization.types';

@Injectable()
export class OrganizationAccessService {
  constructor(private readonly organizationsRepo: OrganizationsRepository) {}

  isSuperAdmin(principal: AdminPrincipal): boolean {
    return principal.role === 'SUPER_ADMIN';
  }

  async requireOrganizationMember(
    organizationId: string,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembership | null> {
    const organization =
      await this.organizationsRepo.findOrganization(organizationId);
    if (!organization) throw new NotFoundException('Organization not found');
    if (await this.organizationsRepo.isCurrentSuperAdmin(principal))
      return null;

    const membership = await this.organizationsRepo.findAcceptedMembership(
      organizationId,
      principal.uuid,
    );
    if (!membership) {
      throw new ForbiddenException('Accepted organization membership required');
    }
    return membership;
  }

  async requireOrganizationManager(
    organizationId: string,
    principal: AdminPrincipal,
  ): Promise<OrganizationMembership | null> {
    const membership = await this.requireOrganizationMember(
      organizationId,
      principal,
    );
    if (membership && membership.role !== 'MANAGER') {
      throw new ForbiddenException('Organization manager role required');
    }
    return membership;
  }

  async resolveUploadOrganization(
    suppliedOrganizationId: string | undefined,
    principal: AdminPrincipal,
  ) {
    const omitted = suppliedOrganizationId === undefined;
    const normalized = suppliedOrganizationId?.trim();
    if (!omitted && (!normalized || !isUUID(normalized))) {
      throw new BadRequestException('organizationId must be a UUID');
    }
    const organization = omitted
      ? await this.organizationsRepo.findDefaultOrganization()
      : await this.organizationsRepo.findOrganization(normalized!);
    if (!organization) {
      throw new NotFoundException(
        !omitted ? 'Organization not found' : 'Default organization not found',
      );
    }
    await this.requireOrganizationMember(organization.id, principal);
    return organization;
  }

  async getDocumentAccess(
    documentId: string,
    principal: AdminPrincipal,
  ): Promise<DocumentAccessDecision> {
    const state = await this.organizationsRepo.findDocumentAccessState(
      documentId,
      principal,
    );
    if (!state?.document.isActive) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }
    const document = state.document;

    if (state.isSuperAdmin) {
      return {
        document,
        relation: 'OWNER',
        ownerRole: null,
        canView: true,
        canManage: true,
        canShare: true,
        canTransfer: true,
      };
    }

    return evaluateDocumentAccess({
      document,
      actorIdpUuid: principal.uuid,
      ownerRole: state.ownerRole,
      shared: !state.ownerRole && state.shared,
    });
  }

  async requireDocumentView(documentId: string, principal: AdminPrincipal) {
    const access = await this.getDocumentAccess(documentId, principal);
    if (!access.canView) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }
    return access;
  }

  async requireDocumentManage(documentId: string, principal: AdminPrincipal) {
    const access = await this.getDocumentAccess(documentId, principal);
    if (!access.canView) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }
    if (!access.canManage) {
      throw new ForbiddenException('Document management permission required');
    }
    return access;
  }

  async requireDocumentShare(documentId: string, principal: AdminPrincipal) {
    const access = await this.getDocumentAccess(documentId, principal);
    if (!access.canView) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }
    if (!access.canShare) {
      throw new ForbiddenException('Document sharing permission required');
    }
    return access;
  }
}

export { evaluateDocumentAccess } from './organization-access.policy';
