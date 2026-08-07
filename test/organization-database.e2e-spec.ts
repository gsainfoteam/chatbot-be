import { ExecutionContext, NotFoundException } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyRequest } from 'fastify';
import postgres from 'postgres';
import { AdminContext } from '../src/auth/context/admin-context.entity';
import { AdminJwtGuard } from '../src/auth/guards/admin-jwt.guard';
import {
  admins,
  documentChunks,
  documentOrganizationShares,
  documentOwnershipTransfers,
  documents,
  organizationMemberships,
  organizations,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { OrganizationAccessService } from '../src/organizations/organization-access.service';
import {
  OrganizationsRepository,
  RepositoryAuthorizationError,
} from '../src/organizations/organizations.repository';
import { DocumentsRepository } from '../src/pdf-processor/documents.repository';
import { GcsStorageService } from '../src/pdf-processor/gcs-storage.service';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { UploadController } from '../src/upload/upload.controller';
import { UploadService } from '../src/upload/upload.service';

type AdminRequest = FastifyRequest & { user?: AdminContext };

class HeaderAdminGuard {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    request.user = new AdminContext(
      String(request.headers['x-admin-email'] ?? 'admin@example.com'),
      String(request.headers['x-admin-uuid'] ?? 'admin'),
      'Database E2E Admin',
      String(request.headers['x-admin-role'] ?? 'ADMIN'),
    );
    return true;
  }
}

const describeDatabase =
  process.env.ORGANIZATION_TEST_DB === 'true' ? describe : describe.skip;

