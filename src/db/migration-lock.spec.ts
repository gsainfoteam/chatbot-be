import { describe, expect, it, jest } from '@jest/globals';
import {
  type MigrationAdvisoryLockClient,
  withMigrationAdvisoryLock,
} from './index';

describe('withMigrationAdvisoryLock', () => {
  it('holds the session lock for the complete migration operation', async () => {
    const events: string[] = [];
    const client: MigrationAdvisoryLockClient = {
      unsafe: jest.fn(async (query: string) => {
        events.push(query.includes('unlock') ? 'unlock' : 'lock');
      }),
    };

    await withMigrationAdvisoryLock(client, async () => {
      events.push('migrate');
    });

    expect(events).toEqual(['lock', 'migrate', 'unlock']);
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
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('pg_advisory_lock');
    expect(queries[1]).toContain('pg_advisory_unlock');
  });
});
