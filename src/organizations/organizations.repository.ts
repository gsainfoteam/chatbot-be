import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  admins,
  DB_CONNECTION,
  documentChunks,
  documentOrganizationShares,
  documentOwnershipTransfers,
  documents,
  organizationMemberships,
  organizations,
  type Database,
  type Document,
  type OrganizationMembership,
  type OrganizationRole,
} from '../db';
import { evaluateDocumentAccess } from './organization-access.policy';
import type {
  AdminPrincipal,
  DocumentAdministrationRecord,
} from './organization.types';

export type MembershipMutationResult =
  | { kind: 'updated'; membership: OrganizationMembership }
  | { kind: 'not_found' }
  | { kind: 'last_manager' }
  | { kind: 'forbidden' };

export type DocumentMutationResult =
  | { kind: 'ok'; document: Document }
  | { kind: 'not_found' }
  | { kind: 'stale_owner' }
  | { kind: 'forbidden' }
  | { kind: 'state_changed'; document: Document };

export class RepositoryAuthorizationError extends Error {
  constructor() {
    super('Organization permission changed');
    this.name = 'RepositoryAuthorizationError';
  }
}

export class AmbiguousAdminEmailError extends Error {
  constructor() {
    super('Multiple administrator identities use the same normalized email');
    this.name = 'AmbiguousAdminEmailError';
  }
}

