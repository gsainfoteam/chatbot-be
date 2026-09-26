import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { LlmClient } from '../chat/llm/llm-client.interface';
import type { LlmResponse } from '../chat/types/llm.types';
import { PdfPipelineService } from './pdf-pipeline.service';
import type { PdfTextService } from './pdf-text.service';

function llmResponse(
  content: string,
  finishReason: LlmResponse['choices'][0]['finish_reason'] = 'stop',
): LlmResponse {
  return {
    id: 'resp',
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
  };
}

function createPipeline(options: {
  pages: string[];
  callLLM: jest.Mock<(...args: unknown[]) => Promise<LlmResponse>>;
}) {
  const pdfTextService = {
    extractPageTexts: jest.fn(async () => options.pages),
  };
  const config = {
    get: jest.fn(() => undefined),
  };
  const llm = {
    getModel: jest.fn(() => 'normal-model'),
    callLLM: options.callLLM,
    generateFinalResponseStream: jest.fn(),
  };

  return new PdfPipelineService(
    pdfTextService as unknown as PdfTextService,
    config as unknown as ConfigService,
    llm as unknown as LlmClient,
  );
}

describe('PdfPipelineService metadata pass', () => {
  it('maps metadata indexes onto server-split section bodies', async () => {
    const bodyA = '수강신청 본문 '.repeat(700);
    const bodyB = '학사일정 본문 '.repeat(700);
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(llmResponse(`## 수강신청\n\n${bodyA}`))
      .mockResolvedValueOnce(llmResponse(`## 학사일정\n\n${bodyB}`))
      .mockResolvedValueOnce(
        llmResponse(
          JSON.stringify({
            summary: '학사 안내',
            chunks: [
              {
                index: 0,
                path: '수강신청',
                description: '수강신청 방법, ZEUS',
              },
              {
                index: 1,
                path: '학사-일정',
                description: '개강, 시험 기간',
              },
            ],
          }),
        ),
      );

    const pipeline = createPipeline({
      pages: ['p1', 'p2'],
      callLLM,
    });

    const result = await pipeline.processPdf(
      Buffer.from('%PDF'),
      '학사편람.pdf',
    );

    expect(result.summary).toBe('학사 안내');
    expect(result.chunks.some((c) => c.path === '학사편람')).toBe(true);
    expect(
      result.chunks.some(
        (c) => c.path === '학사편람/수강신청' && c.content.includes('수강신청'),
      ),
    ).toBe(true);
    expect(
      result.chunks.some(
        (c) =>
          c.path === '학사편람/학사-일정' && c.content.includes('학사일정'),
      ),
    ).toBe(true);
    expect(result.documents['학사편람.md']).toContain(
      'path="학사편람/수강신청"',
    );
    expect(result.chunks.length).toBe(3);
  });

  it('throws when metadata LLM times out instead of returning empty chunks', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(llmResponse(`## A\n\n${'본문 '.repeat(700)}`))
      .mockRejectedValueOnce(new Error('timeout of 120000ms exceeded'));

    const pipeline = createPipeline({
      pages: ['p1'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/timeout/i);
  });

  it('throws when metadata finish_reason is length', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(llmResponse(`## A\n\n${'본문 '.repeat(700)}`))
      .mockResolvedValueOnce(
        llmResponse('{"summary":"x","chunks":[', 'length'),
      );

    const pipeline = createPipeline({
      pages: ['p1'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/finish_reason=length/);
  });

  it('throws when metadata response contains no chunks', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(llmResponse(`## A\n\n${'본문 '.repeat(700)}`))
      .mockResolvedValueOnce(
        llmResponse(JSON.stringify({ summary: '요약', chunks: [] })),
      );

    const pipeline = createPipeline({
      pages: ['p1'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/incomplete batch/);
  });

  it('falls back to the section title when metadata path traverses upward', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(
        llmResponse(`## 안전한 제목\n\n${'본문 '.repeat(700)}`),
      )
      .mockResolvedValueOnce(
        llmResponse(
          JSON.stringify({
            summary: '요약',
            chunks: [
              {
                index: 0,
                path: '../외부/문서',
                description: '설명',
              },
            ],
          }),
        ),
      );

    const pipeline = createPipeline({ pages: ['p1'], callLLM });
    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(result.documents['doc/안전한-제목.md']).toBeDefined();
    expect(
      Object.keys(result.documents).some((path) => path.includes('..')),
    ).toBe(false);
  });

  it('throws when Pass 1 page LLM failures exceed the ratio threshold', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockRejectedValueOnce(new Error('timeout of 120000ms exceeded'))
      .mockRejectedValueOnce(new Error('timeout of 120000ms exceeded'))
      .mockResolvedValueOnce(llmResponse(`## C\n\n${'본문 '.repeat(700)}`));

    const pipeline = createPipeline({
      pages: ['p1', 'p2', 'p3'],
      callLLM,
    });

    // 2/3 ≈ 66% > default 10%
    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/Pass 1 LLM failures exceeded threshold/);
  });

  it('continues when a small Pass 1 fallback stays within the threshold', async () => {
    let pass1Calls = 0;
    const callLLM = jest.fn<(...args: unknown[]) => Promise<LlmResponse>>(
      async (...args) => {
        const messages = args[0] as Array<{ content: string }>;
        const content = messages[0]?.content ?? '';

        if (/^index:\s*\d+/m.test(content)) {
          const indexes = [...content.matchAll(/^index:\s*(\d+)\s*$/gm)].map(
            (m) => Number(m[1]),
          );
          return llmResponse(
            JSON.stringify({
              summary: '요약',
              chunks: indexes.map((index) => ({
                index,
                path: `sec-${index}`,
                description: `desc-${index}`,
              })),
            }),
          );
        }

        pass1Calls += 1;
        if (pass1Calls === 1) {
          throw new Error('timeout of 120000ms exceeded');
        }
        return llmResponse(
          `## Section ${pass1Calls}\n\n${'본문내용입니다. '.repeat(500)}`,
        );
      },
    );

    // 1/10 = 10% is not > 0.1, so should proceed to Pass 2
    const pipeline = createPipeline({
      pages: Array.from({ length: 10 }, (_, i) => `p${i + 1}`),
      callLLM,
    });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it('throws when every Pass 1 page falls back', async () => {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockRejectedValue(new Error('timeout of 120000ms exceeded'));

    const pipeline = createPipeline({
      pages: ['p1', 'p2'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/Pass 1 LLM failures exceeded threshold/);
  });
});

describe('PdfPipelineService metadata index tolerance', () => {
  const twoSections = [
    `## 수강신청\n\n${'수강신청 본문 '.repeat(700)}`,
    `## 학사일정\n\n${'학사일정 본문 '.repeat(700)}`,
  ].join('\n\n');

  function metadataPipeline(indexes: number[]) {
    const callLLM = jest
      .fn<(...args: unknown[]) => Promise<LlmResponse>>()
      .mockResolvedValueOnce(
        llmResponse(
          JSON.stringify({
            summary: '안내',
            chunks: indexes.map((index) => ({
              index,
              path: `항목-${index}`,
              description: `설명 ${index}`,
            })),
          }),
        ),
      );
    return createPipeline({ pages: [], callLLM });
  }

  it('ignores extra labels when the LLM splits a single section further', async () => {
    const pipeline = metadataPipeline([0, 1, 2]);

    const result = await pipeline.processMarkdown(
      '# 의무실\n\n위치: LG도서관 B동 2층\n\n운영: 평일 09:00-18:00',
      '의무실',
    );

    expect(result.chunks.map((c) => c.path)).toEqual([
      '의무실',
      '의무실/항목-0',
    ]);
    expect(result.chunks[1].description).toBe('설명 0');
    expect(result.chunks[1].content).toContain('LG도서관');
  });

  it('keeps every section when extra labels follow a complete batch', async () => {
    const pipeline = metadataPipeline([0, 1, 5]);

    const result = await pipeline.processMarkdown(twoSections, '학사편람');

    const byPath = new Map(result.chunks.map((c) => [c.path, c.content]));
    expect(byPath.get('학사편람/항목-0')).toContain('수강신청 본문');
    expect(byPath.get('학사편람/항목-1')).toContain('학사일정 본문');
    expect(byPath.has('학사편람/항목-5')).toBe(false);
  });

  it('rejects unknown indexes when an expected section is missing', async () => {
    const pipeline = metadataPipeline([0, 2]);

    await expect(
      pipeline.processMarkdown(twoSections, '학사편람'),
    ).rejects.toThrow(
      'Pass 2 metadata unexpected index: 2 (returned [0,2], expected [0,1])',
    );
  });

  it('still rejects duplicate indexes', async () => {
    const pipeline = metadataPipeline([0, 0, 1]);

    await expect(
      pipeline.processMarkdown(twoSections, '학사편람'),
    ).rejects.toThrow('Pass 2 metadata duplicate index: 0');
  });

  it('still rejects a batch with a missing index', async () => {
    const pipeline = metadataPipeline([0]);

    await expect(
      pipeline.processMarkdown(twoSections, '학사편람'),
    ).rejects.toThrow('Pass 2 metadata incomplete batch');
  });
});
