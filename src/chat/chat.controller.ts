import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  Res,
  Logger,
  ParseUUIDPipe,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatService } from './services/chat.service';
import { ChatOrchestrationService } from './services/chat-orchestration.service';
import { McpResourceService } from '../mcp/mcp-resource.service';
import { WidgetSessionGuard } from '../auth/guards/widget-session.guard';
import { CurrentSession } from '../auth/decorators/current-session.decorator';
import type { SessionPayload } from '../auth/decorators/current-session.decorator';
import { ChatMessageInputDto } from '../common/dto/chat-message-input.dto';
import { ChatMessageDto } from '../common/dto/chat-message.dto';
import { PaginatedMessagesDto } from '../common/dto/paginated-messages.dto';
import { ChatRequestDto } from './dto/chat-request.dto';
import { PlatformChatService } from '../platform-chat/platform-chat.service';
import {
  FeedbackRating,
  MessageFeedbackDto,
  MessageFeedbackInputDto,
} from '../common/dto/message-feedback.dto';

@ApiTags('Widget Messages')
@Controller('api/v1/widget/messages')
@UseGuards(WidgetSessionGuard)
@ApiBearerAuth('widgetSessionAuth')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly chatOrchestrationService: ChatOrchestrationService,
    private readonly mcpResourceService: McpResourceService,
    private readonly imageChat: PlatformChatService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '대화 내역 조회 (페이징)',
    description: 'cursor 기반 페이징으로 대화 내역을 조회합니다.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: '이전 페이지의 마지막 메시지 ID (없으면 최신순 조회)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '한 번에 가져올 메시지 개수',
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: '조회 성공',
    type: PaginatedMessagesDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getMessages(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ): Promise<PaginatedMessagesDto> {
    return this.chatService.getMessages(session.sessionId, cursor, limit);
  }

  @Post()
  @ApiOperation({
    summary: '대화 메시지 저장',
    description: 'user 또는 assistant의 메시지를 저장합니다.',
  })
  @ApiResponse({
    status: 201,
    description: '저장 성공',
    type: ChatMessageDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 429,
    description:
      '사용자별 질문 한도 초과 (위젯 키에 한도를 설정한 경우). 본문: statusCode, message, limit, windowSeconds, retryAfterSeconds',
  })
  async createMessage(
    @CurrentSession() session: SessionPayload,
    @Body() dto: ChatMessageInputDto,
  ): Promise<ChatMessageDto> {
    // 질문 한도는 createMessage가 저장과 같은 트랜잭션에서 확인한다.
    return this.chatService.createMessage(session.sessionId, dto);
  }

  @Put(':messageId/feedback')
  @ApiOperation({
    summary: 'assistant 답변 피드백 등록/변경',
    description:
      '현재 위젯 세션에 속한 assistant 답변에 대해 문제가 해결되었는지(GOOD/BAD)를 저장합니다. 같은 답변에는 현재 피드백 하나만 유지됩니다.',
  })
  @ApiParam({
    name: 'messageId',
    description: '피드백 대상 assistant 메시지 ID',
    type: String,
  })
  @ApiBody({
    type: MessageFeedbackInputDto,
  })
  @ApiResponse({
    status: 200,
    description: '피드백 저장 성공',
    type: MessageFeedbackDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 rating 값 또는 assistant가 아닌 메시지',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 404,
    description: '현재 세션에서 접근 가능한 메시지를 찾을 수 없음',
  })
  async upsertMessageFeedback(
    @CurrentSession() session: SessionPayload,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: MessageFeedbackInputDto,
  ): Promise<MessageFeedbackDto> {
    return this.chatService.upsertMessageFeedback(
      session.sessionId,
      messageId,
      dto,
    );
  }

  @Post(':messageId/regenerate/stream')
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiOperation({
    summary: 'BAD 피드백 답변 1회 재생성',
    description:
      'BAD 피드백이 저장된 assistant 답변에 대해 직전 사용자 질문으로 답변을 한 번만 재생성합니다. 재생성은 질문 한도에 포함되지 않습니다. SSE 이벤트 형식은 `POST chat/stream`과 같습니다.',
  })
  @ApiParam({
    name: 'messageId',
    description: 'BAD 피드백을 받은 assistant 메시지 ID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '재생성 스트리밍 시작 (text/event-stream)',
    headers: {
      'Content-Type': {
        description: 'text/event-stream',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'BAD 피드백이 아니거나 이미 재생성된 답변',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 404,
    description:
      '현재 세션에서 접근 가능한 메시지 또는 원본 질문을 찾을 수 없음',
  })
  async regenerateBadFeedbackAnswer(
    @CurrentSession() session: SessionPayload,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (req.isMultipart?.()) {
      return this.imageChat.stream(session, req, reply, messageId, 'widget');
    }
    const target = await this.chatService.getAnswerRegenerationTarget(
      session.sessionId,
      messageId,
      (metadata) => {
        const images = (
          metadata?.platform as { images?: unknown[] } | undefined
        )?.images;
        if (images?.length)
          throw new BadRequestException(
            'Reattach the original images with multipart/form-data',
          );
      },
    );

    return this.chatOrchestrationService.handleStreamingResponse(
      session.sessionId,
      target.question,
      reply,
      req,
      {
        persistUserMessage: false,
        historyBefore: target.historyBefore,
        widgetKeyId: session.widgetKeyId,
        assistantMetadata: {
          regeneratedFromMessageId: target.originalMessageId,
          regeneratedFromFeedback: FeedbackRating.BAD,
        },
      },
    );
  }

  @Post('chat/stream')
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['question'],
          properties: { question: { type: 'string', maxLength: 4000 } },
        },
        {
          type: 'object',
          required: ['payload'],
          properties: {
            payload: {
              type: 'string',
              description:
                'JSON 문자열 {question?, images:[{id: UUID}]} — 첨부 ID별 image_<UUID> 파일 필드 필요',
            },
          },
          additionalProperties: { type: 'string', format: 'binary' },
        },
      ],
    },
  })
  @ApiOperation({
    summary: '사용자 질문 처리 및 스트리밍 답변 생성',
    description: [
      '사용자 질문을 받아 LLM과 MCP Tool을 조합하여 답변을 스트리밍으로 생성합니다. Server-Sent Events (SSE) 형식으로 응답을 전송합니다.',
      '모든 위젯에서 정적 JPEG·PNG·WebP를 첨부할 수 있습니다. multipart의 payload={question?, images:[{id}]}와 image_<id> 파일 필드를 사용하며, 이미지 한 장당 10MiB·요청당 최대 3장입니다. 별도 이미지 허용 설정은 없습니다.',
      '',
      '각 이벤트는 `data: <JSON>` 한 줄입니다.',
      '- `{"content": "..."}`: 답변 조각. 이어 붙이면 전체 답변이 됩니다.',
      '- `{"type": "step", "id", "kind", "label", "status", "thought"?, "resultCount"?}`: 첫 검색이 비었거나 약해 자료를 다시 찾을 때만 답변 전에 옵니다. 같은 `id`가 `running` → `done`/`failed`로 다시 오면 상태를 갱신합니다. `kind`는 `research`(조사 전체) 또는 도구 이름, `label`은 서버가 만든 진행 문구, `thought`는 모델이 남긴 짧은 설명입니다.',
      '- `{"type": "resources", "resources": [...]}`: 참조 문서. 답변 뒤에 옵니다.',
      '- `{"type": "sources", "sources": [{"kind": "notice", "id", "title", "url"}]}`: 리소스 센터 밖의 출처(Ziggle 공지). `url`은 그대로 여는 외부 링크입니다. 답변 뒤에 옵니다.',
      '- `{"type": "web_sources", "sources": [{"kind": "web", "id", "title", "url", "official"}]}`: 웹 검색 결과 출처. `title`은 도메인, `official`은 학교 공식 도메인 여부입니다. 답변 뒤에 옵니다.',
      '- `{"error": "..."}`: 오류. 스트림이 끝납니다.',
      '- `[DONE]`: 정상 종료.',
      '',
      '`step`·`sources`·`web_sources` 이벤트에는 `content`·`error` 키가 없어 이를 모르는 클라이언트는 무시합니다. 완료된 단계와 출처는 assistant 메시지 `metadata.steps`, `metadata.sources`, `metadata.webSources`에도 저장됩니다.',
    ].join('\n'),
  })
  @ApiResponse({
    status: 200,
    description: '스트리밍 시작 (text/event-stream)',
    headers: {
      'Content-Type': {
        description: 'text/event-stream',
        schema: { type: 'string' },
      },
      'Cache-Control': {
        description: 'no-cache',
        schema: { type: 'string' },
      },
      Connection: {
        description: 'keep-alive',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 429,
    description:
      '사용자별 질문 한도 초과 (위젯 키에 한도를 설정한 경우, 본문에 limit 포함) 또는 일시적 요청 과다 (limit 없음)',
  })
  @ApiResponse({
    status: 500,
    description: '서버 오류 (LLM 호출 실패, Tool 실행 실패 등)',
  })
  async chatStream(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // SSE가 시작되면 HTTP 429를 보낼 수 없으므로 스트리밍 전에 먼저 확인한다.
    await this.chatService.assertQuestionAllowed(session.sessionId);
    if (req.isMultipart?.()) {
      return this.imageChat.stream(session, req, reply, undefined, 'widget');
    }
    const dto = (await new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }).transform(body, {
      type: 'body',
      metatype: ChatRequestDto,
    })) as ChatRequestDto;
    return this.chatOrchestrationService.handleStreamingResponse(
      session.sessionId,
      dto.question,
      reply,
      req,
      { widgetKeyId: session.widgetKeyId },
    );
  }

  @Get('resources/*')
  @ApiOperation({
    summary: 'MCP 리소스 조회',
    description:
      'MCP 서버의 리소스(PDF, 이미지 등)를 프록시하여 제공합니다. 리소스 경로는 URL 인코딩되어야 합니다.',
  })
  @ApiParam({
    name: '*',
    description: '리소스 경로 (URL 인코딩됨)',
    type: String,
    example: '2025%20캠프%20발표자료_%201일차%20오전(학생지원,장학복지)',
  })
  @ApiResponse({
    status: 200,
    description: '리소스 조회 성공',
    content: {
      'application/pdf': {
        schema: { type: 'string', format: 'binary' },
      },
      'image/png': {
        schema: { type: 'string', format: 'binary' },
      },
      'image/jpeg': {
        schema: { type: 'string', format: 'binary' },
      },
      'text/plain': {
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 404,
    description: '리소스를 찾을 수 없음',
  })
  async getResource(
    @CurrentSession() session: SessionPayload,
    @Param('*') resourcePath: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const decodedPath = decodeURIComponent(resourcePath);
    const resource = await this.mcpResourceService.getResource(decodedPath);

    // Content-Type 설정
    if (resource.mimeType) {
      (
        reply as FastifyReply & {
          header: (key: string, value: string) => FastifyReply;
        }
      ).header('Content-Type', resource.mimeType);
    }

    // Content-Disposition 설정 (파일 다운로드 시)
    if (
      resource.mimeType?.includes('pdf') ||
      resource.mimeType?.includes('image')
    ) {
      const filename = decodedPath.split('/').pop() || 'resource';
      (
        reply as FastifyReply & {
          header: (key: string, value: string) => FastifyReply;
        }
      ).header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(filename)}"`,
      );
    }

    // CORS 헤더 설정
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Origin', '*');
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Headers', 'Content-Type');

    (reply as FastifyReply & { send: (data: Buffer | string) => void }).send(
      resource.content,
    );
  }
}
