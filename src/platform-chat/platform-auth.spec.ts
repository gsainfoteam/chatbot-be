import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessionGuard } from './platform-session.guard';
import type { Database } from '../db';

const keyId = '550e8400-e29b-41d4-a716-446655440000';
const jwt = new JwtService({ secret: 'test-secret-for-platform-tests-only' });
function setup(enabled = true) {
  let stored: Record<string, unknown>;
  const db = {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest
        .fn()
        .mockResolvedValue([
          { id: keyId, status: 'ACTIVE', allowedDomains: ['example.com'] },
        ]),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(async (value) => {
        stored = value;
      }),
    })),
  };
  const auth = new PlatformAuthService(
    db as unknown as Database,
    new ConfigService({
      PLATFORM_CHAT_ENABLED: enabled,
      PLATFORM_WIDGET_KEY_ID: keyId,
    }),
    jwt,
  );
  return { db, auth, stored: () => stored! };
}

describe('platform anonymous authentication', () => {
  it('sets both JWT and DB expiry to 30 minutes, without sharing a conversation identity', async () => {
    const { auth, stored } = setup();
    const before = Date.now();
    const result = await auth.createSession(
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
  it('disables issuance by default and rejects mismatched origins or unapproved domains', async () => {
    await expect(
      setup(false).auth.createSession('https://example.com'),
    ).rejects.toThrow();
    const { auth, db } = setup();
    await expect(
      auth.createSession('https://example.com', 'https://evil.example'),
    ).rejects.toThrow();
    await expect(auth.createSession('https://evil.example')).rejects.toThrow();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('rejects widget tokens before accessing the platform session store', async () => {
    const { auth, db } = setup();
    const token = jwt.sign({ sessionId: 's', widgetKeyId: keyId });
    const req = { headers: { authorization: 'Bearer ' + token } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new PlatformSessionGuard(
      db as unknown as Database,
      jwt,
      auth,
    );
    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
  it('rejects expired tokens and sessions that no longer exist', async () => {
    const { auth, db } = setup();
    const guard = new PlatformSessionGuard(
      db as unknown as Database,
      jwt,
      auth,
    );
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
});
