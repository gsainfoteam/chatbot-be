import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  IsOptional,
  IsIn,
  Length,
  ValidateIf,
} from 'class-validator';

export class WidgetSessionRequestDto {
  @ApiProperty({
    description: '위젯 키',
    example: 'wk_live_abc123',
  })
  @IsString()
  @IsNotEmpty()
  widgetKey: string;

  @ApiPropertyOptional({
    description:
      '클라이언트 타입. web이면 pageUrl 기반 도메인 검증, app이면 appId 기반 검증. 없으면 web으로 간주.',
    enum: ['web', 'app'],
    example: 'web',
  })
  @IsOptional()
  @IsIn(['web', 'app'])
  clientType?: 'web' | 'app';

  @ApiPropertyOptional({
    description:
      '위젯이 실행된 현재 페이지 URL (clientType이 web이거나 없을 때 필수)',
    example: 'https://www.myshop.com/products/1',
  })
  @ValidateIf((o) => o.clientType !== 'app')
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  @IsNotEmpty({
    message: 'pageUrl is required when clientType is web or omitted',
  })
  pageUrl?: string;

  @ApiPropertyOptional({
    description:
      '앱 식별자 (clientType이 app일 때 필수). Android applicationId / iOS bundle identifier',
    example: 'com.company.myapp',
  })
  @ValidateIf((o) => o.clientType === 'app')
  @IsString()
  @IsNotEmpty({ message: 'appId is required when clientType is app' })
  appId?: string;

  @ApiPropertyOptional({
    description:
      '사용자 식별값. 위젯·앱이 기기에 저장해 두는 무작위 ID(UUID 등)를 쓰세요. 학번·이메일처럼 추측할 수 있는 값을 쓰면 다른 사람이 같은 값을 보내 한도를 소진할 수 있습니다. 같은 값이면 세션이 달라도 질문 한도를 함께 셉니다. 원문은 저장하지 않습니다.',
    example: '6f1c2a9e-3b7d-4c11-9a4e-2d5f8b0c7e13',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  clientId?: string;
}
