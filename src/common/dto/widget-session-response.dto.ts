import { ApiProperty } from '@nestjs/swagger';

export class WidgetSessionResponseDto {
  @ApiProperty({
    description: 'JWT Access Token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  sessionToken: string;

  @ApiProperty({
    description: '토큰 만료 시간(초)',
    example: 3600,
  })
  expiresIn: number;
}
