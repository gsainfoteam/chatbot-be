import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDF_PROCESSOR_PROMPT } from '../chat/prompts/pdf-processor';
import { PDF_CHUNKING_PROMPT } from '../chat/prompts/pdf-chunking-prompt';
import {
  LLM_CLIENT,
  type LlmClient,
} from '../chat/llm/llm-client.interface';
import { PdfTextService } from './pdf-text.service';
import { parseChunksFromMarkdown } from './pdf-chunk-parser';
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

@Injectable()
export class PdfPipelineService {
  private readonly logger = new Logger(PdfPipelineService.name);
  private readonly contextLength: number;
  private readonly llmTimeoutMs: number;

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
  }

  /**
   * Pass 1 (page → markdown) + Pass 2 (semantic chunking). Text-only (no images).
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
    let previousContext = '';

    for (let i = 0; i < totalPages; i += 1) {
      const currentPage = i + 1;
      const pageText = pageTexts[i] ?? '';
      const pageMarkdown = await this.convertPageToMarkdown({
        filename,
        totalPages,
        currentPage,
        pageText,
        previousContext,
      });
      pageMarkdowns.push(pageMarkdown);
      previousContext =
        pageMarkdown.length > this.contextLength
          ? pageMarkdown.slice(-this.contextLength)
          : pageMarkdown;
    }

    const combinedMarkdown = pageMarkdowns.join('\n\n');
    this.logger.log(
      `Pass 2: Chunking complete markdown (${combinedMarkdown.length} chars)`,
    );

    const { documents, metadata } = await this.chunkMarkdownWithLlm(
      combinedMarkdown,
      filename,
    );

    const chunks: PipelineChunk[] = metadata.chunks.map((c, idx) => ({
      path: c.path,
      description: c.description,
      content: documents[`${c.path}.md`] ?? '',
      sortOrder: idx,
    }));

    return {
      documents,
      metadata,
      summary: metadata.description,
      chunks,
    };
  }

  private async convertPageToMarkdown(params: {
    filename: string;
    totalPages: number;
    currentPage: number;
    pageText: string;
    previousContext: string;
  }): Promise<string> {
    const { filename, totalPages, currentPage, pageText, previousContext } =
      params;

    const prompt = PDF_PROCESSOR_PROMPT.replaceAll('{filename}', filename)
      .replaceAll('{total_pages}', String(totalPages))
      .replaceAll('{current_page}', String(currentPage))
      .replaceAll(
        '{previous_context}',
        previousContext || '없음 (첫 페이지)',
      );

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
      return response.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      this.logger.error(
        `Error calling LLM for page ${currentPage}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return `## Page ${currentPage}\n\n${pageText}`;
    }
  }

  private async chunkMarkdownWithLlm(
    markdown: string,
    filename: string,
  ): Promise<{
    documents: Record<string, string>;
    metadata: ResourceIndexEntry;
  }> {
    const prompt = PDF_CHUNKING_PROMPT.replaceAll('{filename}', filename);
    const baseName = filename.toLowerCase().endsWith('.pdf')
      ? filename.slice(0, -4)
      : filename;

    try {
      const model = this.llm.getModel('normal');
      const response = await this.llm.callLLM(
        [{ role: 'user', content: `${prompt}\n\n${markdown}` }],
        model,
        {
          temperature: 0.2,
          max_tokens: 16000,
          timeoutMs: this.llmTimeoutMs,
        },
      );
      const chunked = response.choices?.[0]?.message?.content ?? markdown;
      return parseChunksFromMarkdown(chunked, filename);
    } catch (error) {
      this.logger.error(
        `Error chunking markdown: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        documents: { [`${baseName}.md`]: markdown },
        metadata: { description: '', chunks: [] },
      };
    }
  }
}
