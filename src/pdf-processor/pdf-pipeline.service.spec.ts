import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { LlmClient } from '../chat/llm/llm-client.interface';
import type { LlmRequestMessage, LlmResponse } from '../chat/types/llm.types';
import { extractPageImages } from '../chat/services/page-image-sources';
import { PAGE_START } from './page-image-reference';
import { PdfPipelineService } from './pdf-pipeline.service';
import type { PdfPageContent, PdfTextService } from './pdf-text.service';

const STORED_IMAGE = Buffer.from('cropped');

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
  pages: Array<string | Partial<PdfPageContent>>;
  callLLM: jest.Mock<(...args: unknown[]) => Promise<LlmResponse>>;
}) {
  const pdfTextService = {
    forEachPage: jest.fn(
      async (
        _pdfBytes: Buffer,
        onPage: (page: PdfPageContent, totalPages: number) => Promise<void>,
      ) => {
        for (const [index, page] of options.pages.entries()) {
          await onPage(
            {
              pageNumber: index + 1,
              text: '',
              image: null,
              storedImage:
                typeof page !== 'string' && page.image ? STORED_IMAGE : null,
              imageFailed: false,
              ...(typeof page === 'string' ? { text: page } : page),
            },
            options.pages.length,
          );
        }
      },
    ),
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
    ).rejects.toThrow(/Pass 1 page failures exceeded threshold/);
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
    ).rejects.toThrow(/Pass 1 page failures exceeded threshold/);
  });
});