@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  findOrganization(id: string) {
    return this.db.query.organizations.findFirst({
      where: eq(organizations.id, id),
    });
  }

  findDefaultOrganization() {
    return this.db.query.organizations.findFirst({
      where: eq(organizations.isDefault, true),
    });
  }

  async createOrganization(
    name: string,
    slug: string,
    creator: AdminPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      if (!(await this.isCurrentSuperAdminInTransaction(tx, creator))) {
        throw new RepositoryAuthorizationError();
      }
      const [organization] = await tx
        .insert(organizations)
        .values({ name, slug, createdByIdpUuid: creator.uuid })
        .returning();
      if (!organization) throw new Error('Failed to create organization');

      await tx.insert(organizationMemberships).values({
        organizationId: organization.id,
        inviteeEmail: normalizeEmail(creator.email),
        memberIdpUuid: creator.uuid,
        role: 'MANAGER',
        status: 'ACCEPTED',
        invitedByIdpUuid: creator.uuid,
        acceptedAt: new Date(),
      });
      return organization;
    });
  }

  async listAccessibleOrganizations(principal: AdminPrincipal) {
    const superAdminCondition = this.currentSuperAdminCondition(principal);
    return this.db
      .select({
        organization: organizations,
        membershipRole: sql<OrganizationRole | null>`CASE
          WHEN ${superAdminCondition} THEN NULL
          ELSE ${organizationMemberships.role}
        END`,
      })
      .from(organizations)
      .leftJoin(
        organizationMemberships,
        and(
          eq(organizationMemberships.organizationId, organizations.id),
          eq(organizationMemberships.memberIdpUuid, principal.uuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .where(or(superAdminCondition, isNotNull(organizationMemberships.id)))
      .orderBy(organizations.name);
  }

  async findAcceptedMembership(
    organizationId: string,
    memberIdpUuid: string,
  ): Promise<OrganizationMembership | null> {
    const [membership] = await this.db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.memberIdpUuid, memberIdpUuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .limit(1);
    return membership ?? null;
  }

  async isCurrentSuperAdmin(principal: AdminPrincipal): Promise<boolean> {
    if (principal.role !== 'SUPER_ADMIN') return false;
    const [admin] = await this.db
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(eq(admins.idpUuid, principal.uuid), eq(admins.role, 'SUPER_ADMIN')),
      )
      .limit(1);
    return Boolean(admin);
  }

  async findAcceptedMemberships(
    organizationIds: string[],
    memberIdpUuid: string,
  ) {
    if (organizationIds.length === 0) return [];
    return this.db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.organizationId, organizationIds),
          eq(organizationMemberships.memberIdpUuid, memberIdpUuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      );
  }

  async listMembers(organizationId: string, principal: AdminPrincipal) {
    return this.db
      .select({
        membership: organizationMemberships,
        memberName: admins.name,
      })
      .from(organizationMemberships)
      .leftJoin(
        admins,
        eq(admins.idpUuid, organizationMemberships.memberIdpUuid),
      )
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          this.organizationAccessCondition(organizationId, principal, true),
        ),
      )
      .orderBy(organizationMemberships.createdAt);
  }

  async findAdminByEmail(normalizedEmail: string) {
    const matches = await this.db
      .select({ idpUuid: admins.idpUuid })
      .from(admins)
      .where(sql`lower(trim(${admins.email})) = ${normalizedEmail}`)
      .limit(2);
    if (matches.length > 1) throw new AmbiguousAdminEmailError();
    return matches[0] ?? null;
  }

  async createInvitation(input: {
    organizationId: string;
    inviteeEmail: string;
    inviteeIdpUuid: string | null;
    role: OrganizationRole;
    invitedByIdpUuid: string;
    actor: AdminPrincipal;
  }) {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.organizationId]);
      if (
        !(await this.isCurrentManager(tx, input.organizationId, input.actor))
      ) {
        throw new RepositoryAuthorizationError();
      }
      const [membership] = await tx
        .insert(organizationMemberships)
        .values({
          organizationId: input.organizationId,
          inviteeEmail: input.inviteeEmail,
          memberIdpUuid: input.inviteeIdpUuid,
          role: input.role,
          status: 'PENDING',
          invitedByIdpUuid: input.invitedByIdpUuid,
        })
        .returning();
      if (!membership) throw new Error('Failed to create invitation');
      return membership;
    });
  }

  async updateMembershipRole(
    organizationId: string,
    membershipId: string,
    role: OrganizationRole,
    actor: AdminPrincipal,
  ): Promise<MembershipMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [organizationId]);
      if (!(await this.isCurrentManager(tx, organizationId, actor))) {
        return { kind: 'forbidden' };
      }
      const [current] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!current) return { kind: 'not_found' };

      if (
        current.status === 'ACCEPTED' &&
        current.role === 'MANAGER' &&
        role !== 'MANAGER' &&
        (await this.countAcceptedManagers(tx, organizationId)) <= 1
      ) {
        return { kind: 'last_manager' };
      }

      const [membership] = await tx
        .update(organizationMemberships)
        .set({ role, updatedAt: new Date() })
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, organizationId),
          ),
        )
        .returning();
      return membership
        ? { kind: 'updated', membership }
        : { kind: 'not_found' };
    });
  }

  async removeMembership(
    organizationId: string,
    membershipId: string,
    actor: AdminPrincipal,
  ): Promise<MembershipMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [organizationId]);
      if (!(await this.isCurrentManager(tx, organizationId, actor))) {
        return { kind: 'forbidden' };
      }
      const [current] = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!current) return { kind: 'not_found' };

      if (
        current.status === 'ACCEPTED' &&
        current.role === 'MANAGER' &&
        (await this.countAcceptedManagers(tx, organizationId)) <= 1
      ) {
        return { kind: 'last_manager' };
      }

      const [membership] = await tx
        .delete(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, membershipId),
            eq(organizationMemberships.organizationId, organizationId),
          ),
        )
        .returning();
      return membership
        ? { kind: 'updated', membership }
        : { kind: 'not_found' };
    });
  }

  async listPendingInvitations(normalizedEmail: string, memberIdpUuid: string) {
    return this.db
      .select({
        membership: organizationMemberships,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizationMemberships.organizationId, organizations.id),
      )
      .where(
        and(
          eq(organizationMemberships.inviteeEmail, normalizedEmail),
          eq(organizationMemberships.status, 'PENDING'),
          or(
            eq(organizationMemberships.memberIdpUuid, memberIdpUuid),
            and(
              isNull(organizationMemberships.memberIdpUuid),
              sql`(
                SELECT count(*)
                FROM "admins" AS "invitation_identity"
                WHERE lower(trim("invitation_identity"."email")) = ${normalizedEmail}
              ) = 1`,
              sql`EXISTS (
                SELECT 1
                FROM "admins" AS "current_invitation_identity"
                WHERE lower(trim("current_invitation_identity"."email")) = ${normalizedEmail}
                  AND "current_invitation_identity"."idp_uuid" = ${memberIdpUuid}
              )`,
            ),
          ),
        ),
      )
      .orderBy(desc(organizationMemberships.createdAt));
  }

  async findMembershipById(id: string) {
    const [membership] = await this.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, id))
      .limit(1);
    return membership ?? null;
  }

  async acceptInvitation(id: string, normalizedEmail: string, idpUuid: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM organization_memberships WHERE id = ${id} FOR UPDATE`,
      );
      const [current] = await tx
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.id, id))
        .limit(1);
      if (
        !current ||
        current.inviteeEmail !== normalizedEmail ||
        current.status !== 'PENDING'
      ) {
        return null;
      }
      if (current.memberIdpUuid && current.memberIdpUuid !== idpUuid) {
        throw new RepositoryAuthorizationError();
      }
      if (
        !current.memberIdpUuid &&
        !(await this.isSoleNormalizedAdminIdentity(
          tx,
          normalizedEmail,
          idpUuid,
        ))
      ) {
        throw new RepositoryAuthorizationError();
      }

      const now = new Date();
      const [membership] = await tx
        .update(organizationMemberships)
        .set({
          memberIdpUuid: current.memberIdpUuid ?? idpUuid,
          status: 'ACCEPTED',
          acceptedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(organizationMemberships.id, id),
            eq(organizationMemberships.status, 'PENDING'),
          ),
        )
        .returning();
      return membership ?? null;
    });
  }

  async rejectInvitation(
    id: string,
    normalizedEmail: string,
    memberIdpUuid: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM organization_memberships WHERE id = ${id} FOR UPDATE`,
      );
      const [current] = await tx
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.id, id))
        .limit(1);
      if (
        !current ||
        current.inviteeEmail !== normalizedEmail ||
        current.status !== 'PENDING'
      ) {
        return null;
      }
      if (current.memberIdpUuid && current.memberIdpUuid !== memberIdpUuid) {
        throw new RepositoryAuthorizationError();
      }
      if (
        !current.memberIdpUuid &&
        !(await this.isSoleNormalizedAdminIdentity(
          tx,
          normalizedEmail,
          memberIdpUuid,
        ))
      ) {
        throw new RepositoryAuthorizationError();
      }

      const [membership] = await tx
        .delete(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.id, id),
            eq(organizationMemberships.status, 'PENDING'),
          ),
        )
        .returning();
      return membership ?? null;
    });
  }

  async findDocument(id: string) {
    const [document] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return document ?? null;
  }

  async findDocumentAccessState(
    id: string,
    principal: AdminPrincipal,
  ): Promise<{
    document: Document;
    ownerRole: OrganizationRole | null;
    shared: boolean;
    isSuperAdmin: boolean;
  } | null> {
    const superAdminExpression = this.currentSuperAdminCondition(principal);
    const [row] = await this.db
      .select({
        document: documents,
        ownerRole: sql<OrganizationRole | null>`(
          SELECT "owner_membership"."role"
          FROM "organization_memberships" AS "owner_membership"
          WHERE "owner_membership"."organization_id" = "documents"."owner_organization_id"
            AND "owner_membership"."member_idp_uuid" = ${principal.uuid}
            AND "owner_membership"."status" = 'ACCEPTED'
          LIMIT 1
        )`,
        shared: sql<boolean>`EXISTS (
          SELECT 1
          FROM "document_organization_shares" AS "access_share"
          INNER JOIN "organization_memberships" AS "shared_membership"
            ON "shared_membership"."organization_id" = "access_share"."organization_id"
          WHERE "access_share"."document_id" = "documents"."id"
            AND "shared_membership"."member_idp_uuid" = ${principal.uuid}
            AND "shared_membership"."status" = 'ACCEPTED'
        )`,
        isSuperAdmin: superAdminExpression,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row ?? null;
  }

  async createUploadingDocument(input: {
    title: string;
    resourceName: string;
    gcsPdfPath: string;
    ownerOrganizationId: string;
    expiresAt: Date | null;
    actor: AdminPrincipal;
  }): Promise<Document> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.ownerOrganizationId]);
      if (
        !(await this.isCurrentMember(
          tx,
          input.ownerOrganizationId,
          input.actor,
        ))
      ) {
        throw new RepositoryAuthorizationError();
      }
      const [document] = await tx
        .insert(documents)
        .values({
          title: input.title,
          resourceName: input.resourceName,
          gcsPdfPath: input.gcsPdfPath,
          uploadedByIdpUuid: input.actor.uuid,
          ownerOrganizationId: input.ownerOrganizationId,
          expiresAt: input.expiresAt,
          status: 'uploading',
          isActive: true,
        })
        .returning();
      if (!document) throw new Error('Failed to insert document');
      return document;
    });
  }

  async finalizeUploadingDocument(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeDocumentManage(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;
      if (state.document.status !== 'uploading') {
        return { kind: 'state_changed', document: state.document };
      }

      const [document] = await tx
        .update(documents)
        .set({
          status: 'queued',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(
              documents.ownerOrganizationId,
              input.expectedOwnerOrganizationId,
            ),
            eq(documents.status, 'uploading'),
            eq(documents.isActive, true),
          ),
        )
        .returning();
      return document
        ? { kind: 'ok', document }
        : { kind: 'state_changed', document: state.document };
    });
  }

  async hasAcceptedShare(documentId: string, memberIdpUuid: string) {
    const [row] = await this.db
      .select({ id: documentOrganizationShares.id })
      .from(documentOrganizationShares)
      .innerJoin(
        organizationMemberships,
        eq(
          organizationMemberships.organizationId,
          documentOrganizationShares.organizationId,
        ),
      )
      .where(
        and(
          eq(documentOrganizationShares.documentId, documentId),
          eq(organizationMemberships.memberIdpUuid, memberIdpUuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async listOrganizationDocuments(
    organizationId: string,
    principal: AdminPrincipal,
    options: { limit: number; offset: number },
  ) {
    const ids = await this.db
      .selectDistinct({ id: documents.id, createdAt: documents.createdAt })
      .from(documents)
      .leftJoin(
        documentOrganizationShares,
        eq(documentOrganizationShares.documentId, documents.id),
      )
      .where(
        and(
          eq(documents.isActive, true),
          this.organizationAccessCondition(organizationId, principal, false),
          or(
            eq(documents.ownerOrganizationId, organizationId),
            eq(documentOrganizationShares.organizationId, organizationId),
          ),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(options.limit)
      .offset(options.offset);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(documents)
      .where(
        inArray(
          documents.id,
          ids.map((row) => row.id),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id));
  }

  async listManageableDocuments(
    principal: AdminPrincipal,
    options: { limit: number; offset: number },
  ) {
    return this.db
      .selectDistinct({ document: documents })
      .from(documents)
      .leftJoin(
        organizationMemberships,
        and(
          eq(
            organizationMemberships.organizationId,
            documents.ownerOrganizationId,
          ),
          eq(organizationMemberships.memberIdpUuid, principal.uuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .where(
        and(
          eq(documents.isActive, true),
          or(
            this.currentSuperAdminCondition(principal),
            and(
              isNotNull(organizationMemberships.id),
              or(
                eq(organizationMemberships.role, 'MANAGER'),
                eq(documents.uploadedByIdpUuid, principal.uuid),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(options.limit)
      .offset(options.offset)
      .then((rows) => rows.map((row) => row.document));
  }

  async hydrateDocuments(
    rows: Document[],
  ): Promise<DocumentAdministrationRecord[]> {
    if (rows.length === 0) return [];
    const ownerIds = [...new Set(rows.map((row) => row.ownerOrganizationId))];
    const uploaderIds = [...new Set(rows.map((row) => row.uploadedByIdpUuid))];
    const documentIds = rows.map((row) => row.id);

    const [ownerRows, uploaderRows, shareRows] = await Promise.all([
      this.db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(organizations)
        .where(inArray(organizations.id, ownerIds)),
      this.db
        .select({
          idpUuid: admins.idpUuid,
          email: admins.email,
          name: admins.name,
        })
        .from(admins)
        .where(inArray(admins.idpUuid, uploaderIds)),
      this.db
        .select({
          documentId: documentOrganizationShares.documentId,
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(documentOrganizationShares)
        .innerJoin(
          organizations,
          eq(documentOrganizationShares.organizationId, organizations.id),
        )
        .where(inArray(documentOrganizationShares.documentId, documentIds)),
    ]);

    const owners = new Map(ownerRows.map((row) => [row.id, row]));
    const uploaders = new Map(uploaderRows.map((row) => [row.idpUuid, row]));
    const shares = new Map<string, typeof ownerRows>();
    for (const share of shareRows) {
      const list = shares.get(share.documentId) ?? [];
      list.push({ id: share.id, name: share.name, slug: share.slug });
      shares.set(share.documentId, list);
    }

    return rows.map((document) => {
      const ownerOrganization = owners.get(document.ownerOrganizationId);
      if (!ownerOrganization) {
        throw new Error(
          `Owner organization missing for document ${document.id}`,
        );
      }
      return {
        document,
        ownerOrganization,
        uploader: uploaders.get(document.uploadedByIdpUuid) ?? null,
        sharedOrganizations: shares.get(document.id) ?? [],
      };
    });
  }

  async updateDocumentExpiresAt(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    expiresAt: Date | null;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeDocumentManage(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;

      const [document] = await tx
        .update(documents)
        .set({ expiresAt: input.expiresAt, updatedAt: new Date() })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(
              documents.ownerOrganizationId,
              input.expectedOwnerOrganizationId,
            ),
            eq(documents.isActive, true),
          ),
        )
        .returning();
      return document ? { kind: 'ok', document } : { kind: 'stale_owner' };
    });
  }

  async cancelAndSoftDeleteDocument(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeDocumentManage(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;

      const [document] = await tx
        .update(documents)
        .set({
          isActive: false,
          processingToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(
              documents.ownerOrganizationId,
              input.expectedOwnerOrganizationId,
            ),
            eq(documents.isActive, true),
          ),
        )
        .returning();
      return document ? { kind: 'ok', document } : { kind: 'stale_owner' };
    });
  }

  async enqueueDocumentReprocess(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    cooldownBefore: Date;
    now: Date;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeDocumentManage(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;

      const [document] = await tx
        .update(documents)
        .set({
          status: 'queued',
          errorMessage: null,
          processingToken: null,
          processedAt: null,
          lastReprocessedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(
              documents.ownerOrganizationId,
              input.expectedOwnerOrganizationId,
            ),
            eq(documents.isActive, true),
            inArray(documents.status, ['ready', 'failed']),
            or(
              isNull(documents.lastReprocessedAt),
              lte(documents.lastReprocessedAt, input.cooldownBefore),
            ),
          ),
        )
        .returning();
      if (!document) return { kind: 'state_changed', document: state.document };

      await tx
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, input.documentId));
      return { kind: 'ok', document };
    });
  }

  async setShare(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    targetOrganizationId: string;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeOwnerManager(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;
      await tx
        .insert(documentOrganizationShares)
        .values({
          documentId: input.documentId,
          organizationId: input.targetOrganizationId,
          sharedByIdpUuid: input.actor.uuid,
        })
        .onConflictDoNothing({
          target: [
            documentOrganizationShares.documentId,
            documentOrganizationShares.organizationId,
          ],
        });
      return state;
    });
  }

  async removeShare(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    targetOrganizationId: string;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [input.expectedOwnerOrganizationId]);
      const state = await this.lockAndAuthorizeOwnerManager(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;
      await tx
        .delete(documentOrganizationShares)
        .where(
          and(
            eq(documentOrganizationShares.documentId, input.documentId),
            eq(
              documentOrganizationShares.organizationId,
              input.targetOrganizationId,
            ),
          ),
        );
      return state;
    });
  }

  async transferDocument(input: {
    documentId: string;
    expectedOwnerOrganizationId: string;
    targetOrganizationId: string;
    actor: AdminPrincipal;
  }): Promise<DocumentMutationResult> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganizations(tx, [
        input.expectedOwnerOrganizationId,
        input.targetOrganizationId,
      ]);
      const state = await this.lockAndAuthorizeOwnerManager(
        tx,
        input.documentId,
        input.expectedOwnerOrganizationId,
        input.actor,
      );
      if (state.kind !== 'ok') return state;

      if (state.document.status === 'uploading') {
        return { kind: 'state_changed', document: state.document };
      }

      if (!(await this.isCurrentSuperAdminInTransaction(tx, input.actor))) {
        const [targetMembership] = await tx
          .select({ role: organizationMemberships.role })
          .from(organizationMemberships)
          .where(
            and(
              eq(
                organizationMemberships.organizationId,
                input.targetOrganizationId,
              ),
              eq(organizationMemberships.memberIdpUuid, input.actor.uuid),
              eq(organizationMemberships.status, 'ACCEPTED'),
              eq(organizationMemberships.role, 'MANAGER'),
            ),
          )
          .limit(1);
        if (!targetMembership) return { kind: 'forbidden' };
      }

      const [updated] = await tx
        .update(documents)
        .set({
          ownerOrganizationId: input.targetOrganizationId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(
              documents.ownerOrganizationId,
              input.expectedOwnerOrganizationId,
            ),
            eq(documents.isActive, true),
          ),
        )
        .returning();
      if (!updated) return { kind: 'stale_owner' };

      await tx
        .delete(documentOrganizationShares)
        .where(
          and(
            eq(documentOrganizationShares.documentId, input.documentId),
            eq(
              documentOrganizationShares.organizationId,
              input.targetOrganizationId,
            ),
          ),
        );
      await tx.insert(documentOwnershipTransfers).values({
        documentId: input.documentId,
        sourceOrganizationId: input.expectedOwnerOrganizationId,
        targetOrganizationId: input.targetOrganizationId,
        actorIdpUuid: input.actor.uuid,
      });
      return { kind: 'ok', document: updated };
    });
  }

  private async countAcceptedManagers(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    organizationId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.status, 'ACCEPTED'),
          eq(organizationMemberships.role, 'MANAGER'),
        ),
      );
    return row?.count ?? 0;
  }

  private async isSoleNormalizedAdminIdentity(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    normalizedEmail: string,
    actorIdpUuid: string,
  ): Promise<boolean> {
    // Prevent a case/space-variant admin identity from being inserted between
    // the ambiguity check and binding an invitation to the caller.
    await tx.execute(sql`LOCK TABLE "admins" IN SHARE MODE`);
    const matches = await tx
      .select({ idpUuid: admins.idpUuid })
      .from(admins)
      .where(sql`lower(trim(${admins.email})) = ${normalizedEmail}`)
      .limit(2);
    return matches.length === 1 && matches[0]?.idpUuid === actorIdpUuid;
  }

  private organizationAccessCondition(
    organizationId: string,
    principal: AdminPrincipal,
    managerOnly: boolean,
  ) {
    const superAdminCondition = this.currentSuperAdminCondition(principal);
    const roleCondition = managerOnly
      ? sql`AND "access_membership"."role" = 'MANAGER'`
      : sql``;
    return sql`(
      ${superAdminCondition}
      OR EXISTS (
        SELECT 1
        FROM "organization_memberships" AS "access_membership"
        WHERE "access_membership"."organization_id" = ${organizationId}
          AND "access_membership"."member_idp_uuid" = ${principal.uuid}
          AND "access_membership"."status" = 'ACCEPTED'
          ${roleCondition}
      )
    )`;
  }

  private currentSuperAdminCondition(principal: AdminPrincipal) {
    return principal.role === 'SUPER_ADMIN'
      ? sql<boolean>`EXISTS (
          SELECT 1
          FROM "admins" AS "current_super_admin"
          WHERE "current_super_admin"."idp_uuid" = ${principal.uuid}
            AND "current_super_admin"."role" = 'SUPER_ADMIN'
        )`
      : sql<boolean>`false`;
  }

  private async isCurrentSuperAdminInTransaction(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    actor: AdminPrincipal,
  ): Promise<boolean> {
    if (actor.role !== 'SUPER_ADMIN') return false;
    const [admin] = await tx
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(eq(admins.idpUuid, actor.uuid), eq(admins.role, 'SUPER_ADMIN')),
      )
      .limit(1)
      .for('share');
    return Boolean(admin);
  }

  private async lockOrganizations(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    organizationIds: string[],
  ): Promise<void> {
    const sortedIds = [...new Set(organizationIds)].sort();
    for (const organizationId of sortedIds) {
      await tx.execute(
        sql`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`,
      );
    }
  }

  private async isCurrentManager(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    organizationId: string,
    actor: AdminPrincipal,
  ): Promise<boolean> {
    if (await this.isCurrentSuperAdminInTransaction(tx, actor)) return true;
    const [membership] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.memberIdpUuid, actor.uuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
          eq(organizationMemberships.role, 'MANAGER'),
        ),
      )
      .limit(1);
    return Boolean(membership);
  }

  private async isCurrentMember(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    organizationId: string,
    actor: AdminPrincipal,
  ): Promise<boolean> {
    if (await this.isCurrentSuperAdminInTransaction(tx, actor)) return true;
    const [membership] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.memberIdpUuid, actor.uuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .limit(1);
    return Boolean(membership);
  }

  private async lockAndAuthorizeDocumentManage(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    documentId: string,
    expectedOwnerOrganizationId: string,
    actor: AdminPrincipal,
  ): Promise<DocumentMutationResult> {
    const state = await this.lockDocument(
      tx,
      documentId,
      expectedOwnerOrganizationId,
    );
    if (state.kind !== 'ok') return state;
    if (await this.isCurrentSuperAdminInTransaction(tx, actor)) return state;

    const [membership] = await tx
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(
            organizationMemberships.organizationId,
            expectedOwnerOrganizationId,
          ),
          eq(organizationMemberships.memberIdpUuid, actor.uuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      )
      .limit(1);
    const decision = evaluateDocumentAccess({
      document: state.document,
      actorIdpUuid: actor.uuid,
      ownerRole: membership?.role ?? null,
      shared: false,
    });
    return decision.canManage ? state : { kind: 'forbidden' };
  }

  private async lockAndAuthorizeOwnerManager(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    documentId: string,
    expectedOwnerOrganizationId: string,
    actor: AdminPrincipal,
  ): Promise<DocumentMutationResult> {
    const state = await this.lockDocument(
      tx,
      documentId,
      expectedOwnerOrganizationId,
    );
    if (state.kind !== 'ok') return state;
    return (await this.isCurrentManager(tx, expectedOwnerOrganizationId, actor))
      ? state
      : { kind: 'forbidden' };
  }

  private async lockDocument(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    documentId: string,
    expectedOwnerOrganizationId: string,
  ): Promise<DocumentMutationResult> {
    await tx.execute(
      sql`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`,
    );
    const [document] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!document || !document.isActive) return { kind: 'not_found' };
    if (document.ownerOrganizationId !== expectedOwnerOrganizationId) {
      return { kind: 'stale_owner' };
    }
    return { kind: 'ok', document };
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
