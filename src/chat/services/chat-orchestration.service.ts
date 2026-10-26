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
  ANSWER_GROUNDING_REMINDER,
  isNoAnswerResponse,
} from '../prompts';
import {
  ResourceContentService,
  formatRelevantDocument,
  type ResourceInfo,
} from './resource-content.service';
import { ChatStreamTransport } from './chat-stream.transport';
import { RetrievalService } from '../../retrieval/retrieval.service';
import { Trace } from '@gsainfoteam/nest-observability';
import { UnansweredQuestionsRepository } from '../../unanswered-questions/unanswered-questions.repository';
import { AgentLoopService } from '../agent/agent-loop.service';
import { decideAnswerRoute } from '../agent/answer-route';
import type { AgentStep } from '../agent/agent.types';

export type { ResourceInfo };

interface ProcessUserQuestionStreamOptions {
  persistUserMessage?: boolean;
  historyBefore?: Date;
  /** 에이전트 재탐색 진행 단계를 받는다. 빠른 경로에서는 호출되지 않는다. */
  onStep?: (step: AgentStep) => void;
}

interface StreamingResponseOptions extends ProcessUserQuestionStreamOptions {
  assistantMetadata?: Record<string, unknown>;
}

/**
 * 채팅 오케스트레이션 서비스
 * 사용자 질문을 받아 DB Retrieval + LLM을 조합하여 답변을 생성합니다.
 */
