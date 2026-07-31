import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LlmUsage } from '../types/llm.types';
import type { ResourceInfo } from './resource-content.service';

export type StreamConsumeResult = {
  accumulatedContent: string;
  model: string;
  usage: LlmUsage | null;
};

/**
 * Fastify SSE transport (CORS 헤더, LLM 스트림 파싱·전달)
 */
@Injectable()
export class ChatStreamTransport {
  private readonly logger = new Logger(ChatStreamTransport.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * reply를 hijack하고 SSE 응답 헤더를 기록합니다.
   */
  prepareSse(reply: FastifyReply, req: FastifyRequest): void {
    reply.hijack();

    // credentials: true 사용 시 Access-Control-Allow-Origin은 * 불가, 요청 origin을 그대로 반환해야 함
    const allowedOrigins = [
      'http://localhost:5173',
      `https://${this.configService.get<string>('DOMAIN_NAME') ?? ''}`,
    ];
    const requestOrigin = req.headers.origin;
    const corsOrigin =
      requestOrigin && allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : allowedOrigins[1];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
  }

  /**
   * LLM SSE 스트림을 소비하며 content delta를 클라이언트로 전달합니다.
   * 스트림 종료 시 누적 결과를 resolve합니다.
   */
  consumeAndForward(
    stream: Readable,
    reply: FastifyReply,
  ): Promise<StreamConsumeResult> {
    return new Promise((resolve, reject) => {
      let accumulatedContent = '';
      let model = '';
      let usage: LlmUsage | null = null;
      let buffer = '';
      let settled = false;

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let parsed: {
            choices?: Array<{ delta?: { content?: string } }>;
            model?: string;
            usage?: LlmUsage;
          };
          try {
            parsed = JSON.parse(data) as typeof parsed;
          } catch {
            // JSON 파싱 실패 시 해당 이벤트만 무시
            continue;
          }

          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            accumulatedContent += content;
            try {
              reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
            } catch (error) {
              settled = true;
              const streamError =
                error instanceof Error ? error : new Error(String(error));
              this.logger.error('SSE write error:', streamError);
              if (!reply.raw.writableEnded) {
                try {
                  reply.raw.end();
                } catch {
                  // Socket may already be unavailable.
                }
              }
              if (!stream.destroyed) stream.destroy();
              reject(streamError);
              return;
            }
          }
          if (parsed.model) {
            model = parsed.model;
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
        }
      });

      stream.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        this.logger.error('Stream error:', error);
        try {
          reply.raw.write(
            `data: ${JSON.stringify({ error: error.message || 'Stream error' })}\n\n`,
          );
        } catch {
          // Socket may already be unavailable.
        }
        if (!reply.raw.writableEnded) {
          try {
            reply.raw.end();
          } catch {
            // Socket may already be unavailable.
          }
        }
        reject(error);
      });

      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ accumulatedContent, model, usage });
      });
    });
  }

  writeResources(reply: FastifyReply, resources: ResourceInfo[]): void {
    if (resources.length === 0) return;
    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'resources',
        resources,
      })}\n\n`,
    );
  }

  writeDone(reply: FastifyReply): void {
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }

  writeError(reply: FastifyReply, errorMessage: string): void {
    reply.raw.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
    reply.raw.end();
  }
}
