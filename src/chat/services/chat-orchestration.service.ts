import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpClientService } from '../../mcp/mcp-client.service';
import { OpenRouterService } from './open-router.service';
import { ChatService } from './chat.service';
import type { McpTool, OpenRouterMessage } from '../types/open-router.types';
import { MessageRole } from '../../common/dto/chat-message-input.dto';

/**
 * 리소스 정보
 */
export interface ResourceInfo {
  path: string;
  formats: string[];
  url: string;
}

/**
 * 사용자 질문 처리 결과
 */
export interface ChatResponse {
  message: string;
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, any>;
    result?: string;
    resources?: ResourceInfo[];
  }>;
  resources?: ResourceInfo[];
  metadata?: {
    model?: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
}

/**
 * 채팅 오케스트레이션 서비스
 * 사용자 질문을 받아 LLM과 MCP Tool을 조합하여 답변을 생성
 */
@Injectable()
export class ChatOrchestrationService {
  private readonly logger = new Logger(ChatOrchestrationService.name);

  constructor(
    private readonly mcpClientService: McpClientService,
    private readonly openRouterService: OpenRouterService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 사용자 질문을 처리하여 답변을 생성
   * @param sessionId 세션 ID
   * @param userQuestion 사용자 질문
   * @returns 생성된 답변
   */
  async processUserQuestion(
    sessionId: string,
    userQuestion: string,
  ): Promise<ChatResponse> {
    try {
      // 1. 사용자 메시지 저장
      await this.chatService.createMessage(sessionId, {
        role: MessageRole.USER,
        content: userQuestion,
      });

      // 2. MCP Tool 목록 조회
      this.logger.debug('Fetching MCP tools...');
      const mcpToolsListResult: unknown =
        await this.mcpClientService.listTools();

      // MCPTool 형식으로 변환
      type ToolItem = { name: string; description?: string };
      const mcpToolsList: ToolItem[] = Array.isArray(mcpToolsListResult)
        ? (mcpToolsListResult as ToolItem[])
        : [];
      const mcpTools: McpTool[] = mcpToolsList.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
      }));

      if (mcpTools.length === 0) {
        this.logger.warn('No MCP tools available, using LLM without tools');
        // Tool이 없으면 일반 LLM 호출
        const response = await this.openRouterService.callLLM([
          {
            role: 'system',
            content:
              "Because of the lack of MCP tools, you must not answer the user's question. Just say that you don't know the answer.",
          },
          {
            role: 'user',
            content: userQuestion,
          },
        ]);

        const assistantMessage =
          response.choices[0]?.message.content ||
          '죄송합니다. 응답을 생성할 수 없습니다.';

        // Assistant 메시지 저장
        await this.chatService.createMessage(sessionId, {
          role: MessageRole.ASSISTANT,
          content: assistantMessage,
          metadata: {
            model: response.model,
            usage: response.usage,
          },
        });

        return {
          message: assistantMessage,
          metadata: {
            model: response.model,
            usage: response.usage,
          },
        };
      }

      // 3. LLM에게 Tool 선택 요청
      this.logger.debug('Requesting tool selection from LLM...');
      const toolSelectionResponse = await this.openRouterService.selectTool(
        userQuestion,
        mcpTools,
      );

      // 4. Tool Call 파싱
      const toolCalls = this.openRouterService.parseToolCalls(
        toolSelectionResponse,
      );

      // 5. Tool이 선택되지 않은 경우 (일반 대화)
      if (toolCalls.length === 0) {
        const assistantMessage =
          toolSelectionResponse.choices[0]?.message.content ||
          '죄송합니다. 응답을 생성할 수 없습니다.';

        // Assistant 메시지 저장
        await this.chatService.createMessage(sessionId, {
          role: MessageRole.ASSISTANT,
          content: assistantMessage,
          metadata: {
            model: toolSelectionResponse.model,
            usage: toolSelectionResponse.usage,
          },
        });

        return {
          message: assistantMessage,
          metadata: {
            model: toolSelectionResponse.model,
            usage: toolSelectionResponse.usage,
          },
        };
      }

