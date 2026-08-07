import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Document } from '../db';
import { DocumentsRepository } from '../pdf-processor/documents.repository';
import { GcsStorageService } from '../pdf-processor/gcs-storage.service';
import { toResourceName } from '../pdf-processor/pdf-chunk-parser';
import { isExpiredAt } from '../retrieval/retrieval.repository';
import { OrganizationAccessService } from '../organizations/organization-access.service';
import { evaluateDocumentAccess } from '../organizations/organization-access.policy';
import {
  OrganizationsRepository,
  RepositoryAuthorizationError,
} from '../organizations/organizations.repository';
import type {
  AdminPrincipal,
  DocumentAccessDecision,
} from '../organizations/organization.types';
import type { DocumentListItemDto } from './dto/document-list-item.dto';
import type {
  AccessibleDocumentsResponseDto,
  ListAccessibleDocumentsQueryDto,
} from './dto/list-accessible-documents.dto';
import { isUUID } from 'class-validator';

const PDF_MIME = 'application/pdf';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
export const REPROCESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function parseExpiresAt(raw?: string | null): Date | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      'expiresAt must be a valid ISO-8601 datetime',
    );
  }
  if (parsed.getTime() <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  return parsed;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly documentsRepo: DocumentsRepository,
    private readonly gcs: GcsStorageService,
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly access: OrganizationAccessService,
  ) {}

  async listMyUploads(
    principal: AdminPrincipal,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DocumentListItemDto[]> {
    const paging = this.normalizePaging(options);
    const rows = await this.documentsRepo.listByUploader(principal, paging);
    return this.toListItems(rows, principal, undefined, [], true);
  }

  async listAccessibleDocuments(
    principal: AdminPrincipal,
    query: ListAccessibleDocumentsQueryDto,
  ): Promise<AccessibleDocumentsResponseDto> {
    const organizationId =
      query.organizationId === 'all' ? undefined : query.organizationId;
    if (organizationId != null) {
      if (!isUUID(organizationId)) {
        throw new BadRequestException(
          'organizationId must be a UUID or "all"',
        );
      }
      await this.access.requireOrganizationMember(organizationId, principal);
    }

    const [{ rows, filteredTotal }, summary] = await Promise.all([
      this.organizationsRepo.listAccessibleDocuments(principal, {
        organizationId,
        page: query.page,
        size: query.size,
        query: query.query,
        status: query.status,
        sort: query.sort,
      }),
      this.organizationsRepo.summarizeAccessibleDocuments(principal),
    ]);

    const items = await this.toListItems(
      rows,
      principal,
      organizationId,
      [],
      true,
    );
    const totalPages =
      filteredTotal === 0 ? 0 : Math.ceil(filteredTotal / query.size);

    return {
      items,
      page: {
        number: query.page,
        size: query.size,
        filteredTotal,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrevious: query.page > 1 && filteredTotal > 0,
      },
      summary,
    };
  }

  async listOrganizationDocuments(
    organizationId: string,
    principal: AdminPrincipal,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DocumentListItemDto[]> {
    await this.access.requireOrganizationMember(organizationId, principal);
    const rows = await this.organizationsRepo.listOrganizationDocuments(
      organizationId,
      principal,
      this.normalizePaging(options),
    );
    return this.toListItems(rows, principal, organizationId, [], true);
  }

  async getById(
    id: string,
    principal: AdminPrincipal,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentView(id, principal);
    return (
      await this.toListItems(
        [decision.document],
        principal,
        undefined,
        [decision],
        false,
        true,
      )
    )[0];
  }

  async upload(
    fileBuffer: Buffer,
    filename: string,
    title: string,
    principal: AdminPrincipal,
    organizationId?: string,
    expiresAtRaw?: string | null,
  ): Promise<DocumentListItemDto> {
    if (!fileBuffer?.length) {
      throw new BadRequestException('file is required');
    }

    // Permission is checked before reserving a DB row or touching GCS.
    const organization = await this.access.resolveUploadOrganization(
      organizationId,
      principal,
    );
    const expiresAt = parseExpiresAt(expiresAtRaw);
    const resourceName = toResourceName(filename || 'document.pdf');
    if (!resourceName.trim()) {
      throw new BadRequestException('Invalid filename');
    }

    const gcsPdfPath = this.gcs.toGsPath(`${resourceName}.pdf`);
    let reservation: Document;
    try {
      reservation = await this.organizationsRepo.createUploadingDocument({
        title,
        resourceName,
        gcsPdfPath,
        ownerOrganizationId: organization.id,
        expiresAt,
        actor: principal,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `An active document with resource name "${resourceName}" already exists`,
        );
      }
      if (error instanceof RepositoryAuthorizationError) {
        throw new ForbiddenException('Organization membership changed');
      }
      throw error;
    }

    this.logger.debug(`Uploading PDF to GCS: ${resourceName}.pdf`);
    try {
      await this.gcs.uploadPdf(resourceName, fileBuffer);
    } catch (error) {
      this.logger.error(
        `GCS upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.rollbackUpload(reservation.id, resourceName);
      throw new ServiceUnavailableException(
        'Document storage is temporarily unavailable',
      );
    }

    let record: Document | null;
    try {
      const result = await this.organizationsRepo.finalizeUploadingDocument({
        documentId: reservation.id,
        expectedOwnerOrganizationId: organization.id,
        actor: principal,
      });
      this.assertDocumentMutation(result);
      if (result.kind !== 'ok') {
        throw new ConflictException('Upload reservation state changed');
      }
      record = result.document;
    } catch (error) {
      await this.rollbackUpload(reservation.id, resourceName);
      if (error instanceof HttpException) throw error;
      throw new Error(
        `Failed to enqueue the uploaded document: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(`Upload queued: id=${record.id} resource=${resourceName}`);
    return (await this.toListItems([record], principal))[0];
  }

  async delete(id: string, principal: AdminPrincipal): Promise<void> {
    const decision = await this.access.requireDocumentManage(id, principal);
    const result = await this.organizationsRepo.cancelAndSoftDeleteDocument({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      actor: principal,
    });
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') return;
    const row = result.document;

    try {
      await this.gcs.deleteResourceArtifacts(row.resourceName);
    } catch (error) {
      this.logger.error(
        `GCS delete failed id=${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Document storage is temporarily unavailable',
      );
    }
    this.logger.log(`Document deleted: id=${id} resource=${row.resourceName}`);
  }

  async reprocess(
    id: string,
    principal: AdminPrincipal,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentManage(id, principal);
    const now = new Date();
    this.assertReprocessEligible(decision.document, now);

    const result = await this.organizationsRepo.enqueueDocumentReprocess({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      cooldownBefore: new Date(now.getTime() - REPROCESS_COOLDOWN_MS),
      now,
      actor: principal,
    });
    if (result.kind === 'state_changed') {
      this.assertReprocessEligible(result.document, new Date());
      throw new ConflictException('Document reprocess state changed');
    }
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') {
      throw new ConflictException('Document reprocess state changed');
    }
    const updated = result.document;
    this.logger.log(`Document requeued: id=${id}`);
    return (await this.toListItems([updated], principal))[0];
  }

  async updateExpiresAt(
    id: string,
    principal: AdminPrincipal,
    expiresAtRaw: string | null,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentManage(id, principal);
    const expiresAt =
      expiresAtRaw === null ? null : parseExpiresAt(expiresAtRaw);
    const result = await this.organizationsRepo.updateDocumentExpiresAt({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      expiresAt,
      actor: principal,
    });
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') {
      throw new ConflictException('Document ownership or state changed');
    }
    const updated = result.document;
    return (await this.toListItems([updated], principal))[0];
  }

  async shareDocument(
    id: string,
    targetOrganizationId: string,
    principal: AdminPrincipal,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentShare(id, principal);
    if (decision.document.ownerOrganizationId === targetOrganizationId) {
      throw new BadRequestException(
        'Owning organization cannot be a share target',
      );
    }
    if (
      !(await this.organizationsRepo.findOrganization(targetOrganizationId))
    ) {
      throw new NotFoundException('Target organization not found');
    }
    const result = await this.organizationsRepo.setShare({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      targetOrganizationId,
      actor: principal,
    });
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') {
      throw new ConflictException('Document sharing state changed');
    }
    return (
      await this.toListItems(
        [result.document],
        principal,
        undefined,
        [{ ...decision, document: result.document }],
        false,
        true,
      )
    )[0];
  }

  async unshareDocument(
    id: string,
    targetOrganizationId: string,
    principal: AdminPrincipal,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentShare(id, principal);
    const result = await this.organizationsRepo.removeShare({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      targetOrganizationId,
      actor: principal,
    });
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') {
      throw new ConflictException('Document sharing state changed');
    }
    return (
      await this.toListItems(
        [result.document],
        principal,
        undefined,
        [{ ...decision, document: result.document }],
        false,
        true,
      )
    )[0];
  }

  async transferDocument(
    id: string,
    targetOrganizationId: string,
    principal: AdminPrincipal,
  ): Promise<DocumentListItemDto> {
    const decision = await this.access.requireDocumentShare(id, principal);
    if (decision.document.ownerOrganizationId === targetOrganizationId) {
      throw new BadRequestException(
        'Document is already owned by target organization',
      );
    }
    if (
      !(await this.organizationsRepo.findOrganization(targetOrganizationId))
    ) {
      throw new NotFoundException('Target organization not found');
    }
    await this.access.requireOrganizationMember(
      targetOrganizationId,
      principal,
    );
    const result = await this.organizationsRepo.transferDocument({
      documentId: id,
      expectedOwnerOrganizationId: decision.document.ownerOrganizationId,
      targetOrganizationId,
      actor: principal,
    });
    this.assertDocumentMutation(result);
    if (result.kind !== 'ok') {
      throw new ConflictException('Document transfer state changed');
    }
    return (
      await this.toListItems(
        [result.document],
        principal,
        undefined,
        [],
        false,
        false,
      )
    )[0];
  }

  private async toListItems(
    rows: Document[],
    principal: AdminPrincipal,
    organizationContextId?: string,
    knownDecisions: DocumentAccessDecision[] = [],
    omitUnauthorized = false,
    reauthorizeKnownDecisions = false,
  ): Promise<DocumentListItemDto[]> {
    const records = await this.organizationsRepo.hydrateDocuments(rows);
    const currentSuperAdmin =
      await this.organizationsRepo.isCurrentSuperAdmin(principal);
    const authorizationOrganizationIds = [
      ...new Set([
        ...rows.map((row) => row.ownerOrganizationId),
        ...(organizationContextId ? [organizationContextId] : []),
      ]),
    ];
    const memberships = currentSuperAdmin
      ? []
      : await this.organizationsRepo.findAcceptedMemberships(
          authorizationOrganizationIds,
          principal.uuid,
        );
    const roleByOrganization = new Map(
      memberships.map((membership) => [
        membership.organizationId,
        membership.role,
      ]),
    );
    const currentKnownDecisions = reauthorizeKnownDecisions
      ? await Promise.all(
          knownDecisions.map((decision) =>
            this.access.requireDocumentView(decision.document.id, principal),
          ),
        )
      : knownDecisions;
    const decisions = new Map(
      currentKnownDecisions.map((decision) => [decision.document.id, decision]),
    );

    const items = records.map((record): DocumentListItemDto | null => {
      const row = record.document;
      let decision = decisions.get(row.id);
      if (!decision) {
        if (currentSuperAdmin) {
          decision = {
            document: row,
            relation:
              organizationContextId &&
              organizationContextId !== row.ownerOrganizationId
                ? 'SHARED'
                : 'OWNER',
            ownerRole: null,
            canView: true,
            canManage: true,
            canShare: true,
            canTransfer: true,
          };
        } else {
          const ownerRole =
            roleByOrganization.get(row.ownerOrganizationId) ?? null;
          decision = evaluateDocumentAccess({
            document: row,
            actorIdpUuid: principal.uuid,
            ownerRole,
            shared:
              !ownerRole &&
              Boolean(
                organizationContextId &&
                roleByOrganization.has(organizationContextId) &&
                record.sharedOrganizations.some(
                  (organization) => organization.id === organizationContextId,
                ),
              ),
          });
        }
      }

      if (omitUnauthorized && !decision.canView) return null;

      const reprocessAvailableAt = row.lastReprocessedAt
        ? new Date(row.lastReprocessedAt.getTime() + REPROCESS_COOLDOWN_MS)
        : null;
      const statusAllowsReprocess =
        row.status === 'ready' || row.status === 'failed';
      return {
        id: row.id,
        title: row.title,
        resourceName: row.resourceName,
        status: row.status,
        summary: row.summary,
        gcsPdfPath: row.gcsPdfPath,
        errorMessage: row.errorMessage,
        uploadedAt: row.createdAt,
        processedAt: row.processedAt,
        lastReprocessedAt: row.lastReprocessedAt,
        reprocessAvailableAt,
        canReprocess:
          decision.canManage &&
          statusAllowsReprocess &&
          (!reprocessAvailableAt ||
            reprocessAvailableAt.getTime() <= Date.now()),
        expiresAt: row.expiresAt,
        isExpired: isExpiredAt(row.expiresAt),
        ownerOrganization: record.ownerOrganization,
        uploader:
          !currentSuperAdmin && decision.relation === 'SHARED'
            ? null
            : record.uploader,
        sharedOrganizations:
          !currentSuperAdmin && decision.relation === 'SHARED'
            ? []
            : record.sharedOrganizations,
        accessRelation: decision.relation,
        canManage: decision.canManage,
        canShare: decision.canShare,
        canTransfer: decision.canTransfer,
      };
    });
    return items.filter((item): item is DocumentListItemDto => item !== null);
  }

  private normalizePaging(options: { limit?: number; offset?: number }) {
    return {
      limit: Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      offset: Math.max(0, options.offset ?? 0),
    };
  }

  private assertDocumentMutation(result: {
    kind: 'ok' | 'not_found' | 'stale_owner' | 'forbidden' | 'state_changed';
  }): void {
    if (result.kind === 'ok') return;
    if (result.kind === 'not_found')
      throw new NotFoundException('Document not found');
    if (result.kind === 'forbidden') {
      throw new ForbiddenException('Organization permission changed');
    }
    if (result.kind === 'state_changed')
      throw new ConflictException('Document state changed');
    throw new ConflictException('Document ownership changed');
  }

  private assertReprocessEligible(row: Document, now: Date): void {
    if (row.status !== 'ready' && row.status !== 'failed') {
      throw new ConflictException(
        `Document cannot be reprocessed while status is "${row.status}"`,
      );
    }
    if (!row.lastReprocessedAt) return;
    const retryAt = new Date(
      row.lastReprocessedAt.getTime() + REPROCESS_COOLDOWN_MS,
    );
    if (retryAt.getTime() <= now.getTime()) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Document reprocess cooldown is active',
        error: 'Too Many Requests',
        retryAt: retryAt.toISOString(),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async rollbackUpload(
    documentId: string,
    resourceName: string,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.gcs.deleteResourceArtifacts(resourceName),
      this.documentsRepo.hardDelete(documentId),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Upload rollback failed id=${documentId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }
}

export { PDF_MIME };

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
