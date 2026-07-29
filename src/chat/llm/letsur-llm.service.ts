import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BaseOpenAiCompatibleLlm } from './base-openai-compatible.llm';

/**
 * Letsur AI Gateway LLM 클라이언트
 */
@Injectable()
export class LetsurLlmService extends BaseOpenAiCompatibleLlm {
  protected readonly logger = new Logger(LetsurLlmService.name);

  constructor(httpService: HttpService, configService: ConfigService) {
    const fallback =
      configService.get<string>('LETSUR_AI_GATEWAY_MODEL') || 'gpt-4o-mini';
    const xTitle =
      configService.get<string>('LETSUR_AI_GATEWAY_X_TITLE') ||
      configService.get<string>('LETSUR_AI_GATEWAY_TITLE');

    super(httpService, configService, {
      apiKey: configService.getOrThrow<string>('LETSUR_AI_GATEWAY_API_KEY'),
      baseUrl: configService.getOrThrow<string>('LETSUR_AI_GATEWAY_BASE_URL'),
      modelLight:
        configService.get<string>('LETSUR_AI_GATEWAY_MODEL_LIGHT') || fallback,
      modelNormal:
        configService.get<string>('LETSUR_AI_GATEWAY_MODEL_NORMAL') || fallback,
      modelHeavy:
        configService.get<string>('LETSUR_AI_GATEWAY_MODEL_HEAVY') || fallback,
      xTitle,
      providerLabel: 'Letsur AI Gateway',
    });
  }
}
