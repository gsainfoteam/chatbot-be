import { describe, expect, it, jest } from '@jest/globals';
import { AgentLoopService, type AgentRunInput } from './agent-loop.service';
import type { AgentStep, AgentToolResult } from './agent.types';
import type { LlmMessage, LlmResponse, LlmToolCall } from '../types/llm.types';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';
import { SearchDocumentsTool } from './tools/search-documents.tool';
import { SearchNoticesTool } from './tools/ziggle/search-notices.tool';
import { GetNoticeTool } from './tools/ziggle/get-notice.tool';
import type { ZiggleNoticeSummary } from './tools/ziggle/ziggle-notice.client';
import { shortTitle } from './tools/ziggle/notice-registry';

const CATALOG: ListResourcesResult = {
  raw: {},
  texts: [],
  resourceLinks: [],
  embeddedResources: [],
  resources: [{ path: '학사편람.pdf', description: '학사 규정', chunks: [] }],
  chunks: [],
  total: 1,
};

function toolCall(
  id: string,
  query: string,
  reason = '찾아볼게요',
): LlmToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'search_documents',
      arguments: JSON.stringify({ query, reason }),
    },
  };
}

function response(
  toolCalls: LlmToolCall[] | undefined,
  content: string | null = null,
): LlmResponse {
  return {
    id: 'r',
    model: 'normal-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, tool_calls: toolCalls },
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function setup(
  responses: Array<LlmResponse | Error>,
  options: {
    config?: Record<string, unknown>;
    search?: (query: string) => Promise<AgentToolResult>;
    notices?: ZiggleNoticeSummary[];
    noticeBodies?: Record<number, string>;
  } = {},
) {
  const callLLM = jest.fn<(...args: unknown[]) => Promise<LlmResponse>>();
  for (const next of responses) {
    if (next instanceof Error) callLLM.mockRejectedValueOnce(next);
    else callLLM.mockResolvedValueOnce(next);
  }
  callLLM.mockResolvedValue(response(undefined, 'DONE'));

  const llmClient = {
    getModel: jest.fn((tier: string) => `${tier}-model`),
    callLLM,
  };
  const config = {
    AGENT_ENABLED: 'true',
    ...options.config,
  } as Record<string, unknown>;
  const configService = { get: jest.fn((key: string) => config[key]) };

  const execute = jest.fn(
    async (
      args: Record<string, unknown>,
      context: { seenPaths: ReadonlySet<string> },
    ): Promise<AgentToolResult> => {
      void context;
      const query = String(args.query);
      if (options.search) return options.search(query);
      return {
        content: `${query} 결과`,
        resultCount: 1,
        documents: [{ path: `문서/${query}`, content: `${query} 본문` }],
        usedResources: [{ path: `문서/${query}`, formats: ['md'] }],
      };
    },
  );
  const searchTool = {
    definition: {
      type: 'function' as const,
      function: {
        name: 'search_documents',
        description: '문서 검색',
        parameters: { type: 'object' },
      },
    },
    execute,
    describeStep: SearchDocumentsTool.prototype.describeStep,
  };

  const ziggle = {
    searchNotices: jest.fn(async (query: string) =>
      (options.notices ?? []).filter((notice) =>
        `${notice.title} ${notice.summary ?? ''}`.includes(query),
      ),
    ),
    getNoticeBody: jest.fn(
      async (id: number, _signal?: AbortSignal) =>
        options.noticeBodies?.[id] ?? null,
    ),
    noticeUrl: (id: number) => `https://ziggle.example/notice/${id}`,
  };

  const service = new AgentLoopService(
    llmClient as never,
    configService as never,
    searchTool as never,
    new SearchNoticesTool(ziggle as never),
    new GetNoticeTool(ziggle as never),
  );

  const run = (input: Partial<AgentRunInput> = {}) =>
    service.run({
      question: '졸업하려면?',
      history: [],
      catalog: CATALOG,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      ...input,
    });

  return { service, run, callLLM, execute, ziggle };
}

function noticeCall(id: string, keywords: string[]): LlmToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'search_notices',
      arguments: JSON.stringify({ keywords, reason: '공지를 찾아볼게요' }),
    },
  };
}

function readNoticeCall(id: string, noticeId: number): LlmToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'get_notice',
      arguments: JSON.stringify({ id: noticeId, reason: '본문을 볼게요' }),
    },
  };
}

