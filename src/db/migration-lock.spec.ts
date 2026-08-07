import { describe, expect, it, jest } from '@jest/globals';
import {
  type MigrationAdvisoryLockClient,
  type ReservableMigrationClient,
  type ReservedMigrationConnection,
  withMigrationAdvisoryLock,
  withReservedMigrationConnection,
} from './index';

describe('withMigrationAdvisoryLock', () => {
  it('holds the session lock for the complete migration operation', async () => {
    const events: string[] = [];
    const client: MigrationAdvisoryLockClient = {
      unsafe: jest.fn(async (query: string) => {
        if (query.includes('lock_timeout = DEFAULT')) events.push('reset');
        else if (query.includes('lock_timeout')) events.push('timeout');
        else events.push(query.includes('unlock') ? 'unlock' : 'lock');
      }),
    };

    await withMigrationAdvisoryLock(client, async () => {
      events.push('migrate');
    });

    expect(events).toEqual(['timeout', 'lock', 'reset', 'migrate', 'unlock']);
  });

  it('releases the session lock when migration fails', async () => {
    const queries: string[] = [];
    const client: MigrationAdvisoryLockClient = {
      unsafe: jest.fn(async (query: string) => {
        queries.push(query);
      }),
    };

    await expect(
      withMigrationAdvisoryLock(client, async () => {
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');
    expect(queries.some((query) => query.includes('pg_advisory_lock'))).toBe(
      true,
    );
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
  });

  it('does not replace a migration failure with an unlock failure', async () => {
    const migrationError = new Error('migration failed');
    const client: MigrationAdvisoryLockClient = {
      unsafe: jest.fn(async (query: string) => {
        if (query.includes('pg_advisory_unlock')) {
          throw new Error('unlock failed');
        }
      }),
    };

    await expect(
      withMigrationAdvisoryLock(client, async () => {
        throw migrationError;
      }),
    ).rejects.toBe(migrationError);
  });

  it.each([false, true])(
    'always releases the reserved connection when operation failure is %s',
    async (shouldFail) => {
      const release = jest.fn();
      const connection: ReservedMigrationConnection = {
        unsafe: jest.fn(async () => undefined),
        release,
      };
      const client: ReservableMigrationClient = {
        reserve: jest.fn(async () => connection),
        end: jest.fn(async () => undefined),
      };
      const operation = withReservedMigrationConnection(client, async () => {
        if (shouldFail) throw new Error('migration failed');
        return 'migrated';
      });

      if (shouldFail)
        await expect(operation).rejects.toThrow('migration failed');
      else await expect(operation).resolves.toBe('migrated');
      expect(release).toHaveBeenCalledTimes(1);
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it('closes the migration client when reserving a connection fails', async () => {
    const client: ReservableMigrationClient = {
      reserve: jest.fn(async () => {
        throw new Error('reserve failed');
      }),
      end: jest.fn(async () => undefined),
    };

    await expect(
      withReservedMigrationConnection(client, async () => undefined),
    ).rejects.toThrow('reserve failed');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('sets a finite wait timeout before acquiring the advisory lock', async () => {
    const queries: string[] = [];
    const client: MigrationAdvisoryLockClient = {
      unsafe: jest.fn(async (query: string) => {
        queries.push(query);
      }),
    };

    await withMigrationAdvisoryLock(client, async () => undefined);

    expect(queries[0]).toContain('lock_timeout');
    expect(queries[0]).toContain('30000ms');
    expect(queries[1]).toContain('pg_advisory_lock');
  });
});
