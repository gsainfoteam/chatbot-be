import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../db';
import { WidgetSessionRequestDto } from '../common/dto/widget-session-request.dto';
import { WidgetAuthService } from './widget-auth.service';

const dialect = new PgDialect();

const widgetKey = {
  id: 'widget-key-1',
  status: 'ACTIVE',
  allowedDomains: ['www.example.com'],
  allowedAppIds: [],
};

interface SessionRow {
  id: string;
  sessionToken: string;
  endUserKey?: string | null;
}

/**
 * 위젯 키 조회와 sessions 쓰기를 흉내 내는 fake DB.
 * insert에서 sessions_session_token_unique 제약을 검사해 겹친 요청의 충돌을 재현한다.
 * 토큰을 나중에 채우는 구현도 같은 제약 위반으로 실패하도록 returning과 update를 지원한다.
 */
class FakeDb {
  readonly sessionRows: SessionRow[] = [];

  select() {
    return {
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([widgetKey]) }),
      }),
    };
  }

  insert() {
    return {
      values: (values: Omit<SessionRow, 'id'> & { id?: string }) => {
        const inserted = this.insertSession(values);
        return Object.assign(inserted, {
          returning: () => inserted.then((row) => [row]),
        });
      },
    };
  }

  update() {
    return {
      set: ({ sessionToken }: { sessionToken: string }) => ({
        where: (condition: SQL) => {
          const [id] = dialect.sqlToQuery(condition).params;
          const row = this.sessionRows.find((session) => session.id === id);
          if (row) row.sessionToken = sessionToken;
          return Promise.resolve();
        },
      }),
    };
  }

  private insertSession(values: Omit<SessionRow, 'id'> & { id?: string }) {
    if (
      this.sessionRows.some(
        (session) => session.sessionToken === values.sessionToken,
      )
    ) {
      return Promise.reject<SessionRow>(
        new Error(
          'duplicate key value violates unique constraint "sessions_session_token_unique"',
        ),
      );
    }
    const row = { id: randomUUID(), ...values };
    this.sessionRows.push(row);
    return Promise.resolve<SessionRow>(row);
  }
}

describe('WidgetAuthService.createSession', () => {
  const dto = { widgetKey: 'wk_test', pageUrl: 'https://www.example.com/chat' };
  let db: FakeDb;
  let jwtService: JwtService;
  let service: WidgetAuthService;

  beforeEach(() => {
    db = new FakeDb();
    jwtService = new JwtService({ secret: 'test-secret' });
    service = new WidgetAuthService(
      db as unknown as Database,
      jwtService,
      new ConfigService(),
    );
  });

  it('creates a session for every overlapping request', async () => {
    const results = await Promise.allSettled([
      service.createSession(dto),
      service.createSession(dto),
      service.createSession(dto),
    ]);

    expect(results.filter((result) => result.status === 'rejected')).toEqual(
      [],
    );
    expect(db.sessionRows).toHaveLength(3);
  });

  it('stores the issued token on the session it points to', async () => {
    const { sessionToken } = await service.createSession(dto);

    expect(db.sessionRows).toHaveLength(1);
    const [row] = db.sessionRows;
    expect(row.sessionToken).toBe(sessionToken);
    await expect(jwtService.verifyAsync(sessionToken)).resolves.toMatchObject({
      sessionId: row.id,
      widgetKeyId: 'widget-key-1',
    });
  });

  it('stores the client id as a hash scoped to the widget key', async () => {
    await service.createSession({ ...dto, clientId: 'device-1' });

    expect(db.sessionRows[0].endUserKey).toBe(
      createHash('sha256').update('widget-key-1:device-1').digest('hex'),
    );
  });

  it('leaves the end user key empty without a client id', async () => {
    await service.createSession(dto);

    expect(db.sessionRows[0].endUserKey).toBeNull();
  });

  it('accepts an optional client id of 1 to 128 characters', async () => {
    const errors = (clientId?: string) =>
      validate(
        plainToInstance(WidgetSessionRequestDto, {
          ...dto,
          ...(clientId === undefined ? {} : { clientId }),
        }),
      );

    expect(await errors()).toHaveLength(0);
    expect(await errors('x'.repeat(128))).toHaveLength(0);
    expect(await errors('')).not.toHaveLength(0);
    expect(await errors('x'.repeat(129))).not.toHaveLength(0);
  });
});
