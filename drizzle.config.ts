import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: process.env.NODE_ENV === 'production' 
    ? './dist/db/schema.js' 
    : './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'ziggle_chatbot',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  verbose: true,
  strict: true,
});
