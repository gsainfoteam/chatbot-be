import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabaseConnection, type Database } from './index';

export const DB_CONNECTION = Symbol('DB_CONNECTION');

@Global()
@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      useFactory: (configService: ConfigService): Database => {
        const host = configService.get<string>('DB_HOST', 'localhost');
        const port = configService.get<number>('DB_PORT', 5432);
        const user = configService.get<string>('DB_USER', 'postgres');
        const password = configService.get<string>('DB_PASSWORD', 'postgres');
        const database = configService.get<string>('DB_NAME', 'ziggle_chatbot');
        const ssl = configService.get<string>('DB_SSL', 'false') === 'true';

        const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}${ssl ? '?sslmode=require' : ''}`;

        return createDatabaseConnection(connectionString);
      },
      inject: [ConfigService],
    },
  ],
  exports: [DB_CONNECTION],
})
export class DbModule {}
