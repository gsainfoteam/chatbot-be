import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';
import { ChatStreamTransport } from './chat-stream.transport';

describe('ChatStreamTransport', () => {
  it('cancels an idle provider stream without waiting for another token', async () => {
    const transport = createTransport();
    const stream = new PassThrough();
    const c = new AbortController();
    const promise = transport.consumeAndForward(
      stream,
      { raw: { write: jest.fn(), end: jest.fn() } } as never,
      undefined,
      c.signal,
    );
    c.abort();
    await expect(promise).rejects.toThrow('cancelled');
    expect(stream.destroyed).toBe(true);
  });
  it('cancels a pending refusal probe', async () => {
    const transport = createTransport();
    const stream = new PassThrough();
    const c = new AbortController();
    const promise = transport.detectLeadingText(
      stream,
      '현재 확인 가능한 정보가 없어',
      c.signal,
    );
    c.abort();
    await expect(promise).rejects.toThrow('cancelled');
  });
  it('preserves multibyte Korean characters across network byte boundaries', async () => {
    const transport = createTransport();
    const stream = new PassThrough();
    const promise = transport.consumeAndForward(stream, {
      raw: { write: jest.fn(), end: jest.fn() },
    } as never);
    const data = Buffer.from(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: '안녕하세요' } }] }) +
        '\n\n',
    );
    for (const byte of data) stream.write(Buffer.from([byte]));
    stream.end();
    expect((await promise).accumulatedContent).toBe('안녕하세요');
  });

  function createTransport() {
    return new ChatStreamTransport({
      get: jest.fn((key: string) =>
        key === 'DOMAIN_NAME' ? 'example.com' : undefined,
      ),
    } as never);
  }

  it('prepares SSE headers with allowed origin', () => {
    const transport = createTransport();
    const reply = {
      hijack: jest.fn(),
      raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() },
    };
    const req = { headers: { origin: 'http://localhost:5173' } };

    transport.prepareSse(reply as never, req as never);

    expect(reply.hijack).toHaveBeenCalled();
    expect(reply.raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': 'http://localhost:5173',
        'Access-Control-Allow-Credentials': 'true',
      }),
    );
  });

  it('forwards content deltas and resolves usage on stream end', async () => {
    const transport = createTransport();
    const reply = {
      raw: { write: jest.fn(), end: jest.fn() },
    };
    const stream = new PassThrough();

    const consumePromise = transport.consumeAndForward(stream, reply as never);

    stream.write(
      `data: ${JSON.stringify({
        model: 'heavy-model',
        choices: [{ delta: { content: '안녕' } }],
      })}\n\n`,
    );
    stream.write(
      `data: ${JSON.stringify({
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      })}\n\n`,
    );
    stream.end();

    await expect(consumePromise).resolves.toEqual({
      accumulatedContent: '안녕',
      model: 'heavy-model',
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    });
    expect(reply.raw.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ content: '안녕' })}\n\n`,
    );
  });

  it('ends the SSE response and rejects when the upstream stream errors', async () => {
    const transport = createTransport();
    const reply = {
      raw: { write: jest.fn(), end: jest.fn(), writableEnded: false },
    };
    const stream = new PassThrough();
    const consumePromise = transport.consumeAndForward(stream, reply as never);

    stream.destroy(new Error('upstream timeout'));

    await expect(consumePromise).rejects.toThrow('upstream timeout');
    expect(reply.raw.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ error: '답변 생성 중 오류가 발생했습니다.' })}\n\n`,
    );
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });

  it('does not swallow SSE write failures as JSON parse failures', async () => {
    const transport = createTransport();
    const reply = {
      raw: {
        write: jest.fn(() => {
          throw new Error('socket closed');
        }),
        end: jest.fn(),
        writableEnded: false,
      },
    };
    const stream = new PassThrough();
    const consumePromise = transport.consumeAndForward(stream, reply as never);

    stream.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '안녕' } }],
      })}\n\n`,
    );

    await expect(consumePromise).rejects.toThrow('socket closed');
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });

  it('writes resources and done events', () => {
    const transport = createTransport();
    const reply = {
      raw: { write: jest.fn(), end: jest.fn() },
    };

    transport.writeResources(reply as never, [
      { path: 'a.pdf', formats: ['pdf'], url: 'a.pdf' },
    ]);
    transport.writeDone(reply as never);

    expect(reply.raw.write).toHaveBeenNthCalledWith(
      1,
      `data: ${JSON.stringify({
        type: 'resources',
        resources: [{ path: 'a.pdf', formats: ['pdf'], url: 'a.pdf' }],
      })}\n\n`,
    );
    expect(reply.raw.write).toHaveBeenNthCalledWith(2, 'data: [DONE]\n\n');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  describe('writeStep', () => {
    function stepReply(writableEnded = false) {
      return { raw: { write: jest.fn(), end: jest.fn(), writableEnded } };
    }

    it('writes a step event that old clients ignore', () => {
      const transport = createTransport();
      const reply = stepReply();

      transport.writeStep(reply as never, {
        id: 'r1_a',
        kind: 'search_documents',
        label: "'졸업 요건' 관련 문서 2개를 찾았어요",
        status: 'done',
        thought: '졸업 요건을 먼저 확인해 볼게요',
        resultCount: 2,
      });

      const written = String(reply.raw.write.mock.calls[0][0]);
      expect(written.startsWith('data: ')).toBe(true);
      expect(written.endsWith('\n\n')).toBe(true);
      const event = JSON.parse(written.slice(6)) as Record<string, unknown>;
      expect(event).toEqual({
        type: 'step',
        id: 'r1_a',
        kind: 'search_documents',
        label: "'졸업 요건' 관련 문서 2개를 찾았어요",
        status: 'done',
        thought: '졸업 요건을 먼저 확인해 볼게요',
        resultCount: 2,
      });
      // 웹 위젯·Flutter 패키지는 content를 답변에 붙이고 error를 실패로 본다.
      expect(event).not.toHaveProperty('content');
      expect(event).not.toHaveProperty('error');
    });

    it('omits optional fields that are not set', () => {
      const transport = createTransport();
      const reply = stepReply();

      transport.writeStep(reply as never, {
        id: 'research',
        kind: 'research',
        label: '자료를 더 찾아보고 있어요',
        status: 'running',
      });

      const event = JSON.parse(
        String(reply.raw.write.mock.calls[0][0]).slice(6),
      ) as Record<string, unknown>;
      expect(Object.keys(event).sort()).toEqual(
        ['id', 'kind', 'label', 'status', 'type'].sort(),
      );
    });

    it('does nothing after the response has ended', () => {
      const transport = createTransport();
      const reply = stepReply(true);

      transport.writeStep(reply as never, {
        id: 'research',
        kind: 'research',
        label: '자료를 더 찾아보고 있어요',
        status: 'running',
      });

      expect(reply.raw.write).not.toHaveBeenCalled();
    });

    it('keeps going when the socket write throws', () => {
      const transport = createTransport();
      const reply = stepReply();
      reply.raw.write.mockImplementation(() => {
        throw new Error('socket closed');
      });

      expect(() =>
        transport.writeStep(reply as never, {
          id: 'research',
          kind: 'research',
          label: '자료를 더 찾아보고 있어요',
          status: 'running',
        }),
      ).not.toThrow();
    });
  });

  describe('writeSources', () => {
    it('writes external sources without content, error, or internal fields', () => {
      const transport = createTransport();
      const reply = { raw: { write: jest.fn(), end: jest.fn() } };

      transport.writeSources(reply as never, [
        {
          kind: 'notice',
          id: '301',
          title: '장학생 선발 안내',
          url: 'https://ziggle.gistory.me/notice/301',
          opened: true,
        },
      ]);

      const event = JSON.parse(
        String(reply.raw.write.mock.calls[0][0]).slice(6),
      ) as Record<string, unknown>;
      expect(event).toEqual({
        type: 'sources',
        sources: [
          {
            kind: 'notice',
            id: '301',
            title: '장학생 선발 안내',
            url: 'https://ziggle.gistory.me/notice/301',
          },
        ],
      });
    });

    it('writes nothing for an empty list', () => {
      const transport = createTransport();
      const reply = { raw: { write: jest.fn(), end: jest.fn() } };

      transport.writeSources(reply as never, []);

      expect(reply.raw.write).not.toHaveBeenCalled();
    });
  });

  describe('detectLeadingText', () => {
    const LEAD = '현재 확인 가능한 정보가 없어';
    const delta = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

    async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
      let text = '';
      for await (const chunk of stream) text += String(chunk);
      return text;
    }

    it('passes a normal answer through untouched as soon as it differs', async () => {
      const transport = createTransport();
      const upstream = new PassThrough();
      const pending = transport.detectLeadingText(upstream, LEAD);

      upstream.write(delta('졸업하려면 '));
      const result = await pending;
      upstream.write(delta('130학점이 필요해요.'));
      upstream.end('data: [DONE]\n\n');

      expect(result.matched).toBe(false);
      await expect(readAll(result.stream)).resolves.toBe(
        delta('졸업하려면 ') +
          delta('130학점이 필요해요.') +
          'data: [DONE]\n\n',
      );
    });

    it('matches the lead even when it arrives in small pieces with markdown', async () => {
      const transport = createTransport();
      const upstream = new PassThrough();
      const pending = transport.detectLeadingText(upstream, LEAD);

      for (const piece of [
        '**현재',
        ' 확인 ',
        '가능한 정보',
        '가 없어**',
        ' 답변',
      ]) {
        upstream.write(delta(piece));
      }
      const result = await pending;

      expect(result.matched).toBe(true);
      expect(upstream.destroyed).toBe(true);
    });

    it('does not match an answer that only starts the same way', async () => {
      const transport = createTransport();
      const upstream = new PassThrough();
      const pending = transport.detectLeadingText(upstream, LEAD);

      upstream.write(delta('현재 확인 가능한 정보로는 '));
      const result = await pending;
      upstream.end();

      expect(result.matched).toBe(false);
      await expect(readAll(result.stream)).resolves.toContain('정보로는');
    });

    it('passes through a stream that ends before a decision', async () => {
      const transport = createTransport();
      const upstream = new PassThrough();
      const pending = transport.detectLeadingText(upstream, LEAD);

      upstream.end(delta('현재'));
      const result = await pending;

      expect(result.matched).toBe(false);
      await expect(readAll(result.stream)).resolves.toBe(delta('현재'));
    });
  });

  describe('writeWebSources', () => {
    it('writes web sources with the official flag, without content or error', () => {
      const transport = createTransport();
      const reply = { raw: { write: jest.fn(), end: jest.fn() } };

      transport.writeWebSources(reply as never, [
        {
          kind: 'web',
          id: 'https://dorm.gist.ac.kr/guide',
          title: 'dorm.gist.ac.kr',
          url: 'https://dorm.gist.ac.kr/guide',
          opened: false,
          official: true,
        },
        {
          kind: 'web',
          id: 'https://blog.example.com/a',
          title: 'blog.example.com',
          url: 'https://blog.example.com/a',
          opened: false,
        },
      ]);

      const event = JSON.parse(
        String(reply.raw.write.mock.calls[0][0]).slice(6),
      ) as Record<string, unknown>;
      expect(event).toEqual({
        type: 'web_sources',
        sources: [
          {
            kind: 'web',
            id: 'https://dorm.gist.ac.kr/guide',
            title: 'dorm.gist.ac.kr',
            url: 'https://dorm.gist.ac.kr/guide',
            official: true,
          },
          {
            kind: 'web',
            id: 'https://blog.example.com/a',
            title: 'blog.example.com',
            url: 'https://blog.example.com/a',
            official: false,
          },
        ],
      });
    });

    it('writes nothing for an empty list', () => {
      const transport = createTransport();
      const reply = { raw: { write: jest.fn(), end: jest.fn() } };

      transport.writeWebSources(reply as never, []);

      expect(reply.raw.write).not.toHaveBeenCalled();
    });
  });
});