@Trace()
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
    private readonly unansweredQuestionsRepository: UnansweredQuestionsRepository,
    private readonly agentLoopService: AgentLoopService,
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

  /** 미답변 질문 기록 실패가 채팅 응답을 막지 않도록 경고만 남긴다. */
  private async recordUnansweredQuestion(
    sessionId: string,
    question: string,
    answerMessageId: string | null,
    countOccurrence: boolean,
  ): Promise<void> {
    try {
      await this.unansweredQuestionsRepository.record({
        sessionId,
        question,
        answerMessageId,
        countOccurrence,
      });
    } catch (err) {
      this.logger.warn(
        'Failed to record unanswered question',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** 근거 자료 없이 "찾지 못했다"는 안내만 스트리밍한다. */
  private streamNoRelevantMaterials(
    historyMessages: LlmMessage[],
    userQuestion: string,
  ): Promise<Readable> {
    return this.llmClient.generateFinalResponseStream(
      [
        { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
        ...historyMessages,
        { role: 'user', content: userQuestion },
      ],
      [],
      this.llmClient.getModel('normal'),
      { temperature: 0 },
    );
  }

  /**
   * 첫 검색이 비었거나 근거가 약하면 에이전트가 검색어를 바꿔 다시 찾는다.
   * 에이전트가 실패하면 첫 검색 결과로 답한다.
   */
  private async gatherRelevantContent(
    userQuestion: string,
    historyMessages: LlmMessage[],
    listResult: Awaited<ReturnType<RetrievalService['listCatalog']>>,
    usage: LlmUsage,
    onStep?: (step: AgentStep) => void,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
    /** 에이전트가 거친 단계의 최종 상태. 빠른 경로면 비어 있다. */
    steps: AgentStep[];
  }> {
    let t0 = Date.now();
    const initial =
      await this.resourceContentService.fetchRelevantResourceContents(
        userQuestion,
        listResult,
        usage,
      );
    this.logger.log(
      `[PERF] fetchRelevantResourceContents: ${Date.now() - t0}ms`,
    );

    const { route, reason } = decideAnswerRoute({
      agentEnabled: this.agentLoopService.isEnabled(),
      documentCount: initial.documents.length,
      confident: initial.confident,
    });
    this.logger.log(`[DEBUG] answer route: ${route} (${reason})`);
    if (route === 'direct') return { ...initial, steps: [] };

    t0 = Date.now();
    const steps = new Map<string, AgentStep>();
    const recordStep = (step: AgentStep) => {
      steps.set(step.id, step);
      onStep?.(step);
    };
    try {
      const agentResult = await this.agentLoopService.run({
        question: userQuestion,
        history: historyMessages,
        catalog: listResult,
        usage,
        seed: {
          documents: initial.documents,
          usedResources: initial.usedResources,
        },
        onStep: recordStep,
      });
      this.logger.log(`[PERF] agent research: ${Date.now() - t0}ms`);
      return {
        content: agentResult.documents
          .map((doc) => formatRelevantDocument(doc.content))
          .join('\n'),
        usedResources: agentResult.usedResources,
        steps: agentResult.steps,
      };
    } catch (error) {
      this.logger.warn(
        `Agent research failed; answering with the first search: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // FE에 진행 중으로 남은 단계가 없도록 실패로 닫는다.
      for (const step of [...steps.values()]) {
        if (step.status === 'running') {
          recordStep({ ...step, status: 'failed' });
        }
      }
      return { ...initial, steps: [...steps.values()] };
    }
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
    /** 답변 근거로 사용한 문서(chunk) 수. FE 참조 목록 노출 여부와 무관하다. */
    referencedDocumentCount: number;
    usage: LlmUsage;
    /** 에이전트 재탐색 단계. 빠른 경로면 비어 있다. */
    steps: AgentStep[];
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

      const chunkCount = listResult.chunks?.length ?? 0;
      this.logger.log(
        `[DEBUG] catalog 결과: 상위 ${listResult.resources?.length ?? 0}개, chunk ${chunkCount}개`,
      );

      const hasResources = chunkCount > 0;
      if (!hasResources) {
        this.logger.warn('No resources from document catalog');
        const stream = await this.streamNoRelevantMaterials(
          historyMessages,
          userQuestion,
        );
        return {
          stream,
          resources: [],
          referencedDocumentCount: 0,
          usage,
          steps: [],
        };
      }

      const relevantResult = await this.gatherRelevantContent(
        userQuestion,
        historyMessages,
        listResult,
        usage,
        options.onStep,
      );

      const hasContent =
        typeof relevantResult.content === 'string' &&
        relevantResult.content.trim().length > 0;

      if (!hasContent) {
        this.logger.warn('No reference documents available.');
        const stream = await this.streamNoRelevantMaterials(
          historyMessages,
          userQuestion,
        );
        return {
          stream,
          resources: [],
          referencedDocumentCount: 0,
          usage,
          steps: relevantResult.steps,
        };
      }

      const resultText =
        listResult.texts.join('\n') || JSON.stringify(listResult.raw, null, 2);

      // LLM 입력 길이가 커지면 400이 발생할 수 있어, tool 호출 컨텐츠는 하드 캡을 둡니다.
      // 끝에 붙는 답변 규칙 리마인더 몫은 미리 뺀다.
      const MAX_TOOL_CONTENT_CHARS = 50000 - ANSWER_GROUNDING_REMINDER.length;
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
          // 시스템 프롬프트의 금지 규칙만으로는 자료에 없는 항목을 덧붙이는 경우가 많아,
          // 자료 바로 뒤에 규칙을 한 번 더 둔다.
          content: fullContent + ANSWER_GROUNDING_REMINDER,
        },
      ];

      const allResources: ResourceInfo[] = [];
      // 텍스트 지식 문서는 원본 PDF가 없으므로 이미 본 경로로 취급해 FE 참조 목록에서 제외한다.
      const seenFePdfPaths = new Set<string>(
        (listResult.resources ?? [])
          .filter((resource) => resource.sourceType === 'text')
          .map((resource) => resource.path),
      );
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

      return {
        stream,
        resources: allResources,
        referencedDocumentCount: relevantResult.usedResources.length,
        usage,
        steps: relevantResult.steps,
      };
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
        referencedDocumentCount,
        usage: reasoningUsage,
        steps,
      } = await this.processUserQuestionStream(sessionId, userQuestion, {
        persistUserMessage: options.persistUserMessage,
        historyBefore: options.historyBefore,
        onStep: (step) => this.chatStreamTransport.writeStep(reply, step),
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

        // 검색에 걸린 문서가 있어도 최종 답변이 답변 불가면 참조 문서를 숨기고 미답변으로 본다.
        const answered =
          referencedDocumentCount > 0 &&
          !isNoAnswerResponse(streamResult.accumulatedContent);
        const answerResources = answered ? resources : [];

        let answerMessageId: string | null = null;
        if (streamResult.accumulatedContent) {
          const answer = await this.chatService.createMessage(sessionId, {
            role: MessageRole.ASSISTANT,
            content: streamResult.accumulatedContent,
            metadata: {
              ...(options.assistantMetadata ?? {}),
              model: streamResult.model || undefined,
              usage,
              resources:
                answerResources.length > 0 ? answerResources : undefined,
              // 히스토리에서도 진행 과정을 다시 보여줄 수 있게 최종 상태를 남긴다.
              steps: steps.length > 0 ? steps : undefined,
            },
          });
          answerMessageId = answer.id;
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

        this.chatStreamTransport.writeResources(reply, answerResources);
        this.chatStreamTransport.writeDone(reply);

        // 응답 종료 후 기록해 SSE 완료 시점을 늦추지 않는다.
        if (!answered) {
          await this.recordUnansweredQuestion(
            sessionId,
            userQuestion,
            answerMessageId,
            options.persistUserMessage ?? true,
          );
        }
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
