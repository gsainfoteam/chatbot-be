import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { LLM_CLIENT } from './llm-client.interface';
import { LetsurLlmService } from './letsur-llm.service';
import { OpenRouterLlmService } from './open-router-llm.service';

export type LlmProviderName = 'letsur' | 'openrouter';

export function resolveLlmProviderName(
  value: string | undefined,
): LlmProviderName {
  const normalized = (value || 'letsur').toLowerCase().trim();
  if (normalized === 'openrouter') {
    return 'openrouter';
  }
  return 'letsur';
}

/**
 * LLM_PROVIDER 환경변수에 따라 Letsur / OpenRouter 구현체를 선택합니다.
 * 기본값: letsur
 */
export const llmClientProvider: Provider = {
  provide: LLM_CLIENT,
  useFactory: (
    configService: ConfigService,
    httpService: HttpService,
  ): LetsurLlmService | OpenRouterLlmService => {
    const provider = resolveLlmProviderName(
      configService.get<string>('LLM_PROVIDER'),
    );
    if (provider === 'openrouter') {
      return new OpenRouterLlmService(httpService, configService);
    }
    return new LetsurLlmService(httpService, configService);
  },
  inject: [ConfigService, HttpService],
};
