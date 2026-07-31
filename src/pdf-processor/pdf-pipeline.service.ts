import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDF_PROCESSOR_PROMPT } from '../chat/prompts/pdf-processor';
import { PDF_CHUNKING_PROMPT } from '../chat/prompts/pdf-chunking-prompt';
import { LLM_CLIENT, type LlmClient } from '../chat/llm/llm-client.interface';
import { PdfTextService } from './pdf-text.service';
import {
  splitMarkdownIntoSections,
  type MarkdownSection,
} from './markdown-section-splitter';
import { toRelativeChunkPath, toResourceName } from './pdf-chunk-parser';
import type { ResourceIndexEntry } from './gcs-storage.service';

export type PipelineChunk = {
  path: string;
  description: string;
  content: string;
  sortOrder: number;
};

export type PipelineResult = {
  documents: Record<string, string>;
  metadata: ResourceIndexEntry;
  summary: string;
  chunks: PipelineChunk[];
};

type ChunkMetadata = {
  index: number;
  path: string;
  description: string;
};

type MetadataBatchResponse = {
  summary?: string;
  chunks: ChunkMetadata[];
};

const METADATA_BATCH_SIZE = 15;
const SNIPPET_CHARS = 1_500;
const OVERVIEW_CHARS = 2_500;
/** Fail the whole job when Pass 1 LLM fallbacks exceed this fraction of pages. */
const DEFAULT_PASS1_MAX_FAILURE_RATIO = 0.1;

@Injectable()
export class PdfPipelineService {
  private readonly logger = new Logger(PdfPipelineService.name);
  private readonly contextLength: number;
  private readonly llmTimeoutMs: number;
  private readonly pass1MaxFailureRatio: number;

