import { Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AxiosError } from 'axios';
import type { Readable } from 'stream';
import { inspect } from 'node:util';
import type { LlmClient, LlmCallOptions } from './llm-client.interface';
import type {
  LlmMessage,
  LlmModelType,
  LlmRequest,
  LlmResponse,
  LlmToolResult,
} from '../types/llm.types';

export type OpenAiCompatibleLlmConfig = {
  apiKey: string;
  baseUrl: string;
  modelLight: string;
  modelNormal: string;
  modelHeavy: string;
  xTitle?: string;
  /** 로그/에러 메시지에 표시할 프로바이더 이름 */
  providerLabel: string;
};

/**
 * OpenAI-compatible /chat/completions HTTP 클라이언트 공통 로직
 */
export abstract class BaseOpenAiCompatibleLlm implements LlmClient {
  protected abstract readonly logger: Logger;

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly modelLight: string;
  protected readonly modelNormal: string;
  protected readonly modelHeavy: string;
  protected readonly defaultModel: string;
  protected readonly xTitle: string | undefined;
  protected readonly providerLabel: string;

  constructor(
    protected readonly httpService: HttpService,
    protected readonly configService: ConfigService,
    config: OpenAiCompatibleLlmConfig,
  ) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelLight = config.modelLight;
    this.modelNormal = config.modelNormal;
    this.modelHeavy = config.modelHeavy;
    this.defaultModel = config.modelNormal;
    this.xTitle = config.xTitle;
    this.providerLabel = config.providerLabel;
  }

  getModel(type: LlmModelType): string {
    switch (type) {
      case 'light':
        return this.modelLight;
      case 'normal':
        return this.modelNormal;
      case 'heavy':
        return this.modelHeavy;
      default:
        return this.defaultModel;
    }
  }

  async callLLM(
    messages: LlmMessage[],
    model?: string,
    options?: LlmCallOptions,
  ): Promise<LlmResponse> {
    const request: LlmRequest = {
      model: model || this.defaultModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
    };

    const requestLogSummary = {
      model: request.model,
      stream: false,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      messages: this.summarizeMessages(messages),
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<LlmResponse>(`${this.baseUrl}/chat/completions`, request, {
            headers: this.buildHeaders(),
            timeout: 15000,
          })
          .pipe(
            catchError((error: AxiosError) => {
              this.logApiError(error, requestLogSummary);
              throw new InternalServerErrorException(
                `Failed to call ${this.providerLabel} API: ${error.message}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling ${this.providerLabel}: ${error}`);
      throw error;
    }
  }

  async generateFinalResponseStream(
    messages: LlmMessage[],
    toolResults: LlmToolResult[],
    model?: string,
    options?: { temperature?: number },
  ): Promise<Readable> {
    const toolMessages: LlmMessage[] = toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.tool_call_id,
      name: result.name,
      content: result.content,
    }));

    const updatedMessages = [...messages, ...toolMessages];

    const request: LlmRequest & { stream: boolean } = {
      model: model || this.defaultModel,
      messages: updatedMessages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: 2000,
      stream: true,
      stream_options: { include_usage: true },
    };

    const requestLogSummary = {
      model: request.model,
      stream: request.stream,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      toolResultsCount: toolResults.length,
      toolResultsContentCharsSum: toolResults.reduce(
        (sum, r) => sum + (r.content?.length ?? 0),
        0,
      ),
      messages: this.summarizeMessages(updatedMessages),
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<Readable>(`${this.baseUrl}/chat/completions`, request, {
            headers: this.buildHeaders(),
            responseType: 'stream',
            timeout: 15000,
          })
          .pipe(
            catchError((error: AxiosError) => {
              this.logApiError(error, requestLogSummary);
              throw new InternalServerErrorException(
                `Failed to call ${this.providerLabel} API: ${error.message}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling ${this.providerLabel}: ${error}`);
      throw error;
    }
  }

  protected buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.configService.get<string>('DOMAIN_NAME') ?? '',
      ...(this.xTitle ? { 'X-Title': this.xTitle } : {}),
    };
  }

  protected logApiError(error: AxiosError, requestLogSummary: unknown): void {
    const statusCode = error.response?.status;
    const responseData = error.response?.data;
    this.logger.error(
      `${this.providerLabel} API error (status ${statusCode}): ${error.message}`,
      error instanceof Error ? error.stack : undefined,
    );
    if (responseData != null) {
      this.logger.error(
        `${this.providerLabel} error response body: ${this.safeStringify(responseData)}`,
      );
    }
    this.logger.error(
      `${this.providerLabel} request summary: ${this.safeStringify(requestLogSummary)}`,
    );
  }

  protected safeStringify(value: unknown, maxLen: number = 2000): string {
    try {
      if (typeof value === 'string') {
        return value.length > maxLen
          ? value.slice(0, maxLen) + '...(truncated)'
          : value;
      }

      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value as Buffer)) {
        const str = (value as Buffer).toString('utf8');
        return str.length > maxLen
          ? str.slice(0, maxLen) + '...(truncated)'
          : str;
      }

      const str = JSON.stringify(value, null, 2);
      return str.length > maxLen
        ? str.slice(0, maxLen) + '...(truncated)'
        : str;
    } catch {
      const str = inspect(value, {
        depth: 5,
        maxArrayLength: 50,
        breakLength: 120,
      });
      return str.length > maxLen
        ? str.slice(0, maxLen) + '...(truncated)'
        : str;
    }
  }

  protected summarizeMessages(messages: LlmMessage[]) {
    const roleCounts: Record<string, number> = {};
    let assistantToolCalls = 0;
    let toolRoleMessages = 0;
    let toolRoleHasNameField = 0;
    let contentNullCount = 0;
    let contentCharsSum = 0;

    for (const m of messages) {
      roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
      if (m.role === 'assistant' && m.tool_calls?.length) {
        assistantToolCalls += m.tool_calls.length;
      }
      if (m.role === 'tool') {
        toolRoleMessages += 1;
        if ((m as unknown as { name?: unknown }).name != null) {
          toolRoleHasNameField += 1;
        }
      }
      if (m.content === null) contentNullCount += 1;
      if (typeof m.content === 'string') contentCharsSum += m.content.length;
    }

    return {
      total: messages.length,
      roleCounts,
      assistantToolCalls,
      toolRoleMessages,
      toolRoleHasNameField,
      contentNullCount,
      contentCharsSum,
    };
  }
}
