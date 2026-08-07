import type { OrganizationRole } from '../db';
import type { DocumentAccessDecision } from './organization.types';

/**
 * Pure document authorization policy shared by request-time checks and
 * transaction-time reauthorization.
 */
export function evaluateDocumentAccess(input: {
  document: DocumentAccessDecision['document'];
  actorIdpUuid: string;
  ownerRole: OrganizationRole | null;
  shared: boolean;
}): DocumentAccessDecision {
  if (input.ownerRole) {
    // Accepted owner-org membership (MANAGER or MEMBER) grants full document
    // rights. Organization admin actions (invite/role changes) stay MANAGER-only.
    return {
      document: input.document,
      relation: 'OWNER',
      ownerRole: input.ownerRole,
      canView: true,
      canManage: true,
      canShare: true,
      canTransfer: true,
    };
  }

  return {
    document: input.document,
    relation: 'SHARED',
    ownerRole: null,
    canView: input.shared,
    canManage: false,
    canShare: false,
    canTransfer: false,
  };
}
