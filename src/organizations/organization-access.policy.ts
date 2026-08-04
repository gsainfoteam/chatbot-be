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
    const isManager = input.ownerRole === 'MANAGER';
    const isOwnUpload = input.document.uploadedByIdpUuid === input.actorIdpUuid;
    return {
      document: input.document,
      relation: 'OWNER',
      ownerRole: input.ownerRole,
      canView: true,
      canManage: isManager || isOwnUpload,
      canShare: isManager,
      canTransfer: isManager,
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
