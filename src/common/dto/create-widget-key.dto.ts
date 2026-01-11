import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateWidgetKeyDto {
  @ApiProperty({
    description: '위젯 키 이름',
    example: '메인 쇼핑몰용',
  })
  @IsString()
  @IsNotEmpty()
  name: string;
}
