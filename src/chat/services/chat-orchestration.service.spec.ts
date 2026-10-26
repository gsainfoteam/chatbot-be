import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';
import { ChatOrchestrationService } from './chat-orchestration.service';
import { MessageRole } from '../../common/dto/chat-message-input.dto';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import type { LlmResponse } from '../types/llm.types';
import { ResourceContentService } from './resource-content.service';
import { ResourceSelectionService } from './resource-selection.service';
import { ChatStreamTransport } from './chat-stream.transport';
import {
  ANSWER_GROUNDING_REMINDER,
  NO_ANSWER_MESSAGE,
  NO_RELEVANT_MATERIALS_SYSTEM_PROMPT,
} from '../prompts';
import type { RelevantChunkSelection } from './resource-selection.service';
import type { AgentRunInput } from '../agent/agent-loop.service';
import type { AgentRunResult } from '../agent/agent.types';

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

  type SetupOptions = {
    agentEnabled?: boolean;
    /** null = 벡터 검색 불가(LLM 선별로 폴백) */
    vectorSelection?: RelevantChunkSelection | null;
    agentRun?: (input: AgentRunInput) => Promise<AgentRunResult>;
  };

  function setup(listResult: ListResourcesResult, options: SetupOptions = {}) {
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
      selectRelevantChunkPaths: jest.fn<
        (...args: unknown[]) => Promise<RelevantChunkSelection | null>
      >(async () => options.vectorSelection ?? null),
    };
    const agentLoopService = {
      isEnabled: jest.fn(() => options.agentEnabled ?? false),
      run: jest.fn<(input: AgentRunInput) => Promise<AgentRunResult>>(
        options.agentRun ??
          (async () => ({
            documents: [],
            usedResources: [],
            steps: [],
            rounds: 1,
            stopReason: 'ready' as const,
          })),
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
      agentLoopService as never,
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
      answer = '졸업요건 답변',
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
          choices: [{ delta: { content: answer } }],
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
      agentLoopService,
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

  it('hides documents and records the question when the answer is a no-answer reply', async () => {
    const { run, chatService, unansweredQuestionsRepository, writtenSse } =
      setup(createCatalog());

    await run(
      'GIST에서 광주송정역까지 가는 방법 알려줘',
      undefined,
      NO_ANSWER_MESSAGE,
    );

    expect(writtenSse()).not.toContain('"type":"resources"');
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        metadata: expect.objectContaining({ resources: undefined }),
      }),
    );
    expect(unansweredQuestionsRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'GIST에서 광주송정역까지 가는 방법 알려줘',
        answerMessageId: 'message-id',
      }),
    );
  });

  it('keeps documents for a partial answer that mentions missing information', async () => {
    const { run, unansweredQuestionsRepository, writtenSse } =
      setup(createCatalog());

    await run(
      '졸업 요건과 기숙사 비용 알려줘',
      undefined,
      `졸업 요건은 130학점입니다. 기숙사 비용은 ${NO_ANSWER_MESSAGE}`,
    );

    expect(writtenSse()).toContain('"type":"resources"');
    expect(unansweredQuestionsRepository.record).not.toHaveBeenCalled();
  });

  it('treats a reworded refusal as unanswered', async () => {
    const { run, chatService, unansweredQuestionsRepository, writtenSse } =
      setup(createCatalog());

    await run(
      'GIFT 프로그램 지원하면 장학금 얼마 받아?',
      undefined,
      '현재 GIFT 프로그램 지원 시 장학금에 대한 정보는 확인할 수 없습니다.',
    );

    expect(writtenSse()).not.toContain('"type":"resources"');
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        metadata: expect.objectContaining({ resources: undefined }),
      }),
    );
    expect(unansweredQuestionsRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'GIFT 프로그램 지원하면 장학금 얼마 받아?',
      }),
    );
  });

  it('records the question when the stream ends without any answer', async () => {
    const { run, unansweredQuestionsRepository, writtenSse } =
      setup(createCatalog());

    await run('졸업 요건 알려줘', undefined, '');

    expect(writtenSse()).not.toContain('"type":"resources"');
    expect(unansweredQuestionsRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({ answerMessageId: null }),
    );
  });

  it('reminds the answer model to stay within the materials right after them', async () => {
    const { run, llmClient } = setup(createCatalog());

    await run('졸업 요건 알려줘');

    const [, toolResults] = llmClient.generateFinalResponseStream.mock
      .calls[0] as unknown as [unknown, Array<{ content: string }>];
    expect(toolResults[0].content).toContain('졸업요건 문서 본문입니다.');
    expect(toolResults[0].content.endsWith(ANSWER_GROUNDING_REMINDER)).toBe(
      true,
    );
  });

  describe('agent research route', () => {
    const confidentSelection: RelevantChunkSelection = {
      rootPaths: [],
      detailPaths: ['학사편람/졸업요건'],
      confident: true,
    };
    const weakSelection: RelevantChunkSelection = {
      rootPaths: [],
      detailPaths: ['학사편람/수강신청'],
      confident: false,
    };

    it('answers directly without the agent when the first search is confident', async () => {
      const { run, agentLoopService, llmClient } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: confidentSelection,
      });

      await run('졸업 요건 알려줘');

      expect(agentLoopService.run).not.toHaveBeenCalled();
      const [, toolResults] = llmClient.generateFinalResponseStream.mock
        .calls[0] as unknown as [unknown, Array<{ content: string }>];
      expect(toolResults[0].content).toContain('졸업요건 문서 본문입니다.');
    });

    it('never calls the agent while it is disabled, even for a weak match', async () => {
      const { run, agentLoopService } = setup(createCatalog(), {
        agentEnabled: false,
        vectorSelection: weakSelection,
      });

      await run('졸업 요건 알려줘');

      expect(agentLoopService.run).not.toHaveBeenCalled();
    });

    it('answers with documents the agent collected after an empty first search', async () => {
      const { run, agentLoopService, llmClient, chatService } = setup(
        createCatalog(),
        {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
          agentRun: async () => ({
            documents: [
              { path: '학사편람/졸업요건', content: '재검색으로 찾은 본문' },
            ],
            usedResources: [{ path: '학사편람/졸업요건', formats: ['md'] }],
            steps: [],
            rounds: 2,
            stopReason: 'ready',
          }),
        },
      );

      await run('졸업하려면 뭐 해야 돼?');

      expect(agentLoopService.run).toHaveBeenCalledWith(
        expect.objectContaining({
          question: '졸업하려면 뭐 해야 돼?',
          seed: { documents: [], usedResources: [] },
        }),
      );
      const [, toolResults] = llmClient.generateFinalResponseStream.mock
        .calls[0] as unknown as [unknown, Array<{ content: string }>];
      expect(toolResults[0].content).toContain('재검색으로 찾은 본문');
      expect(chatService.createMessage).toHaveBeenCalledWith(
        'session-id',
        expect.objectContaining({
          role: MessageRole.ASSISTANT,
          metadata: expect.objectContaining({
            resources: [expect.objectContaining({ path: '학사편람.pdf' })],
          }),
        }),
      );
    });

    it('passes the weak first search to the agent as its seed', async () => {
      const { run, agentLoopService } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: weakSelection,
      });

      await run('수강신청 언제야?');

      const input = agentLoopService.run.mock.calls[0][0];
      expect(input.seed?.documents).toEqual([
        { path: '학사편람/수강신청', content: '수강신청 문서 본문입니다.' },
      ]);
    });

    it('falls back to the first search when the agent throws', async () => {
      const { run, llmClient } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: weakSelection,
        agentRun: async () => {
          throw new Error('gateway down');
        },
      });

      await run('수강신청 언제야?');

      const [, toolResults] = llmClient.generateFinalResponseStream.mock
        .calls[0] as unknown as [unknown, Array<{ content: string }>];
      expect(toolResults[0].content).toContain('수강신청 문서 본문입니다.');
    });

    it('streams agent steps before the answer and saves their final state', async () => {
      const running = {
        id: 'research',
        kind: 'research',
        label: '자료를 더 찾아보고 있어요',
        status: 'running' as const,
      };
      const done = {
        ...running,
        status: 'done' as const,
        label: '자료 1개를 모았어요',
        resultCount: 1,
      };
      const { run, writtenSse, chatService } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: { rootPaths: [], detailPaths: [] },
        agentRun: async (input) => {
          input.onStep?.(running);
          input.onStep?.(done);
          return {
            documents: [{ path: '학사편람/졸업요건', content: '본문' }],
            usedResources: [{ path: '학사편람/졸업요건', formats: ['md'] }],
            steps: [done],
            rounds: 1,
            stopReason: 'ready',
          };
        },
      });

      await run('졸업하려면 뭐 해야 돼?');

      const sse = writtenSse();
      const stepAt = sse.indexOf('"type":"step"');
      expect(stepAt).toBeGreaterThan(-1);
      expect(stepAt).toBeLessThan(sse.indexOf('"content"'));
      expect(sse).toContain('"status":"running"');
      expect(chatService.createMessage).toHaveBeenCalledWith(
        'session-id',
        expect.objectContaining({
          role: MessageRole.ASSISTANT,
          metadata: expect.objectContaining({ steps: [done] }),
        }),
      );
    });

    it('closes a running step as failed when the agent throws', async () => {
      const { run, writtenSse, chatService } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: weakSelection,
        agentRun: async (input) => {
          input.onStep?.({
            id: 'research',
            kind: 'research',
            label: '자료를 더 찾아보고 있어요',
            status: 'running',
          });
          throw new Error('unexpected');
        },
      });

      await run('수강신청 언제야?');

      expect(writtenSse()).toContain('"status":"failed"');
      expect(chatService.createMessage).toHaveBeenCalledWith(
        'session-id',
        expect.objectContaining({
          role: MessageRole.ASSISTANT,
          metadata: expect.objectContaining({
            steps: [expect.objectContaining({ status: 'failed' })],
          }),
        }),
      );
    });

    it('does not add steps to a direct answer', async () => {
      const { run, writtenSse, chatService } = setup(createCatalog(), {
        agentEnabled: true,
        vectorSelection: confidentSelection,
      });

      await run('졸업 요건 알려줘');

      expect(writtenSse()).not.toContain('"type":"step"');
      const saved = chatService.createMessage.mock.calls.find(
        ([, dto]) =>
          (dto as { role: MessageRole }).role === MessageRole.ASSISTANT,
      )?.[1] as { metadata: Record<string, unknown> };
      expect(saved.metadata.steps).toBeUndefined();
    });

    it('tells the user nothing was found when neither search finds documents', async () => {
      const { run, llmClient, unansweredQuestionsRepository } = setup(
        createCatalog(),
        {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
        },
      );

      await run('학식 메뉴 알려줘');

      const [messages] = llmClient.generateFinalResponseStream.mock
        .calls[0] as unknown as [Array<{ role: string; content: string }>];
      expect(messages[0].content).toBe(NO_RELEVANT_MATERIALS_SYSTEM_PROMPT);
      expect(unansweredQuestionsRepository.record).toHaveBeenCalled();
    });
  });
});
