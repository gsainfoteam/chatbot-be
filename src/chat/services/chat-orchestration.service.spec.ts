import { GistScopePolicy } from '../safety/gist-scope.policy';
import { chatAdmission } from '../safety/chat-admission';
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
  beforeEach(() => {
    jest
      .spyOn(GistScopePolicy.prototype, 'assess')
      .mockResolvedValue({ allowed: true, reason: 'gist' });
    jest.spyOn(chatAdmission, 'acquire').mockReturnValue(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  it('refuses out-of-scope questions before catalog retrieval or external tools', async () => {
    jest
      .spyOn(GistScopePolicy.prototype, 'assess')
      .mockResolvedValue({ allowed: false, reason: 'out-of-scope' });
    const { run, retrievalService, agentLoopService, writtenSse } = setup(
      createCatalog(),
      { agentEnabled: true },
    );
    await run('GIST라는 단어를 넣은 일반 코딩 작업');
    expect(retrievalService.listCatalog).not.toHaveBeenCalled();
    expect(agentLoopService.run).not.toHaveBeenCalled();
    expect(writtenSse()).toContain('학교와 무관한');
  });

  it('does not send rejected seed documents to final generation after an insufficient assessment', async () => {
    const { run, llmClient, chatService } = setup(createCatalog(), {
      agentEnabled: true,
      vectorSelection: {
        rootPaths: ['학사편람/졸업요건'],
        detailPaths: [],
        confident: false,
      },
      agentRun: async () => ({
        documents: [{ path: 'weak', content: '무관한 자료' }],
        usedResources: [],
        sources: [],
        steps: [],
        rounds: 2,
        stopReason: 'exhausted',
        assessment: {
          outcome: 'insufficient',
          evidencePaths: [],
          unresolvedQuestions: ['질문'],
          reason: '관련 자료가 없음',
        },
      }),
    });
    await run('GIST 신청 기간');
    expect(
      JSON.stringify(llmClient.generateFinalResponseStream.mock.calls),
    ).not.toContain('무관한 자료');
    expect(chatService.createMessage).toHaveBeenCalledWith(
      'session-id',
      expect.objectContaining({
        role: MessageRole.ASSISTANT,
        metadata: expect.objectContaining({
          evaluation: expect.objectContaining({ stopReason: 'exhausted' }),
        }),
      }),
    );
  });
  it('researches external sources even when the internal catalog is empty', async () => {
    const { run, agentLoopService } = setup(EMPTY_CATALOG, {
      agentEnabled: true,
      noticeWidgetKeyIds: ['w1'],
    });
    await run('장학금 공지', { widgetKeyId: 'w1' });
    expect(agentLoopService.run).toHaveBeenCalled();
  });
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
    /** Ziggle 공지를 쓸 수 있는 위젯 키 ID */
    noticeWidgetKeyIds?: string[];
    /** 웹 검색을 쓸 수 있는 위젯 키 ID */
    webWidgetKeyIds?: string[];
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
    const webSearchClient = {
      isEnabledFor: jest.fn((widgetKeyId: string | undefined) =>
        (options.webWidgetKeyIds ?? []).includes(widgetKeyId ?? ''),
      ),
    };
    const ziggleNoticeClient = {
      isEnabledFor: jest.fn((widgetKeyId: string | undefined) =>
        (options.noticeWidgetKeyIds ?? []).includes(widgetKeyId ?? ''),
      ),
    };
    const agentLoopService = {
      isEnabled: jest.fn(() => options.agentEnabled ?? false),
      run: jest.fn<(input: AgentRunInput) => Promise<AgentRunResult>>(
        options.agentRun ??
          (async () => ({
            documents: [],
            usedResources: [],
            sources: [],
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
      ziggleNoticeClient as never,
      webSearchClient as never,
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
      retrievalService,
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
            sources: [],
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
            sources: [],
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

    describe('Ziggle notices', () => {
      const noticeSource = {
        kind: 'notice' as const,
        id: '301',
        title: '2026년 정원장학금 장학생 선발 안내',
        url: 'https://ziggle.gistory.me/notice/301',
        opened: true,
      };
      const noticeResult = async (): Promise<AgentRunResult> => ({
        documents: [
          {
            path: 'ziggle-notice/301',
            content:
              '[Ziggle 공지] 2026년 정원장학금 장학생 선발 안내\n\n신청 기간 10.1.~10.6.',
          },
        ],
        usedResources: [],
        sources: [
          noticeSource,
          { ...noticeSource, id: '1', url: 'u1', opened: false },
          { ...noticeSource, id: '2', url: 'u2', opened: false },
          { ...noticeSource, id: '3', url: 'u3', opened: false },
        ],
        steps: [],
        rounds: 2,
        stopReason: 'ready',
      });

      it('researches notices for a notice-like question on an allowed widget', async () => {
        const { run, agentLoopService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: confidentSelection,
          noticeWidgetKeyIds: ['w1'],
        });

        await run('장학금 신청 기간 언제야?', { widgetKeyId: 'w1' });

        expect(agentLoopService.run).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledTools: ['search_documents', 'search_notices', 'get_notice'],
          }),
        );
      });

      it('keeps notice tools off for a widget that is not allowed', async () => {
        const { run, agentLoopService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: weakSelection,
          noticeWidgetKeyIds: ['w1'],
        });

        await run('장학금 신청 기간 언제야?', { widgetKeyId: 'other' });

        expect(agentLoopService.run).toHaveBeenCalledWith(
          expect.objectContaining({ enabledTools: ['search_documents'] }),
        );
      });

      it('answers a confident non-notice question directly on an allowed widget', async () => {
        const { run, agentLoopService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: confidentSelection,
          noticeWidgetKeyIds: ['w1'],
        });

        await run('졸업 요건 학점 알려줘', { widgetKeyId: 'w1' });

        expect(agentLoopService.run).not.toHaveBeenCalled();
      });

      it('adds notice rules to the answer prompt and sends notice sources after the answer', async () => {
        const { run, llmClient, writtenSse, chatService } = setup(
          createCatalog(),
          {
            agentEnabled: true,
            vectorSelection: { rootPaths: [], detailPaths: [] },
            noticeWidgetKeyIds: ['w1'],
            agentRun: noticeResult,
          },
        );

        await run(
          '장학금 신청 기간 언제야?',
          { widgetKeyId: 'w1' },
          '신청 기간은 10월 6일까지입니다. [cite:1]',
        );

        const [messages] = llmClient.generateFinalResponseStream.mock
          .calls[0] as unknown as [Array<{ role: string; content: string }>];
        expect(messages[0].content).toContain('### 7. Ziggle 공지 자료');
        expect(messages[0].content).toContain('오늘 날짜는');

        const sse = writtenSse();
        const sourcesAt = sse.indexOf('"type":"sources"');
        expect(sourcesAt).toBeGreaterThan(sse.indexOf('"content"'));
        const event = sse
          .split('\n\n')
          .map((line) => line.replace(/^data: /, ''))
          .filter((line) => line.includes('"type":"sources"'))
          .map(
            (line) =>
              JSON.parse(line) as { sources: Array<Record<string, unknown>> },
          )[0];
        // 실제 인용한 유효한 출처만 보여준다.
        expect(event.sources.map((source) => source.id)).toEqual(['301']);
        expect(event.sources[0]).not.toHaveProperty('opened');
        expect(chatService.createMessage).toHaveBeenCalledWith(
          'session-id',
          expect.objectContaining({
            role: MessageRole.ASSISTANT,
            metadata: expect.objectContaining({
              sources: expect.arrayContaining([
                expect.objectContaining({ id: '301' }),
              ]),
            }),
          }),
        );
      });

      it('counts a notice-only answer as answered', async () => {
        const { run, unansweredQuestionsRepository } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
          noticeWidgetKeyIds: ['w1'],
          agentRun: noticeResult,
        });

        await run('장학금 신청 기간 언제야?', { widgetKeyId: 'w1' });

        expect(unansweredQuestionsRepository.record).not.toHaveBeenCalled();
      });

      it('hides notice sources when the answer is a no-answer reply', async () => {
        const { run, writtenSse } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
          noticeWidgetKeyIds: ['w1'],
          agentRun: noticeResult,
        });

        await run(
          '장학금 신청 기간 언제야?',
          { widgetKeyId: 'w1' },
          NO_ANSWER_MESSAGE,
        );

        expect(writtenSse()).not.toContain('"type":"sources"');
      });

      it('leaves the answer prompt unchanged without notices', async () => {
        const { run, llmClient } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: confidentSelection,
        });

        await run('졸업 요건 알려줘');

        const [messages] = llmClient.generateFinalResponseStream.mock
          .calls[0] as unknown as [Array<{ role: string; content: string }>];
        expect(messages[0].content).not.toContain('Ziggle');
      });
    });

    describe('no-answer retry', () => {
      const refusalStream = () => {
        const stream = new PassThrough();
        stream.end(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: NO_ANSWER_MESSAGE } }],
          })}\n\n`,
        );
        return stream;
      };

      it('retries a direct no-answer reply with agent research before anything is sent', async () => {
        const { run, llmClient, agentLoopService, writtenSse } = setup(
          createCatalog(),
          {
            agentEnabled: true,
            vectorSelection: confidentSelection,
            agentRun: async () => ({
              documents: [
                { path: '학사편람/졸업요건', content: '재탐색 본문' },
              ],
              usedResources: [{ path: '학사편람/졸업요건', formats: ['md'] }],
              sources: [],
              steps: [],
              rounds: 2,
              stopReason: 'ready',
            }),
          },
        );
        llmClient.generateFinalResponseStream.mockImplementationOnce(async () =>
          refusalStream(),
        );

        await run('GIST 안강훈 교수에 대해 알려줘');

        expect(llmClient.generateFinalResponseStream).toHaveBeenCalledTimes(2);
        expect(agentLoopService.run).toHaveBeenCalledWith(
          expect.objectContaining({
            seed: expect.objectContaining({
              documents: [
                {
                  path: '학사편람/졸업요건',
                  content: '졸업요건 문서 본문입니다.',
                },
              ],
            }),
          }),
        );
        const [, retriedToolResults] = llmClient.generateFinalResponseStream
          .mock.calls[1] as unknown as [unknown, Array<{ content: string }>];
        expect(retriedToolResults[0].content).toContain('재탐색 본문');
        expect(writtenSse()).not.toContain(NO_ANSWER_MESSAGE);
        expect(writtenSse()).toContain('졸업요건 답변');
      });

      it('does not retry while the agent is disabled', async () => {
        const { run, llmClient, agentLoopService } = setup(createCatalog(), {
          agentEnabled: false,
          vectorSelection: confidentSelection,
        });

        await run('졸업 요건 알려줘', undefined, NO_ANSWER_MESSAGE);

        expect(llmClient.generateFinalResponseStream).toHaveBeenCalledTimes(1);
        expect(agentLoopService.run).not.toHaveBeenCalled();
      });

      it('does not retry an answer that came from the agent already', async () => {
        const { run, llmClient, agentLoopService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: weakSelection,
        });

        await run('수강신청 언제야?', undefined, NO_ANSWER_MESSAGE);

        expect(agentLoopService.run).toHaveBeenCalledTimes(1);
        expect(llmClient.generateFinalResponseStream).toHaveBeenCalledTimes(1);
      });
    });

    describe('web search', () => {
      it.each([
        ['w1', ['search_documents', 'search_web']],
        ['other', ['search_documents']],
      ])('gives widget %s the tools %j', async (widgetKeyId, enabledTools) => {
        const { run, agentLoopService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: weakSelection,
          webWidgetKeyIds: ['w1'],
        });

        await run('기숙사 외박 어떻게 해?', { widgetKeyId });

        expect(agentLoopService.run).toHaveBeenCalledWith(
          expect.objectContaining({ enabledTools }),
        );
      });

      it('sends web sources in their own event so notices do not crowd them out', async () => {
        const notice = (id: string) => ({
          kind: 'notice' as const,
          id,
          title: `공지 ${id}`,
          url: `https://ziggle.gistory.me/notice/${id}`,
          opened: false,
        });
        const web = (url: string, official: boolean) => ({
          kind: 'web' as const,
          id: url,
          title: new URL(url).hostname,
          url,
          opened: false,
          official,
        });
        const { run, writtenSse, chatService } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
          webWidgetKeyIds: ['w1'],
          agentRun: async () => ({
            documents: [{ path: 'web-search/x', content: '[웹 검색] 결과' }],
            usedResources: [],
            sources: [
              notice('1'),
              notice('2'),
              notice('3'),
              notice('4'),
              web('https://blog.example.com/a', false),
              web('https://dorm.gist.ac.kr/guide', true),
            ],
            steps: [],
            rounds: 2,
            stopReason: 'ready',
          }),
        });

        await run(
          '기숙사 외박 어떻게 해?',
          { widgetKeyId: 'w1' },
          '생활관 안내 [cite:1] [cite:6]',
        );

        const events = writtenSse()
          .split('\n\n')
          .map((line) => line.replace(/^data: /, ''))
          .filter((line) => line.startsWith('{"type":"'))
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                sources?: Array<{ id: string; kind: string }>;
              },
          );
        const notices = events.find((event) => event.type === 'sources');
        const webSources = events.find((event) => event.type === 'web_sources');
        expect(notices?.sources?.map((source) => source.id)).toEqual(['1']);
        // 수집 목록이 아니라 실제 인용한 출처만 나온다.
        expect(webSources?.sources?.map((source) => source.id)).toEqual([
          'https://dorm.gist.ac.kr/guide',
        ]);
        expect(chatService.createMessage).toHaveBeenCalledWith(
          'session-id',
          expect.objectContaining({
            role: MessageRole.ASSISTANT,
            metadata: expect.objectContaining({
              sources: expect.arrayContaining([
                expect.objectContaining({ kind: 'notice' }),
              ]),
              webSources: expect.arrayContaining([
                expect.objectContaining({ kind: 'web', official: true }),
              ]),
            }),
          }),
        );
      });

      it('adds web answer rules when web findings are in the materials', async () => {
        const { run, llmClient } = setup(createCatalog(), {
          agentEnabled: true,
          vectorSelection: { rootPaths: [], detailPaths: [] },
          webWidgetKeyIds: ['w1'],
          agentRun: async () => ({
            documents: [
              {
                path: 'web-search/gist기숙사외박',
                content:
                  "[웹 검색] 'GIST 기숙사 외박' 검색 결과\n- 외박은 생활관 시스템에서 신청한다. (출처: dorm.gist.ac.kr, 공식)",
              },
            ],
            usedResources: [],
            sources: [
              {
                kind: 'web',
                id: 'https://dorm.gist.ac.kr/guide',
                title: 'dorm.gist.ac.kr',
                url: 'https://dorm.gist.ac.kr/guide',
                opened: false,
              },
            ],
            steps: [],
            rounds: 2,
            stopReason: 'ready',
          }),
        });

        await run('기숙사 외박 어떻게 해?', { widgetKeyId: 'w1' });

        const [messages] = llmClient.generateFinalResponseStream.mock
          .calls[0] as unknown as [Array<{ role: string; content: string }>];
        expect(messages[0].content).toContain('### 8. 웹 검색 자료');
        expect(messages[0].content).not.toContain('### 7. Ziggle 공지 자료');
      });
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
