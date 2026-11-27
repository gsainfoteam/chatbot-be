import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminContext } from '../auth/context/admin-context.entity';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import {
  MonthlyReportDto,
  MonthlyReportQueryDto,
} from './dto/monthly-report.dto';
import { ReportsService } from './reports.service';

@ApiTags('Admin Reports')
@ApiBearerAuth('bearerAuth')
@UseGuards(AdminJwtGuard)
@Controller('api/v1/admin/widget-keys')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':widgetKeyId/reports/monthly')
  @ApiOperation({
    summary: '월간 보고서',
    description:
      'KST 달력 월 기준으로 위젯 키의 이용 현황과 문제 답변(BAD 피드백, 참고 자료 없는 답변)을 집계합니다. 요청할 때 계산하므로 진행 중인 달도 조회할 수 있습니다. 키 소유자, 수락한 협업자, SUPER_ADMIN이 볼 수 있습니다.',
  })
  @ApiParam({ name: 'widgetKeyId', format: 'uuid' })
  @ApiResponse({ status: 200, type: MonthlyReportDto })
  @ApiResponse({ status: 400, description: '잘못된 month 형식 또는 미래 달' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({ status: 403, description: '볼 권한 없음' })
  @ApiResponse({ status: 404, description: '존재하지 않는 Key ID' })
  getMonthlyReport(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId', new ParseUUIDPipe()) widgetKeyId: string,
    @Query() query: MonthlyReportQueryDto,
  ): Promise<MonthlyReportDto> {
    return this.reportsService.getMonthlyReport(
      widgetKeyId,
      admin,
      query.month,
    );
  }
}
