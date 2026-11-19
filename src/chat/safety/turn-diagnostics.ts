import type { LlmUsage } from '../types/llm.types';
import type { ResearchAssessment } from '../agent/research-decision';

export type TurnDiagnostics = {
  version: 1;
  observedUsage?: LlmUsage;
  noticesEnabled?: boolean;
  webEnabled?: boolean;
  scopeModel?: string;
  answerModel?: string;
  scope?: string;
  scopeAttempts?: number;
  scopeMs?: number;
  scopeFailure?: string;
  route?: string;
  routeReason?: string;
  rounds?: number;
  stopReason?: string;
  assessment?: ResearchAssessment;
  toolCalls?: Record<string, number>;
  toolFailures?: number;
  researchMs?: number;
  firstContentMs?: number;
  totalMs?: number;
  discardedAnswers?: number;
  usageIncomplete?: boolean;
  outcome?:
    | 'answered'
    | 'partial'
    | 'source-only'
    | 'unanswered'
    | 'scope-refused';
  outcomeBasis?: 'research-assessment' | 'response-heuristic';
  researchModel?: string;
  maxRounds?: number;
  timeBudgetEnforced?: boolean;
};
