import type { ConfigService } from '@nestjs/config';
import type { LlmModelType } from '../types/llm.types';

export type AgentConfig = {
  enabled: boolean;
  maxRounds: number;
  timeBudgetMs: number;
  modelTier: LlmModelType;
};

export const DEFAULT_AGENT_MAX_ROUNDS = 3;
export const DEFAULT_AGENT_TIME_BUDGET_MS = 20_000;

const MODEL_TIERS: readonly LlmModelType[] = ['light', 'normal', 'heavy'];

/**
 * 검증을 거친 ConfigService 값은 이미 boolean/number지만, 테스트처럼 원시 문자열이
 * 들어오는 경우도 같은 의미로 읽는다.
 */
export function readAgentConfig(configService: ConfigService): AgentConfig {
  const enabled = configService.get<boolean | string>('AGENT_ENABLED');
  const tier = configService.get<string>('AGENT_MODEL_TIER');
  return {
    enabled: enabled === true || String(enabled).toLowerCase() === 'true',
    maxRounds: positiveInt(
      configService.get('AGENT_MAX_ROUNDS'),
      DEFAULT_AGENT_MAX_ROUNDS,
    ),
    timeBudgetMs: positiveInt(
      configService.get('AGENT_TIME_BUDGET_MS'),
      DEFAULT_AGENT_TIME_BUDGET_MS,
    ),
    modelTier: MODEL_TIERS.includes(tier as LlmModelType)
      ? (tier as LlmModelType)
      : 'normal',
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
