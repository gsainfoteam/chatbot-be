import { describe, expect, it, jest } from '@jest/globals';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { Logger } from '@nestjs/common';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { BaseOpenAiCompatibleLlm } from './base-openai-compatible.llm';
import type { LlmRequestMessage } from '../types/llm.types';

const IMAGE_URL = 'data:image/jpeg;base64,QUJD';

const imageMessage: LlmRequestMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'hello' },
    { type: 'image_url', image_url: { url: IMAGE_URL } },
  ],
};

function createLlm(post: jest.Mock) {
  const logError = jest.fn();
  class TestLlm extends BaseOpenAiCompatibleLlm {
    protected readonly logger = { error: logError } as unknown as Logger;
  }
  const llm = new TestLlm(
    { post } as unknown as HttpService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService,
    {
      apiKey: 'key',
      baseUrl: 'https://llm.test',
      modelLight: 'light',
      modelNormal: 'normal',
      modelHeavy: 'heavy',
      providerLabel: 'Test',
    },
  );
  return { llm, logError };
}

describe('BaseOpenAiCompatibleLlm image requests', () => {
  it('sends image parts to the API as given', async () => {
    const post = jest.fn(() => of({ data: { choices: [] } }));
    const { llm } = createLlm(post);

    await llm.callLLM([imageMessage], 'normal');

    const [url, body] = post.mock.calls[0] as unknown[];
    expect(url).toBe('https://llm.test/chat/completions');
    expect(body).toMatchObject({ messages: [imageMessage] });
  });

  it('logs the image count but never the image data when the API fails', async () => {
    const post = jest.fn(() => throwError(() => new AxiosError('bad request')));
    const { llm, logError } = createLlm(post);

    await expect(llm.callLLM([imageMessage], 'normal')).rejects.toThrow();

    const logged = logError.mock.calls.flat().join('\n');
    expect(logged).toContain('"imagePartCount": 1');
    expect(logged).toContain('"contentCharsSum": 5');
    expect(logged).not.toContain('QUJD');
  });
});
