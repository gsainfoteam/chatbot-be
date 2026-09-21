import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ListResourceItem } from '../../retrieval/retrieval.types';
import { LLM_CLIENT, type LlmClient } from '../llm/llm-client.interface';
import type { LlmUsage } from '../types/llm.types';
import {
  CHUNK_SELECTION_SYSTEM_PROMPT,
  getChunkSelectionUserPrompt,
  buildChunkSelectionCandidates,
  formatChunkCandidatesForSelection,
} from '../prompts';
import { Trace } from '@gsainfoteam/nest-observability';

export type RelevantChunkSelection = {
  rootPaths: string[];
  detailPaths: string[];
};

/**
 * LLM 기반 리소스/문서 선별 서비스
 */
@Trace()
@Injectable()
export class ResourceSelectionService {
  private readonly logger = new Logger(ResourceSelectionService.name);

  constructor(@Inject(LLM_CLIENT) private readonly llmClient: LlmClient) {}

  private addTokenUsage(
    target: LlmUsage | undefined,
    usage: LlmUsage | null | undefined,
  ): void {
    if (!target || !usage) return;

    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

    target.prompt_tokens += promptTokens;
    target.completion_tokens += completionTokens;
    target.total_tokens += totalTokens;
  }

  async selectRelevantChunkPaths(
    question: string,
    resources: ListResourceItem[],
    maxResults: number = 5,
    tokenUsage?: LlmUsage,
  ): Promise<RelevantChunkSelection> {
    if (!resources?.length) {
      return { rootPaths: [], detailPaths: [] };
    }

    const candidates = buildChunkSelectionCandidates(resources);
    if (candidates.length === 0) {
      return { rootPaths: [], detailPaths: [] };
    }

    const resourceListText = formatChunkCandidatesForSelection(candidates);
    const userPrompt = getChunkSelectionUserPrompt({
      question,
      resourceListText,
      maxSelect: maxResults,
    });

    try {
      const response = await this.llmClient.callLLM(
        [
          { role: 'system', content: CHUNK_SELECTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        this.llmClient.getModel('light'),
        { temperature: 0.1, max_tokens: 5000 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      let selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM chunk selection raw: ${selectedText}`);

      // 마크다운 코드블록 제거 (```json ... ```)
      const codeBlockMatch = selectedText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        selectedText = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(selectedText) as unknown;
      const numbers = Array.isArray(parsed)
        ? parsed.filter(
            (value): value is number =>
              typeof value === 'number' &&
              Number.isInteger(value) &&
              value >= 1 &&
              value <= candidates.length,
          )
        : [];

      const selected = [...new Set(numbers)]
        .slice(0, maxResults)
        .map((number) => candidates[number - 1]);
      const rootPaths = new Set<string>();
      const detailPaths: string[] = [];

      for (const candidate of selected) {
        if (candidate.isRoot) {
          rootPaths.add(candidate.path);
        } else {
          detailPaths.push(candidate.path);
          if (candidate.rootPath) rootPaths.add(candidate.rootPath);
        }
      }

      this.logger.log(
        `[DEBUG] 1차 선별 결과: 루트 ${rootPaths.size}개, 세부 chunk ${detailPaths.length}개`,
      );
      return { rootPaths: [...rootPaths], detailPaths };
    } catch (error) {
      this.logger.warn(
        `Failed to select chunks by LLM: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { rootPaths: [], detailPaths: [] };
    }
  }
}
