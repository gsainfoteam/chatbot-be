import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { McpClientService } from '../../mcp/mcp-client.service';
import { OpenRouterService } from './open-router.service';
import { ChatService } from './chat.service';
import { UsageService } from '../../usage/usage.service';
import type { McpTool, OpenRouterMessage } from '../types/open-router.types';
import { MessageRole } from '../../common/dto/chat-message-input.dto';
import type { Readable } from 'stream';
import type { FastifyReply } from 'fastify';
import {
  DOCUMENT_SELECTION_SYSTEM_PROMPT,
  getDocumentSelectionUserPrompt,
  FINAL_RESPONSE_SYSTEM_PROMPT,
  NO_TOOLS_AVAILABLE_SYSTEM_PROMPT,
  NO_RELEVANT_MATERIALS_SYSTEM_PROMPT,
} from '../prompts';

/**
 * 리소스 정보
 */
export interface ResourceInfo {
  path: string; // 문서 제목 (PDF/PNG인 경우 format 포함)
  formats: string[];
  url: string;
}

/**
 * 채팅 오케스트레이션 서비스
 * 사용자 질문을 받아 LLM과 MCP Tool을 조합하여 답변을 생성합니다.
 */
@Injectable()
export class ChatOrchestrationService {
  private readonly logger = new Logger(ChatOrchestrationService.name);

  // Tool 목록 캐시 (5분간 유효)
  private cachedTools: McpTool[] | null = null;
  private cachedToolsTimestamp: number = 0;
  private readonly TOOLS_CACHE_TTL = 5 * 60 * 1000; // 5분

  // Tool 실행 타임아웃 (30초)
  private readonly TOOL_EXECUTION_TIMEOUT = 30 * 1000;

  constructor(
    private readonly mcpClientService: McpClientService,
    private readonly openRouterService: OpenRouterService,
    private readonly chatService: ChatService,
    private readonly usageService: UsageService,
  ) {}

