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

  function createCatalog(
    sourceType: 'pdf' | 'text' = 'pdf',
  ): ListResourcesResult {
    return {
      raw: {},
      texts: ['available school documents'],
      resourceLinks: [],
      embeddedResources: [],
      resources: [
        {
          path: '학사편람.pdf',
          description: '학사 안내',
          sourceType,
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
  }

  const EMPTY_CATALOG: ListResourcesResult = {
    raw: {},
    texts: [],
    resourceLinks: [],
    embeddedResources: [],
    resources: [],
    chunks: [],
    total: 0,
  };

  function setup(listResult: ListResourcesResult) {
    const finalStream = new PassThrough();
    const retrievalService = {
      listCatalog: jest.fn(async () => listResult),
      getContentsByPaths: jest.fn(async (paths: string[]) =>
        paths.map((path) => ({
          path,
          content: path.includes('졸업')
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
    type RecordUnanswered = (input: {
      sessionId: string;
      question: string;
      answerMessageId: string | null;
      countOccurrence: boolean;
    }) => Promise<null>;

    const llmClient = {
      getModel: jest.fn((type: string) => `${type}-model`),
      callLLM: jest
        .fn<CallLLM>()
        .mockResolvedValueOnce(createLlmResponse(JSON.stringify([1, 2]), 100)),
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
    const unansweredQuestionsRepository = {
      record: jest.fn<RecordUnanswered>(async () => null),
    };

    const resourceSelectionService = new ResourceSelectionService(
      llmClient as never,
    );
    const vectorChunkSelectionService = {
      selectRelevantChunkPaths: jest.fn<(...args: unknown[]) => Promise<null>>(
        async () => null,
      ),
    };
    const resourceContentService = new ResourceContentService(
      retrievalService as never,
      resourceSelectionService,
      vectorChunkSelectionService as never,
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
      unansweredQuestionsRepository as never,
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

    const run = async (
      question: string,
      options?: Parameters<
        ChatOrchestrationService['handleStreamingResponse']
      >[4],
    ) => {
      const handlePromise = service.handleStreamingResponse(
        'session-id',
        question,
        reply as never,
        req as never,
        options,
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
    };

    const writtenSse = () =>
      reply.raw.write.mock.calls.map((call) => String(call[0])).join('');

    return {
      run,
      writtenSse,
      llmClient,
      chatService,
      usageService,
      unansweredQuestionsRepository,
    };
  }

  it('records document reasoning tokens together with final response tokens', async () => {
    const { run, llmClient, chatService, usageService } =
      setup(createCatalog());

    await run('졸업 요건 알려줘');

    expect(llmClient.callLLM).toHaveBeenCalledTimes(1);
    expect(usageService.recordUsage).toHaveBeenCalledWith('session-id', {
      totalTokens: 400,
    });
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        role: MessageRole.ASSISTANT,
        content: '졸업요건 답변',
        metadata: expect.objectContaining({
          model: 'heavy-model',
          usage: {
            prompt_tokens: 280,
            completion_tokens: 120,
            total_tokens: 400,
          },
        }),
      }),
    );
  });

  it('does not record an unanswered question when documents were referenced', async () => {
    const { run, unansweredQuestionsRepository } = setup(createCatalog());

    await run('졸업 요건 알려줘');

    expect(unansweredQuestionsRepository.record).not.toHaveBeenCalled();
  });

  it('records the question when the answer referenced no documents', async () => {
    const { run, unansweredQuestionsRepository, writtenSse } =
      setup(EMPTY_CATALOG);

    await run('유학생 계좌 개설 방법?');

    expect(unansweredQuestionsRepository.record).toHaveBeenCalledWith({
      sessionId: 'session-id',
      question: '유학생 계좌 개설 방법?',
      answerMessageId: 'message-id',
      countOccurrence: true,
    });
    expect(writtenSse()).toContain('[DONE]');
  });

  it('does not count a regenerated answer as a new occurrence', async () => {
    const { run, unansweredQuestionsRepository } = setup(EMPTY_CATALOG);

    await run('유학생 계좌 개설 방법?', {
      persistUserMessage: false,
      historyBefore: new Date(),
    });

    expect(unansweredQuestionsRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({ countOccurrence: false }),
    );
  });

  it('completes the response even if recording the unanswered question fails', async () => {
    const { run, unansweredQuestionsRepository, writtenSse } =
      setup(EMPTY_CATALOG);
    unansweredQuestionsRepository.record.mockRejectedValueOnce(
      new Error('db down'),
    );

    await run('유학생 계좌 개설 방법?');

    expect(writtenSse()).toContain('[DONE]');
    expect(writtenSse()).not.toContain('"error"');
  });

  it('hides text knowledge documents from FE references but still counts them as answered', async () => {
    const { run, chatService, unansweredQuestionsRepository } = setup(
      createCatalog('text'),
    );

    await run('졸업 요건 알려줘');

    expect(unansweredQuestionsRepository.record).not.toHaveBeenCalled();
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        metadata: expect.objectContaining({ resources: undefined }),
      }),
    );
  });
});
