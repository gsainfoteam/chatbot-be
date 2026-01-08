import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Database connection factory
export const createDatabaseConnection = (connectionString: string) => {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
};

// Type exports
export type Database = ReturnType<typeof createDatabaseConnection>;
export * from './schema';
