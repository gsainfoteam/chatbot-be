import { Module, Global, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DB_CONNECTION,
  createDatabaseConnection,
  runMigrations,
  type Database,
  type DatabaseConnectionParams,
} from './index';

@Global()
@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      useFactory: (configService: ConfigService): Database => {
        const host = configService.getOrThrow<string>('DB_HOST');
        const port = configService.getOrThrow<number>('DB_PORT');
        const user = configService.getOrThrow<string>('DB_USER');
        const password = configService.getOrThrow<string>('DB_PASSWORD');
        const database = configService.getOrThrow<string>('DB_NAME');

        // 환경 변수는 문자열이므로 명시적으로 boolean 변환
        const sslValue = configService.get<string>('DB_SSL', 'false');
        const ssl = sslValue === 'true';

        // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
        const params: DatabaseConnectionParams = {
          host,
          port,
          user,
          password,
          database,
          sslEnabled: ssl,
        };

        return createDatabaseConnection(params);
      },
      inject: [ConfigService],
    },
  ],
  exports: [DB_CONNECTION],
})
export class DbModule implements OnModuleInit {
  private readonly logger = new Logger(DbModule.name);

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    // Run migrations on startup
    const host = this.configService.getOrThrow<string>('DB_HOST');
    const port = this.configService.getOrThrow<number>('DB_PORT');
    const user = this.configService.getOrThrow<string>('DB_USER');
    const password = this.configService.getOrThrow<string>('DB_PASSWORD');
    const database = this.configService.getOrThrow<string>('DB_NAME');

    // 환경 변수는 문자열이므로 명시적으로 boolean 변환
    const sslValue = this.configService.get<string>('DB_SSL', 'false');
    const ssl = sslValue === 'true';

    // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
    const params: DatabaseConnectionParams = {
      host,
      port,
      user,
      password,
      database,
      sslEnabled: ssl,
    };

    this.logger.log(`Connecting to database at ${host}:${port}/${database}`);
    this.logger.log(`DB_SSL env value: ${sslValue}`);
    this.logger.log(`SSL enabled: ${ssl}`);

    try {
      await runMigrations(params);
      this.logger.log('Database migrations completed');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to run migrations', errorMessage);
      throw error;
    }
  }
}
