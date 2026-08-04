import {
  BadRequestException,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AdminContext } from '../src/auth/context/admin-context.entity';
import { AdminJwtGuard } from '../src/auth/guards/admin-jwt.guard';
import { SuperAdminGuard } from '../src/auth/guards/super-admin.guard';
import { OrganizationAccessService } from '../src/organizations/organization-access.service';
import { OrganizationsController } from '../src/organizations/organizations.controller';
import { OrganizationsRepository } from '../src/organizations/organizations.repository';
import { OrganizationsService } from '../src/organizations/organizations.service';

type AdminRequest = FastifyRequest & { user?: AdminContext };

class TestAdminGuard {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    request.user = new AdminContext(
      String(request.headers['x-admin-email'] ?? 'admin@example.com'),
      String(request.headers['x-admin-uuid'] ?? 'admin'),
      'Test Admin',
      String(request.headers['x-admin-role'] ?? 'ADMIN'),
    );
    return true;
  }
}

const ORG_ID = '550e8400-e29b-41d4-a716-446655440010';
const MEMBERSHIP_ID = '550e8400-e29b-41d4-a716-446655440011';

function pendingMembership() {
  return {
    id: MEMBERSHIP_ID,
    organizationId: ORG_ID,
    inviteeEmail: 'invitee@example.com',
    memberIdpUuid: 'invitee',
    role: 'MEMBER' as const,
    status: 'PENDING' as const,
    invitedByIdpUuid: 'manager',
    acceptedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

describe('Organization administration API (e2e)', () => {
  let app: NestFastifyApplication | undefined;
  const repo = {
    createOrganization: jest.fn(async () => ({
      id: ORG_ID,
      name: 'Student Support',
      slug: 'student-support',
      isDefault: false,
      createdByIdpUuid: 'root',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    })),
    findAdminByEmail: jest.fn(async () => ({ idpUuid: 'invitee' })),
    createInvitation: jest.fn(async () => pendingMembership()),
    findMembershipById: jest.fn(async () => pendingMembership()),
    acceptInvitation: jest.fn(async () => ({
      ...pendingMembership(),
      status: 'ACCEPTED' as const,
      acceptedAt: new Date('2026-08-01T00:01:00.000Z'),
    })),
  };
  const access = {
    isSuperAdmin: jest.fn(
      (admin: AdminContext) => admin.role === 'SUPER_ADMIN',
    ),
    requireOrganizationManager: jest.fn(async () => null),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        OrganizationsService,
        SuperAdminGuard,
        { provide: OrganizationsRepository, useValue: repo },
        { provide: OrganizationAccessService, useValue: access },
      ],
    })
      .overrideGuard(AdminJwtGuard)
      .useClass(TestAdminGuard)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: (errors) =>
          new BadRequestException({
            statusCode: 400,
            message: errors.flatMap((error) =>
              Object.values(error.constraints ?? {}),
            ),
            error: 'Bad Request',
          }),
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());

  it('rejects organization creation by a non-SUPER_ADMIN', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { 'x-admin-role': 'ADMIN' },
        payload: { name: 'Student Support', slug: 'student-support' },
      });
    expect(response.statusCode).toBe(403);
    expect(repo.createOrganization).not.toHaveBeenCalled();
  });

  it('creates an organization through the atomic service operation for SUPER_ADMIN', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: {
          'x-admin-role': 'SUPER_ADMIN',
          'x-admin-uuid': 'root',
        },
        payload: { name: 'Student Support', slug: 'student-support' },
      });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload)).toEqual({
      id: ORG_ID,
      name: 'Student Support',
      slug: 'student-support',
      isDefault: false,
      effectiveRole: 'SUPER_ADMIN',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    expect(repo.createOrganization).toHaveBeenCalledTimes(1);
  });

  it('keeps a known admin invitation PENDING', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/v1/admin/organizations/${ORG_ID}/members`,
        headers: {
          'x-admin-email': 'manager@example.com',
          'x-admin-uuid': 'manager',
        },
        payload: { inviteeEmail: ' Invitee@Example.com ', role: 'MEMBER' },
      });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload)).toEqual({
      id: MEMBERSHIP_ID,
      organizationId: ORG_ID,
      inviteeEmail: 'invitee@example.com',
      memberIdpUuid: 'invitee',
      role: 'MEMBER',
      status: 'PENDING',
      memberName: null,
      acceptedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('forbids a different email from accepting the invitation', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/v1/admin/organization-invitations/${MEMBERSHIP_ID}/accept`,
        headers: {
          'x-admin-email': 'other@example.com',
          'x-admin-uuid': 'other',
        },
      });
    expect(response.statusCode).toBe(403);
    expect(repo.acceptInvitation).not.toHaveBeenCalled();
  });

  it('accepts explicitly for the invited normalized email', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/v1/admin/organization-invitations/${MEMBERSHIP_ID}/accept`,
        headers: {
          'x-admin-email': 'INVITEE@example.com',
          'x-admin-uuid': 'invitee',
        },
      });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload).status).toBe('ACCEPTED');
    expect(repo.acceptInvitation).toHaveBeenCalledWith(
      MEMBERSHIP_ID,
      'invitee@example.com',
      'invitee',
    );
  });

  it('rejects invalid organization slugs through the global validation contract', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { 'x-admin-role': 'SUPER_ADMIN' },
        payload: { name: 'Invalid', slug: 'Not Valid' },
      });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an organization name containing only whitespace', async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { 'x-admin-role': 'SUPER_ADMIN' },
        payload: { name: '   ', slug: 'blank-name' },
      });
    expect(response.statusCode).toBe(400);
    expect(repo.createOrganization).not.toHaveBeenCalled();
  });
});
