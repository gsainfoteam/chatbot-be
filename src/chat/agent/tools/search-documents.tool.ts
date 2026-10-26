import { Injectable } from '@nestjs/common';
import { ResourceContentService } from '../../services/resource-content.service';
import type {
  AgentDocument,
  AgentStepOutcome,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from '../agent.types';

export const SEARCH_DOCUMENTS_TOOL_NAME = 'search_documents';

/** 에이전트 모델에게 보여줄 문서 한 개의 본문 상한. 최종 답변에는 원문 전체가 들어간다. */
const MAX_DOCUMENT_CHARS_FOR_AGENT = 3_000;

/** 진행 문구에 넣는 검색어 길이 상한 */
const MAX_QUERY_CHARS_IN_LABEL = 30;

/**
 * 내부 문서·주입 지식 검색. 기존 빠른 경로와 같은 선별(벡터 → LLM 폴백)을 쓰고,
 * 검색어만 에이전트가 정한다.
 */
@Injectable()
export class SearchDocumentsTool implements AgentTool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: SEARCH_DOCUMENTS_TOOL_NAME,
      description:
        'GIST 내부 문서(학사 규정, 안내문, 관리자가 입력한 지식)에서 검색어와 관련된 내용을 찾는다.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '문서에 실제로 쓰였을 법한 짧은 검색 문장. 이전 대화의 대상·학기 등 맥락을 채워 넣는다.',
          },
          reason: {
            type: 'string',
            description:
              '이 검색이 왜 필요한지 사용자에게 말하듯 쓴 해요체 한 문장(30자 이내). 예: "졸업 요건을 먼저 확인해 볼게요"',
          },
        },
        required: ['query', 'reason'],
      },
    },
  };

  constructor(
    private readonly resourceContentService: ResourceContentService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { content: 'query가 비어 있습니다.', resultCount: 0 };
    }

    const result =
      await this.resourceContentService.fetchRelevantResourceContents(
        query,
        context.catalog,
        context.usage,
      );

    return {
      content: describeDocumentsForAgent(result.documents, context.seenPaths),
      resultCount: result.documents.length,
      documents: result.documents,
      usedResources: result.usedResources,
    };
  }

  describeStep(
    args: Record<string, unknown>,
    outcome: AgentStepOutcome,
  ): string {
    const raw = typeof args.query === 'string' ? args.query.trim() : '';
    const query =
      raw.length > MAX_QUERY_CHARS_IN_LABEL
        ? `${raw.slice(0, MAX_QUERY_CHARS_IN_LABEL)}…`
        : raw;
    switch (outcome.status) {
      case 'running':
        return `'${query}' 문서를 찾고 있어요`;
      case 'done':
        return outcome.resultCount > 0
          ? `'${query}' 관련 문서 ${outcome.resultCount}개를 찾았어요`
          : `'${query}'${withRo(query)}는 문서를 찾지 못했어요`;
      case 'failed':
        return `'${query}' 문서 검색에 실패했어요`;
    }
  }
}

/** 이미 보여준 문서는 경로만 남겨 같은 본문으로 컨텍스트를 채우지 않는다. */
export function describeDocumentsForAgent(
  documents: AgentDocument[],
  seenPaths: ReadonlySet<string>,
): string {
  if (documents.length === 0) {
    return '검색 결과가 없습니다. 동의어, 공식 명칭, 더 넓은 표현으로 바꿔 검색해 보세요.';
  }

  const fresh = documents.filter((doc) => !seenPaths.has(doc.path));
  const repeated = documents.length - fresh.length;
  if (fresh.length === 0) {
    return `새로 찾은 문서가 없습니다. 이미 확인한 문서 ${repeated}개와 같습니다.`;
  }

  const sections = fresh.map((doc) => {
    const body =
      doc.content.length > MAX_DOCUMENT_CHARS_FOR_AGENT
        ? `${doc.content.slice(0, MAX_DOCUMENT_CHARS_FOR_AGENT)}\n[이하 생략]`
        : doc.content;
    return `### ${doc.path}\n${body}`;
  });
  if (repeated > 0) {
    sections.push(`(이미 확인한 문서 ${repeated}개는 생략)`);
  }
  return sections.join('\n\n');
}

/**
 * 조사 "로/으로". 받침이 있으면(ㄹ 제외) "으로", 없으면 "로".
 * 한글로 끝나지 않으면 읽는 법을 알 수 없어 "(으)로"를 쓴다.
 */
export function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (Number.isNaN(code) || code < 0 || code > 11171) return '(으)로';
  const finalConsonant = code % 28;
  return finalConsonant === 0 || finalConsonant === 8 ? '로' : '으로';
}
