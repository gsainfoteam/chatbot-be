import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString, ArrayMinSize } from 'class-validator';

export class CreateWidgetKeyDto {
  @ApiProperty({
    description: '위젯 키 이름',
    example: '메인 쇼핑몰용',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '허용된 도메인 목록 (프로토콜 제외)',
    type: [String],
    example: ['*.myshop.com', 'myshop.com'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  allowedDomains: string[];
}
