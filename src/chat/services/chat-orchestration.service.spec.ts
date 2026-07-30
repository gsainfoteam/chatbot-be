import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';
import { ChatOrchestrationService } from './chat-orchestration.service';
import { MessageRole } from '../../common/dto/chat-message-input.dto';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import type { LlmResponse } from '../types/llm.types';
import { ResourceContentService } from './resource-content.service';
import { ResourceSelectionService } from './resource-selection.service';
import { ChatStreamTransport } from './chat-stream.transport';

describe('ChatOrchestrationService', () => {
  function createLlmResponse(
    content: string,
    totalTokens: number,
  ): LlmResponse {
    return {
      id: `response-${totalTokens}`,
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content },
          finish_reason: 'stop' as const,
        },
      ],
      usage: {
        prompt_tokens: Math.floor(totalTokens * 0.7),
        completion_tokens: totalTokens - Math.floor(totalTokens * 0.7),
        total_tokens: totalTokens,
      },
    };
  }

  it('records document reasoning tokens together with final response tokens', async () => {
    const finalStream = new PassThrough();
    const listResult: ListResourcesResult = {
      raw: {},
      texts: ['available school documents'],
      resourceLinks: [],
      embeddedResources: [],
      filteredResources: [],
      resources: [
        {
          path: '학사편람.pdf',
          description: '학사 안내',
          chunks: [
            { path: '학사편람/졸업요건', description: '졸업요건' },
            { path: '학사편람/수강신청', description: '수강신청' },
          ],
        },
      ],
      chunks: [
        { path: '학사편람/졸업요건', description: '졸업요건' },
        { path: '학사편람/수강신청', description: '수강신청' },
      ],
      total: 1,
    };

    const retrievalService = {
      listCatalog: jest.fn(async () => listResult),
      getContentsByPaths: jest.fn(async (paths: string[]) =>
        paths.map((path) => ({
          path,
          content:
            path.includes('졸업')
              ? '졸업요건 문서 본문입니다.'
              : '수강신청 문서 본문입니다.',
        })),
      ),
    };
    type CallLLM = (...args: unknown[]) => Promise<LlmResponse>;
    type RecordUsage = (
      sessionId: string,
      input: { totalTokens: number },
    ) => Promise<void>;

    const llmClient = {
      getModel: jest.fn((type: string) => `${type}-model`),
      callLLM: jest
        .fn<CallLLM>()
        .mockResolvedValueOnce(
          createLlmResponse(
            JSON.stringify(['학사편람/졸업요건', '학사편람/수강신청']),
            100,
          ),
        )
        .mockResolvedValueOnce(createLlmResponse('1', 200)),
      generateFinalResponseStream: jest.fn(async () => finalStream),
    };
    const chatService = {
      getMessagesForContext: jest.fn(async () => []),
      createMessage: jest.fn(async (_sessionId: string, dto: unknown) => ({
        id: 'message-id',
        ...(dto as Record<string, unknown>),
        createdAt: new Date(),
      })),
    };
    const usageService = {
      recordUsage: jest.fn<RecordUsage>(async () => undefined),
    };

    const resourceSelectionService = new ResourceSelectionService(
      llmClient as never,
    );
    const resourceContentService = new ResourceContentService(
      retrievalService as never,
      resourceSelectionService,
    );
    const chatStreamTransport = new ChatStreamTransport({
      get: jest.fn((key: string) =>
        key === 'DOMAIN_NAME' ? 'example.com' : undefined,
      ),
    } as never);

    const service = new ChatOrchestrationService(
      retrievalService as never,
      llmClient as never,
      chatService as never,
      usageService as never,
      resourceContentService,
      chatStreamTransport,
    );

    const reply = {
      hijack: jest.fn(),
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      },
    };
    const req = {
      headers: { origin: 'http://localhost:5173' },
    };

    const handlePromise = service.handleStreamingResponse(
      'session-id',
      '졸업 요건 알려줘',
      reply as never,
      req as never,
    );

    // processUserQuestionStream이 generateFinalResponseStream을 호출한 뒤
    // consumeAndForward가 stream을 구독할 시간을 준다.
    await new Promise((r) => setImmediate(r));

    finalStream.write(
      `data: ${JSON.stringify({
        model: 'heavy-model',
        choices: [{ delta: { content: '졸업요건 답변' } }],
      })}\n\n`,
    );
    finalStream.write(
      `data: ${JSON.stringify({
        usage: {
          prompt_tokens: 210,
          completion_tokens: 90,
          total_tokens: 300,
        },
      })}\n\n`,
    );
    finalStream.end('data: [DONE]\n\n');

    await handlePromise;

    expect(llmClient.callLLM).toHaveBeenCalledTimes(2);
    expect(usageService.recordUsage).toHaveBeenCalledWith('session-id', {
      totalTokens: 600,
    });
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        role: MessageRole.ASSISTANT,
        content: '졸업요건 답변',
        metadata: expect.objectContaining({
          model: 'heavy-model',
          usage: {
            prompt_tokens: 420,
            completion_tokens: 180,
            total_tokens: 600,
          },
        }),
      }),
    );
  });
});
