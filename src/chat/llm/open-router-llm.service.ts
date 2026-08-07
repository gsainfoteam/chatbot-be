import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BaseOpenAiCompatibleLlm } from './base-openai-compatible.llm';

const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPEN_ROUTER_MODEL = 'openai/gpt-4o-mini';

/**
 * OpenRouter LLM 클라이언트
 * LLM_PROVIDER=openrouter 일 때 사용합니다.
 */
@Injectable()
export class OpenRouterLlmService extends BaseOpenAiCompatibleLlm {
  protected readonly logger = new Logger(OpenRouterLlmService.name);

  constructor(httpService: HttpService, configService: ConfigService) {
    const fallback =
      configService.get<string>('OPEN_ROUTER_MODEL') ||
      DEFAULT_OPEN_ROUTER_MODEL;
    const xTitle =
      configService.get<string>('OPEN_ROUTER_X_TITLE') ||
      configService.get<string>('OPEN_ROUTER_TITLE');

    super(httpService, configService, {
      apiKey: configService.getOrThrow<string>('OPEN_ROUTER_API_KEY'),
      baseUrl:
        configService.get<string>('OPEN_ROUTER_BASE_URL') ||
        DEFAULT_OPEN_ROUTER_BASE_URL,
      modelLight:
        configService.get<string>('OPEN_ROUTER_MODEL_LIGHT') || fallback,
      modelNormal:
        configService.get<string>('OPEN_ROUTER_MODEL_NORMAL') || fallback,
      modelHeavy:
        configService.get<string>('OPEN_ROUTER_MODEL_HEAVY') || fallback,
      xTitle,
      providerLabel: 'OpenRouter',
    });
  }
}
