import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

// Database connection token
export const DB_CONNECTION = Symbol('DB_CONNECTION');

// Database connection parameters
export interface DatabaseConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslEnabled: boolean;
}

const MIGRATION_LOCK_SQL = 'SELECT pg_advisory_lock(1128352846, 1667785076)';
const MIGRATION_UNLOCK_SQL =
  'SELECT pg_advisory_unlock(1128352846, 1667785076)';

export interface MigrationAdvisoryLockClient {
  unsafe(query: string): PromiseLike<unknown>;
}

/** Serialize startup migrators across every application instance. */
export async function withMigrationAdvisoryLock<T>(
  client: MigrationAdvisoryLockClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.unsafe(MIGRATION_LOCK_SQL);
  try {
    return await operation();
  } finally {
    await client.unsafe(MIGRATION_UNLOCK_SQL);
  }
}

// Database connection factory with SSL options
export const createDatabaseConnection = (params: DatabaseConnectionParams) => {
  const options = {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: params.sslEnabled ? { rejectUnauthorized: false } : false,
  };

  // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
  const client = postgres({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.user,
    password: params.password,
    ...options,
  });
  return drizzle(client, { schema });
};

// Run migrations with SSL options
export const runMigrations = async (params: DatabaseConnectionParams) => {
  // Create a separate connection for migrations
  // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
  const migrationClient = postgres({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.user,
    password: params.password,
    max: 1,
    ssl: params.sslEnabled ? { rejectUnauthorized: false } : false,
  });
  const db = drizzle(migrationClient);

  // Determine migrations folder path based on environment
  const migrationsFolder =
    process.env.NODE_ENV === 'production'
      ? '/app/drizzle' // Docker container path
      : './drizzle'; // Local development path

  try {
    await withMigrationAdvisoryLock(migrationClient, () =>
      migrate(db, { migrationsFolder }),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Migration failed:', errorMessage);
    throw error;
  } finally {
    await migrationClient.end();
  }
};

// Type exports
export type Database = ReturnType<typeof createDatabaseConnection>;
export * from './schema';