describe('PdfPipelineService page images', () => {
  const IMAGE = 'data:image/jpeg;base64,QUJD';
  const SECTION = `## 제목\n\n${'본문 '.repeat(700)}`;

  /** Pass 1 answers in order; Pass 2 answers are generated from the request. */
  function fakeLlm(pass1Outputs: Array<string | Error>) {
    const pass1Contents: LlmRequestMessage['content'][] = [];
    const callLLM = jest.fn<(...args: unknown[]) => Promise<LlmResponse>>(
      async (...args) => {
        const { content } = (args[0] as LlmRequestMessage[])[0];
        if (typeof content === 'string' && /^index:\s*\d+/m.test(content)) {
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

        const output = pass1Outputs[pass1Contents.length] ?? SECTION;
        pass1Contents.push(content);
        if (output instanceof Error) throw output;
        return llmResponse(output);
      },
    );
    return { callLLM, pass1Contents };
  }

  it('sends a page with an image as text and image parts', async () => {
    const { callLLM, pass1Contents } = fakeLlm([]);
    const pipeline = createPipeline({
      pages: [{ text: '그림 설명', image: IMAGE }],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents[0]).toEqual([
      { type: 'text', text: expect.stringContaining('그림 설명') },
      { type: 'image_url', image_url: { url: IMAGE } },
    ]);
  });

  it('reads an image page once', async () => {
    const { callLLM, pass1Contents } = fakeLlm([SECTION]);
    const pipeline = createPipeline({
      pages: [{ text: '', image: IMAGE }],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents).toHaveLength(1);
  });

  it('sends a page with only an image without any page text', async () => {
    const { callLLM, pass1Contents } = fakeLlm([]);
    const pipeline = createPipeline({
      pages: [{ text: '', image: IMAGE }],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents[0]).toEqual([
      { type: 'text', text: expect.not.stringContaining('페이지 텍스트:\n') },
      { type: 'image_url', image_url: { url: IMAGE } },
    ]);
  });

  it('skips the LLM for a page with neither text nor image', async () => {
    const { callLLM, pass1Contents } = fakeLlm([]);
    const pipeline = createPipeline({ pages: ['', '본문'], callLLM });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents).toHaveLength(1);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it('never asks the LLM to convert a document with nothing to read', async () => {
    const { callLLM } = fakeLlm([]);
    const pipeline = createPipeline({ pages: ['', ''], callLLM });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow('produced 0 sections');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('counts a failed image on a page without text and skips the LLM', async () => {
    const { callLLM, pass1Contents } = fakeLlm([]);
    const pipeline = createPipeline({
      pages: [{ imageFailed: true }, '본문'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/Pass 1 page failures exceeded threshold.*pages=\[1\]/);
    expect(pass1Contents).toHaveLength(1);
  });

  it('counts a failed image on a page with text but still converts the text', async () => {
    const { callLLM, pass1Contents } = fakeLlm([]);
    const pipeline = createPipeline({
      pages: [{ text: '남은 본문', imageFailed: true }, '본문'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/Pass 1 page failures exceeded threshold.*pages=\[1\]/);
    expect(pass1Contents[0]).toEqual(expect.stringContaining('남은 본문'));
  });

  it('adds no heading-only section when the LLM fails on an image page', async () => {
    const { callLLM } = fakeLlm([new Error('timeout')]);
    const pipeline = createPipeline({
      pages: [
        { text: '', image: IMAGE },
        ...Array.from({ length: 10 }, (_, i) => `본문 ${i}`),
      ],
      callLLM,
    });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(result.chunks.some((c) => c.content.includes('## Page 1'))).toBe(
      false,
    );
  });

  it('keeps the extracted text when the LLM fails on a page with text', async () => {
    const { callLLM } = fakeLlm([new Error('timeout')]);
    const pipeline = createPipeline({
      pages: [
        '원문 보존',
        ...Array.from({ length: 10 }, (_, i) => `본문 ${i}`),
      ],
      callLLM,
    });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(
      result.chunks.some((c) => c.content.includes('## Page 1\n\n원문 보존')),
    ).toBe(true);
  });

  it('keeps the previous page context across a blank page', async () => {
    const { callLLM, pass1Contents } = fakeLlm([`## 앞 장\n\n앞 장의 끝부분`]);
    const pipeline = createPipeline({
      pages: ['첫 페이지', '', '셋째 페이지'],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents[1]).toEqual(expect.stringContaining('앞 장의 끝부분'));
    expect(pass1Contents[1]).toEqual(expect.stringContaining('현재 페이지: 3'));
    expect(pass1Contents[1]).toEqual(expect.stringContaining('총 페이지: 3'));
  });

  it('gives an image page only the headings of the previous page', async () => {
    const { callLLM, pass1Contents } = fakeLlm([`## 앞 장\n\n앞 장의 본문`]);
    const pipeline = createPipeline({
      pages: ['첫 페이지', { text: '', image: IMAGE }],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    const [{ text }] = pass1Contents[1] as Array<{ text: string }>;
    expect(text).toContain('## 앞 장');
    expect(text).not.toContain('앞 장의 본문');
  });

  it('calls only the first page the first page', async () => {
    const { callLLM, pass1Contents } = fakeLlm(['제목 없는 본문']);
    const pipeline = createPipeline({
      pages: ['첫 쪽', { text: '', image: IMAGE }],
      callLLM,
    });

    await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(pass1Contents[0]).toEqual(
      expect.stringContaining('없음 (첫 페이지)'),
    );
    const [{ text }] = pass1Contents[1] as Array<{ text: string }>;
    expect(text).not.toContain('없음 (첫 페이지)');
  });

  it('keeps only the description of image syntax the LLM emits', async () => {
    const { callLLM } = fakeLlm([`${SECTION}\n\n![절차도](IMAGE:page-6)`]);
    const pipeline = createPipeline({ pages: ['본문'], callLLM });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    const content = result.chunks[1].content;
    expect(content).toContain('절차도');
    expect(content).not.toContain('IMAGE:page-6');
    expect(content).not.toContain('![');
  });

  describe('referenced page images', () => {
    const RICH_TEXT = '본문 '.repeat(60);
    const REFERENCE = '![절차도](IMAGE:page-1)';
    const allContent = (result: { chunks: Array<{ content: string }> }) =>
      result.chunks.map((chunk) => chunk.content).join('\n');

    function imageSink() {
      return jest.fn<(page: number, jpeg: Buffer) => Promise<void>>(
        async () => undefined,
      );
    }

    it('keeps the text of earlier pages from speaking for an image', async () => {
      const { callLLM } = fakeLlm([
        '수강신청 안내',
        '캠퍼스 건물 배치\n\n![지도](IMAGE:page-2)',
      ]);
      const pipeline = createPipeline({
        pages: [RICH_TEXT, { text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        imageSink(),
      );

      const [image] = extractPageImages(result.chunks[1].content, 'doc');
      expect(image.context).toContain('캠퍼스 건물 배치');
      expect(image.context).not.toContain('수강신청');
    });

    it('marks no page start at the very top of a document', async () => {
      const { callLLM } = fakeLlm([`${SECTION}\n\n${REFERENCE}`]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        imageSink(),
      );

      expect(allContent(result)).not.toContain(PAGE_START);
    });

    it('leaves references out of the root preview', async () => {
      const { callLLM } = fakeLlm([`${SECTION}\n\n${REFERENCE}`]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        imageSink(),
      );

      expect(result.chunks[0].content).not.toContain('IMAGE:page-1');
      expect(result.chunks[1].content).toContain(REFERENCE);
    });

    it('leaves page marks out of the root preview', async () => {
      const { callLLM } = fakeLlm([
        '첫 쪽 본문',
        '지도 설명\n\n![지도](IMAGE:page-2)',
      ]);
      const pipeline = createPipeline({
        pages: [RICH_TEXT, { text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        imageSink(),
      );

      expect(result.chunks[0].content).toContain('지도 설명');
      expect(result.chunks[0].content).not.toContain(PAGE_START);
    });

    it('stores the image of a page the LLM references', async () => {
      const { callLLM } = fakeLlm([`${SECTION}\n\n${REFERENCE}`]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });
      const sink = imageSink();

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        sink,
      );

      expect(allContent(result)).toContain(REFERENCE);
      expect(sink).toHaveBeenCalledWith(1, STORED_IMAGE);
    });

    it('stores nothing for a text-rich page the LLM does not reference', async () => {
      const { callLLM } = fakeLlm([SECTION]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });
      const sink = imageSink();

      await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf', sink);

      expect(sink).not.toHaveBeenCalled();
    });

    it('references an image-only page even when the LLM does not', async () => {
      const { callLLM } = fakeLlm([SECTION]);
      const pipeline = createPipeline({
        pages: [{ text: '', image: IMAGE }],
        callLLM,
      });
      const sink = imageSink();

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        sink,
      );

      expect(allContent(result)).toContain('(IMAGE:page-1)');
      expect(sink).toHaveBeenCalledTimes(1);
    });

    it('adds no reference to a cover that has a little text of its own', async () => {
      const { callLLM } = fakeLlm([SECTION]);
      const pipeline = createPipeline({
        pages: [{ text: '공유기 네트워크 설정방법 정보보안팀', image: IMAGE }],
        callLLM,
      });
      const sink = imageSink();

      await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf', sink);

      expect(sink).not.toHaveBeenCalled();
    });

    it('stores nothing for an image-only page the LLM returns empty', async () => {
      const { callLLM } = fakeLlm(['', SECTION]);
      const pipeline = createPipeline({
        pages: [{ text: '', image: IMAGE }, RICH_TEXT],
        callLLM,
      });
      const sink = imageSink();

      await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf', sink);

      expect(sink).not.toHaveBeenCalled();
    });

    it('drops the reference and keeps the page when storing fails', async () => {
      const { callLLM } = fakeLlm([`${SECTION}\n\n${REFERENCE}`]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }],
        callLLM,
      });
      const sink = imageSink();
      sink.mockRejectedValue(new Error('storage down'));

      const result = await pipeline.processPdf(
        Buffer.from('%PDF'),
        'doc.pdf',
        sink,
      );

      expect(allContent(result)).toContain('절차도');
      expect(allContent(result)).not.toContain('IMAGE:page-1');
    });

    it('does not pass the reference on as context for the next page', async () => {
      const { callLLM, pass1Contents } = fakeLlm([
        `${SECTION}\n\n${REFERENCE}`,
        SECTION,
      ]);
      const pipeline = createPipeline({
        pages: [{ text: RICH_TEXT, image: IMAGE }, RICH_TEXT],
        callLLM,
      });

      await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf', imageSink());

      expect(pass1Contents[1]).not.toContain('IMAGE:page-1');
    });
  });

  it('leaves out a sparse page the LLM returns empty without failing it', async () => {
    const { callLLM } = fakeLlm(['', SECTION]);
    const pipeline = createPipeline({ pages: ['감사합니다', '본문'], callLLM });

    const result = await pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf');

    expect(result.chunks.some((c) => c.content.includes('감사합니다'))).toBe(
      false,
    );
  });

  it('counts a text-rich page the LLM returns empty as failed', async () => {
    const { callLLM } = fakeLlm(['', SECTION]);
    const pipeline = createPipeline({
      pages: ['충분히 긴 본문입니다. '.repeat(20), '본문'],
      callLLM,
    });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow(/Pass 1 page failures exceeded threshold.*pages=\[1\]/);
  });

  it('fails a document with no pages', async () => {
    const { callLLM } = fakeLlm([]);
    const pipeline = createPipeline({ pages: [], callLLM });

    await expect(
      pipeline.processPdf(Buffer.from('%PDF'), 'doc.pdf'),
    ).rejects.toThrow('Pass 1 produced 0 pages');
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
