import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsDefined, ValidateIf } from 'class-validator';

export class UpdateExpiresAtDto {
  @ApiProperty({
    description:
      '문서 유효기간 (ISO-8601). null이면 무기한. 과거 시각은 허용하지 않습니다.',
    nullable: true,
    example: '2026-12-31T23:59:59.000Z',
  })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  expiresAt: string | null;
}
