import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import type { OrganizationMembershipStatus, OrganizationRole } from '../../db';

export const ORGANIZATION_ROLES: OrganizationRole[] = ['MANAGER', 'MEMBER'];

export class InviteOrganizationMemberDto {
  @ApiProperty({ example: 'member@example.com' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  inviteeEmail: string;

  @ApiProperty({ enum: ORGANIZATION_ROLES, default: 'MEMBER' })
  @IsEnum(ORGANIZATION_ROLES)
  role: OrganizationRole = 'MEMBER';
}

export class UpdateOrganizationMemberDto {
  @ApiProperty({ enum: ORGANIZATION_ROLES })
  @IsEnum(ORGANIZATION_ROLES)
  role: OrganizationRole;
}

export class OrganizationMembershipDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty()
  inviteeEmail: string;

  @ApiProperty({ nullable: true })
  memberIdpUuid: string | null;

  @ApiProperty({ enum: ORGANIZATION_ROLES })
  role: OrganizationRole;

  @ApiProperty({ enum: ['PENDING', 'ACCEPTED'] })
  status: OrganizationMembershipStatus;

  @ApiProperty({ nullable: true })
  memberName: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class OrganizationInvitationDto extends OrganizationMembershipDto {
  @ApiProperty()
  organizationName: string;

  @ApiProperty()
  organizationSlug: string;
}
