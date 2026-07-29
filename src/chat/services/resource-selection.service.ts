import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ListResourceItem } from '../../mcp/mcp-client.service';
import { LLM_CLIENT, type LlmClient } from '../llm/llm-client.interface';
import type { LlmUsage } from '../types/llm.types';
import {
  DOCUMENT_SELECTION_SYSTEM_PROMPT,
  getDocumentSelectionUserPrompt,
  RESOURCE_PATH_SELECTION_SYSTEM_PROMPT,
  getResourcePathSelectionUserPrompt,
  CHUNK_SELECTION_SYSTEM_PROMPT,
  getChunkSelectionUserPrompt,
  formatResourceListForChunkSelection,
} from '../prompts';

/**
 * LLM 기반 리소스/문서 선별 서비스
 */
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
    maxResults: number = 10,
    tokenUsage?: LlmUsage,
  ): Promise<string[]> {
    if (!resources?.length) {
      return [];
    }

    const resourceListText = formatResourceListForChunkSelection(resources);
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
      const paths = Array.isArray(parsed)
        ? (parsed as string[]).filter(
            (p) => typeof p === 'string' && p.length > 0,
          )
        : [];

      const limited = paths.slice(0, maxResults);
      this.logger.log(`[DEBUG] 1차 선별 결과(chunk 경로): ${limited.length}개`);
      return limited;
    } catch (error) {
      this.logger.warn(
        `Failed to select chunk paths by LLM: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * LLM으로 질문과 의미·맥락상 관련 있는 리소스 경로를 선별 (구 형식)
   * 키워드 매칭 대신 의미 기반으로 최대 maxResults개 선택합니다.
   */
  async selectRelevantResourcePaths(
    question: string,
    resources: Array<{ path: string; formats?: string[] }>,
    maxResults: number = 10,
    tokenUsage?: LlmUsage,
  ): Promise<Array<{ path: string; formats?: string[] }>> {
    if (!resources.length) {
      return [];
    }

    const pathList = resources.map((r, i) => `${i + 1}. ${r.path}`).join('\n');

    const userPrompt = getResourcePathSelectionUserPrompt({
      pathList,
      question,
      maxSelect: maxResults,
    });

    try {
      const response = await this.llmClient.callLLM(
        [
          { role: 'system', content: RESOURCE_PATH_SELECTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        this.llmClient.getModel('light'),
        { temperature: 0.1, max_tokens: 200 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      const selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM selected resource paths: ${selectedText}`);

      if (selectedText.toLowerCase().includes('없음')) {
        return [];
      }

      const numbers =
        selectedText
          .match(/\d+/g)
          ?.map((n) => parseInt(n, 10) - 1)
          .filter((n) => n >= 0 && n < resources.length) || [];

      const uniqueIndices = [...new Set(numbers)].slice(0, maxResults);
      const selected = uniqueIndices.map((idx) => resources[idx]);

      this.logger.log(`Selected ${selected.length} resource path(s) by LLM`);
      return selected;
    } catch (error) {
      this.logger.warn(
        `Failed to select resource paths by LLM: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * LLM에게 문서 목록을 주고 질문과 관련성이 높은 문서만 선별하도록 요청
   */
  async selectMostRelevantDocuments(
    question: string,
    documents: Array<{ title: string; content: string; path: string }>,
    tokenUsage?: LlmUsage,
  ): Promise<Array<{ title: string; content: string; path: string }>> {
    if (documents.length === 0) {
      return [];
    }

    // 문서가 1개면 선별 불필요
    if (documents.length === 1) {
      return documents;
    }

    try {
      // 제목 + 내용 앞부분(요약)을 주어 경로/제목에 키워드가 없어도 내용으로 관련 문서 선별 가능하게 함
      const CONTENT_SNIPPET_LENGTH = 280;
      const documentList = documents
        .map((doc, index) => {
          const snippet =
            doc.content.length > CONTENT_SNIPPET_LENGTH
              ? doc.content
                  .slice(0, CONTENT_SNIPPET_LENGTH)
                  .replace(/\n/g, ' ') + '...'
              : doc.content.replace(/\n/g, ' ');
          return `${index + 1}. ${doc.title}\n   내용 요약: ${snippet}`;
        })
        .join('\n\n');

      const selectionPrompt = getDocumentSelectionUserPrompt({
        documentList,
        question,
      });

      this.logger.debug(
        `Selection prompt length: ${selectionPrompt.length} chars, documents: ${documents.length}`,
      );

      const response = await this.llmClient.callLLM(
        [
          {
            role: 'system',
            content: DOCUMENT_SELECTION_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: selectionPrompt,
          },
        ],
        this.llmClient.getModel('normal'),
        { temperature: 0.1, max_tokens: 100 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      const selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM selected documents: ${selectedText}`);

      // "없음"이면 빈 배열 반환 (관련 없는 질문일 수 있으므로 문서 강제 선택 안 함)
      if (selectedText.toLowerCase().includes('없음')) {
        return [];
      }

      // 번호 추출 (예: "1, 3, 5" 또는 "1,3,5")
      const numbers =
        selectedText
          .match(/\d+/g)
          ?.map((n) => parseInt(n, 10) - 1) // 0-based index로 변환
          .filter((n) => n >= 0 && n < documents.length) || [];

      if (numbers.length === 0) {
        // 번호를 파싱할 수 없으면 앞쪽 문서 반환 (최대 5개)
        this.logger.warn(
          `Could not parse document selection, returning first 5 documents`,
        );
        return documents.slice(0, 5);
      }

      // 최대 5개로 제한 (중요 문서 놓치지 않도록)
      const limitedNumbers = numbers.slice(0, 5);
      const selected = limitedNumbers.map((idx) => documents[idx]);
      this.logger.log(
        `Selected ${selected.length} relevant document(s) out of ${documents.length}`,
      );

      return selected;
    } catch (error) {
      this.logger.warn(
        `Failed to select relevant documents: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 에러 발생 시 모든 문서 반환
      return documents;
    }
  }
}
