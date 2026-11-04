import { InternalServerErrorException } from '@nestjs/common';
import { GistScopePolicy, type ScopeDiagnostics } from './gist-scope.policy';

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

  const timeout = () =>
    new InternalServerErrorException('Gateway timeout', {
      cause: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    });

  it('allows the scholarship question after one transient timeout with a longer request timeout', async () => {
    const { policy, usage, callLLM } = setup(
      '{"allowed":true,"reason":"gist"}',
    );
    callLLM.mockRejectedValueOnce(timeout());
    const diagnostics: ScopeDiagnostics = {};
    expect(
      await policy.assess(
        '장학금 종류와 신청 방법을 알려주세요.',
        [],
        usage,
        undefined,
        diagnostics,
      ),
    ).toEqual({ allowed: true, reason: 'gist' });
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(callLLM.mock.calls[0][2].timeoutMs).toBe(30000);
    expect(callLLM.mock.calls[1][2].timeoutMs).toBe(30000);
    expect(usage.total_tokens).toBe(15);
    expect(diagnostics).toMatchObject({
      attempts: 2,
      failure: 'timeout',
      usageIncomplete: true,
    });
  });

  it('stops after two timeouts without allowing an unchecked request', async () => {
    const { policy, usage, callLLM } = setup('{}');
    callLLM.mockRejectedValue(timeout());
    expect(await policy.assess('장학금 신청 방법', [], usage)).toEqual({
      allowed: false,
      reason: 'unavailable',
    });
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-timeout provider failures', async () => {
    const { policy, usage, callLLM } = setup('{}');
    callLLM.mockRejectedValue(new Error('Invalid API key'));
    const diagnostics: ScopeDiagnostics = {};
    await policy.assess('장학금 신청 방법', [], usage, undefined, diagnostics);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(diagnostics.failure).toBe('provider-error');
  });

  it('does not retry when the user disconnects during the provider call', async () => {
    const { policy, usage, callLLM } = setup('{}');
    const controller = new AbortController();
    callLLM.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(timeout());
    });
    await expect(
      policy.assess('장학금', [], usage, controller.signal),
    ).rejects.toThrow();
    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});
