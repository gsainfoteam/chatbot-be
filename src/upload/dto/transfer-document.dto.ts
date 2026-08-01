import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class TransferDocumentDto {
  @ApiProperty({ format: 'uuid', description: '새 소유 조직 UUID' })
  @IsUUID()
  targetOrganizationId: string;
}
