import { AnswerOutputFilter } from '../safety/answer-output';
import { maskPersonalInfo } from '../agent/tools/ziggle/notice-text';
import { StringDecoder } from 'node:string_decoder';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, type Readable } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LlmUsage } from '../types/llm.types';
import type { ResourceInfo } from './resource-content.service';
import type { AgentStep, ExternalSource } from '../agent/agent.types';

/** SSE `step` 이벤트 페이로드 */
export type StepEvent = {
  type: 'step';
  id: string;
  kind: string;
  label: string;
  status: AgentStep['status'];
  thought?: string;
  resultCount?: number;
};

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
  /**
   * 답변 스트림의 앞부분만 읽어 `lead`로 시작하는지 본다. 클라이언트에는 아무것도 쓰지 않는다.
   * - 앞부분이 lead와 달라지는 순간 판단을 끝내고, 읽은 내용을 그대로 이어 주는 스트림을 돌려준다.
   *   일반 답변은 첫 몇 글자에서 갈라지므로 체감 지연이 거의 없다.
   * - lead와 같으면 원래 스트림을 닫고 matched=true를 돌려준다(그 스트림의 토큰 사용량은 버려진다).
   * 공백과 마크다운 강조(`*`)는 비교에서 뺀다.
   */
  detectLeadingText(
    stream: Readable,
    lead: string,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean; stream: Readable }> {
    const target = compactForLeadMatch(lead);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const out = new PassThrough();
      const abort = () => {
        stream.destroy(new Error('Request cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      stream.once('close', () => {
        signal?.removeEventListener('abort', abort);
        if (!decided) {
          decided = true;
          out.destroy();
          reject(new Error('Stream closed before answer'));
        }
      });
      out.once('close', () => {
        if (!stream.destroyed) stream.destroy();
      });
      const buffered: Buffer[] = [];
      let lineBuffer = '';
      const decoder = new StringDecoder('utf8');
      let content = '';
      let decided = false;

      const passThrough = () => {
        decided = true;
        for (const chunk of buffered) out.write(chunk);
        buffered.length = 0;
        resolve({ matched: false, stream: out });
      };

      stream.on('data', (chunk: Buffer) => {
        if (decided) {
          out.write(chunk);
          return;
        }
        buffered.push(chunk);
        lineBuffer += decoder.write(chunk);
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          content += readContentDelta(line);
        }
        const seen = compactForLeadMatch(content);
        if (seen.length >= target.length) {
          if (seen.startsWith(target)) {
            decided = true;
            stream.destroy();
            out.destroy();
            resolve({ matched: true, stream: out });
          } else {
            passThrough();
          }
        } else if (!target.startsWith(seen)) {
          passThrough();
        }
      });
      stream.on('end', () => {
        if (!decided) passThrough();
        out.end();
      });
      stream.on('error', (error: Error) => {
        if (!decided) {
          decided = true;
          out.destroy();
          reject(error);
        } else out.destroy(error);
      });
    });
  }

  consumeAndForward(
    stream: Readable,
    reply: FastifyReply,
    output?: AnswerOutputFilter,
    signal?: AbortSignal,
    onFirstContent?: () => void,
  ): Promise<StreamConsumeResult> {
    return new Promise((resolve, reject) => {
      let accumulatedContent = '';
      let model = '';
      let usage: LlmUsage | null = null;
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        stream.destroy();
        reject(new Error('Request cancelled'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      stream.once('close', () => {
        if (!stream.readableEnded) abort();
      });

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;

        buffer += decoder.write(chunk);
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

          const delta = parsed.choices?.[0]?.delta?.content;
          const content = delta ? (output ? output.push(delta) : delta) : '';
          if (content) {
            onFirstContent?.();
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
        cleanup();
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
        cleanup();
        try {
          const content = output?.push('', true) ?? '';
          if (content) {
            onFirstContent?.();
            accumulatedContent += content;
            reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
          resolve({ accumulatedContent, model, usage });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * 에이전트 진행 단계 이벤트. 기존 클라이언트는 `content`·`error`가 없는 이벤트를 무시하므로
   * 두 키를 절대 넣지 않는다.
   */
  writeStep(reply: FastifyReply, step: AgentStep): void {
    if (reply.raw.writableEnded) return;
    const event: StepEvent = {
      type: 'step',
      id: step.id,
      kind: step.kind,
      label: maskPersonalInfo(step.label),
      status: step.status,
      ...(step.thought ? { thought: maskPersonalInfo(step.thought) } : {}),
      ...(step.resultCount != null ? { resultCount: step.resultCount } : {}),
    };
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      // 단계 표시는 부가 정보라 실패해도 답변 생성을 멈추지 않는다.
      this.logger.warn(
        `SSE step write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  /**
   * 리소스 센터 밖의 출처(Ziggle 공지 등). FE는 `resources`의 url 앞에 리소스 센터 주소를 붙이므로
   * 외부 링크는 별도 이벤트로 보낸다. `step`과 마찬가지로 content·error 키를 넣지 않는다.
   */
  writeSources(reply: FastifyReply, sources: ExternalSource[]): void {
    if (sources.length === 0) return;
    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'sources',
        sources: sources.map(({ kind, id, title, url }) => ({
          kind,
          id,
          title,
          url,
        })),
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

/** OpenAI 호환 SSE 한 줄에서 content 조각을 꺼낸다. 형식이 다르면 빈 문자열 */
function readContentDelta(line: string): string {
  if (!line.startsWith('data: ')) return '';
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

function compactForLeadMatch(text: string): string {
  return text.replace(/[\s*]/g, '');
}
