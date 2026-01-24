import { Module, Global, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DB_CONNECTION,
  createDatabaseConnection,
  runMigrations,
  type Database,
} from './index';

@Global()
@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      useFactory: (configService: ConfigService): Database => {
        const host = configService.get<string>('DB_HOST');
        const port = configService.get<number>('DB_PORT');
        const user = configService.get<string>('DB_USER');
        const password = configService.get<string>('DB_PASSWORD');
        const database = configService.get<string>('DB_NAME');

        // 환경 변수는 문자열이므로 명시적으로 boolean 변환
        const sslValue = configService.get<string>('DB_SSL', 'false');
        const ssl = sslValue === 'true';

        // 보안: connectionString에 비밀번호가 포함되어 있으므로 로그에 출력하지 않음
        const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;

        return createDatabaseConnection(connectionString, ssl);
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
    const host = this.configService.get<string>('DB_HOST');
    const port = this.configService.get<number>('DB_PORT');
    const user = this.configService.get<string>('DB_USER');
    const password = this.configService.get<string>('DB_PASSWORD');
    const database = this.configService.get<string>('DB_NAME');

    // 환경 변수는 문자열이므로 명시적으로 boolean 변환
    const sslValue = this.configService.get<string>('DB_SSL', 'false');
    const ssl = sslValue === 'true';

    const connectionString = `postgres://${user}:${password}@${host}:${port}/${database}`;

    // 보안: connectionString에 비밀번호가 포함되어 있으므로 로그에 출력하지 않음
    this.logger.log(`Connecting to database at ${host}:${port}/${database}`);
    this.logger.log(`DB_SSL env value: ${sslValue}`);
    this.logger.log(`SSL enabled: ${ssl}`);

    try {
      await runMigrations(connectionString, ssl);
      this.logger.log('Database migrations completed');
    } catch (error) {
      // 보안: connectionString이 에러 메시지에 포함되지 않도록 주의
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // connectionString이 포함된 에러 메시지를 제거
      const sanitizedMessage = errorMessage.replace(
        /postgres:\/\/[^@]+@[^\s]+/g,
        'postgres://***:***@***',
      );
      this.logger.error('Failed to run migrations', sanitizedMessage);
      throw error;
    }
  }
}
