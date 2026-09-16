import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppService, HealthStatus } from './app.service';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: '서버 상태 확인',
    description:
      '서버가 정상적으로 동작 중인지 확인하는 헬스 체크 엔드포인트입니다.',
  })
  @ApiResponse({
    status: 200,
    description: '서버 정상 동작',
    schema: {
      type: 'string',
      example: 'Hello World!',
    },
  })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @ApiOperation({
    summary: '서버 프로세스 생존 확인',
    description:
      '프로세스가 살아 있는지 확인하는 라이브니스 엔드포인트입니다. 인증이 필요하지 않으며, DB 등 의존성은 검사하지 않습니다.',
  })
  @ApiResponse({
    status: 200,
    description: '서버 정상 동작',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          example: 'ok',
        },
      },
    },
  })
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}
