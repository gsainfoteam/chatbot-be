import type { Document, OrganizationRole } from '../db';

export interface AdminPrincipal {
  uuid: string;
  email: string;
  role: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

export type DocumentAccessRelation = 'OWNER' | 'SHARED';

export interface DocumentAccessDecision {
  document: Document;
  relation: DocumentAccessRelation;
  ownerRole: OrganizationRole | null;
  canView: boolean;
  canManage: boolean;
  canShare: boolean;
  canTransfer: boolean;
}

export interface DocumentAdministrationRecord {
  document: Document;
  ownerOrganization: OrganizationSummary;
  uploader: { idpUuid: string; email: string; name: string } | null;
  sharedOrganizations: OrganizationSummary[];
}
