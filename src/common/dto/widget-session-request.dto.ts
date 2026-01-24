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
    description: '위젯이 실행된 현재 페이지 URL',
    example: 'https://www.myshop.com/products/1',
  })
  @IsUrl({
    require_tld: false, // TODO: 로컬 테스트를 위해 false로 설정, 실제 운영 시 true로 변경 필요
    require_protocol: true,
  })
  @IsNotEmpty()
  pageUrl: string;
}
