import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CurrentSession,
  type SessionPayload,
} from '../auth/decorators/current-session.decorator';
import { ChatService } from '../chat/services/chat.service';
import { MessageFeedbackInputDto } from '../common/dto/message-feedback.dto';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessionGuard } from './platform-session.guard';
import { PlatformChatService } from './platform-chat.service';
import { PlatformAdmission } from './platform-admission';
import { McpResourceService } from '../mcp/mcp-resource.service';

class PlatformSessionRequestDto {
  @ApiProperty({
    description: '발급받은 위젯 키 (widget_keys.id가 아닌 키 문자열)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  widgetKey: string;

  @ApiProperty({
    description: '자체 플랫폼의 현재 페이지 URL',
    maxLength: 2048,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  pageUrl: string;
}

const PAYLOAD_SCHEMA = {
  type: 'object' as const,
  required: ['localConversationId'],
  properties: {
    localConversationId: { type: 'string' as const, format: 'uuid' },
    question: {
      type: 'string' as const,
      maxLength: 4000,
      description: '질문 또는 현재 첨부 이미지 필수',
    },
    history: {
      type: 'array' as const,
      maxItems: 20,
      items: {
        type: 'object' as const,
        required: ['id', 'role', 'content'],
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          role: { type: 'string' as const, enum: ['user', 'assistant'] },
          content: { type: 'string' as const },
          imageSummary: { type: 'string' as const, maxLength: 6000 },
        },
      },
    },
    images: {
      type: 'array' as const,
      maxItems: 3,
      items: {
        type: 'object' as const,
        required: ['id'],
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          messageId: {
            type: 'string' as const,
            format: 'uuid',
            description: '이전 user 메시지 ID. 현재 질문 이미지는 생략',
          },
        },
      },
    },
  },
};

@ApiTags('Platform Chat')
@Controller('api/v1/platform/auth')
export class PlatformAuthController {
  private readonly admission = new PlatformAdmission(32);
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('session')
  @ApiOperation({ summary: '로그인 없이 자체 플랫폼 요청 토큰 발급 (30분)' })
  @ApiResponse({
    status: 201,
    description:
      'sessionToken, sessionId, expiresIn 반환. 브라우저 대화 수명과 무관합니다.',
  })
  async session(
    @Body() body: PlatformSessionRequestDto,
    @Req() req: FastifyRequest,
  ) {
    const release = this.admission.acquire(req.ip, req.ip);
    try {
      return await this.auth.createSession(
        body.widgetKey,
        body.pageUrl,
        req.headers.origin,
      );
    } finally {
      release();
    }
  }
}

@ApiTags('Platform Chat')
@ApiBearerAuth('widgetSessionAuth')
@UseGuards(PlatformSessionGuard)
@Controller('api/v1/platform/messages')
export class PlatformChatController {
  constructor(
    private readonly platform: PlatformChatService,
    private readonly chat: ChatService,
    private readonly resources: McpResourceService,
  ) {}

  @Get('resources/*')
  @ApiOperation({ summary: '플랫폼 세션으로 답변의 출처 자료 조회' })
  async resource(@Param('*') path: string, @Res() reply: FastifyReply) {
    // Fastify has already decoded the wildcard parameter.
    const resource = await this.resources.getResource(path);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (resource.mimeType) reply.type(resource.mimeType);
    if (/pdf|image/.test(resource.mimeType ?? '')) {
      const name = encodeURIComponent(path.split('/').pop() || 'resource');
      reply.header('Content-Disposition', `inline; filename="${name}"`);
    }
    return reply.send(resource.content);
  }

  @Post('chat/stream')
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      oneOf: [
        PAYLOAD_SCHEMA,
        {
          type: 'object',
          required: ['payload'],
          properties: {
            payload: {
              type: 'string',
              description: '위 JSON 요청을 직렬화한 값',
            },
          },
          additionalProperties: {
            type: 'string',
            format: 'binary',
            description: 'image_<이미지 UUID> 필드, 최대 3개',
          },
        },
      ],
    },
  })
  @ApiOperation({
    summary: '브라우저 이력과 이미지로 질문',
    description:
      '이미지는 정적 JPEG·PNG·WebP, 장당 10MiB. 파일 필드 image_<id>와 payload.images를 대응시킵니다. SSE message_metadata 뒤 [DONE]이 정상 완료입니다. 대화당 질문 수 제한은 없습니다.',
  })
  @ApiResponse({
    status: 200,
    description: 'text/event-stream: 기존 이벤트 + message_metadata',
  })
  @ApiResponse({ status: 400, description: '잘못된 입력 또는 이미지' })
  @ApiResponse({ status: 413, description: '파일/본문 제한 초과' })
  @ApiResponse({ status: 429, description: '처리량 제한' })
  stream(
    @CurrentSession() session: SessionPayload,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.platform.stream(session, req, reply);
  }

  @Put(':messageId/feedback')
  @ApiOperation({ summary: '현재 플랫폼 인증 세션 답변의 피드백' })
  feedback(
    @CurrentSession() session: SessionPayload,
    @Param('messageId', ParseUUIDPipe) id: string,
    @Body() body: MessageFeedbackInputDto,
  ) {
    return this.chat.upsertMessageFeedback(session.sessionId, id, body);
  }

  @Post(':messageId/regenerate/stream')
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ schema: PAYLOAD_SCHEMA })
  @ApiOperation({
    summary: '현재 세션 BAD 답변 1회 재생성',
    description:
      'question은 생략합니다. localConversationId와 원래 질문 이전 history, 원래 질문 이미지를 동일 ID로 다시 전송합니다. 인증 세션이 다른 과거 답변은 재생성할 수 없습니다.',
  })
  regenerate(
    @CurrentSession() session: SessionPayload,
    @Param('messageId', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.platform.stream(session, req, reply, id);
  }
}
