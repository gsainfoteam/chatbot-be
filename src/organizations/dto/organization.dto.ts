import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ example: '학생지원팀', maxLength: 255 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    example: 'student-support',
    description: '소문자 영문/숫자와 단일 하이픈으로 구성된 고유 slug',
  })
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(255)
  slug: string;
}

export class OrganizationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty({ enum: ['SUPER_ADMIN', 'MANAGER', 'MEMBER'] })
  effectiveRole: 'SUPER_ADMIN' | 'MANAGER' | 'MEMBER';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
