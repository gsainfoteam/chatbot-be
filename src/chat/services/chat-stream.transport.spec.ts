import { PassThrough } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';
import { ChatStreamTransport } from './chat-stream.transport';

describe('ChatStreamTransport', () => {
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
      `data: ${JSON.stringify({ error: 'upstream timeout' })}\n\n`,
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
});