  constructor(
    private readonly pdfTextService: PdfTextService,
    private readonly configService: ConfigService,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {
    this.contextLength = Number(
      this.configService.get<string>('PDF_PROCESSOR_CONTEXT_LENGTH') ?? 500,
    );
    this.llmTimeoutMs =
      Number(
        this.configService.get<string>('PDF_PROCESSOR_LLM_TIMEOUT') ?? 120,
      ) * 1000;
    const ratio = Number(
      this.configService.get<string>('PDF_PROCESSOR_PASS1_MAX_FAILURE_RATIO') ??
        DEFAULT_PASS1_MAX_FAILURE_RATIO,
    );
    this.pass1MaxFailureRatio = Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, ratio))
      : DEFAULT_PASS1_MAX_FAILURE_RATIO;
  }

  /**
   * Pass 1 (page → markdown) + Pass 2 (server split + LLM metadata).
   */
  async processPdf(
    pdfBytes: Buffer,
    filename: string,
  ): Promise<PipelineResult> {
    const pageTexts = await this.pdfTextService.extractPageTexts(pdfBytes);
    const totalPages = pageTexts.length;
    this.logger.log(
      `Pass 1: Converting ${filename} to markdown (${totalPages} pages)`,
    );

    const pageMarkdowns: string[] = [];
    const failedPages: number[] = [];
    let previousContext = '';

    for (let i = 0; i < totalPages; i += 1) {
      const currentPage = i + 1;
      const pageText = pageTexts[i] ?? '';
      const { markdown, usedFallback } = await this.convertPageToMarkdown({
        filename,
        totalPages,
        currentPage,
        pageText,
        previousContext,
      });
      if (usedFallback) failedPages.push(currentPage);
      pageMarkdowns.push(markdown);
      previousContext =
        markdown.length > this.contextLength
          ? markdown.slice(-this.contextLength)
          : markdown;
    }

    this.assertPass1FailureWithinLimit(totalPages, failedPages);

    const combinedMarkdown = pageMarkdowns.join('\n\n');
    this.logger.log(
      `Pass 2: Labeling server-split sections (${combinedMarkdown.length} chars)`,
    );

    return this.chunkMarkdownWithMetadata(combinedMarkdown, filename);
  }

  private assertPass1FailureWithinLimit(
    totalPages: number,
    failedPages: number[],
  ): void {
    if (totalPages === 0) {
      throw new Error('Pass 1 produced 0 pages');
    }
    if (failedPages.length === 0) return;

    const ratio = failedPages.length / totalPages;
    this.logger.warn(
      `Pass 1 LLM fallbacks: ${failedPages.length}/${totalPages} pages (${(ratio * 100).toFixed(1)}%) pages=[${failedPages.join(',')}]`,
    );

    if (
      failedPages.length === totalPages ||
      ratio > this.pass1MaxFailureRatio
    ) {
      throw new Error(
        `Pass 1 LLM failures exceeded threshold: ${failedPages.length}/${totalPages} pages failed ` +
          `(max ratio ${this.pass1MaxFailureRatio}). pages=[${failedPages.join(',')}]`,
      );
    }
  }

  private async convertPageToMarkdown(params: {
    filename: string;
    totalPages: number;
    currentPage: number;
    pageText: string;
    previousContext: string;
  }): Promise<{ markdown: string; usedFallback: boolean }> {
    const { filename, totalPages, currentPage, pageText, previousContext } =
      params;

    const prompt = PDF_PROCESSOR_PROMPT.replaceAll('{filename}', filename)
      .replaceAll('{total_pages}', String(totalPages))
      .replaceAll('{current_page}', String(currentPage))
      .replaceAll('{previous_context}', previousContext || '없음 (첫 페이지)');

    const userText = pageText.trim()
      ? `${prompt}\n\n페이지 텍스트:\n${pageText}`
      : `${prompt}\n\n페이지 텍스트를 추출할 수 없었습니다. 추출된 텍스트 없이 가능한 범위에서 변환하세요.`;

    try {
      const model = this.llm.getModel('normal');
      const response = await this.llm.callLLM(
        [{ role: 'user', content: userText }],
        model,
        {
          temperature: 0.2,
          max_tokens: 8000,
          timeoutMs: this.llmTimeoutMs,
        },
      );
      const markdown = response.choices?.[0]?.message?.content ?? '';
      if (!markdown.trim() && pageText.trim()) {
        this.logger.warn(
          `Empty LLM markdown for page ${currentPage}; using raw extracted text`,
        );
        return {
          markdown: `## Page ${currentPage}\n\n${pageText}`,
          usedFallback: true,
        };
      }
      return { markdown, usedFallback: false };
    } catch (error) {
      this.logger.error(
        `Error calling LLM for page ${currentPage}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        markdown: `## Page ${currentPage}\n\n${pageText}`,
        usedFallback: true,
      };
    }
  }

  private async chunkMarkdownWithMetadata(
    markdown: string,
    filename: string,
  ): Promise<PipelineResult> {
    const baseName = toResourceName(filename);
    const sections = splitMarkdownIntoSections(markdown);
    if (sections.length === 0) {
      throw new Error('Markdown section split produced 0 sections');
    }

    this.logger.log(
      `Pass 2: ${sections.length} section(s) → metadata batches of ${METADATA_BATCH_SIZE}`,
    );

    const labeled = await this.labelSectionsWithLlm(sections, filename);
    const assembled = this.assembleChunkArtifacts(baseName, sections, labeled);

    if (assembled.chunks.length === 0) {
      throw new Error('Chunk assembly produced 0 chunks');
    }

    return assembled;
  }

  private async labelSectionsWithLlm(
    sections: MarkdownSection[],
    filename: string,
  ): Promise<{ summary: string; chunks: ChunkMetadata[] }> {
    const prompt = PDF_CHUNKING_PROMPT.replaceAll('{filename}', filename);
    const model = this.llm.getModel('normal');
    const allChunks: ChunkMetadata[] = [];
    const summaries: string[] = [];

    for (let start = 0; start < sections.length; start += METADATA_BATCH_SIZE) {
      const batch = sections.slice(start, start + METADATA_BATCH_SIZE);
      const batchText = batch
        .map((section) => {
          const snippet = section.content.slice(0, SNIPPET_CHARS);
          return [
            `index: ${section.index}`,
            `title: ${section.title}`,
            `snippet:`,
            snippet,
          ].join('\n');
        })
        .join('\n\n---\n\n');

      const response = await this.llm.callLLM(
        [{ role: 'user', content: `${prompt}\n\n${batchText}` }],
        model,
        {
          temperature: 0.2,
          max_tokens: 16000,
          timeoutMs: this.llmTimeoutMs,
        },
      );

      const finishReason = response.choices?.[0]?.finish_reason ?? 'missing';
      this.logger.log(
        `Pass 2 metadata batch ${start}-${start + batch.length - 1} finish_reason=${finishReason}`,
      );
      if (finishReason === 'length') {
        throw new Error(
          `Pass 2 metadata LLM truncated (finish_reason=length) for batch starting at ${start}`,
        );
      }

      const raw = response.choices?.[0]?.message?.content?.trim() ?? '';
      const parsed = this.parseMetadataResponse(raw, batch);
      if (parsed.summary?.trim()) summaries.push(parsed.summary.trim());
      allChunks.push(...parsed.chunks);
    }

    if (allChunks.length !== sections.length) {
      throw new Error(
        `Pass 2 metadata count mismatch: expected ${sections.length}, got ${allChunks.length}`,
      );
    }

    return {
      summary: summaries.join(' ').trim(),
      chunks: allChunks.sort((a, b) => a.index - b.index),
    };
  }

  private parseMetadataResponse(
    raw: string,
    batch: MarkdownSection[],
  ): MetadataBatchResponse {
    let text = raw.trim();
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) text = codeBlock[1].trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Pass 2 metadata JSON parse failed: ${text.slice(0, 200)}`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Pass 2 metadata response is not an object');
    }

    const obj = parsed as { summary?: unknown; chunks?: unknown };
    if (!Array.isArray(obj.chunks)) {
      throw new Error('Pass 2 metadata response missing chunks array');
    }

    const expectedIndexes = new Set(batch.map((s) => s.index));
    const seen = new Set<number>();
    const chunks: ChunkMetadata[] = [];

    for (const item of obj.chunks) {
      if (!item || typeof item !== 'object') {
        throw new Error('Pass 2 metadata chunk entry is not an object');
      }
      const entry = item as Record<string, unknown>;
      const index = entry.index;
      const path = entry.path;
      const description = entry.description;

      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw new Error(`Pass 2 metadata invalid index: ${String(index)}`);
      }
      if (!expectedIndexes.has(index)) {
        throw new Error(`Pass 2 metadata unexpected index: ${index}`);
      }
      if (seen.has(index)) {
        throw new Error(`Pass 2 metadata duplicate index: ${index}`);
      }
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error(`Pass 2 metadata missing path for index ${index}`);
      }
      if (typeof description !== 'string' || !description.trim()) {
        throw new Error(
          `Pass 2 metadata missing description for index ${index}`,
        );
      }

      seen.add(index);
      chunks.push({
        index,
        path: path.trim(),
        description: description.trim(),
      });
    }

    if (seen.size !== expectedIndexes.size) {
      throw new Error(
        `Pass 2 metadata incomplete batch: expected ${expectedIndexes.size} indexes, got ${seen.size}`,
      );
    }

    return {
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      chunks,
    };
  }

  private assembleChunkArtifacts(
    baseName: string,
    sections: MarkdownSection[],
    labeled: { summary: string; chunks: ChunkMetadata[] },
  ): PipelineResult {
    const byIndex = new Map(sections.map((s) => [s.index, s]));
    const documents: Record<string, string> = {};
    const stubLinks: string[] = [];
    const detailChunks: PipelineChunk[] = [];
    const usedPaths = new Set<string>();

    for (const meta of labeled.chunks) {
      const section = byIndex.get(meta.index);
      if (!section) {
        throw new Error(`Missing section for labeled index ${meta.index}`);
      }

      let relative = toRelativeChunkPath(meta.path, baseName);
      if (!relative) {
        relative = slugifyTitle(section.title) || `section-${meta.index + 1}`;
      }
      relative = ensureUniquePath(relative, usedPaths);

      const fullPath = `${baseName}/${relative}`;
      documents[`${fullPath}.md`] = section.content;
      stubLinks.push(
        `<document path="${fullPath}" description="${escapeAttr(meta.description)}"></document>`,
      );
      detailChunks.push({
        path: fullPath,
        description: meta.description,
        content: section.content,
        sortOrder: detailChunks.length + 1,
      });
    }

    const overviewBody = buildRootOverview(sections, labeled.summary);
    const rootContent = [overviewBody, '', ...stubLinks].join('\n').trim();
    documents[`${baseName}.md`] = rootContent;

    const chunks: PipelineChunk[] = [
      {
        path: baseName,
        description: labeled.summary || '문서 개요',
        content: rootContent,
        sortOrder: 0,
      },
      ...detailChunks,
    ];

    return {
      documents,
      metadata: {
        description: labeled.summary || '문서 개요',
        chunks: chunks.map((c) => ({
          path: c.path,
          description: c.description,
        })),
      },
      summary: labeled.summary || '문서 개요',
      chunks,
    };
  }
}

function buildRootOverview(
  sections: MarkdownSection[],
  summary: string,
): string {
  const outline = sections
    .slice(0, 40)
    .map((s, i) => `${i + 1}. ${s.title}`)
    .join('\n');
  const preface = sections[0]?.content.slice(0, OVERVIEW_CHARS) ?? '';
  return [
    summary ? `# 개요\n\n${summary}` : '# 개요',
    '',
    '## 목차',
    outline,
    '',
    '## 미리보기',
    preface,
  ]
    .join('\n')
    .trim();
}

function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_/]/gu, '')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');
}

function ensureUniquePath(path: string, used: Set<string>): string {
  let candidate = path;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${path}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "'");
}
