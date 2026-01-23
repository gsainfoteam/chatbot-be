import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Options } from 'postgres';
import * as schema from './schema';

// Database connection token
export const DB_CONNECTION = Symbol('DB_CONNECTION');

// Database connection factory with SSL options
export const createDatabaseConnection = (
  connectionString: string,
  sslEnabled: boolean = false,
) => {
  const options: Options<{}> = {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };

  const client = postgres(connectionString, options);
  return drizzle(client, { schema });
};

// Run migrations with SSL options
export const runMigrations = async (
  connectionString: string,
  sslEnabled: boolean = false,
) => {
  console.log('Running database migrations...');
  console.log('SSL Enabled:', sslEnabled);
  
  // Create a separate connection for migrations
  const options: Options<{}> = {
    max: 1,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };
  
  const migrationClient = postgres(connectionString, options);
  const db = drizzle(migrationClient);
  
  // Determine migrations folder path based on environment
  const migrationsFolder = process.env.NODE_ENV === 'production' 
    ? '/app/drizzle'  // Docker container path
    : './drizzle';     // Local development path
  
  console.log(`Using migrations folder: ${migrationsFolder}`);
  
  try {
    await migrate(db, { migrationsFolder });
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await migrationClient.end();
  }
};

// Type exports
export type Database = ReturnType<typeof createDatabaseConnection>;
export * from './schema';
