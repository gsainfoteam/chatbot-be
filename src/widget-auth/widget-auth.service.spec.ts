import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Database } from '../db';
import { WidgetSessionRequestDto } from '../common/dto/widget-session-request.dto';
import { WidgetAuthService } from './widget-auth.service';

const createService = (widgetKeyId: string) => {
  const inserted: Record<string, unknown>[] = [];
  const key = {
    id: widgetKeyId,
    status: 'ACTIVE',
    allowedDomains: ['example.com'],
  };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [key] }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: 'session-1' }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  const jwtService = { signAsync: jest.fn().mockResolvedValue('token') };
  const service = new WidgetAuthService(
    db as unknown as Database,
    jwtService as unknown as JwtService,
    {} as ConfigService,
  );
  return { service, inserted };
};

const request = (clientId?: string) => ({
  widgetKey: 'wk_test',
  pageUrl: 'https://example.com/help',
  ...(clientId === undefined ? {} : { clientId }),
});

describe('WidgetAuthService end user key', () => {
  it('stores the client id as a hash scoped to the widget key', async () => {
    const first = createService('key-1');
    const second = createService('key-2');

    await first.service.createSession(request('device-1'));
    await second.service.createSession(request('device-1'));

    expect(first.inserted[0].endUserKey).toBe(
      createHash('sha256').update('key-1:device-1').digest('hex'),
    );
    expect(second.inserted[0].endUserKey).not.toBe(
      first.inserted[0].endUserKey,
    );
  });

  it('leaves the end user key empty without a client id', async () => {
    const { service, inserted } = createService('key-1');

    await service.createSession(request());

    expect(inserted[0].endUserKey).toBeNull();
  });

  it('accepts an optional client id of 1 to 128 characters', async () => {
    const errors = (clientId?: string) =>
      validate(plainToInstance(WidgetSessionRequestDto, request(clientId)));

    expect(await errors()).toHaveLength(0);
    expect(await errors('x'.repeat(128))).toHaveLength(0);
    expect(await errors('')).not.toHaveLength(0);
    expect(await errors('x'.repeat(129))).not.toHaveLength(0);
  });
});
