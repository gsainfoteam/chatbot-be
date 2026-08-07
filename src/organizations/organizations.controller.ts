import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CreateOrganizationDto, OrganizationDto } from './dto/organization.dto';
import {
  InviteOrganizationMemberDto,
  OrganizationInvitationDto,
  OrganizationMembershipDto,
  UpdateOrganizationMemberDto,
} from './dto/membership.dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('Organizations')
@ApiBearerAuth('bearerAuth')
@UseGuards(AdminJwtGuard)
@Controller('api/v1/admin')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post('organizations')
  @UseGuards(SuperAdminGuard)
  @ApiOperation({
    summary: '조직 생성',
    description:
      'SUPER_ADMIN만 호출할 수 있으며 생성자 MANAGER 멤버십도 같은 트랜잭션에서 생성합니다.',
  })
  @ApiResponse({ status: 201, type: OrganizationDto })
  @ApiResponse({ status: 403, description: 'SUPER_ADMIN 권한 필요' })
  @ApiResponse({ status: 409, description: 'slug 중복' })
  createOrganization(
    @Body() dto: CreateOrganizationDto,
    @CurrentAdmin() admin: AdminContext,
  ) {
    return this.organizationsService.createOrganization(dto, admin);
  }

  @Get('organizations')
  @ApiOperation({ summary: '현재 사용자가 접근 가능한 조직 목록' })
  @ApiResponse({ status: 200, type: OrganizationDto, isArray: true })
  listOrganizations(@CurrentAdmin() admin: AdminContext) {
    return this.organizationsService.listOrganizations(admin);
  }

  @Get('organizations/:organizationId/members')
  @ApiOperation({ summary: '조직 멤버 및 대기 중 초대 목록' })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({ status: 200, type: OrganizationMembershipDto, isArray: true })
  @ApiResponse({ status: 403, description: '조직 MANAGER 권한 필요' })
  listMembers(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @CurrentAdmin() admin: AdminContext,
  ) {
    return this.organizationsService.listMembers(organizationId, admin);
  }

  @Post('organizations/:organizationId/members')
  @ApiOperation({
    summary: '조직 멤버 초대',
    description:
      '알려진 관리자도 자동 수락되지 않으며 PENDING 상태로 명시적 수락을 기다립니다.',
  })
  @ApiParam({ name: 'organizationId', format: 'uuid' })
  @ApiResponse({ status: 201, type: OrganizationMembershipDto })
  @ApiResponse({ status: 400, description: '자기 자신 초대' })
  @ApiResponse({ status: 403, description: '조직 MANAGER 권한 필요' })
  @ApiResponse({ status: 409, description: '중복 초대/멤버십' })
  inviteMember(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: InviteOrganizationMemberDto,
    @CurrentAdmin() admin: AdminContext,
  ) {
    return this.organizationsService.inviteMember(organizationId, dto, admin);
  }

  @Patch('organizations/:organizationId/members/:membershipId')
  @ApiOperation({ summary: '조직 멤버 역할 변경' })
  @ApiResponse({ status: 200, type: OrganizationMembershipDto })
  @ApiResponse({ status: 400, description: '최종 MANAGER 강등 불가' })
  @ApiResponse({ status: 403, description: '조직 MANAGER 권한 필요' })
  updateMember(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() dto: UpdateOrganizationMemberDto,
    @CurrentAdmin() admin: AdminContext,
  ) {
    return this.organizationsService.updateMember(
      organizationId,
      membershipId,
      dto,
      admin,
    );
  }

  @Delete('organizations/:organizationId/members/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '조직 멤버 또는 대기 중 초대 제거' })
  @ApiResponse({ status: 204, description: '제거 성공' })
  @ApiResponse({ status: 400, description: '최종 MANAGER 제거 불가' })
  @ApiResponse({ status: 403, description: '조직 MANAGER 권한 필요' })
  async removeMember(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @CurrentAdmin() admin: AdminContext,
  ): Promise<void> {
    await this.organizationsService.removeMember(
      organizationId,
      membershipId,
      admin,
    );
  }

  @Get('organization-invitations')
  @ApiOperation({ summary: '현재 이메일의 대기 중 조직 초대 목록' })
  @ApiResponse({ status: 200, type: OrganizationInvitationDto, isArray: true })
  listInvitations(@CurrentAdmin() admin: AdminContext) {
    return this.organizationsService.listInvitations(admin);
  }

  @Post('organization-invitations/:membershipId/accept')
  @ApiOperation({ summary: '조직 초대 명시적 수락' })
  @ApiResponse({ status: 201, type: OrganizationMembershipDto })
  @ApiResponse({ status: 403, description: '초대 이메일 불일치' })
  @ApiResponse({ status: 409, description: '이미 처리됨 또는 멤버십 충돌' })
  acceptInvitation(
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @CurrentAdmin() admin: AdminContext,
  ) {
    return this.organizationsService.acceptInvitation(membershipId, admin);
  }

  @Delete('organization-invitations/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '조직 초대 거절' })
  @ApiResponse({ status: 204, description: '거절 성공' })
  @ApiResponse({ status: 403, description: '초대 이메일 불일치' })
  async rejectInvitation(
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @CurrentAdmin() admin: AdminContext,
  ): Promise<void> {
    await this.organizationsService.rejectInvitation(membershipId, admin);
  }
}
