import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminBearerGuard } from '../auth/guards/admin-bearer.guard';
import { CreateWidgetKeyDto } from '../common/dto/create-widget-key.dto';
import { WidgetKeyDto } from '../common/dto/widget-key.dto';

@ApiTags('Admin Management')
@Controller('api/v1/admin')
@UseGuards(AdminBearerGuard)
@ApiBearerAuth('bearerAuth')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('widget-keys')
  @ApiOperation({
    summary: '위젯 키 목록 조회',
    description: '모든 위젯 키 목록을 조회합니다.',
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: [WidgetKeyDto],
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getAllWidgetKeys(): Promise<WidgetKeyDto[]> {
    return this.adminService.getAllWidgetKeys();
  }

  @Post('widget-keys')
  @ApiOperation({
    summary: '위젯 키 생성',
    description: `새로운 위젯 키를 생성합니다. 생성된 직후 secretKey가 반환됩니다.

**도메인 등록 규칙:**
- 프로토콜(https://)은 제외하고 입력하세요.
- *.example.com 와일드카드 지원.`,
  })
  @ApiResponse({
    status: 201,
    description: '생성 성공',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 요청 (도메인에 프로토콜 포함 등)',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async createWidgetKey(
    @Body() dto: CreateWidgetKeyDto,
  ): Promise<WidgetKeyDto> {
    return this.adminService.createWidgetKey(dto);
  }

  @Patch('widget-keys/:widgetKeyId/revoke')
  @ApiOperation({
    summary: '위젯 키 폐기 (Revoke)',
    description:
      '특정 키를 REVOKED 상태로 변경하여 더 이상 세션 발급이 불가능하게 만듭니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '폐기할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '폐기 성공 (상태 변경됨)',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 Key ID',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async revokeWidgetKey(
    @Param('widgetKeyId') widgetKeyId: string,
  ): Promise<WidgetKeyDto> {
    return this.adminService.revokeWidgetKey(widgetKeyId);
  }
}
