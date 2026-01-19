import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AxiosError } from 'axios';
import type {
  McpTool,
  OpenRouterTool,
  OpenRouterMessage,
  OpenRouterRequest,
  OpenRouterResponse,
  ParsedToolCall,
} from '../types/open-router.types';

/**
 * Open Router 서비스
 * LLM을 통해 MCP Tool 선택 및 실행을 관리합니다.
 */
@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly defaultModel: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.getOrThrow<string>('OPEN_ROUTER_API_KEY');
    this.defaultModel =
      this.configService.get<string>(
        'OPEN_ROUTER_MODEL',
        'anthropic/claude-3.5-sonnet',
      ) || 'anthropic/claude-3.5-sonnet';
  }

  /**
   * MCP Tool 목록을 Open Router Function Calling 형식으로 변환
   */
  convertMcpToolsToOpenRouterFormat(mcpTools: McpTool[]): OpenRouterTool[] {
    return mcpTools.map((tool) => {
      const parameters = tool.inputSchema || {
        type: 'object',
        properties: {},
        required: [],
      };

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: parameters.type || 'object',
            properties: parameters.properties || {},
            required: parameters.required || [],
          },
        },
      };
    });
  }

  /**
   * 사용자 질문과 MCP Tool 목록을 기반으로 LLM에게 Tool 선택 요청
   * @param userQuestion 사용자 질문
   * @param mcpTools 사용 가능한 MCP Tool 목록
   * @param model 사용할 LLM 모델 (선택사항)
   * @returns LLM 응답 (tool_calls 포함 가능)
   */
  async selectTool(
    userQuestion: string,
    mcpTools: McpTool[],
    model?: string,
  ): Promise<OpenRouterResponse> {
    const tools = this.convertMcpToolsToOpenRouterFormat(mcpTools);

    const messages: OpenRouterMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant that can use tools to help users. When you need to use a tool, select the appropriate tool and provide the necessary arguments.',
      },
      {
        role: 'user',
        content: userQuestion,
      },
    ];

    const request: OpenRouterRequest = {
      model: model || this.defaultModel,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 1000,
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<OpenRouterResponse>(
            `${this.baseUrl}/chat/completions`,
            request,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': this.configService.get<string>(
                  'OPEN_ROUTER_REFERER',
                  'https://ziggle.ai',
                ),
                'X-Title': this.configService.get<string>(
                  'OPEN_ROUTER_TITLE',
                  'Ziggle Chatbot',
                ),
              },
            },
          )
          .pipe(
            catchError((error: AxiosError) => {
              this.logger.error(
                `Open Router API error: ${error.message}`,
                error.response?.data,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${error.message}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }

  /**
   * LLM 응답에서 tool_calls 파싱
   */
  parseToolCalls(response: OpenRouterResponse): ParsedToolCall[] {
    const toolCalls: ParsedToolCall[] = [];

    for (const choice of response.choices) {
      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: args,
            });
          } catch (error) {
            this.logger.warn(
              `Failed to parse tool call arguments: ${toolCall.function.arguments}`,
              error,
            );
          }
        }
      }
    }

    return toolCalls;
  }

  /**
   * Tool 실행 결과를 LLM에 전달하여 최종 응답 생성
   * @param messages 이전 대화 내역
   * @param toolResults Tool 실행 결과 (tool_call_id와 결과 매핑)
   * @param model 사용할 LLM 모델 (선택사항)
   * @returns 최종 LLM 응답
   */
  async generateFinalResponse(
    messages: OpenRouterMessage[],
    toolResults: Array<{
      tool_call_id: string;
      name: string;
      content: string;
    }>,
    model?: string,
  ): Promise<OpenRouterResponse> {
    // Tool 결과를 메시지에 추가
    const toolMessages: OpenRouterMessage[] = toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.tool_call_id,
      name: result.name,
      content: result.content,
    }));

    const updatedMessages = [...messages, ...toolMessages];

    const request: OpenRouterRequest = {
      model: model || this.defaultModel,
      messages: updatedMessages,
      temperature: 0.7,
      max_tokens: 2000,
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<OpenRouterResponse>(
            `${this.baseUrl}/chat/completions`,
            request,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': this.configService.get<string>(
                  'OPEN_ROUTER_REFERER',
                  'https://ziggle.ai',
                ),
                'X-Title': this.configService.get<string>(
                  'OPEN_ROUTER_TITLE',
                  'Ziggle Chatbot',
                ),
              },
            },
          )
          .pipe(
            catchError((error: AxiosError) => {
              this.logger.error(
                `Open Router API error: ${error.message}`,
                error.response?.data,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${error.message}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }

  /**
   * 일반적인 LLM 호출 (Tool 없이)
   */
  async callLLM(
    messages: OpenRouterMessage[],
    model?: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    },
  ): Promise<OpenRouterResponse> {
    const request: OpenRouterRequest = {
      model: model || this.defaultModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<OpenRouterResponse>(
            `${this.baseUrl}/chat/completions`,
            request,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': this.configService.get<string>(
                  'OPEN_ROUTER_REFERER',
                  'https://ziggle.ai',
                ),
                'X-Title': this.configService.get<string>(
                  'OPEN_ROUTER_TITLE',
                  'Ziggle Chatbot',
                ),
              },
            },
          )
          .pipe(
            catchError((error: AxiosError) => {
              this.logger.error(
                `Open Router API error: ${error.message}`,
                error.response?.data,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${error.message}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }
}
