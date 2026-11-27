import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PlatformChatController } from '../src/platform-chat/platform.controller';
import { PlatformSessionGuard } from '../src/platform-chat/platform-session.guard';
import { PlatformChatService } from '../src/platform-chat/platform-chat.service';
import { PlatformImageService } from '../src/platform-chat/platform-image.service';
import { ChatService } from '../src/chat/services/chat.service';
import { ChatOrchestrationService } from '../src/chat/services/chat-orchestration.service';
import { ChatStreamTransport } from '../src/chat/services/chat-stream.transport';
import { LLM_CLIENT } from '../src/chat/llm/llm-client.interface';
import { UsageService } from '../src/usage/usage.service';
import { UnansweredQuestionsRepository } from '../src/unanswered-questions/unanswered-questions.repository';
import { PLATFORM_IMAGE_PROMPT } from '../src/platform-chat/platform-prompts';
import { McpResourceService } from '../src/mcp/mcp-resource.service';
import { ChatController } from '../src/chat/chat.controller';
import { WidgetSessionGuard } from '../src/auth/guards/widget-session.guard';

function form(
  payload: unknown,
  images: Array<{ id: string; bytes: Buffer; mime?: string }>,
) {
  const boundary = 'platform-test-boundary';
  const chunks = [
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="payload"\r\n\r\n' +
        JSON.stringify(payload) +
        '\r\n',
    ),
  ];
  for (const img of images) {
    chunks.push(
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="image_' +
          img.id +
          '"; filename="image.png"\r\nContent-Type: ' +
          (img.mime ?? 'image/png') +
          '\r\n\r\n',
      ),
    );
    chunks.push(img.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
  };
}