describeDatabase('Organization database invariants (e2e)', () => {
  const testPrefix = `org-e2e-${Date.now()}`;
  const managerUuid = `${testPrefix}-manager`;
  const memberUuid = `${testPrefix}-member`;
  const inviteeUuid = `${testPrefix}-invitee`;
  const sourceOnlyManagerUuid = `${testPrefix}-source-only-manager`;
  const concurrentManagerAUuid = `${testPrefix}-concurrent-manager-a`;
  const concurrentManagerBUuid = `${testPrefix}-concurrent-manager-b`;
  const collisionAdminAUuid = `${testPrefix}-collision-a`;
  const collisionAdminBUuid = `${testPrefix}-collision-b`;
  const listingSourceManagerUuid = `${testPrefix}-listing-source-manager`;
  const listingMultiManagerUuid = `${testPrefix}-listing-multi-manager`;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: OrganizationsRepository;
  let access: OrganizationAccessService;
  let retrievalRepo: RetrievalRepository;
  let app: NestFastifyApplication;
  let sourceOrganizationId: string;
  let targetOrganizationId: string;
  let rootDocumentId: string;
  let memberDocumentId: string;
  let targetDocumentId: string;

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error(
        'Organization database E2E requires DB_NAME ending in _test',
      );
    }
    client = postgres({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database,
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      max: 5,
    });
    db = drizzle(client, { schema });
    repo = new OrganizationsRepository(db as unknown as Database);
    access = new OrganizationAccessService(repo);
    retrievalRepo = new RetrievalRepository(db as unknown as Database);

    await db.insert(admins).values([
      {
        idpUuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        name: 'Manager',
        role: 'SUPER_ADMIN',
      },
      {
        idpUuid: memberUuid,
        email: `${testPrefix}-member@example.com`,
        name: 'Member',
      },
      {
        idpUuid: inviteeUuid,
        email: `${testPrefix}-invitee@example.com`,
        name: 'Invitee',
      },
    ]);

    const [source, target] = await db
      .insert(organizations)
      .values([
        {
          name: `${testPrefix} source`,
          slug: `${testPrefix}-source`,
          createdByIdpUuid: managerUuid,
        },
        {
          name: `${testPrefix} target`,
          slug: `${testPrefix}-target`,
          createdByIdpUuid: managerUuid,
        },
      ])
      .returning();
    sourceOrganizationId = source.id;
    targetOrganizationId = target.id;

    await db
      .insert(organizationMemberships)
      .values([
        {
          organizationId: sourceOrganizationId,
          inviteeEmail: `${testPrefix}-manager@example.com`,
          memberIdpUuid: managerUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
        {
          organizationId: targetOrganizationId,
          inviteeEmail: `${testPrefix}-manager@example.com`,
          memberIdpUuid: managerUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
        {
          organizationId: sourceOrganizationId,
          inviteeEmail: `${testPrefix}-member@example.com`,
          memberIdpUuid: memberUuid,
          role: 'MEMBER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
      ])
      .returning();

    await db.insert(admins).values([
      {
        idpUuid: listingSourceManagerUuid,
        email: `${testPrefix}-listing-source-manager@example.com`,
        name: 'Listing Source Manager',
      },
      {
        idpUuid: listingMultiManagerUuid,
        email: `${testPrefix}-listing-multi-manager@example.com`,
        name: 'Listing Multi Manager',
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        organizationId: sourceOrganizationId,
        inviteeEmail: `${testPrefix}-listing-source-manager@example.com`,
        memberIdpUuid: listingSourceManagerUuid,
        role: 'MANAGER',
        status: 'ACCEPTED',
        invitedByIdpUuid: managerUuid,
        acceptedAt: new Date(),
      },
      {
        organizationId: sourceOrganizationId,
        inviteeEmail: `${testPrefix}-listing-multi-manager@example.com`,
        memberIdpUuid: listingMultiManagerUuid,
        role: 'MANAGER',
        status: 'ACCEPTED',
        invitedByIdpUuid: managerUuid,
        acceptedAt: new Date(),
      },
      {
        organizationId: targetOrganizationId,
        inviteeEmail: `${testPrefix}-listing-multi-manager@example.com`,
        memberIdpUuid: listingMultiManagerUuid,
        role: 'MANAGER',
        status: 'ACCEPTED',
        invitedByIdpUuid: managerUuid,
        acceptedAt: new Date(),
      },
    ]);

    const listingDocuments = await db
      .insert(documents)
      .values([
        {
          title: `${testPrefix} root upload`,
          resourceName: `${testPrefix}-root-upload`,
          gcsPdfPath: `gs://test/${testPrefix}-root-upload.pdf`,
          status: 'ready',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: sourceOrganizationId,
        },
        {
          title: `${testPrefix} member upload`,
          resourceName: `${testPrefix}-member-upload`,
          gcsPdfPath: `gs://test/${testPrefix}-member-upload.pdf`,
          status: 'ready',
          uploadedByIdpUuid: memberUuid,
          ownerOrganizationId: sourceOrganizationId,
        },
        {
          title: `${testPrefix} target upload`,
          resourceName: `${testPrefix}-target-upload`,
          gcsPdfPath: `gs://test/${testPrefix}-target-upload.pdf`,
          status: 'ready',
          uploadedByIdpUuid: listingMultiManagerUuid,
          ownerOrganizationId: targetOrganizationId,
        },
      ])
      .returning({ id: documents.id });
    [rootDocumentId, memberDocumentId, targetDocumentId] = listingDocuments.map(
      (row) => row.id,
    );
    await db.insert(documentOrganizationShares).values({
      documentId: rootDocumentId,
      organizationId: targetOrganizationId,
      sharedByIdpUuid: managerUuid,
    });
    const documentsRepo = new DocumentsRepository(db as unknown as Database);
    const uploadService = new UploadService(
      documentsRepo,
      {} as GcsStorageService,
      repo,
      access,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [{ provide: UploadService, useValue: uploadService }],
    })
      .overrideGuard(AdminJwtGuard)
      .useClass(HeaderAdminGuard)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    if (!db || !client) return;
    const ownedOrganizations = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.createdByIdpUuid, managerUuid));
    const organizationIds = ownedOrganizations.map((row) => row.id);
    if (organizationIds.length > 0) {
      const ownedDocuments = await db
        .select({ id: documents.id })
        .from(documents)
        .where(inArray(documents.ownerOrganizationId, organizationIds));
      const documentIds = ownedDocuments.map((row) => row.id);
      if (documentIds.length > 0) {
        await db
          .delete(documentOrganizationShares)
          .where(inArray(documentOrganizationShares.documentId, documentIds));
        await db
          .delete(documentOwnershipTransfers)
          .where(inArray(documentOwnershipTransfers.documentId, documentIds));
        await db
          .delete(documentChunks)
          .where(inArray(documentChunks.documentId, documentIds));
        await db.delete(documents).where(inArray(documents.id, documentIds));
      }
      await db
        .delete(organizationMemberships)
        .where(
          inArray(organizationMemberships.organizationId, organizationIds),
        );
      await db
        .delete(organizations)
        .where(inArray(organizations.id, organizationIds));
    }
    await db
      .delete(admins)
      .where(
        inArray(admins.idpUuid, [
          managerUuid,
          memberUuid,
          inviteeUuid,
          sourceOnlyManagerUuid,
          concurrentManagerAUuid,
          concurrentManagerBUuid,
          collisionAdminAUuid,
          collisionAdminBUuid,
          listingSourceManagerUuid,
          listingMultiManagerUuid,
        ]),
      );
    await client.end();
  });

  async function getUploadList(url: string, uuid: string, role = 'ADMIN') {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url,
        headers: {
          'x-admin-email': `${uuid}@example.com`,
          'x-admin-uuid': uuid,
          'x-admin-role': role,
        },
      });
  }

  function responseIds(payload: string): string[] {
    return JSON.parse(payload).map((row: { id: string }) => row.id);
  }

  it('preserves the legacy upload list and exposes the separate manageable HTTP contract', async () => {
    const memberOwn = await getUploadList('/api/v1/admin/upload', memberUuid);
    expect(memberOwn.statusCode).toBe(200);
    expect(responseIds(memberOwn.payload)).toEqual([memberDocumentId]);

    const superOwn = await getUploadList(
      '/api/v1/admin/upload',
      managerUuid,
      'SUPER_ADMIN',
    );
    expect(superOwn.statusCode).toBe(200);
    expect(responseIds(superOwn.payload)).toEqual([rootDocumentId]);

    const superManageable = await getUploadList(
      '/api/v1/admin/upload/manageable?limit=100',
      managerUuid,
      'SUPER_ADMIN',
    );
    expect(superManageable.statusCode).toBe(200);
    const superManageableIds = responseIds(superManageable.payload);
    expect(superManageableIds).toEqual(
      expect.arrayContaining([
        rootDocumentId,
        memberDocumentId,
        targetDocumentId,
      ]),
    );
    expect(new Set(superManageableIds).size).toBe(superManageableIds.length);

    const sourceManagerManageable = await getUploadList(
      '/api/v1/admin/upload/manageable',
      listingSourceManagerUuid,
    );
    expect(sourceManagerManageable.statusCode).toBe(200);
    expect(new Set(responseIds(sourceManagerManageable.payload))).toEqual(
      new Set([rootDocumentId, memberDocumentId]),
    );

    const memberManageable = await getUploadList(
      '/api/v1/admin/upload/manageable',
      memberUuid,
    );
    expect(memberManageable.statusCode).toBe(200);
    expect(responseIds(memberManageable.payload)).toEqual([memberDocumentId]);

    const multiManagerManageable = await getUploadList(
      '/api/v1/admin/upload/manageable',
      listingMultiManagerUuid,
    );
    expect(multiManagerManageable.statusCode).toBe(200);
    const multiManagerIds = responseIds(multiManagerManageable.payload);
    expect(new Set(multiManagerIds)).toEqual(
      new Set([rootDocumentId, memberDocumentId, targetDocumentId]),
    );
    expect(new Set(multiManagerIds).size).toBe(multiManagerIds.length);

    const staleSuperManageable = await getUploadList(
      '/api/v1/admin/upload/manageable',
      inviteeUuid,
      'SUPER_ADMIN',
    );
    expect(staleSuperManageable.statusCode).toBe(200);
    expect(responseIds(staleSuperManageable.payload)).toEqual([]);
  });

  it('supports one user as accepted MANAGER in multiple organizations', async () => {
    const memberships = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.memberIdpUuid, managerUuid),
          eq(organizationMemberships.status, 'ACCEPTED'),
        ),
      );
    expect(memberships).toHaveLength(2);
  });

  it('creates an organization and creator MANAGER membership atomically', async () => {
    const created = await repo.createOrganization(
      `${testPrefix} atomic`,
      `${testPrefix}-atomic`,
      {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'SUPER_ADMIN',
      },
    );
    await expect(
      repo.findAcceptedMembership(created.id, managerUuid),
    ).resolves.toMatchObject({ role: 'MANAGER', status: 'ACCEPTED' });
  });

  it('keeps known-admin invitations PENDING until explicit acceptance', async () => {
    const invitation = await repo.createInvitation({
      organizationId: targetOrganizationId,
      inviteeEmail: `${testPrefix}-invitee@example.com`,
      inviteeIdpUuid: inviteeUuid,
      role: 'MEMBER',
      invitedByIdpUuid: managerUuid,
      actor: {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'ADMIN',
      },
    });
    expect(invitation).toMatchObject({
      memberIdpUuid: inviteeUuid,
      status: 'PENDING',
    });
    expect(
      await repo.findAcceptedMembership(targetOrganizationId, inviteeUuid),
    ).toBeNull();
    await expect(
      repo.listPendingInvitations(invitation.inviteeEmail, 'other-uuid'),
    ).resolves.toHaveLength(0);
    await expect(
      repo.rejectInvitation(
        invitation.id,
        invitation.inviteeEmail,
        'other-uuid',
      ),
    ).rejects.toBeInstanceOf(RepositoryAuthorizationError);

    await expect(
      repo.acceptInvitation(
        invitation.id,
        invitation.inviteeEmail,
        'same-email-different-uuid',
      ),
    ).rejects.toBeInstanceOf(RepositoryAuthorizationError);

    const accepted = await repo.acceptInvitation(
      invitation.id,
      invitation.inviteeEmail,
      inviteeUuid,
    );
    expect(accepted).toMatchObject({
      memberIdpUuid: inviteeUuid,
      status: 'ACCEPTED',
      acceptedAt: expect.any(Date),
    });
  });

  it('serializes concurrent mutations of different MANAGER rows', async () => {
    await db.insert(admins).values([
      {
        idpUuid: concurrentManagerAUuid,
        email: `${testPrefix}-concurrent-a@example.com`,
        name: 'Concurrent Manager A',
      },
      {
        idpUuid: concurrentManagerBUuid,
        email: `${testPrefix}-concurrent-b@example.com`,
        name: 'Concurrent Manager B',
      },
    ]);
    const [concurrentOrganization] = await db
      .insert(organizations)
      .values({
        name: `${testPrefix} concurrent managers`,
        slug: `${testPrefix}-concurrent-managers`,
        createdByIdpUuid: managerUuid,
      })
      .returning();
    const managerRows = await db
      .insert(organizationMemberships)
      .values([
        {
          organizationId: concurrentOrganization.id,
          inviteeEmail: `${testPrefix}-concurrent-a@example.com`,
          memberIdpUuid: concurrentManagerAUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
        {
          organizationId: concurrentOrganization.id,
          inviteeEmail: `${testPrefix}-concurrent-b@example.com`,
          memberIdpUuid: concurrentManagerBUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
      ])
      .returning();
    const root = {
      uuid: managerUuid,
      email: `${testPrefix}-manager@example.com`,
      role: 'SUPER_ADMIN',
    };
    const results = await Promise.all([
      repo.removeMembership(concurrentOrganization.id, managerRows[0].id, root),
      repo.updateMembershipRole(
        concurrentOrganization.id,
        managerRows[1].id,
        'MEMBER',
        root,
      ),
    ]);
    expect(
      results.filter((result) => result.kind === 'last_manager'),
    ).toHaveLength(1);
    const remainingManagers = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, concurrentOrganization.id),
          eq(organizationMemberships.status, 'ACCEPTED'),
          eq(organizationMemberships.role, 'MANAGER'),
        ),
      );
    expect(remainingManagers).toHaveLength(1);
  });

  it('enforces sole normalized admin identity and still deduplicates pending invites', async () => {
    const normalizedEmail = `${testPrefix}-collision@example.com`;
    const [unboundInvitation] = await db
      .insert(organizationMemberships)
      .values({
        organizationId: targetOrganizationId,
        inviteeEmail: normalizedEmail,
        memberIdpUuid: null,
        role: 'MEMBER',
        status: 'PENDING',
        invitedByIdpUuid: managerUuid,
      })
      .returning();
    await db.insert(admins).values({
      idpUuid: collisionAdminAUuid,
      email: `${testPrefix}-Collision@Example.com`,
      name: 'Collision A',
      role: 'SUPER_ADMIN',
    });
    await expect(
      db.insert(admins).values({
        idpUuid: collisionAdminBUuid,
        email: `${testPrefix}-collision@example.com`,
        name: 'Collision B',
        role: 'SUPER_ADMIN',
      }),
    ).rejects.toBeDefined();
    await db.insert(admins).values({
      idpUuid: collisionAdminBUuid,
      email: `${testPrefix}-collision-b@example.com`,
      name: 'Collision B',
      role: 'SUPER_ADMIN',
    });

    await expect(
      repo.listPendingInvitations(normalizedEmail, collisionAdminAUuid),
    ).resolves.toHaveLength(1);
    await expect(
      repo.acceptInvitation(
        unboundInvitation.id,
        normalizedEmail,
        collisionAdminAUuid,
      ),
    ).resolves.toMatchObject({
      id: unboundInvitation.id,
      status: 'ACCEPTED',
      memberIdpUuid: collisionAdminAUuid,
    });

    const [collisionOrganization] = await db
      .insert(organizations)
      .values({
        name: `${testPrefix} collision`,
        slug: `${testPrefix}-collision`,
        createdByIdpUuid: managerUuid,
      })
      .returning();
    await expect(
      db.insert(organizationMemberships).values([
        {
          organizationId: collisionOrganization.id,
          inviteeEmail: normalizedEmail,
          memberIdpUuid: collisionAdminAUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
        {
          organizationId: collisionOrganization.id,
          inviteeEmail: normalizedEmail,
          memberIdpUuid: collisionAdminBUuid,
          role: 'MANAGER',
          status: 'ACCEPTED',
          invitedByIdpUuid: managerUuid,
          acceptedAt: new Date(),
        },
      ]),
    ).resolves.toBeDefined();
    await db.insert(organizationMemberships).values({
      organizationId: collisionOrganization.id,
      inviteeEmail: `${testPrefix}-pending@example.com`,
      role: 'MEMBER',
      status: 'PENDING',
      invitedByIdpUuid: managerUuid,
    });
    await expect(
      db.insert(organizationMemberships).values({
        organizationId: collisionOrganization.id,
        inviteeEmail: `${testPrefix}-pending@example.com`,
        role: 'MEMBER',
        status: 'PENDING',
        invitedByIdpUuid: managerUuid,
      }),
    ).rejects.toBeDefined();
  });

  it("removes an uploader's rights immediately with their membership", async () => {
    const [created] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} member document`,
        resourceName: `${testPrefix}-member-document`,
        gcsPdfPath: `gs://test/${testPrefix}-member-document.pdf`,
        status: 'ready',
        uploadedByIdpUuid: memberUuid,
        ownerOrganizationId: sourceOrganizationId,
      })
      .returning();
    await expect(
      access.requireDocumentManage(created.id, {
        uuid: memberUuid,
        email: `${testPrefix}-member@example.com`,
        role: 'ADMIN',
      }),
    ).resolves.toMatchObject({ canManage: true });
    await expect(
      repo.updateDocumentExpiresAt({
        documentId: created.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        expiresAt: null,
        actor: {
          uuid: memberUuid,
          email: `${testPrefix}-member@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    const reservation = await repo.createUploadingDocument({
      title: `${testPrefix} pending member upload`,
      resourceName: `${testPrefix}-pending-member-upload`,
      gcsPdfPath: `gs://test/${testPrefix}-pending-member-upload.pdf`,
      ownerOrganizationId: sourceOrganizationId,
      expiresAt: null,
      actor: {
        uuid: memberUuid,
        email: `${testPrefix}-member@example.com`,
        role: 'ADMIN',
      },
    });
    await db.insert(organizationMemberships).values({
      organizationId: targetOrganizationId,
      inviteeEmail: `${testPrefix}-member@example.com`,
      memberIdpUuid: memberUuid,
      role: 'MEMBER',
      status: 'ACCEPTED',
      invitedByIdpUuid: managerUuid,
      acceptedAt: new Date(),
    });
    const [stillAuthorizedDocument] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} older authorized member document`,
        resourceName: `${testPrefix}-older-authorized-member-document`,
        gcsPdfPath: `gs://test/${testPrefix}-older-authorized-member-document.pdf`,
        status: 'ready',
        uploadedByIdpUuid: memberUuid,
        ownerOrganizationId: targetOrganizationId,
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
      })
      .returning();

    const [member] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, sourceOrganizationId),
          eq(organizationMemberships.memberIdpUuid, memberUuid),
        ),
      );
    await repo.removeMembership(sourceOrganizationId, member.id, {
      uuid: managerUuid,
      email: `${testPrefix}-manager@example.com`,
      role: 'ADMIN',
    });
    const ownAfterRemoval = await getUploadList(
      '/api/v1/admin/upload?limit=1',
      memberUuid,
    );
    const manageableAfterRemoval = await getUploadList(
      '/api/v1/admin/upload/manageable?limit=100',
      memberUuid,
    );
    expect(ownAfterRemoval.statusCode).toBe(200);
    expect(manageableAfterRemoval.statusCode).toBe(200);
    expect(responseIds(ownAfterRemoval.payload)).toEqual([
      stillAuthorizedDocument.id,
    ]);
    expect(responseIds(manageableAfterRemoval.payload)).toEqual([
      stillAuthorizedDocument.id,
    ]);
    await expect(
      access.requireDocumentManage(created.id, {
        uuid: memberUuid,
        email: `${testPrefix}-member@example.com`,
        role: 'ADMIN',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      repo.updateDocumentExpiresAt({
        documentId: created.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        expiresAt: null,
        actor: {
          uuid: memberUuid,
          email: `${testPrefix}-member@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      repo.finalizeUploadingDocument({
        documentId: reservation.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        actor: {
          uuid: memberUuid,
          email: `${testPrefix}-member@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      repo.createUploadingDocument({
        title: `${testPrefix} revoked upload`,
        resourceName: `${testPrefix}-revoked-upload`,
        gcsPdfPath: `gs://test/${testPrefix}-revoked-upload.pdf`,
        ownerOrganizationId: sourceOrganizationId,
        expiresAt: null,
        actor: {
          uuid: memberUuid,
          email: `${testPrefix}-member@example.com`,
          role: 'ADMIN',
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryAuthorizationError);
    await expect(
      repo.updateDocumentExpiresAt({
        documentId: created.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        expiresAt: null,
        actor: {
          uuid: managerUuid,
          email: `${testPrefix}-manager@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it('gives shared-organization members view-only access', async () => {
    const [created] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} shared document`,
        resourceName: `${testPrefix}-shared-document`,
        gcsPdfPath: `gs://test/${testPrefix}-shared-document.pdf`,
        status: 'ready',
        uploadedByIdpUuid: managerUuid,
        ownerOrganizationId: sourceOrganizationId,
      })
      .returning();
    await repo.setShare({
      documentId: created.id,
      expectedOwnerOrganizationId: sourceOrganizationId,
      targetOrganizationId,
      actor: {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'ADMIN',
      },
    });

    await expect(
      access.requireDocumentView(created.id, {
        uuid: inviteeUuid,
        email: `${testPrefix}-invitee@example.com`,
        role: 'ADMIN',
      }),
    ).resolves.toMatchObject({ relation: 'SHARED', canManage: false });
    await expect(
      repo.updateDocumentExpiresAt({
        documentId: created.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        expiresAt: null,
        actor: {
          uuid: inviteeUuid,
          email: `${testPrefix}-invitee@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      repo.listOrganizationDocuments(
        targetOrganizationId,
        {
          uuid: inviteeUuid,
          email: `${testPrefix}-invitee@example.com`,
          role: 'ADMIN',
        },
        {
          limit: 100,
          offset: 0,
        },
      ),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
  });

  it('requires target MANAGER permission and returns manageable documents once', async () => {
    await db.insert(admins).values({
      idpUuid: sourceOnlyManagerUuid,
      email: `${testPrefix}-source-only@example.com`,
      name: 'Source-only Manager',
    });
    await db.insert(organizationMemberships).values({
      organizationId: sourceOrganizationId,
      inviteeEmail: `${testPrefix}-source-only@example.com`,
      memberIdpUuid: sourceOnlyManagerUuid,
      role: 'MANAGER',
      status: 'ACCEPTED',
      invitedByIdpUuid: managerUuid,
      acceptedAt: new Date(),
    });
    const [created] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} target permission`,
        resourceName: `${testPrefix}-target-permission`,
        gcsPdfPath: `gs://test/${testPrefix}-target-permission.pdf`,
        status: 'ready',
        uploadedByIdpUuid: managerUuid,
        ownerOrganizationId: sourceOrganizationId,
      })
      .returning();
    const sourceOnlyActor = {
      uuid: sourceOnlyManagerUuid,
      email: `${testPrefix}-source-only@example.com`,
      role: 'ADMIN',
    };
    await expect(
      repo.transferDocument({
        documentId: created.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        targetOrganizationId,
        actor: sourceOnlyActor,
      }),
    ).resolves.toEqual({ kind: 'forbidden' });

    const manageable = await repo.listManageableDocuments(
      {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'ADMIN',
      },
      { limit: 100, offset: 0 },
    );
    expect(new Set(manageable.map((row) => row.id)).size).toBe(
      manageable.length,
    );
  });

  it('transfers ownership, removes the target share, audits, and preserves chunks/state', async () => {
    const [created] = await db
      .insert(documents)
      .values({
        title: `${testPrefix} transfer document`,
        resourceName: `${testPrefix}-transfer-document`,
        gcsPdfPath: `gs://test/${testPrefix}-transfer-document.pdf`,
        status: 'ready',
        uploadedByIdpUuid: managerUuid,
        ownerOrganizationId: sourceOrganizationId,
      })
      .returning();
    const [chunk] = await db
      .insert(documentChunks)
      .values({
        documentId: created.id,
        path: `${testPrefix}/chunk`,
        description: '',
        content: 'unchanged',
        sortOrder: 0,
      })
      .returning();
    await db.insert(documentOrganizationShares).values({
      documentId: created.id,
      organizationId: targetOrganizationId,
      sharedByIdpUuid: managerUuid,
    });

    const result = await repo.transferDocument({
      documentId: created.id,
      expectedOwnerOrganizationId: sourceOrganizationId,
      targetOrganizationId,
      actor: {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'ADMIN',
      },
    });
    expect(result).toMatchObject({
      kind: 'ok',
      document: {
        ownerOrganizationId: targetOrganizationId,
        status: 'ready',
      },
    });
    expect(
      await db
        .select()
        .from(documentOrganizationShares)
        .where(eq(documentOrganizationShares.documentId, created.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(documentOwnershipTransfers)
        .where(eq(documentOwnershipTransfers.documentId, created.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(documentChunks)
        .where(eq(documentChunks.documentId, created.id)),
    ).toEqual([
      expect.objectContaining({ id: chunk.id, content: 'unchanged' }),
    ]);
  });

  it('does not transfer an incomplete uploading reservation', async () => {
    const reservation = await repo.createUploadingDocument({
      title: `${testPrefix} incomplete transfer`,
      resourceName: `${testPrefix}-incomplete-transfer`,
      gcsPdfPath: `gs://test/${testPrefix}-incomplete-transfer.pdf`,
      ownerOrganizationId: sourceOrganizationId,
      expiresAt: null,
      actor: {
        uuid: managerUuid,
        email: `${testPrefix}-manager@example.com`,
        role: 'ADMIN',
      },
    });
    await expect(
      repo.transferDocument({
        documentId: reservation.id,
        expectedOwnerOrganizationId: sourceOrganizationId,
        targetOrganizationId,
        actor: {
          uuid: managerUuid,
          email: `${testPrefix}-manager@example.com`,
          role: 'ADMIN',
        },
      }),
    ).resolves.toMatchObject({ kind: 'state_changed' });
    await expect(
      db
        .select()
        .from(documentOwnershipTransfers)
        .where(eq(documentOwnershipTransfers.documentId, reservation.id)),
    ).resolves.toHaveLength(0);
  });

  it('keeps ready, active, non-expired chatbot retrieval global across owner organizations', async () => {
    const rows = await db
      .insert(documents)
      .values([
        {
          title: `${testPrefix} retrieval source`,
          resourceName: `${testPrefix}-retrieval-source`,
          gcsPdfPath: `gs://test/${testPrefix}-retrieval-source.pdf`,
          status: 'ready',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: sourceOrganizationId,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          title: `${testPrefix} retrieval target`,
          resourceName: `${testPrefix}-retrieval-target`,
          gcsPdfPath: `gs://test/${testPrefix}-retrieval-target.pdf`,
          status: 'ready',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: targetOrganizationId,
          expiresAt: null,
        },
        {
          title: `${testPrefix} retrieval inactive`,
          resourceName: `${testPrefix}-retrieval-inactive`,
          gcsPdfPath: `gs://test/${testPrefix}-retrieval-inactive.pdf`,
          status: 'ready',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: sourceOrganizationId,
          isActive: false,
        },
        {
          title: `${testPrefix} retrieval expired`,
          resourceName: `${testPrefix}-retrieval-expired`,
          gcsPdfPath: `gs://test/${testPrefix}-retrieval-expired.pdf`,
          status: 'ready',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: targetOrganizationId,
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          title: `${testPrefix} retrieval queued`,
          resourceName: `${testPrefix}-retrieval-queued`,
          gcsPdfPath: `gs://test/${testPrefix}-retrieval-queued.pdf`,
          status: 'queued',
          uploadedByIdpUuid: managerUuid,
          ownerOrganizationId: sourceOrganizationId,
        },
      ])
      .returning();
    await db.insert(documentChunks).values(
      rows.map((row, index) => ({
        documentId: row.id,
        path: `${testPrefix}/retrieval-${index}`,
        description: `retrieval ${index}`,
        content: `content ${index}`,
        sortOrder: 0,
      })),
    );

    const catalog = await retrievalRepo.listReadyWithChunks();
    const catalogIds = new Set(catalog.map((row) => row.id));
    expect(catalogIds.has(rows[0].id)).toBe(true);
    expect(catalogIds.has(rows[1].id)).toBe(true);
    expect(catalogIds.has(rows[2].id)).toBe(false);
    expect(catalogIds.has(rows[3].id)).toBe(false);
    expect(catalogIds.has(rows[4].id)).toBe(false);

    const paths = rows.map((_, index) => `${testPrefix}/retrieval-${index}`);
    const contents = await retrievalRepo.findChunkContentsByPaths(paths);
    expect(contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: paths[0], content: 'content 0' }),
        expect.objectContaining({ path: paths[1], content: 'content 1' }),
      ]),
    );
    const retrievedPaths = new Set(contents.map((row) => row.path));
    expect(retrievedPaths.has(paths[2])).toBe(false);
    expect(retrievedPaths.has(paths[3])).toBe(false);
    expect(retrievedPaths.has(paths[4])).toBe(false);
  });
});