describe('AgentLoopService', () => {
  it('reads the enable flag from config', () => {
    expect(setup([]).service.isEnabled()).toBe(true);
    expect(
      setup([], { config: { AGENT_ENABLED: false } }).service.isEnabled(),
    ).toBe(false);
  });

  it('runs requested searches and stops when the model calls no tool', async () => {
    const { run, callLLM, execute } = setup([
      response([toolCall('a', '졸업 요건'), toolCall('b', '조기 졸업')]),
      response(undefined, 'DONE'),
    ]);

    const result = await run();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('unassessed');
    expect(result.rounds).toBe(2);
    expect(result.documents.map((doc) => doc.path)).toEqual([
      '문서/졸업 요건',
      '문서/조기 졸업',
    ]);

    const [, model, options] = callLLM.mock.calls[0] as [
      unknown,
      string,
      { tools: Array<{ function: { name: string } }>; tool_choice: string },
    ];
    expect(model).toBe('normal-model');
    expect(options.tools.map((tool) => tool.function.name)).toEqual([
      'search_documents',
      'finish_research',
    ]);
    expect(options.tool_choice).toBe('auto');
  });

  it('answers every tool call id so the next round is a valid request', async () => {
    const { run, callLLM } = setup([
      response([toolCall('a', '졸업 요건'), toolCall('b', '졸업 요건')]),
    ]);

    await run();

    const secondRound = callLLM.mock.calls[1][0] as LlmMessage[];
    const toolMessages = secondRound.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['a', 'b']);
    // 같은 검색어를 두 번 부르면 두 번째는 실행하지 않는다.
    expect(toolMessages[1].content).toContain('이미 같은 인자로');
  });

  it('keeps provider-specific fields on the assistant message it sends back', async () => {
    const first = response([toolCall('a', '졸업 요건')]);
    (first.choices[0].message as unknown as Record<string, unknown>)[
      'provider_specific_fields'
    ] = { thought_signature: 'sig' };
    const { run, callLLM } = setup([first]);

    await run();

    const secondRound = callLLM.mock.calls[1][0] as Array<
      LlmMessage & { provider_specific_fields?: unknown }
    >;
    const assistant = secondRound.find((m) => m.tool_calls?.length);
    expect(assistant?.provider_specific_fields).toEqual({
      thought_signature: 'sig',
    });
  });

  it('stops at the round limit', async () => {
    const { run, callLLM } = setup(
      [
        response([toolCall('a', '1')]),
        response([toolCall('b', '2')]),
        response([toolCall('c', '3')]),
      ],
      { config: { AGENT_MAX_ROUNDS: 2 } },
    );

    const result = await run();

    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('max-rounds');
    expect(result.documents).toHaveLength(2);
  });

  it('keeps what it collected when a later round fails', async () => {
    const { run } = setup([
      response([toolCall('a', '졸업 요건')]),
      new Error('timeout'),
    ]);

    const result = await run();

    expect(result.stopReason).toBe('llm-error');
    expect(result.documents.map((doc) => doc.path)).toEqual(['문서/졸업 요건']);
  });

  it('includes the seed search and does not repeat it', async () => {
    const { run, callLLM, execute } = setup([
      response([toolCall('a', '졸업하려면?')]),
    ]);

    const result = await run({
      seed: {
        documents: [{ path: '학사편람/졸업', content: '첫 검색 본문' }],
        usedResources: [{ path: '학사편람/졸업', formats: ['md'] }],
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.documents.map((doc) => doc.path)).toEqual(['학사편람/졸업']);
    const firstRound = callLLM.mock.calls[0][0] as LlmMessage[];
    expect(firstRound.find((m) => m.role === 'tool')?.content).toContain(
      '첫 검색 본문',
    );
  });

  it('dedupes documents found by more than one search', async () => {
    const { run } = setup(
      [response([toolCall('a', '졸업'), toolCall('b', '학위 수여')])],
      {
        search: async () => ({
          content: '같은 문서',
          resultCount: 1,
          documents: [{ path: '학사편람/졸업', content: '본문' }],
          usedResources: [{ path: '학사편람/졸업', formats: ['md'] }],
        }),
      },
    );

    const result = await run();

    expect(result.documents).toEqual([
      { path: '학사편람/졸업', content: '본문' },
    ]);
    expect(result.usedResources).toHaveLength(1);
  });

  it('reports each search with a server label and the model reason as thought', async () => {
    const steps: AgentStep[] = [];
    const { run } = setup([
      response([toolCall('a', '졸업 요건', '졸업 요건을 먼저 확인해 볼게요')]),
    ]);

    await run({ onStep: (step) => steps.push(step) });

    const searchSteps = steps.filter(
      (step) => step.kind === 'search_documents',
    );
    expect(searchSteps).toEqual([
      expect.objectContaining({
        status: 'running',
        label: "'졸업 요건' 문서를 찾고 있어요",
        thought: '졸업 요건을 먼저 확인해 볼게요',
      }),
      expect.objectContaining({
        status: 'done',
        label: "'졸업 요건' 관련 문서 1개를 찾았어요",
        resultCount: 1,
      }),
    ]);
  });

  it('wraps the research in a step that opens first and closes last', async () => {
    const steps: AgentStep[] = [];
    const { run } = setup([response([toolCall('a', '졸업 요건')])]);

    const result = await run({ onStep: (step) => steps.push(step) });

    expect(steps[0]).toMatchObject({ kind: 'research', status: 'running' });
    expect(steps.at(-1)).toMatchObject({
      kind: 'research',
      status: 'done',
      label: '자료 1개를 모았어요',
      resultCount: 1,
    });
    // 저장용 결과에는 단계마다 최종 상태 하나만 남는다.
    expect(result.steps.map((step) => [step.kind, step.status])).toEqual([
      ['research', 'done'],
      ['search_documents', 'done'],
    ]);
  });

  it('says nothing was found when the research ends empty-handed', async () => {
    const steps: AgentStep[] = [];
    const { run } = setup([response([toolCall('a', '학식')])], {
      search: async () => ({ content: '없음', resultCount: 0 }),
    });

    await run({ onStep: (step) => steps.push(step) });

    expect(steps.at(-1)).toMatchObject({
      kind: 'research',
      label: '관련 자료를 찾지 못했어요',
    });
    expect(
      steps.find(
        (step) => step.kind === 'search_documents' && step.status === 'done',
      )?.label,
    ).toBe("'학식'으로는 문서를 찾지 못했어요");
  });

  it('stops once a round adds no new documents to what it already has', async () => {
    const { run, callLLM } = setup(
      [
        response([toolCall('a', '졸업')]),
        response([toolCall('b', '학위 수여')]),
        response([toolCall('c', '졸업 요건')]),
      ],
      {
        search: async () => ({
          content: '같은 문서',
          resultCount: 1,
          documents: [{ path: '학사편람/졸업', content: '본문' }],
          usedResources: [],
        }),
      },
    );

    const result = await run();

    expect(callLLM).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe('max-rounds');
  });

  it('keeps rephrasing while nothing has been found yet', async () => {
    const { run, callLLM } = setup(
      [
        response([toolCall('a', '학식')]),
        response([toolCall('b', '식당 메뉴')]),
      ],
      {
        config: { AGENT_MAX_ROUNDS: 2 },
        search: async () => ({ content: '없음', resultCount: 0 }),
      },
    );

    const result = await run();

    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('max-rounds');
  });

  it('turns a failing tool into a tool message instead of throwing', async () => {
    const steps: AgentStep[] = [];
    const { run, callLLM } = setup([response([toolCall('a', '졸업')])], {
      search: async () => {
        throw new Error('db down');
      },
    });

    const result = await run({ onStep: (step) => steps.push(step) });

    expect(
      steps.filter((step) => step.kind === 'search_documents').at(-1),
    ).toMatchObject({
      status: 'failed',
      label: "'졸업' 문서 검색에 실패했어요",
    });
    expect(result.documents).toEqual([]);
    const secondRound = callLLM.mock.calls[1][0] as LlmMessage[];
    expect(secondRound.at(-1)?.content).toContain('오류');
  });

  it('adds every round to the turn usage', async () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const { run } = setup([response([toolCall('a', '졸업')])]);

    await run({ usage });

    expect(usage.total_tokens).toBe(30);
  });

  describe('tool selection', () => {
    const toolNames = (callLLM: { mock: { calls: unknown[][] } }) =>
      (
        callLLM.mock.calls[0][2] as {
          tools: Array<{ function: { name: string } }>;
        }
      ).tools.map((tool) => tool.function.name);

    it('offers only the document search unless more tools are enabled', async () => {
      const { run, callLLM } = setup([]);

      await run();

      expect(toolNames(callLLM)).toEqual([
        'search_documents',
        'finish_research',
      ]);
      const system = (callLLM.mock.calls[0][0] as LlmMessage[])[0].content;
      expect(system).not.toContain('search_notices');
    });

    it('offers the notice tools and their rules when they are enabled', async () => {
      const { run, callLLM } = setup([]);

      await run({
        enabledTools: ['search_documents', 'search_notices', 'get_notice'],
      });

      expect(toolNames(callLLM)).toEqual([
        'search_documents',
        'search_notices',
        'get_notice',
        'finish_research',
      ]);
      const system = (callLLM.mock.calls[0][0] as LlmMessage[])[0].content;
      expect(system).toContain('## Ziggle 공지');
    });

    it('refuses a tool that is not enabled for this run', async () => {
      const { run, callLLM, ziggle } = setup([
        response([noticeCall('a', ['장학생'])]),
      ]);

      await run();

      expect(ziggle.searchNotices).not.toHaveBeenCalled();
      const secondRound = callLLM.mock.calls[1][0] as LlmMessage[];
      expect(secondRound.at(-1)?.content).toContain('알 수 없는 도구');
    });
  });

  describe('Ziggle notices', () => {
    const notices: ZiggleNoticeSummary[] = [
      {
        id: 301,
        title: '[학사] 2026년 정원장학금 장학생 선발 안내',
        summary: '신청 기간 10.1.~10.6. 학사과정 재학생 대상 장학생 선발',
      },
      { id: 288, title: '[학사] 고속도로 장학생 선발 안내', summary: null },
    ];
    const enabledTools = ['search_documents', 'search_notices', 'get_notice'];

    it('reads a notice found in an earlier round and marks its source opened', async () => {
      const { run, ziggle } = setup(
        [
          response([noticeCall('a', ['장학생', '선발'])]),
          response([readNoticeCall('b', 288)]),
        ],
        {
          notices,
          noticeBodies: { 288: '<p>신청 기간: 9.1.~9.30.</p>' },
        },
      );

      const result = await run({ enabledTools });

      expect(ziggle.searchNotices).toHaveBeenCalledTimes(2);
      expect(ziggle.getNoticeBody).toHaveBeenCalledWith(288, undefined);
      expect(result.documents.map((doc) => doc.path)).toEqual([
        'ziggle-notice/301/summary',
        'ziggle-notice/288',
      ]);
      expect(result.sources).toEqual([
        expect.objectContaining({ id: '301', opened: false }),
        expect.objectContaining({
          id: '288',
          opened: true,
          url: 'https://ziggle.example/notice/288',
        }),
      ]);
      // 내부 문서 참조(리소스 센터 PDF)와 섞이지 않는다.
      expect(result.usedResources).toEqual([]);
    });

    it('labels notice steps with the notice title', async () => {
      const steps: AgentStep[] = [];
      const { run } = setup(
        [
          response([noticeCall('a', ['장학생'])]),
          response([readNoticeCall('b', 301)]),
        ],
        { notices, noticeBodies: { 301: '<p>본문</p>' } },
      );

      await run({ enabledTools, onStep: (step) => steps.push(step) });

      const done = steps.filter(
        (step) => step.status === 'done' && step.kind !== 'research',
      );
      expect(done.map((step) => step.label)).toEqual([
        'Ziggle 공지 2개를 불러왔어요',
        `'${shortTitle(notices[0].title)}' 공지를 확인했어요`,
      ]);
    });
  });
});

