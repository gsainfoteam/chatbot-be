import { describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { LLM_CLIENT } from './llm-client.interface';
import {
  llmClientProvider,
  resolveLlmProviderName,
} from './llm-client.provider';
import { LetsurLlmService } from './letsur-llm.service';
import { OpenRouterLlmService } from './open-router-llm.service';

describe('resolveLlmProviderName', () => {
  it('defaults to letsur', () => {
    expect(resolveLlmProviderName(undefined)).toBe('letsur');
    expect(resolveLlmProviderName('')).toBe('letsur');
    expect(resolveLlmProviderName('letsur')).toBe('letsur');
    expect(resolveLlmProviderName('LETSUR')).toBe('letsur');
  });

  it('resolves openrouter', () => {
    expect(resolveLlmProviderName('openrouter')).toBe('openrouter');
    expect(resolveLlmProviderName(' OpenRouter ')).toBe('openrouter');
  });
});

describe('llmClientProvider factory', () => {
  it('provides LetsurLlmService by default', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        llmClientProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'LLM_PROVIDER') return undefined;
              if (key === 'LETSUR_AI_GATEWAY_MODEL') return 'gpt-4o-mini';
              return undefined;
            }),
            getOrThrow: jest.fn((key: string) => {
              if (key === 'LETSUR_AI_GATEWAY_API_KEY') return 'letsur-key';
              if (key === 'LETSUR_AI_GATEWAY_BASE_URL')
                return 'https://gw.letsur.ai/v1';
              throw new Error(`unexpected key: ${key}`);
            }),
          },
        },
        { provide: HttpService, useValue: {} },
      ],
    }).compile();

    const client = moduleRef.get(LLM_CLIENT);
    expect(client).toBeInstanceOf(LetsurLlmService);
    expect(client.getModel('light')).toBe('gpt-4o-mini');
  });

  it('provides OpenRouterLlmService when LLM_PROVIDER=openrouter', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        llmClientProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'LLM_PROVIDER') return 'openrouter';
              if (key === 'OPEN_ROUTER_MODEL_LIGHT') return 'light-model';
              if (key === 'OPEN_ROUTER_MODEL_NORMAL') return 'normal-model';
              if (key === 'OPEN_ROUTER_MODEL_HEAVY') return 'heavy-model';
              return undefined;
            }),
            getOrThrow: jest.fn((key: string) => {
              if (key === 'OPEN_ROUTER_API_KEY') return 'openrouter-key';
              throw new Error(`unexpected key: ${key}`);
            }),
          },
        },
        { provide: HttpService, useValue: {} },
      ],
    }).compile();

    const client = moduleRef.get(LLM_CLIENT);
    expect(client).toBeInstanceOf(OpenRouterLlmService);
    expect(client.getModel('heavy')).toBe('heavy-model');
  });
});
