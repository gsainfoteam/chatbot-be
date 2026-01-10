import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsUrl, IsOptional } from 'class-validator';

export class AdminLoginRequestDto {
  @ApiProperty({
    description: 'IDP로부터 받은 authorization code',
    example: 'NhhvTDYsFcdgNLnnLijcl7Ku7bEEeee',
  })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    description: '인증 요청 시 사용한 redirect URI',
    example: 'http://localhost:5173/login',
  })
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false })
  redirect_uri: string;

  @ApiProperty({
    description: 'PKCE code_verifier (code_challenge 생성에 사용된 원본 값)',
    example: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    required: false,
  })
  @IsString()
  @IsOptional()
  code_verifier?: string;
}

export class AdminLoginResponseDto {
  @ApiProperty({
    description: '자체 발급 JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  access_token: string;

  @ApiProperty({
    description: 'Refresh token (IDP에서 발급된 경우)',
    example: 'D43f5y0ahjqew82jZ4NViEr2YafMKhue',
    required: false,
  })
  refresh_token?: string;

  @ApiProperty({
    description: 'Access token 만료 시간 (초 단위)',
    example: 3600,
  })
  expires_in: number;
}

export class AdminVerifyResponseDto {
  @ApiProperty({
    description: 'Admin UUID (IDP)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  uuid: string;

  @ApiProperty({
    description: 'Admin 이메일',
    example: 'admin@gistory.me',
  })
  email: string;

  @ApiProperty({
    description: 'Admin 이름',
    example: '홍길동',
  })
  name: string;
}

export class LogoutRequestDto {
  @ApiProperty({
    description: 'IDP에서 발급받은 refresh token (선택사항)',
    example: 'D43f5y0ahjqew82jZ4NViEr2YafMKhue',
    required: false,
  })
  @IsString()
  @IsOptional()
  refresh_token?: string;
}

export class LogoutResponseDto {
  @ApiProperty({
    description: '로그아웃 성공 메시지',
    example: 'Successfully logged out',
  })
  message: string;
}
