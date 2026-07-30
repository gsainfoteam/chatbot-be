import {
  Inject,
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { UsageService } from '../../usage/usage.service';
import { LLM_CLIENT, type LlmClient } from '../llm/llm-client.interface';
import type { LlmMessage, LlmUsage } from '../types/llm.types';
import { MessageRole } from '../../common/dto/chat-message-input.dto';
import type { Readable } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  FINAL_RESPONSE_SYSTEM_PROMPT,
  NO_RELEVANT_MATERIALS_SYSTEM_PROMPT,
} from '../prompts';
import {
  ResourceContentService,
  type ResourceInfo,
} from './resource-content.service';
import { ChatStreamTransport } from './chat-stream.transport';
import { RetrievalService } from '../../retrieval/retrieval.service';

export type { ResourceInfo };

interface ProcessUserQuestionStreamOptions {
  persistUserMessage?: boolean;
  historyBefore?: Date;
}

interface StreamingResponseOptions extends ProcessUserQuestionStreamOptions {
  assistantMetadata?: Record<string, unknown>;
}

/**
 * 채팅 오케스트레이션 서비스
 * 사용자 질문을 받아 DB Retrieval + LLM을 조합하여 답변을 생성합니다.
 */
@Injectable()
export class ChatOrchestrationService {
  private readonly logger = new Logger(ChatOrchestrationService.name);

  constructor(
    private readonly retrievalService: RetrievalService,
    @Inject(LLM_CLIENT) private readonly llmClient: LlmClient,
    private readonly chatService: ChatService,
    private readonly usageService: UsageService,
    private readonly resourceContentService: ResourceContentService,
    private readonly chatStreamTransport: ChatStreamTransport,
  ) {}

  private createEmptyUsage(): LlmUsage {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
  }

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

  private hasTokenUsage(usage: LlmUsage): boolean {
    return (
      usage.prompt_tokens > 0 ||
      usage.completion_tokens > 0 ||
      usage.total_tokens > 0
    );
  }

  /**
   * 사용자 질문을 처리하여 스트리밍 답변을 생성
   */
  async processUserQuestionStream(
    sessionId: string,
    userQuestion: string,
    options: ProcessUserQuestionStreamOptions = {},
  ): Promise<{
    stream: Readable;
    resources: ResourceInfo[];
    usage: LlmUsage;
  }> {
    const perfTurnStart = Date.now();
    const usage = this.createEmptyUsage();

    try {
      let t0 = Date.now();
      const pastMessagesRaw = await this.chatService.getMessagesForContext(
        sessionId,
        options.historyBefore,
      );
      const historyMessages: LlmMessage[] = [...pastMessagesRaw]
        .reverse()
        .map((msg) => ({ role: msg.role, content: msg.content }));
      this.logger.log(`[PERF] getMessagesForContext: ${Date.now() - t0}ms`);

      if (options.persistUserMessage ?? true) {
        t0 = Date.now();
        await this.chatService.createMessage(sessionId, {
          role: MessageRole.USER,
          content: userQuestion,
        });
        this.logger.log(`[PERF] createMessage(user): ${Date.now() - t0}ms`);
      }

      t0 = Date.now();
      this.logger.debug('Loading document catalog from DB...');
      const listResult = await this.retrievalService.listCatalog();
      this.logger.log(`[PERF] listCatalog: ${Date.now() - t0}ms`);

      const isNewFormat =
        listResult.resources &&
        listResult.resources.length > 0 &&
        listResult.chunks &&
        listResult.chunks.length > 0;
      const totalFromList = isNewFormat
        ? (listResult.total ?? listResult.resources?.length ?? 0)
        : (listResult.filteredResources?.length ?? 0);
      const chunkCount = listResult.chunks?.length ?? 0;
      this.logger.log(
        `[DEBUG] catalog 결과: ${isNewFormat ? `신 형식 상위 ${listResult.resources?.length ?? 0}개, chunk ${chunkCount}개` : `구 형식 ${totalFromList}개 리소스`}`,
      );

      const hasResources =
        (listResult.chunks && listResult.chunks.length > 0) ||
        (listResult.filteredResources &&
          listResult.filteredResources.length > 0);
      if (!hasResources) {
        this.logger.warn('No resources from document catalog');
        const stream = await this.llmClient.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          this.llmClient.getModel('normal'),
          { temperature: 0 },
        );
        return { stream, resources: [], usage };
      }

      t0 = Date.now();
      const relevantResult =
        await this.resourceContentService.fetchRelevantResourceContents(
          userQuestion,
          listResult,
          usage,
        );
      this.logger.log(
        `[PERF] fetchRelevantResourceContents: ${Date.now() - t0}ms`,
      );

      const hasContent =
        typeof relevantResult.content === 'string' &&
        relevantResult.content.trim().length > 0;

      if (!hasContent) {
        this.logger.warn('No reference documents available.');
        const stream = await this.llmClient.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          this.llmClient.getModel('normal'),
          { temperature: 0 },
        );
        return { stream, resources: [], usage };
      }

      const resultText =
        listResult.texts.join('\n') || JSON.stringify(listResult.raw, null, 2);

      // LLM 입력 길이가 커지면 400이 발생할 수 있어, tool 호출 컨텐츠는 하드 캡을 둡니다.
      const MAX_TOOL_CONTENT_CHARS = 50000;
      const separator = '\n\n';
      const relevantPart = relevantResult.content;
      const listPart = resultText;
      const fullContentOriginalChars =
        relevantPart.length + separator.length + listPart.length;

