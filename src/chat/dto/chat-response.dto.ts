import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResourceInfoDto {
  @ApiProperty({
    description: '리소스 경로',
    example: '2025 캠프 발표자료_ 1일차 오전(학생지원,장학복지)',
  })
  path: string;

  @ApiProperty({
    description: '지원되는 파일 형식',
    example: ['md', 'pdf'],
    type: [String],
  })
  formats: string[];

  @ApiProperty({
    description: '리소스 접근 URL',
    example:
      'http://localhost:3000/api/v1/mcp/resources/2025%20캠프%20발표자료_%201일차%20오전(학생지원,장학복지)',
  })
  url: string;
}

export class ToolCallDto {
  @ApiProperty({
    description: '사용된 Tool 이름',
    example: 'get_weather',
  })
  toolName: string;

  @ApiProperty({
    description: 'Tool에 전달된 인자',
    example: { location: 'Seoul' },
  })
  arguments: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Tool 실행 결과',
    example: 'Seoul의 현재 온도는 15도입니다.',
  })
  result?: string;

  @ApiPropertyOptional({
    description: 'Tool 결과에서 추출된 리소스 목록',
    type: [ResourceInfoDto],
  })
  resources?: ResourceInfoDto[];
}

export class ChatResponseDto {
  @ApiProperty({
    description: '생성된 답변',
    example: '서울의 현재 날씨는 맑고 온도는 15도입니다.',
  })
  message: string;

  @ApiPropertyOptional({
    description: '사용된 Tool 호출 정보',
    type: [ToolCallDto],
  })
  toolCalls?: ToolCallDto[];

  @ApiPropertyOptional({
    description: '전체 리소스 목록 (모든 Tool에서 추출된 리소스)',
    type: [ResourceInfoDto],
  })
  resources?: ResourceInfoDto[];

  @ApiPropertyOptional({
    description: '메타데이터 (모델, 토큰 사용량 등)',
    example: {
      model: 'anthropic/claude-3.5-sonnet',
      usage: {
        prompt_tokens: 150,
        completion_tokens: 50,
        total_tokens: 200,
      },
    },
  })
  metadata?: {
    model?: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
}
