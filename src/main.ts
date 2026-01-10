import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger 설정
  const config = new DocumentBuilder()
    .setTitle('Chat Widget Auth & History API')
    .setDescription(
      '채팅 위젯의 인증(Auth) 및 대화 내역 저장(History Storage)을 담당하는 백엔드 API',
    )
    .setVersion('1.3.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: '관리자용 토큰 (Admin Dashboard)',
      },
      'bearerAuth',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '위젯 세션 토큰 (Widget Client)',
      },
      'widgetSessionAuth',
    )
    .addTag('Widget Auth', '(Public) 위젯 초기화 및 세션 발급')
    .addTag('Widget Messages', '(Public) 대화 내역 저장 및 조회')
    .addTag('Admin Management', '(Private) 위젯 키 관리')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // ConfigService를 통해 환경 변수 가져오기 (검증된 값)
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // CORS 설정
  app.enableCors({
    origin: [
      'http://localhost:5173',
      `https://${configService.get<string>('DOMAIN_NAME') ?? ''}`,
    ],
    credentials: true,
  });

  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation: http://localhost:${port}/api/docs`);
}
bootstrap();