  /**
   * MCP Tool 목록을 가져오거나 캐시에서 반환
   */
  private async getMcpTools(): Promise<McpTool[]> {
    const now = Date.now();
    if (
      this.cachedTools &&
      now - this.cachedToolsTimestamp < this.TOOLS_CACHE_TTL
    ) {
      this.logger.debug('Using cached MCP tools');
      return this.cachedTools;
    }

    this.logger.debug('Fetching MCP tools from server...');
    const mcpToolsListResult: unknown = await this.mcpClientService.listTools();

    type ToolItem = {
      name: string;
      description?: string;
      inputSchema?: McpTool['inputSchema'];
    };
    const mcpToolsList: ToolItem[] = Array.isArray(mcpToolsListResult)
      ? (mcpToolsListResult as ToolItem[])
      : [];
    const mcpTools: McpTool[] = mcpToolsList.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));

    this.cachedTools = mcpTools;
    this.cachedToolsTimestamp = now;

    return mcpTools;
  }

  /**
   * 리소스 경로 정규화
   * MCP 서버는 확장자 없이 경로를 받고 자동으로 .md 또는 .pdf를 찾으므로,
   * 확장자를 제거하여 전달합니다.
   */
  private normalizeResourcePath(path: string): string {
    // 확장자가 있으면 제거 (MCP 서버가 자동으로 찾음)
    if (path.includes('.')) {
      const lastDotIndex = path.lastIndexOf('.');
      // 마지막 점 이후가 확장자인 경우 (예: .md, .pdf)
      const extension = path.substring(lastDotIndex + 1);
      if (extension.length <= 5 && /^[a-z0-9]+$/i.test(extension)) {
        return path.substring(0, lastDotIndex);
      }
    }
    return path;
  }

  /**
   * 경로에서 마지막 문서 제목만 추출 (확장자 포함)
   * 예: "2025 캠프 발표자료_ 1일차 오전/학생지원.md" -> "학생지원.md"
   * 원본 경로에 확장자가 없으면 formats 배열에서 찾아서 추가
   */
  private extractDocumentTitle(
    path: string,
    originalPath?: string,
    formats?: string[],
  ): string {
    // 원본 경로가 있으면 원본 경로 사용 (확장자 포함)
    const pathToUse = originalPath || path;

    // 슬래시로 분리하여 마지막 부분만 반환
    const parts = pathToUse.split('/');
    let title = parts[parts.length - 1] || pathToUse;

    // 확장자가 없고 formats 배열에 md가 있으면 .md 추가
    if (!title.includes('.') && formats && formats.includes('md')) {
      title = `${title}.md`;
    }

    return title;
  }

  /**
   * get_resource 툴 응답에서 텍스트 내용 추출
   * MCP 서버는 문자열을 직접 반환하므로, texts 배열이나 raw.content에서 추출
   */
  private extractContentFromToolResult(
    toolResult: Awaited<ReturnType<typeof this.mcpClientService.callTool>>,
  ): string {
    // texts 배열에서 내용 추출 (가장 일반적인 경우)
    if (toolResult.texts.length > 0) {
      // texts가 여러 개인 경우 합치기
      const content = toolResult.texts.join('\n');
      // JSON 문자열이 아닌 경우 그대로 반환
      if (
        content &&
        !content.trim().startsWith('{') &&
        !content.trim().startsWith('[')
      ) {
        return content;
      }
    }

    // raw.content에서 text 타입 항목 추출
    if (toolResult.raw.content) {
      const textContents: string[] = [];
      for (const item of toolResult.raw.content) {
        if (item.type === 'text' && 'text' in item) {
          const text = item.text;
          // JSON 문자열이 아닌 경우 그대로 추가
          if (
            text &&
            !text.trim().startsWith('{') &&
            !text.trim().startsWith('[')
          ) {
            textContents.push(text);
          }
        }
      }
      if (textContents.length > 0) {
        return textContents.join('\n');
      }
    }

    return '';
  }

  /**
   * 질문 키워드와 리소스 경로를 매칭하여 관련 리소스 찾기
   */
  private findRelevantResources(
    question: string,
    resources: Array<{ path: string; formats?: string[] }>,
    maxResults: number = 3,
  ): Array<{ path: string; formats?: string[] }> {
    const keywords =
      question
        .toLowerCase()
        .match(/[\uac00-\ud7a3]+|[a-z]+/gi)
        ?.filter((word) => word.length > 1) || [];

    if (keywords.length === 0) {
      return resources.slice(0, maxResults);
    }

    const scoredResources = resources.map((resource) => {
      const pathLower = resource.path.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        if (pathLower.includes(keyword)) {
          score += keyword.length;
        }
      }

      return { resource, score };
    });

    return scoredResources
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => item.resource);
  }

  /**
   * 리소스 내용에서 <document> 태그를 파싱하여 하위 문서 정보 추출
   */
  private parseDocumentLinks(content: string): Array<{
    path: string;
    description: string;
  }> {
    const documents: Array<{ path: string; description: string }> = [];
    const documentRegex =
      /<document\s+path="([^"]+)"\s+description="([^"]+)"><\/document>/g;

    let match;
    while ((match = documentRegex.exec(content)) !== null) {
      documents.push({
        path: match[1],
        description: match[2],
      });
    }

    return documents;
  }

  /**
   * 질문과 관련된 하위 문서 찾기
   */
  private findRelevantSubDocuments(
    question: string,
    documents: Array<{ path: string; description: string }>,
    maxResults: number = 3,
  ): Array<{ path: string; description: string }> {
    const keywords =
      question
        .toLowerCase()
        .match(/[\uac00-\ud7a3]+|[a-z]+/gi)
        ?.filter((word) => word.length > 1) || [];

    if (keywords.length === 0) {
      return documents.slice(0, maxResults);
    }

    const scoredDocuments = documents.map((doc) => {
      const pathLower = doc.path.toLowerCase();
      const descLower = doc.description.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        if (pathLower.includes(keyword)) {
          score += keyword.length * 2; // 경로 매칭은 가중치 높게
        }
        if (descLower.includes(keyword)) {
          score += keyword.length; // 설명 매칭
        }
      }

      return { document: doc, score };
    });

    return scoredDocuments
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => item.document);
  }

  /**
   * 하위 문서 내용 가져오기
   */
  private async fetchSubDocumentContents(
    subDocuments: Array<{ path: string; description: string }>,
  ): Promise<string> {
    const contents: string[] = [];

    for (const doc of subDocuments) {
      try {
        const resourcePath = this.normalizeResourcePath(doc.path);
        this.logger.debug(`Fetching sub-document: ${resourcePath}`);
        const toolResult = await this.mcpClientService.callTool(
          'get_resource',
          {
            path: resourcePath,
          },
        );

        const content = this.extractContentFromToolResult(toolResult);
        if (content) {
          const documentTitle = this.extractDocumentTitle(
            resourcePath,
            doc.path,
            ['md'],
          );
          contents.push(
            `\n\n## 하위 문서: ${documentTitle}\n\n**설명**: ${doc.description}\n\n${content}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch sub-document ${doc.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return contents.join('\n');
  }

  /**
   * LLM에게 문서 목록을 주고 질문과 관련성이 높은 문서만 선별하도록 요청
   */
  private async selectMostRelevantDocuments(
    question: string,
    documents: Array<{ title: string; content: string; path: string }>,
  ): Promise<Array<{ title: string; content: string; path: string }>> {
    if (documents.length === 0) {
      return [];
    }

    // 문서가 1개면 선별 불필요
    if (documents.length === 1) {
      return documents;
    }

    try {
      // 문서 제목만 사용하여 프롬프트 생성 (내용은 제외하여 프롬프트 길이 최소화)
      const documentList = documents
        .map((doc, index) => `${index + 1}. ${doc.title}`)
        .join('\n');

      const selectionPrompt = getDocumentSelectionUserPrompt({
        documentList,
        question,
      });

      this.logger.debug(
        `Selection prompt length: ${selectionPrompt.length} chars, documents: ${documents.length}`,
      );

      const response = await this.openRouterService.callLLM(
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
        undefined,
        { temperature: 0.1, max_tokens: 100 },
      );

      const selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM selected documents: ${selectedText}`);

      // "없음"이면 빈 배열 반환
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
        // 번호를 파싱할 수 없으면 모든 문서 반환 (최대 3개)
        this.logger.warn(
          `Could not parse document selection, returning first 3 documents`,
        );
        return documents.slice(0, 3);
      }

      // 최대 3개로 제한
      const limitedNumbers = numbers.slice(0, 3);
      const selected = limitedNumbers.map((idx) => documents[idx]);
      this.logger.log(
        `Selected ${selected.length} relevant document(s) out of ${documents.length}: ${selected.map((d) => d.title).join(', ')}`,
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

  /**
   * list_resources tool 응답에서 관련 리소스 내용 가져오기
   * formats 배열에 md가 있는 리소스만 가져옵니다.
   * 리소스 내용에 하위 문서 링크가 있으면 관련 하위 문서도 추가로 가져옵니다.
   * LLM에게 질문과 관련성이 높은 문서만 선별하도록 요청합니다.
   * @returns 문서 내용과 실제 사용된 리소스 정보 (PDF/PNG만)
   */
  private async fetchRelevantResourceContents(
    question: string,
    filteredResources: Array<{ path: string; formats: string[] }>,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
  }> {
    if (!filteredResources || filteredResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    // formats 배열에 md가 있는 리소스만 필터링
    const mdResources = filteredResources.filter(
      (resource) => resource.formats && resource.formats.includes('md'),
    );

    if (mdResources.length === 0) {
      this.logger.debug('No markdown resources found in filtered resources');
      return { content: '', usedResources: [] };
    }

    const relevantResources = this.findRelevantResources(
      question,
      mdResources,
      5, // 초기 선택은 5개로 늘림 (나중에 LLM이 선별)
    );

    if (relevantResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `Found ${relevantResources.length} candidate markdown resource(s): ${relevantResources.map((r) => r.path).join(', ')}`,
    );

    // 모든 후보 문서 내용 가져오기
    const documentCandidates: Array<{
      title: string;
      content: string;
      path: string;
      formats: string[];
      subDocuments: Array<{ path: string; description: string }>;
    }> = [];

    for (const resource of relevantResources) {
      try {
        // MCP 서버는 확장자 없이 경로를 받음
        const resourcePath = this.normalizeResourcePath(resource.path);
        this.logger.debug(`Fetching markdown resource: ${resourcePath}`);
        const toolResult = await this.mcpClientService.callTool(
          'get_resource',
          {
            path: resourcePath,
          },
        );

        const content = this.extractContentFromToolResult(toolResult);
        if (content) {
          const documentTitle = this.extractDocumentTitle(
            resourcePath,
            resource.path,
            resource.formats,
          );

          // 리소스 내용에서 하위 문서 링크 추출
          const subDocuments = this.parseDocumentLinks(content);

          documentCandidates.push({
            title: documentTitle,
            content,
            path: resource.path,
            formats: resource.formats || [],
            subDocuments,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch ${resource.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    // LLM에게 질문과 관련성이 높은 문서만 선별하도록 요청
    const selectedDocuments = await this.selectMostRelevantDocuments(
      question,
      documentCandidates.map((doc) => ({
        title: doc.title,
        content: doc.content,
        path: doc.path,
      })),
    );

    if (selectedDocuments.length === 0) {
      this.logger.log('No documents selected by LLM as relevant');
      return { content: '', usedResources: [] };
    }

    // 선별된 문서만 사용
    const contents: string[] = [];
    const allSubDocuments: Array<{ path: string; description: string }> = [];
    const usedResources: Array<{ path: string; formats: string[] }> = [];

    for (const selected of selectedDocuments) {
      const docCandidate = documentCandidates.find(
        (d) => d.title === selected.title,
      );
      if (docCandidate) {
        contents.push(
          `\n\n## 리소스: ${docCandidate.title}\n\n${docCandidate.content}`,
        );

        // 실제 사용된 리소스 정보 수집 (PDF/PNG만)
        const hasPdf = docCandidate.formats.includes('pdf');
        const hasPng = docCandidate.formats.includes('png');
        if (hasPdf || hasPng) {
          usedResources.push({
            path: docCandidate.path,
            formats: docCandidate.formats.filter(
              (f) => f === 'pdf' || f === 'png',
            ),
          });
        }

        // 하위 문서도 수집
        if (docCandidate.subDocuments.length > 0) {
          allSubDocuments.push(...docCandidate.subDocuments);
        }
      }
    }

    // 하위 문서 중 질문과 관련된 문서 찾아서 추가로 가져오기
    if (allSubDocuments.length > 0) {
      const relevantSubDocuments = this.findRelevantSubDocuments(
        question,
        allSubDocuments,
        3, // 최대 3개의 하위 문서만 추가로 가져오기
      );

      if (relevantSubDocuments.length > 0) {
        this.logger.log(
          `Fetching ${relevantSubDocuments.length} relevant sub-document(s): ${relevantSubDocuments.map((d) => d.path).join(', ')}`,
        );
        const subDocumentContents =
          await this.fetchSubDocumentContents(relevantSubDocuments);
        if (subDocumentContents) {
          contents.push('\n\n---\n\n## 관련 하위 문서\n' + subDocumentContents);
        }
      }
    }

    return {
      content: contents.join('\n'),
      usedResources,
    };
  }

  /**
   * Tool 실행에 타임아웃 적용
   */
  private async executeToolWithTimeout(
    toolCall: {
      id: string;
      name: string;
      arguments: Record<string, any>;
    },
    sessionId: string,
    userQuestion?: string,
  ): Promise<{
    tool_call_id: string;
    name: string;
    content: string;
    resources: ResourceInfo[];
    /** list_resources에서 실제 문서 내용을 붙였을 때만 true */
    hadReferenceContent: boolean;
  }> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timeout: ${toolCall.name}`));
      }, this.TOOL_EXECUTION_TIMEOUT);
    });

    const executePromise = (async () => {
      this.logger.debug(
        `Calling tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}`,
      );

      const toolResult = await this.mcpClientService.callTool(
        toolCall.name,
        toolCall.arguments,
      );

      let resultText =
        toolResult.texts.join('\n') || JSON.stringify(toolResult.raw, null, 2);

      // list_resources tool인 경우, 관련 리소스 내용을 가져와서 추가
      let usedResourcesFromContent: Array<{
        path: string;
        formats: string[];
      }> = [];
      let hadReferenceContent = false;
      if (
        toolCall.name === 'list_resources' &&
        userQuestion &&
        toolResult.filteredResources &&
        toolResult.filteredResources.length > 0
      ) {
        const relevantResult = await this.fetchRelevantResourceContents(
          userQuestion,
          toolResult.filteredResources,
        );
        const hasActualContent =
          typeof relevantResult.content === 'string' &&
          relevantResult.content.trim().length > 0;
        if (hasActualContent) {
          resultText += '\n\n' + relevantResult.content;
          usedResourcesFromContent = relevantResult.usedResources;
          hadReferenceContent = true;
        }
      }

      // 실제 사용된 리소스만 포함 (PDF/PNG만)
      const resources: ResourceInfo[] = [];
      if (usedResourcesFromContent.length > 0) {
        for (const resource of usedResourcesFromContent) {
          if (resource.path && resource.formats) {
            // PDF 또는 PNG만 포함
            const pdfPngFormats = resource.formats.filter(
              (f) => f === 'pdf' || f === 'png',
            );
            if (pdfPngFormats.length > 0) {
              const resourceUrl = this.generateResourceUrl(resource.path);
              // 문서 제목 추출 (마지막 부분만)
              const documentTitle = this.extractDocumentTitle(
                resource.path,
                resource.path,
                pdfPngFormats,
              );
              // PDF/PNG인 경우 format을 제목에 추가
              const titleWithFormat = pdfPngFormats.includes('pdf')
                ? `${documentTitle} (PDF)`
                : pdfPngFormats.includes('png')
                  ? `${documentTitle} (PNG)`
                  : documentTitle;

              resources.push({
                path: titleWithFormat,
                formats: pdfPngFormats,
                url: resourceUrl,
              });
            }
          }
        }
      }

      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: resultText,
        resources,
        hadReferenceContent,
      };
    })();

    return Promise.race([executePromise, timeoutPromise]);
  }

  /**
   * 사용자 질문을 처리하여 스트리밍 답변을 생성
   * @param sessionId 세션 ID
   * @param userQuestion 사용자 질문
   * @returns 스트리밍 응답 스트림과 리소스 정보
   */
  async processUserQuestionStream(
    sessionId: string,
    userQuestion: string,
  ): Promise<{
    stream: Readable;
    resources: ResourceInfo[];
  }> {
    try {
      // 0. 과거 대화 조회 (현재 user 저장 전 → 직전 대화까지 context)
      const pastMessagesRaw =
        await this.chatService.getMessagesForContext(sessionId);
      const historyMessages: OpenRouterMessage[] = [...pastMessagesRaw]
        .reverse()
        .map((msg) => ({ role: msg.role, content: msg.content }));

      // 1. 사용자 메시지 저장
      await this.chatService.createMessage(sessionId, {
        role: MessageRole.USER,
        content: userQuestion,
      });

      // 2. MCP Tool 목록 조회 (캐시 사용)
      const mcpTools = await this.getMcpTools();

      if (mcpTools.length === 0) {
        this.logger.warn('No MCP tools available');
        const stream = await this.openRouterService.generateFinalResponseStream(
          [
            { role: 'system', content: NO_TOOLS_AVAILABLE_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          undefined,
          { temperature: 0 },
        );
        return { stream, resources: [] };
      }

      // 3. LLM에게 Tool 선택 요청 (최대 2회 시도)
      this.logger.debug(
        `Requesting tool selection from LLM for question: "${userQuestion}"`,
      );

      let toolSelectionResponse: any;
      let toolCalls: any[] = [];
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          toolSelectionResponse = await this.openRouterService.selectTool(
            userQuestion,
            mcpTools,
            undefined,
            attempt > 1
              ? { temperature: 0.1, emphasizeToolUsage: true }
              : undefined,
            historyMessages,
          );

          toolCalls = this.openRouterService.parseToolCalls(
            toolSelectionResponse,
          );

          this.logger.debug(
            `Tool selection result (attempt ${attempt}/${maxAttempts}): ${toolCalls.length} tool(s) selected`,
          );

          if (toolCalls.length > 0) {
            break; // Tool이 선택되었으면 중단
          }

          // 마지막 시도가 아니면 잠시 대기 후 재시도
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Error during tool selection (attempt ${attempt}): ${errorMessage}`,
          );

          // 마지막 시도가 아니면 재시도
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          // 마지막 시도에서도 실패하면 toolCalls는 빈 배열로 유지
        }
      }

      // 4. Tool이 선택되지 않은 경우 (2회 시도 후 실패)
      if (toolCalls.length === 0) {
        this.logger.warn(
          `No tools selected after ${maxAttempts} attempt(s). Responding that no relevant materials are available.`,
        );
        const stream = await this.openRouterService.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          undefined,
          { temperature: 0 },
        );
        return { stream, resources: [] };
      }

      // 5. Tool 실행 (병렬 처리)
      this.logger.debug(`Executing ${toolCalls.length} tool(s) in parallel...`);
      const toolExecutionPromises = toolCalls.map((toolCall) =>
        this.executeToolWithTimeout(toolCall, sessionId, userQuestion).catch(
          (error) => {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Error executing tool ${toolCall.name}: ${errorMessage}`,
            );
            return {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: `Tool execution failed: ${errorMessage}`,
              resources: [] as ResourceInfo[],
              hadReferenceContent: false,
            };
          },
        ),
      );

      const toolExecutionResults = await Promise.all(toolExecutionPromises);

      const toolResults: Array<{
        tool_call_id: string;
        name: string;
        content: string;
      }> = [];
      const allResources: ResourceInfo[] = [];

      for (const result of toolExecutionResults) {
        toolResults.push({
          tool_call_id: result.tool_call_id,
          name: result.name,
          content: result.content,
        });
        const resources = result.resources ?? [];
        if (resources.length > 0) {
          allResources.push(...resources);
        }
      }

      // 5.5 참조 문서가 없으면 LLM에 넘기지 않고 "관련 자료 없음" 응답으로 처리
      // (참조 문서 없을 때 모델이 학습 지식으로 답하는 것 방지. hadReferenceContent는 fetchRelevantResourceContents에서 실제로 내용을 붙였을 때만 true)
      const anyHadReferenceContent = toolExecutionResults.some(
        (r) => r.hadReferenceContent === true,
      );
      const hasReferenceContent =
        allResources.length > 0 || anyHadReferenceContent;
      this.logger.debug(
        `[5.5] allRes=${allResources.length} anyHadRef=${anyHadReferenceContent} → hasRef=${hasReferenceContent}`,
      );
      if (!hasReferenceContent) {
        this.logger.warn('No reference documents available.');
        const stream = await this.openRouterService.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          undefined,
          { temperature: 0 },
        );
        return { stream, resources: [] };
      }

      // 6. Tool 결과를 LLM에 전달하여 최종 응답 생성 (스트리밍)
      this.logger.debug('Generating final response with tool results...');
      const messages: OpenRouterMessage[] = [
        { role: 'system', content: FINAL_RESPONSE_SYSTEM_PROMPT },
        ...historyMessages,
        { role: 'user', content: userQuestion },
      ];

      // tool_calls가 있으면 하나의 assistant 메시지에 모든 tool_calls 포함
      if (toolSelectionResponse.choices[0]?.message.tool_calls) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: toolSelectionResponse.choices[0].message.tool_calls,
        });
      }

      const stream = await this.openRouterService.generateFinalResponseStream(
        messages,
        toolResults,
      );

      return { stream, resources: allResources };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error processing user question: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        `Failed to process user question: ${errorMessage}`,
      );
    }
  }

  /**
   * 스트리밍 응답을 처리하여 SSE 형식으로 전송
   * @param sessionId 세션 ID
   * @param userQuestion 사용자 질문
   * @param reply Fastify 응답 객체
   */
  async handleStreamingResponse(
    sessionId: string,
    userQuestion: string,
    reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });

    try {
      const { stream, resources } = await this.processUserQuestionStream(
        sessionId,
        userQuestion,
      );

      let accumulatedContent = '';
      let model = '';
      let usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                const content = parsed.choices[0].delta.content;
                accumulatedContent += content;
                reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
              if (parsed.model) {
                model = parsed.model;
              }
              if (parsed.usage) {
                usage = parsed.usage;
              }
            } catch {
              // JSON 파싱 실패 시 무시
            }
          }
        }
      });

      stream.on('error', (error) => {
        this.logger.error('Stream error:', error);
        reply.raw.write(
          `data: ${JSON.stringify({ error: error.message || 'Stream error' })}\n\n`,
        );
        reply.raw.end();
      });

      stream.on('end', () => {
        void (async () => {
          try {
            if (accumulatedContent) {
              await this.chatService.createMessage(sessionId, {
                role: MessageRole.ASSISTANT,
                content: accumulatedContent,
                metadata: {
                  model: model || undefined,
                  usage: usage || undefined,
                  resources: resources.length > 0 ? resources : undefined,
                },
              });
            }

            if (usage?.total_tokens != null) {
              try {
                await this.usageService.recordUsage(sessionId, {
                  totalTokens: usage.total_tokens,
                });
              } catch (err) {
                this.logger.warn(
                  'Failed to record usage',
                  err instanceof Error ? err.message : String(err),
                );
              }
            }

            if (resources.length > 0) {
              reply.raw.write(
                `data: ${JSON.stringify({
                  type: 'resources',
                  resources: resources,
                })}\n\n`,
              );
            }

            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
          } catch (error) {
            this.logger.error('Error saving final message:', error);
            reply.raw.write(
              `data: ${JSON.stringify({ error: 'Failed to save message' })}\n\n`,
            );
            reply.raw.end();
          }
        })();
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Error in chat stream:', errorMessage);
      reply.raw.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      reply.raw.end();
    }
  }

  /**
   * 리소스 경로를 기반으로 URL 생성
   */
  private generateResourceUrl(resourcePath: string): string {
    const encodedPath = encodeURIComponent(resourcePath);
    return encodedPath;
  }
}
