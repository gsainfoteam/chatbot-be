import { describe, expect, it, jest } from '@jest/globals';
import { AgentLoopService, type AgentRunInput } from './agent-loop.service';
import type { AgentStep, AgentToolResult } from './agent.types';
import type { LlmMessage, LlmResponse, LlmToolCall } from '../types/llm.types';
import type { ListResourcesResult } from '../../retrieval/retrieval.types';

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
  };

  const service = new AgentLoopService(
    llmClient as never,
    configService as never,
    searchTool as never,
  );

  const run = (input: Partial<AgentRunInput> = {}) =>
    service.run({
      question: '졸업하려면?',
      history: [],
      catalog: CATALOG,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      ...input,
    });

  return { service, run, callLLM, execute };
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
    expect(result.stopReason).toBe('ready');
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

  it('reports tool progress with the reason the model gave', async () => {
    const steps: AgentStep[] = [];
    const { run } = setup([
      response([toolCall('a', '졸업 요건', '졸업 요건을 찾아볼게요')]),
    ]);

    const result = await run({ onStep: (step) => steps.push(step) });

    expect(steps.map((step) => step.status)).toEqual(['running', 'done']);
    expect(steps[1]).toMatchObject({
      kind: 'search_documents',
      label: '졸업 요건을 찾아볼게요',
      resultCount: 1,
    });
    expect(result.steps).toEqual([steps[1]]);
  });

  it('turns a failing tool into a tool message instead of throwing', async () => {
    const steps: AgentStep[] = [];
    const { run, callLLM } = setup([response([toolCall('a', '졸업')])], {
      search: async () => {
        throw new Error('db down');
      },
    });

    const result = await run({ onStep: (step) => steps.push(step) });

    expect(steps.at(-1)?.status).toBe('failed');
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
});
