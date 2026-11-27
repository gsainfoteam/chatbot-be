import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessionGuard } from './platform-session.guard';
import type { Database } from '../db';
import { PgDialect } from 'drizzle-orm/pg-core';

const keyId = '550e8400-e29b-41d4-a716-446655440000';
const jwt = new JwtService({ secret: 'test-secret-for-platform-tests-only' });
function setup(id = keyId) {
  let stored: Record<string, unknown>;
  const db = {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        {
          id,
          widgetKeyId: id,
          status: 'ACTIVE',
          allowedDomains: ['example.com'],
        },
      ]),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(async (value) => {
        stored = value;
      }),
    })),
  };
  const auth = new PlatformAuthService(db as unknown as Database, jwt);
  return { db, auth, stored: () => stored! };
}

describe('platform anonymous authentication', () => {
  it.each([
    ['wk_first', '550e8400-e29b-41d4-a716-446655440001'],
    ['wk_second', '550e8400-e29b-41d4-a716-446655440002'],
  ])(
    'issues a session for %s without a configured allowlist',
    async (secretKey, id) => {
      const { auth, db, stored } = setup(id);
      const result = await auth.createSession(
        secretKey,
        'https://example.com/chat',
      );
      const query = db.select.mock.results[0].value.where.mock.calls[0][0];
      expect(new PgDialect().sqlToQuery(query).params).toEqual([secretKey]);
      expect(stored().widgetKeyId).toBe(id);
      expect(jwt.verify(result.sessionToken).widgetKeyId).toBe(id);
    },
  );

  it.each([
    { rows: [] },
    {
      rows: [{ id: keyId, status: 'REVOKED', allowedDomains: ['example.com'] }],
    },
  ])('rejects an invalid or revoked key', async ({ rows }) => {
    const { auth, db } = setup();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    });
    await expect(
      auth.createSession('wk_invalid', 'https://example.com'),
    ).rejects.toThrow();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('sets both JWT and DB expiry to 30 minutes, without sharing a conversation identity', async () => {
    const { auth, stored } = setup();
    const before = Date.now();
    const result = await auth.createSession(
      'wk_test_a',
      'https://example.com/chat',
      'https://example.com',
    );
    const claims = jwt.verify(result.sessionToken);
    expect(claims.channel).toBe('platform');
    expect(claims.exp - claims.iat).toBe(1800);
    expect(stored().channel).toBe('platform');
    expect(
      (stored().expiresAt as Date).getTime() - before,
    ).toBeGreaterThanOrEqual(1800000);
    expect(result.sessionId).toBe(stored().id);
  });
  it('rejects mismatched origins and unapproved domains without feature flags', async () => {
    const { auth, db } = setup();
    await expect(
      auth.createSession(
        'wk_test_a',
        'https://example.com',
        'https://evil.example',
      ),
    ).rejects.toThrow();
    await expect(
      auth.createSession('wk_test_a', 'https://evil.example'),
    ).rejects.toThrow();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('rejects widget tokens before accessing the platform session store', async () => {
    const { db } = setup();
    const token = jwt.sign({ sessionId: 's', widgetKeyId: keyId });
    const req = { headers: { authorization: 'Bearer ' + token } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new PlatformSessionGuard(db as unknown as Database, jwt);
    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
  it('rejects expired tokens and sessions that no longer exist', async () => {
    const { db } = setup();
    const guard = new PlatformSessionGuard(db as unknown as Database, jwt);
    const context = (token: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization: 'Bearer ' + token } }),
        }),
      }) as unknown as ExecutionContext;
    await expect(
      guard.canActivate(
        context(
          jwt.sign(
            { channel: 'platform', widgetKeyId: keyId, sessionId: 's' },
            { expiresIn: -1 },
          ),
        ),
      ),
    ).rejects.toThrow();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    });
    await expect(
      guard.canActivate(
        context(
          jwt.sign({ channel: 'platform', widgetKeyId: keyId, sessionId: 's' }),
        ),
      ),
    ).rejects.toThrow();
  });

  it.each([
    '550e8400-e29b-41d4-a716-446655440001',
    '550e8400-e29b-41d4-a716-446655440002',
  ])('accepts a valid platform session for widget %s', async (id) => {
    const { db } = setup(id);
    const token = jwt.sign({
      channel: 'platform',
      widgetKeyId: id,
      sessionId: id,
    });
    const req: {
      headers: { authorization: string };
      session?: { widgetKeyId: string };
    } = { headers: { authorization: 'Bearer ' + token } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new PlatformSessionGuard(db as unknown as Database, jwt);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.session?.widgetKeyId).toBe(id);
    const query = db.select.mock.results[0].value.where.mock.calls[0][0];
    const params = new PgDialect().sqlToQuery(query).params;
    expect(params).toEqual([
      id,
      id,
      'platform',
      token,
      expect.any(String),
      'ACTIVE',
    ]);
  });
});