it('finishes only with a structured assessment referencing collected evidence', async () => {
  const { run } = setup([
    response([toolCall('search', '규정')]),
    response([
      {
        id: 'finish',
        type: 'function',
        function: {
          name: 'finish_research',
          arguments: JSON.stringify({
            outcome: 'partial',
            evidencePaths: ['문서/규정'],
            unresolvedQuestions: ['마감일'],
            reason: '다른 자료를 찾지 못함',
          }),
        },
      },
    ]),
  ]);
  const result = await run();
  expect(result.stopReason).toBe('exhausted');
  expect(result.assessment?.unresolvedQuestions).toEqual(['마감일']);
});

it('continues from a weak seed through a summaryless notice to its body', async () => {
  const { run, ziggle } = setup(
    [
      response([noticeCall('find', ['장학금'])]),
      response([readNoticeCall('read', 42)]),
    ],
    {
      notices: [{ id: 42, title: '장학금', summary: null }],
      noticeBodies: { 42: '신청 기간은 11월 5일까지' },
    },
  );
  const result = await run({
    seed: {
      documents: [{ path: 'weak', content: '무관한 문서' }],
      usedResources: [],
    },
    enabledTools: ['search_documents', 'search_notices', 'get_notice'],
  });
  expect(ziggle.getNoticeBody).toHaveBeenCalledWith(42, undefined);
  expect(result.documents.some((d) => d.path === 'ziggle-notice/42')).toBe(
    true,
  );
});
