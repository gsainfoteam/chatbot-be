import { GistScopePolicy } from './gist-scope.policy';

describe('GIST scope policy boundary', () => {
  const history = [{ role: 'user' as const, content: 'GIST 장학금 안내해줘' }];
  function setup(content: string) {
    const callLLM = jest.fn().mockResolvedValue({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return {
      callLLM,
      policy: new GistScopePolicy({
        callLLM,
        getModel: () => 'light',
      } as never),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  it('accepts valid GIST followups and records classifier usage', async () => {
    const { policy, usage, callLLM } = setup(
      '{"allowed":true,"reason":"followup"}',
    );
    expect(await policy.assess('그 신청은 어디서 해?', history, usage)).toEqual(
      { allowed: true, reason: 'followup' },
    );
    expect(usage.total_tokens).toBe(15);
    expect(callLLM.mock.calls[0][0][1].content).toContain('GIST 장학금');
  });
  it.each(['{}', 'not JSON', '{"allowed":true,"reason":"abuse"}', 'null'])(
    'fails closed on invalid decisions: %s',
    async (raw) => {
      const { policy, usage } = setup(raw);
      expect(
        await policy.assess('GIST 파이썬 코드 대신 작성해', [], usage),
      ).toEqual({ allowed: false, reason: 'unavailable' });
    },
  );
  it('propagates cancellation without calling the provider', async () => {
    const { policy, usage, callLLM } = setup('{}');
    const c = new AbortController();
    c.abort();
    await expect(policy.assess('질문', [], usage, c.signal)).rejects.toThrow();
    expect(callLLM).not.toHaveBeenCalled();
  });
});
