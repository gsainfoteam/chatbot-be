import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class WidgetSessionRequestDto {
  @ApiProperty({
    description: '위젯 키',
    example: 'wk_live_abc123',
  })
  @IsString()
  @IsNotEmpty()
  widgetKey: string;

  @ApiProperty({
    description: '위젯이 실행된 현재 페이지 URL (Origin 검증 보조용)',
    example: 'https://www.myshop.com/products/1',
  })
  @IsUrl()
  @IsNotEmpty()
  pageUrl: string;
}
