import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterDomainsDto {
  @ApiProperty({
    description: '허용된 도메인 (프로토콜 제외)',
    type: String,
    example: '*.myshop.com',
  })
  @IsString()
  @IsNotEmpty()
  domain: string;
}