      const maxListChars = Math.max(
        0,
        MAX_TOOL_CONTENT_CHARS - relevantPart.length - separator.length,
      );
      const LIST_TRUNCATION_NOTE =
        '\n\n[Truncated: document catalog preview too long]';
      let listPartForTool = listPart;
      let fullContentWasTruncated = false;
      if (listPart.length > maxListChars) {
        const maxSlice = Math.max(
          0,
          maxListChars - LIST_TRUNCATION_NOTE.length,
        );
        listPartForTool = listPart.slice(0, maxSlice) + LIST_TRUNCATION_NOTE;
        fullContentWasTruncated = true;
      }
      let fullContent = relevantPart + separator + listPartForTool;
      if (fullContent.length > MAX_TOOL_CONTENT_CHARS) {
        const maxRel = Math.max(
          0,
          MAX_TOOL_CONTENT_CHARS - listPartForTool.length - separator.length,
        );
        fullContent =
          relevantPart.slice(0, maxRel) +
          '\n\n[Truncated: reference material too long]' +
          separator +
          listPartForTool;
        fullContentWasTruncated = true;
      }

      const syntheticToolCallId = 'list_resources_0';
      const toolResults: Array<{
        tool_call_id: string;
        name: string;
        content: string;
      }> = [
        {
          tool_call_id: syntheticToolCallId,
          name: 'list_resources',
          content: fullContent,
        },
      ];

      const allResources: ResourceInfo[] = [];
      const seenFePdfPaths = new Set<string>();
      for (const r of relevantResult.usedResources) {
        this.resourceContentService.appendFePdfResourceEntryFromUsed(
          allResources,
          seenFePdfPaths,
          r,
        );
      }

      t0 = Date.now();
      this.logger.debug('Generating final response with tool results...');
      const messages: LlmMessage[] = [
        { role: 'system', content: FINAL_RESPONSE_SYSTEM_PROMPT },
        ...historyMessages,
        { role: 'user', content: userQuestion },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: syntheticToolCallId,
              type: 'function',
              function: { name: 'list_resources', arguments: '{}' },
            },
          ],
        },
      ];

      const toolResultsContentCharsSum = toolResults.reduce(
        (sum, r) => sum + (r.content?.length ?? 0),
        0,
      );

      const roleCounts: Record<string, number> = {};
      let assistantToolCalls = 0;
      let contentNullCount = 0;
      for (const m of messages) {
        roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
        if (m.role === 'assistant') {
          assistantToolCalls += m.tool_calls?.length ?? 0;
        }
        if (m.content === null) {
          contentNullCount += 1;
        }
      }

      this.logger.debug(
        `[DEBUG] Final LLM request summary: model=heavy, messages=${messages.length}, roles=${JSON.stringify(roleCounts)}, contentNullCount=${contentNullCount}, assistantToolCalls=${assistantToolCalls}, toolResults=${toolResults.length}, toolResultsContentCharsSum=${toolResultsContentCharsSum}, fullContentOriginalChars=${fullContentOriginalChars}, fullContentWasTruncated=${fullContentWasTruncated}, numberOfAllResources=${allResources.length}`,
      );

      const stream = await this.llmClient.generateFinalResponseStream(
        messages,
        toolResults,
        this.llmClient.getModel('heavy'),
      );
      this.logger.log(
        `[PERF] generateFinalResponseStream(시작까지): ${Date.now() - t0}ms`,
      );
      this.logger.log(
        `[PERF] processUserQuestionStream 전체: ${Date.now() - perfTurnStart}ms`,
      );

      return { stream, resources: allResources, usage };
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
   */
  async handleStreamingResponse(
    sessionId: string,
    userQuestion: string,
    reply: FastifyReply,
    req: FastifyRequest,
    options: StreamingResponseOptions = {},
  ): Promise<void> {
    this.chatStreamTransport.prepareSse(reply, req);

    try {
      const {
        stream,
        resources,
        usage: reasoningUsage,
      } = await this.processUserQuestionStream(sessionId, userQuestion, {
        persistUserMessage: options.persistUserMessage,
        historyBefore: options.historyBefore,
      });

      let streamResult: {
        accumulatedContent: string;
        model: string;
        usage: LlmUsage | null;
      };
      try {
        streamResult = await this.chatStreamTransport.consumeAndForward(
          stream,
          reply,
        );
      } catch {
        // 스트림 에러 시 transport가 이미 응답을 종료함
        return;
      }

      try {
        const totalUsage = { ...reasoningUsage };
        this.addTokenUsage(totalUsage, streamResult.usage);
        const usage = this.hasTokenUsage(totalUsage) ? totalUsage : undefined;

        if (streamResult.accumulatedContent) {
          await this.chatService.createMessage(sessionId, {
            role: MessageRole.ASSISTANT,
            content: streamResult.accumulatedContent,
            metadata: {
              ...(options.assistantMetadata ?? {}),
              model: streamResult.model || undefined,
              usage,
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

        this.chatStreamTransport.writeResources(reply, resources);
        this.chatStreamTransport.writeDone(reply);
      } catch (error) {
        this.logger.error('Error saving final message:', error);
        this.chatStreamTransport.writeError(reply, 'Failed to save message');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Error in chat stream:', errorMessage);
      this.chatStreamTransport.writeError(reply, errorMessage);
    }
  }
}
