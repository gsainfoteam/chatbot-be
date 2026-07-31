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
});