      // 6. Tool 실행
      this.logger.debug(`Executing ${toolCalls.length} tool(s)...`);
      const toolResults: Array<{
        tool_call_id: string;
        name: string;
        content: string;
      }> = [];

      const toolCallDetails: Array<{
        toolName: string;
        arguments: Record<string, any>;
        result?: string;
        resources?: ResourceInfo[];
      }> = [];
      const allResources: ResourceInfo[] = [];

      for (const toolCall of toolCalls) {
        try {
          this.logger.debug(
            `Calling tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}`,
          );

          // MCP Tool 실행
          const toolResult = await this.mcpClientService.callTool(
            toolCall.name,
            toolCall.arguments,
          );

          // Tool 결과를 텍스트로 변환
          const resultText =
            toolResult.texts.join('\n') ||
            JSON.stringify(toolResult.raw, null, 2);

          // 리소스 추출 (JSON 파싱 시도)
          const toolResources: ResourceInfo[] = [];
          try {
            const parsedResult = JSON.parse(resultText);
            if (
              parsedResult.resources &&
              Array.isArray(parsedResult.resources)
            ) {
              for (const resource of parsedResult.resources) {
                if (resource.path && resource.formats) {
                  const resourceUrl = this.generateResourceUrl(resource.path);
                  const resourceInfo: ResourceInfo = {
                    path: resource.path,
                    formats: resource.formats,
                    url: resourceUrl,
                  };
                  toolResources.push(resourceInfo);
                  allResources.push(resourceInfo);
                }
              }
            }
          } catch {
            // JSON 파싱 실패 시 무시 (텍스트 결과만 사용)
          }

          toolResults.push({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: resultText,
          });

          toolCallDetails.push({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            result: resultText,
            resources: toolResources.length > 0 ? toolResources : undefined,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Error executing tool ${toolCall.name}: ${errorMessage}`,
            error instanceof Error ? error.stack : undefined,
          );
          // Tool 실행 실패 시 에러 메시지를 결과로 사용
          const toolErrorMessage = `Tool execution failed: ${errorMessage}`;
          toolResults.push({
            tool_call_id: toolCall.id,
            name: toolCall.name,
            content: toolErrorMessage,
          });

          toolCallDetails.push({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            result: toolErrorMessage,
          });
        }
      }

      // 7. Tool 결과를 LLM에 전달하여 최종 응답 생성
      this.logger.debug('Generating final response with tool results...');
      const messages: OpenRouterMessage[] = [
        {
          role: 'system',
          content:
            'You are a helpful assistant that can use tools to help users. When you receive tool results, use them to provide a clear and helpful answer to the user.',
        },
        {
          role: 'user',
          content: userQuestion,
        },
        ...(toolSelectionResponse.choices[0]?.message.tool_calls?.map((tc) => ({
          role: 'assistant' as const,
          content: null,
          tool_calls: [tc],
        })) || []),
      ];

      const finalResponse = await this.openRouterService.generateFinalResponse(
        messages,
        toolResults,
      );

      const assistantMessage =
        finalResponse.choices[0]?.message.content ||
        '죄송합니다. 응답을 생성할 수 없습니다.';

      // 8. Assistant 메시지 저장
      await this.chatService.createMessage(sessionId, {
        role: MessageRole.ASSISTANT,
        content: assistantMessage,
        metadata: {
          model: finalResponse.model,
          usage: finalResponse.usage,
          toolCalls: toolCallDetails,
        },
      });

      return {
        message: assistantMessage,
        toolCalls: toolCallDetails,
        resources: allResources.length > 0 ? allResources : undefined,
        metadata: {
          model: finalResponse.model,
          usage: finalResponse.usage,
        },
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
   * 리소스 경로를 기반으로 URL 생성
   * 백엔드의 리소스 프록시 엔드포인트를 사용
   */
  private generateResourceUrl(resourcePath: string): string {
    // 백엔드의 리소스 프록시 엔드포인트 사용
    // 실제 MCP 서버 URL이 아닌 백엔드 프록시 URL 반환
    const encodedPath = encodeURIComponent(resourcePath);
    return `/api/v1/widget/messages/resources/${encodedPath}`;
  }
}