describe('Platform chat multipart and SSE', () => {
  let app: NestFastifyApplication;
  let png: Buffer;
  let llm: {
    getModel: jest.Mock;
    callLLM: jest.Mock;
    generateFinalResponseStream: jest.Mock;
  };
  let chat: {
    createMessage: jest.Mock;
    getMessagesForContext: jest.Mock;
    getAnswerRegenerationTarget: jest.Mock;
    getUserMessageCount: jest.Mock;
  };
  let retrieval: { retrieveForPlatform: jest.Mock };
  let usage: { recordUsage: jest.Mock };
  let unanswered: { record: jest.Mock };
  let analysis: Record<string, unknown>;
  let allowed: boolean;
  const conversation = randomUUID();
  const imageId = randomUUID();
  const widgetSession = randomUUID();
  let regenerationConversation: string;

  beforeAll(async () => {
    png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
  });
  beforeEach(async () => {
    regenerationConversation = conversation;
    allowed = true;
    analysis = {
      summary: 'GIST 장학금 공지. 신청 기간은 이미지에 적혀 있습니다.',
      searchQuery: 'GIST 장학금 신청',
      needsSearch: false,
      needsClarification: false,
    };
    llm = {
      getModel: jest.fn((tier) =>
        tier === 'heavy' ? 'vision-heavy' : 'scope-light',
      ),
      callLLM: jest.fn(async (messages) => ({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify(
                messages[0].content === PLATFORM_IMAGE_PROMPT
                  ? analysis
                  : { allowed, reason: allowed ? 'gist' : 'out-of-scope' },
              ),
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })),
      generateFinalResponseStream: jest.fn(async () =>
        Readable.from([
          'data: ' +
            JSON.stringify({
              model: 'vision-heavy',
              choices: [
                {
                  delta: {
                    content:
                      '첨부 이미지에는 GIST 장학금 신청 안내가 있습니다.',
                  },
                },
              ],
            }) +
            '\n\n',
          'data: ' +
            JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: 4,
                completion_tokens: 2,
                total_tokens: 6,
              },
            }) +
            '\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    };
    chat = {
      getUserMessageCount: jest.fn(async () => 0),
      createMessage: jest.fn(async (_session, dto) => ({
        id: randomUUID(),
        ...dto,
      })),
      getMessagesForContext: jest.fn(() => {
        throw new Error('Must not read server conversation');
      }),
      getAnswerRegenerationTarget: jest.fn(async (_session, _id, validate) => {
        const metadata = {
          platform: {
            localConversationId: regenerationConversation,
            question: '공지 내용 설명',
            images: [{ id: imageId }],
          },
        };
        validate?.(metadata);
        return { question: '공지 내용 설명', userMetadata: metadata };
      }),
    };
    retrieval = {
      retrieveForPlatform: jest.fn(async () => ({
        content: '공식 검색 근거',
        resources: [],
        sources: [],
        steps: [],
      })),
    };
    usage = { recordUsage: jest.fn(async () => {}) };
    unanswered = { record: jest.fn(async () => {}) };
    const module = await Test.createTestingModule({
      controllers: [PlatformChatController, ChatController],
      providers: [
        PlatformChatService,
        PlatformImageService,
        ChatStreamTransport,
        {
          provide: ConfigService,
          useValue: new ConfigService({ DOMAIN_NAME: 'example.com' }),
        },
        { provide: LLM_CLIENT, useValue: llm },
        { provide: ChatService, useValue: chat },
        { provide: ChatOrchestrationService, useValue: retrieval },
        { provide: UsageService, useValue: usage },
        { provide: UnansweredQuestionsRepository, useValue: unanswered },
        {
          provide: McpResourceService,
          useValue: {
            getResource: jest.fn(async (path: string) => ({
              content: path,
              mimeType: 'application/pdf',
            })),
          },
        },
      ],
    })
      .overrideGuard(PlatformSessionGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          req.session = {
            sessionId: req.headers['x-test-session'] ?? 'session',
            widgetKeyId: 'key',
          };
          return true;
        },
      })
      .overrideGuard(WidgetSessionGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          req.session = {
            sessionId: widgetSession,
            widgetKeyId: req.headers['x-widget-key'] ?? 'widget-key-a',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(multipart, {
      limits: { files: 1, fileSize: 20 * 1024 * 1024 },
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => {
    await app.close();
  });
  const post = (options: Record<string, unknown>, path = 'chat/stream') =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/platform/messages/' + path,
        ...options,
      });

  it('streams an image answer, counts usage, and never stores bytes or marks it unanswered', async () => {
    const response = await post(
      form(
        {
          localConversationId: conversation,
          question: '공지 내용 설명',
          images: [{ id: imageId }],
        },
        [{ id: imageId, bytes: png }],
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"outcome":"image-answer"');
    expect(response.body).toContain('"type":"message_metadata"');
    expect(response.body).toContain('[DONE]');
    expect(retrieval.retrieveForPlatform).not.toHaveBeenCalled();
    expect(unanswered.record).not.toHaveBeenCalled();
    expect(usage.recordUsage).toHaveBeenCalledWith('session', {
      totalTokens: 12,
    });
    expect(llm.callLLM.mock.calls[0][1]).toBe('vision-heavy');
    expect(
      JSON.stringify(llm.generateFinalResponseStream.mock.calls),
    ).toContain('data:image/jpeg;base64,');
    expect(JSON.stringify(chat.createMessage.mock.calls)).not.toContain(
      'base64',
    );
    expect(chat.getMessagesForContext).not.toHaveBeenCalled();
  });
  it('accepts three images despite the existing global one-file PDF limit', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const response = await post(
      form(
        {
          localConversationId: conversation,
          question: '이 학교 공지 비교',
          images: ids.map((id) => ({ id })),
        },
        ids.map((id) => ({ id, bytes: png })),
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('[DONE]');
    const call = JSON.stringify(llm.callLLM.mock.calls[0][0]);
    expect(call.match(/data:image\/jpeg/g)).toHaveLength(3);
  });
  it('asks for intent for image-only input without counting it as unanswered', async () => {
    analysis.needsClarification = true;
    const response = await post(
      form({ localConversationId: conversation, images: [{ id: imageId }] }, [
        { id: imageId, bytes: png },
      ]),
    );
    expect(response.body).toContain('"outcome":"clarification"');
    expect(llm.generateFinalResponseStream).not.toHaveBeenCalled();
    expect(unanswered.record).not.toHaveBeenCalled();
  });
  it('uses the extracted query for existing retrieval and the original image for the final answer', async () => {
    analysis.needsSearch = true;
    await post(
      form(
        {
          localConversationId: conversation,
          question: '이 장학금 신청 자격 확인',
          images: [{ id: imageId }],
        },
        [{ id: imageId, bytes: png }],
      ),
    );
    expect(retrieval.retrieveForPlatform.mock.calls[0][0]).toBe(
      'GIST 장학금 신청',
    );
    expect(
      JSON.stringify(llm.generateFinalResponseStream.mock.calls[0][0]),
    ).toContain('공식 검색 근거');
  });
  it('rejects unrelated requests without retrieval or answer generation', async () => {
    allowed = false;
    const response = await post(
      form(
        {
          localConversationId: conversation,
          question: '일반 사진 설명',
          images: [{ id: imageId }],
        },
        [{ id: imageId, bytes: png }],
      ),
    );
    expect(response.body).toContain('"outcome":"scope-refused"');
    expect(retrieval.retrieveForPlatform).not.toHaveBeenCalled();
    expect(llm.generateFinalResponseStream).not.toHaveBeenCalled();
  });
  it('uses browser history after token renewal and does not mix another local conversation', async () => {
    const history = [
      {
        id: randomUUID(),
        role: 'user',
        content: '지난번 GIST 장학금',
        imageSummary: '과거 공지 캡처',
      },
    ];
    const response = await post({
      payload: {
        localConversationId: conversation,
        question: '그 신청 기간은?',
        history,
      },
      headers: { 'x-test-session': 'renewed' },
    });
    expect(response.body).toContain('"sessionId":"renewed"');
    expect(retrieval.retrieveForPlatform.mock.calls[0][1][0].content).toContain(
      '과거 공지 캡처',
    );
    await post({
      payload: { localConversationId: randomUUID(), question: 'GIST 기숙사' },
    });
    expect(retrieval.retrieveForPlatform.mock.calls[1][1]).toEqual([]);
    expect(chat.getMessagesForContext).not.toHaveBeenCalled();
    expect(
      chat.createMessage.mock.calls.filter(([, dto]) => dto.role === 'user'),
    ).toHaveLength(2);
  });
  it('returns an SSE error, not a fabricated answer, when analysis is invalid', async () => {
    analysis = { summary: '' };
    const response = await post(
      form({ localConversationId: conversation, images: [{ id: imageId }] }, [
        { id: imageId, bytes: png },
      ]),
    );
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain('[DONE]');
    expect(llm.generateFinalResponseStream).not.toHaveBeenCalled();
    expect(usage.recordUsage).toHaveBeenCalledWith('session', {
      totalTokens: 3,
    });
  });
  it('fails validation before persistence or provider calls', async () => {
    const response = await post(
      form({ localConversationId: conversation, images: [{ id: imageId }] }, [
        {
          id: imageId,
          bytes: Buffer.from('%PDF-1.7'),
          mime: 'application/pdf',
        },
      ]),
    );
    expect(response.statusCode).toBe(400);
    expect(chat.createMessage).not.toHaveBeenCalled();
    expect(llm.callLLM).not.toHaveBeenCalled();
  });
  it('enforces the per-image 10 MiB limit before decoding', async () => {
    const response = await post(
      form({ localConversationId: conversation, images: [{ id: imageId }] }, [
        { id: imageId, bytes: Buffer.alloc(10 * 1024 * 1024 + 1) },
      ]),
    );
    expect(response.statusCode).toBe(413);
    expect(llm.callLLM).not.toHaveBeenCalled();
  });
  it('regenerates with original question and reattached image but does not duplicate the user message', async () => {
    const response = await post(
      form({ localConversationId: conversation, images: [{ id: imageId }] }, [
        { id: imageId, bytes: png },
      ]),
      randomUUID() + '/regenerate/stream',
    );
    expect(response.body).toContain('[DONE]');
    expect(
      chat.createMessage.mock.calls.every(
        ([, dto]) => dto.role === 'assistant',
      ),
    ).toBe(true);
    expect(JSON.stringify(llm.callLLM.mock.calls[0][0])).toContain(
      '공지 내용 설명',
    );
  });
  it('requires original images before claiming a regeneration', async () => {
    const response = await post(
      { payload: { localConversationId: conversation } },
      randomUUID() + '/regenerate/stream',
    );
    expect(response.statusCode).toBe(400);
    expect(llm.callLLM).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not persist a successful answer on incomplete stream (length=%s)',
    async (length) => {
      llm.generateFinalResponseStream.mockResolvedValueOnce(
        Readable.from([
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: { content: '부분 답변' },
                  finish_reason: length ? 'length' : null,
                },
              ],
            }) +
            '\n\n',
          ...(length ? ['data: [DONE]\n\n'] : []),
        ]),
      );
      const response = await post({
        payload: {
          localConversationId: conversation,
          question: 'GIST 장학금 안내',
        },
      });
      expect(response.body).toContain('"error"');
      expect(response.body).not.toContain('[DONE]');
      expect(
        chat.createMessage.mock.calls.every(([, dto]) => dto.role === 'user'),
      ).toBe(true);
    },
  );

  it('serves source resources with the platform route and decodes paths once', async () => {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/platform/messages/resources/' +
        encodeURIComponent('장학금 100% 안내.pdf'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('장학금 100% 안내.pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it.each(['widget-key-a', 'widget-key-b'])(
    'accepts images for %s without an image feature flag',
    async (key) => {
      analysis.needsSearch = true;
      chat.getMessagesForContext.mockResolvedValueOnce([
        { id: randomUUID(), role: 'user', content: 'GIST 장학금 관련 질문' },
      ]);
      const request = form(
        { question: '이 공지 확인해 줘', images: [{ id: imageId }] },
        [{ id: imageId, bytes: png }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/widget/messages/chat/stream',
        ...request,
        headers: { ...request.headers, 'x-widget-key': key },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('[DONE]');
      expect(chat.getMessagesForContext).toHaveBeenCalledWith(
        widgetSession,
        undefined,
      );
      expect(retrieval.retrieveForPlatform).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ content: 'GIST 장학금 관련 질문' }),
        ]),
        expect.any(Object),
        expect.objectContaining({ widgetKeyId: key }),
      );
      expect(chat.createMessage).toHaveBeenCalledWith(
        widgetSession,
        expect.objectContaining({ role: 'user' }),
      );
    },
  );

  it('retains the widget question cap for image uploads', async () => {
    chat.getUserMessageCount.mockResolvedValueOnce(5);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/messages/chat/stream',
      ...form({ images: [{ id: imageId }] }, [{ id: imageId, bytes: png }]),
    });
    expect(response.statusCode).toBe(429);
    expect(llm.callLLM).not.toHaveBeenCalled();
    expect(chat.createMessage).not.toHaveBeenCalled();
  });

  it('does not accept client-controlled history or conversation identity on widget uploads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/messages/chat/stream',
      ...form(
        {
          localConversationId: conversation,
          history: [],
          images: [{ id: imageId }],
        },
        [{ id: imageId, bytes: png }],
      ),
    });
    expect(response.statusCode).toBe(400);
    expect(llm.callLLM).not.toHaveBeenCalled();
  });

  it('regenerates widget image answers using their original attachments and server history', async () => {
    regenerationConversation = widgetSession;
    chat.getMessagesForContext.mockResolvedValueOnce([]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/messages/' + randomUUID() + '/regenerate/stream',
      ...form({ images: [{ id: imageId }] }, [{ id: imageId, bytes: png }]),
    });
    expect(response.body).toContain('[DONE]');
    expect(
      chat.createMessage.mock.calls.every(
        ([, dto]) => dto.role === 'assistant',
      ),
    ).toBe(true);
  });

  it('requires reattaching images even on the legacy widget regeneration route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/widget/messages/' + randomUUID() + '/regenerate/stream',
    });
    expect(response.statusCode).toBe(400);
    expect(llm.callLLM).not.toHaveBeenCalled();
  });
});
