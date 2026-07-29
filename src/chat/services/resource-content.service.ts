import { Injectable, Logger } from '@nestjs/common';
import type {
  ListResourcesResult,
  ListResourceItem,
} from '../../mcp/mcp-client.service';
import { McpClientService } from '../../mcp/mcp-client.service';
import { ResourceSelectionService } from './resource-selection.service';
import type { LlmUsage } from '../types/llm.types';

/**
 * FE·SSE용 참조 리소스 정보
 */
export interface ResourceInfo {
  path: string; // 문서 제목 (PDF/PNG인 경우 format 포함)
  formats: string[];
  url: string;
}

/**
 * MCP 리소스 내용 fetch·파싱·FE 리소스 조립
 */
@Injectable()
export class ResourceContentService {
  private readonly logger = new Logger(ResourceContentService.name);

  constructor(
    private readonly mcpClientService: McpClientService,
    private readonly resourceSelectionService: ResourceSelectionService,
  ) {}

  private normalizeResourcePath(path: string): string {
    // 확장자가 있으면 제거 (MCP 서버가 자동으로 찾음)
    if (path.includes('.')) {
      const lastDotIndex = path.lastIndexOf('.');
      // 마지막 점 이후가 확장자인 경우 (예: .md, .pdf)
      const extension = path.substring(lastDotIndex + 1);
      if (extension.length <= 5 && /^[a-z0-9]+$/i.test(extension)) {
        return path.substring(0, lastDotIndex);
      }
    }
    return path;
  }

  /**
   * 경로에서 마지막 문서 제목만 추출 (확장자 포함)
   * 예: "2025 캠프 발표자료_ 1일차 오전/학생지원.md" -> "학생지원.md"
   * 원본 경로에 확장자가 없으면 formats 배열에서 찾아서 추가
   */
  private extractDocumentTitle(
    path: string,
    originalPath?: string,
    formats?: string[],
  ): string {
    // 원본 경로가 있으면 원본 경로 사용 (확장자 포함)
    const pathToUse = originalPath || path;

    // 슬래시로 분리하여 마지막 부분만 반환
    const parts = pathToUse.split('/');
    let title = parts[parts.length - 1] || pathToUse;

    // 확장자가 없고 formats 배열에 md가 있으면 .md 추가
    if (!title.includes('.') && formats && formats.includes('md')) {
      title = `${title}.md`;
    }

    return title;
  }

  /**
   * FE·리소스 API용 PDF 경로: 하위 chunk/이미지 경로가 아니라 상위 묶음 PDF 한 개
   * 예: `에어컨+…/세부/파일.png` → `에어컨+….pdf` (첫 `/` 앞 세그먼트 + `.pdf`)
   */
  private normalizeTopLevelPdfPathForFe(resourcePath: string): string {
    const first = resourcePath.split('/')[0]?.trim() || resourcePath;
    const base = first.replace(/\.(pdf|png|md|jpe?g|gif|webp)$/i, '');
    return `${base}.pdf`;
  }

  /**
   * SSE·메타데이터용 참조 문서: **PDF 번들만** (마크다운 chunk 경로는 상위 세그먼트 + `.pdf`로 변환).
   * 예: `2026년+학사편람/…/졸업요건.md` → `2026년+학사편람.pdf`
   */
  appendFePdfResourceEntryFromUsed(
    out: ResourceInfo[],
    seenPdfPaths: Set<string>,
    r: { path: string; formats: string[] },
  ): void {
    if (!r.path || !r.formats?.length) return;
    const contributes =
      r.formats.includes('md') ||
      r.formats.includes('pdf') ||
      r.formats.includes('png');
    if (!contributes) return;

    const pathForFe = this.normalizeTopLevelPdfPathForFe(r.path);
    if (seenPdfPaths.has(pathForFe)) return;
    seenPdfPaths.add(pathForFe);

    out.push({
      path: pathForFe,
      formats: ['pdf'],
      url: this.generateResourceUrl(pathForFe),
    });
  }

  /**
   * get_resource 툴 응답에서 텍스트 내용 추출
   * MCP 서버는 문자열을 직접 반환하므로, texts 배열이나 raw.content에서 추출
   */
  private extractContentFromToolResult(
    toolResult: Awaited<ReturnType<typeof this.mcpClientService.callTool>>,
  ): string {
    // texts 배열에서 내용 추출 (가장 일반적인 경우)
    if (toolResult.texts.length > 0) {
      // texts가 여러 개인 경우 합치기
      const content = toolResult.texts.join('\n');
      // JSON 문자열이 아닌 경우 그대로 반환
      if (
        content &&
        !content.trim().startsWith('{') &&
        !content.trim().startsWith('[')
      ) {
        return content;
      }
    }

    // raw.content에서 text 타입 항목 추출
    const raw = toolResult.raw as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (raw?.content) {
      const textContents: string[] = [];
      for (const item of raw.content) {
        if (item.type === 'text' && 'text' in item) {
          const text = item.text;
          // JSON 문자열이 아닌 경우 그대로 추가
          if (
            text &&
            !text.trim().startsWith('{') &&
            !text.trim().startsWith('[')
          ) {
            textContents.push(text);
          }
        }
      }
      if (textContents.length > 0) {
        return textContents.join('\n');
      }
    }

    return '';
  }

  /**
   * 신 형식: LLM에게 description을 보고 관련 chunk 경로 최대 maxResults개 선택 (JSON 배열 반환)
   */
  private parseDocumentLinks(content: string): Array<{
    path: string;
    description: string;
  }> {
    const documents: Array<{ path: string; description: string }> = [];
    const documentRegex =
      /<document\s+path="([^"]+)"\s+description="([^"]+)"><\/document>/g;

    let match;
    while ((match = documentRegex.exec(content)) !== null) {
      documents.push({
        path: match[1],
        description: match[2],
      });
    }

    return documents;
  }

  /**
   * 마크다운에서 이미지 참조 추출: ![alt](path) 형태
   * 첨부된 이미지(.png, .jpg 등) 경로만 반환
   */
  private parseImageReferencesFromMarkdown(content: string): string[] {
    const paths: string[] = [];
    const imageRefRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = imageRefRegex.exec(content)) !== null) {
      const path = match[1].trim();
      if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(path)) {
        paths.push(path);
      }
    }
    return paths;
  }

  /**
   * 문서 경로 기준으로 상대 이미지 경로를 전체 리소스 경로로 변환
   * 예: docPath="폴더/문서.md", imageRef="이미지.png" → "폴더/이미지.png"
   */
  private resolveImagePath(imageRef: string, docPath: string): string {
    const lastSlash = docPath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : docPath.slice(0, lastSlash + 1);
    return dir + imageRef;
  }

  /**
   * MD 링크/이미지의 상대 경로를 절대 리소스 경로로 변환 (`../` 처리)
   */
  private resolveRelativeResourcePath(ref: string, docPath: string): string {
    const raw = ref.trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
    if (!raw || /^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return raw.replace(/^\/+/, '');
    const lastSlash = docPath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : docPath.slice(0, lastSlash + 1);
    const combined = dir + raw;
    const segments = combined.split('/').filter((s) => s.length > 0);
    const out: string[] = [];
    for (const s of segments) {
      if (s === '..') out.pop();
      else if (s !== '.') out.push(s);
    }
    return out.join('/');
  }

  /**
   * 선별된 MD 본문에서 PDF/PNG 참조 경로 추출 (마크다운 링크, 이미지, `<document>`)
   */
  private extractPdfPngReferencesFromMarkdown(
    content: string,
    docPath: string,
  ): Array<{ path: string; formats: string[] }> {
    const results: Array<{ path: string; formats: string[] }> = [];
    const seen = new Set<string>();
    const add = (p: string, fmt: 'pdf' | 'png') => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      results.push({ path: p, formats: [fmt] });
    };

    const mdLink = /\[([^\]]*)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdLink.exec(content)) !== null) {
      const inner = m[2].trim();
      const raw = inner.split(/\s+/)[0];
      if (/\.pdf$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'pdf');
      }
      if (/\.png$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    for (const img of this.parseImageReferencesFromMarkdown(content)) {
      const raw = img.trim().split(/[?#]/)[0];
      if (/\.png$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    for (const d of this.parseDocumentLinks(content)) {
      const p = d.path.trim();
      if (/\.pdf$/i.test(p)) {
        const full = p.includes('/')
          ? p
          : this.resolveRelativeResourcePath(p, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'pdf');
      }
      if (/\.png$/i.test(p)) {
        const full = p.includes('/')
          ? p
          : this.resolveRelativeResourcePath(p, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    return results;
  }

  /**
   * list_resources chunk 목록에서 선별된 상위 폴더와 같은 루트의 PDF/PNG chunk 경로 수집
   */
  private collectPdfPngPathsFromChunkCatalog(
    chunks: Array<{ path: string }> | undefined,
    selectedPaths: string[],
    max: number = 8,
  ): Array<{ path: string; formats: string[] }> {
    if (!chunks?.length || !selectedPaths.length) return [];
    const roots = new Set(
      selectedPaths.map((p) => p.split('/')[0]).filter(Boolean),
    );
    const out: Array<{ path: string; formats: string[] }> = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      const isPdf = /\.pdf$/i.test(c.path);
      const isPng = /\.png$/i.test(c.path);
      if (!isPdf && !isPng) continue;
      const root = c.path.split('/')[0];
      if (!roots.has(root)) continue;
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push({ path: c.path, formats: isPdf ? ['pdf'] : ['png'] });
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 질문과 관련된 하위 문서 찾기
   */
  private findRelevantSubDocuments(
    question: string,
    documents: Array<{ path: string; description: string }>,
    maxResults: number = 3,
  ): Array<{ path: string; description: string }> {
    const keywords =
      question
        .toLowerCase()
        .match(/[\uac00-\ud7a3]+|[a-z]+/gi)
        ?.filter((word) => word.length > 1) || [];

    if (keywords.length === 0) {
      return documents.slice(0, maxResults);
    }

    const scoredDocuments = documents.map((doc) => {
      const pathLower = doc.path.toLowerCase();
      const descLower = doc.description.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        if (pathLower.includes(keyword)) {
          score += keyword.length * 2; // 경로 매칭은 가중치 높게
        }
        if (descLower.includes(keyword)) {
          score += keyword.length; // 설명 매칭
        }
      }

      return { document: doc, score };
    });

    return scoredDocuments
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => item.document);
  }

  /**
   * 하위 문서 내용 가져오기
   */
  private async fetchSubDocumentContents(
    subDocuments: Array<{ path: string; description: string }>,
  ): Promise<string> {
    const results = await Promise.all(
      subDocuments.map(async (doc) => {
        try {
          const resourcePath = this.normalizeResourcePath(doc.path);
          this.logger.debug(`Fetching sub-document: ${resourcePath}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: resourcePath },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const documentTitle = this.extractDocumentTitle(
              resourcePath,
              doc.path,
              ['md'],
            );
            return `\n\n## 하위 문서: ${documentTitle}\n\n**설명**: ${doc.description}\n\n${content}`;
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch sub-document ${doc.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return '';
      }),
    );
    return results.filter(Boolean).join('\n');
  }

  /**
   * LLM에게 문서 목록을 주고 질문과 관련성이 높은 문서만 선별하도록 요청
   */
  private async fetchRelevantContentsFromChunks(
    question: string,
    resources: ListResourceItem[],
    catalogChunks?: Array<{ path: string }>,
    tokenUsage?: LlmUsage,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
  }> {
    this.logger.log(
      `[DEBUG] 1차 선별(description 기준) 입력: 상위 리소스 ${resources.length}개, chunk 총 ${resources.reduce((s, r) => s + (r.chunks?.length ?? 0), 0)}개 → LLM에 전달`,
    );

    let t0 = Date.now();
    const chunkPaths = await this.resourceSelectionService.selectRelevantChunkPaths(
      question,
      resources,
      10,
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectRelevantChunkPaths(LLM): ${Date.now() - t0}ms`,
    );

    if (chunkPaths.length === 0) {
      return { content: '', usedResources: [] };
    }

    t0 = Date.now();
    const chunkResults = await Promise.all(
      chunkPaths.map(async (chunkPath) => {
        try {
          const pathForTool = this.normalizeResourcePath(chunkPath);
          this.logger.debug(`Fetching chunk: ${pathForTool}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: pathForTool },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const title = chunkPath.split('/').pop() || chunkPath || '문서';
            return { title, content, path: chunkPath };
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch chunk ${chunkPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }),
    );
    const documentCandidates = chunkResults.filter(
      (r): r is { title: string; content: string; path: string } => r !== null,
    );
    this.logger.log(
      `[PERF] get_resource 루프(신 형식, ${chunkPaths.length}개): ${Date.now() - t0}ms`,
    );

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 2차 선별(본문 기준) 입력: 후보 문서 ${documentCandidates.length}개 → LLM에 전달`,
    );

    t0 = Date.now();
    const selectedDocuments = await this.resourceSelectionService.selectMostRelevantDocuments(
      question,
      documentCandidates.map((doc) => ({
        title: doc.title,
        content: doc.content,
        path: doc.path,
      })),
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectMostRelevantDocuments(LLM, 신 형식): ${Date.now() - t0}ms`,
    );

    this.logger.log(
      `[DEBUG] 2차 선별 결과(최종 사용 문서): ${selectedDocuments.length}개`,
    );

    if (selectedDocuments.length === 0) {
      this.logger.log('No documents selected by LLM as relevant');
      return { content: '', usedResources: [] };
    }

    const contents: string[] = [];
    const mdUsed: Array<{ path: string; formats: string[] }> = [];

    for (const selected of selectedDocuments) {
      const doc = documentCandidates.find((d) => d.path === selected.path);
      if (doc) {
        contents.push(`\n\n## 리소스: ${doc.title}\n\n${doc.content}`);
        mdUsed.push({ path: doc.path, formats: ['md'] });
      }
    }

    const selectedPaths = selectedDocuments.map((s) => s.path);
    const fromMarkdown: Array<{ path: string; formats: string[] }> = [];
    for (const selected of selectedDocuments) {
      const doc = documentCandidates.find((d) => d.path === selected.path);
      if (!doc?.content) continue;
      fromMarkdown.push(
        ...this.extractPdfPngReferencesFromMarkdown(doc.content, doc.path),
      );
    }
    const fromCatalog = this.collectPdfPngPathsFromChunkCatalog(
      catalogChunks,
      selectedPaths,
      8,
    );

    const seenPdfPng = new Set<string>();
    const pdfPngExtras: Array<{ path: string; formats: string[] }> = [];
    for (const e of [...fromMarkdown, ...fromCatalog]) {
      if (seenPdfPng.has(e.path)) continue;
      seenPdfPng.add(e.path);
      pdfPngExtras.push(e);
    }

    const finalUsedResources = [
      ...mdUsed.slice(0, 5),
      ...pdfPngExtras.slice(0, 8),
    ];

    return {
      content: contents.join('\n'),
      usedResources: finalUsedResources,
    };
  }

  /**
   * list_resources tool 응답에서 관련 리소스 내용 가져오기
   * - 신 형식(resources + chunks): description 보고 chunk 경로 선별 → get_resource(chunk_path)
   * - 구 형식(filteredResources): 경로만 선별 후 get_resource
   * @returns 문서 내용과 usedResources(선별 경로·formats; chunk는 md 포함). FE 참조 목록은 PDF/PNG만 노출.
   */
  async fetchRelevantResourceContents(
    question: string,
    listResult: ListResourcesResult,
    tokenUsage?: LlmUsage,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
  }> {
    const isNewFormat =
      listResult.resources &&
      listResult.resources.length > 0 &&
      listResult.chunks &&
      listResult.chunks.length > 0;

    if (isNewFormat) {
      return this.fetchRelevantContentsFromChunks(
        question,
        listResult.resources!,
        listResult.chunks,
        tokenUsage,
      );
    }

    const filteredResources = listResult.filteredResources;
    if (!filteredResources || filteredResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    const mdResources = filteredResources.filter(
      (resource) => resource.formats && resource.formats.includes('md'),
    );

    if (mdResources.length === 0) {
      this.logger.debug('No markdown resources found in filtered resources');
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 1차 선별(경로 기준) 입력: MD 문서 ${mdResources.length}개 → LLM에 전달`,
    );

    let t0 = Date.now();
    const relevantResources = await this.resourceSelectionService.selectRelevantResourcePaths(
      question,
      mdResources,
      10,
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectRelevantResourcePaths(LLM, 구 형식): ${Date.now() - t0}ms`,
    );

    if (relevantResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 1차 선별 결과(상위 관련 문서 경로): ${relevantResources.length}개`,
    );

    t0 = Date.now();
    const resourceResults = await Promise.all(
      relevantResources.map(async (resource) => {
        try {
          const resourcePath = this.normalizeResourcePath(resource.path);
          this.logger.debug(`Fetching markdown resource: ${resourcePath}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: resourcePath },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const documentTitle = this.extractDocumentTitle(
              resourcePath,
              resource.path,
              resource.formats,
            );
            const subDocuments = this.parseDocumentLinks(content);
            return {
              title: documentTitle,
              content,
              path: resource.path,
              formats: resource.formats || [],
              subDocuments,
            };
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch ${resource.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }),
    );
    const documentCandidates = resourceResults.filter(
      (
        r,
      ): r is {
        title: string;
        content: string;
        path: string;
        formats: string[];
        subDocuments: Array<{ path: string; description: string }>;
      } => r !== null,
    );
    this.logger.log(
      `[PERF] get_resource 루프(구 형식, ${relevantResources.length}개): ${Date.now() - t0}ms`,
    );

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 2차 선별(본문 기준) 입력: 후보 문서 ${documentCandidates.length}개 → LLM에 전달`,
    );

    t0 = Date.now();
    const selectedDocuments = await this.resourceSelectionService.selectMostRelevantDocuments(
      question,
      documentCandidates.map((doc) => ({
        title: doc.title,
        content: doc.content,
        path: doc.path,
      })),
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectMostRelevantDocuments(LLM, 구 형식): ${Date.now() - t0}ms`,
    );

    this.logger.log(
      `[DEBUG] 2차 선별 결과(최종 사용 문서): ${selectedDocuments.length}개`,
    );
    if (selectedDocuments.length === 0) {
      this.logger.log('No documents selected by LLM as relevant');
      return { content: '', usedResources: [] };
    }

    const contents: string[] = [];
    const allSubDocuments: Array<{ path: string; description: string }> = [];
    const usedResources: Array<{ path: string; formats: string[] }> = [];
    const addedPaths = new Set<string>();

    for (const selected of selectedDocuments) {
      const docCandidate = documentCandidates.find(
        (d) => d.title === selected.title,
      );
      if (docCandidate) {
        contents.push(
          `\n\n## 리소스: ${docCandidate.title}\n\n${docCandidate.content}`,
        );

        const hasPdf = docCandidate.formats.includes('pdf');
        const hasPng = docCandidate.formats.includes('png');
        if (hasPdf || hasPng) {
          const pdfPngFormats = docCandidate.formats.filter(
            (f) => f === 'pdf' || f === 'png',
          );
          usedResources.push({
            path: docCandidate.path,
            formats: pdfPngFormats,
          });
          addedPaths.add(docCandidate.path);
        }

        if (docCandidate.subDocuments.length > 0) {
          allSubDocuments.push(...docCandidate.subDocuments);
        }
      }
    }

    for (const selected of selectedDocuments) {
      const path = selected.path;
      const firstSegment = path.split('/')[0];
      for (const r of filteredResources) {
        if (!r.formats) continue;
        if (addedPaths.has(r.path)) continue;
        if (r.formats.includes('pdf')) {
          const pathLower = r.path.toLowerCase();
          if (pathLower.endsWith('.png')) continue;
          const match =
            r.path === firstSegment ||
            r.path === `${firstSegment}.pdf` ||
            r.path.startsWith(`${firstSegment}.`);
          if (match) {
            usedResources.push({ path: r.path, formats: ['pdf'] });
            addedPaths.add(r.path);
          }
        }
      }
    }

    for (const selected of selectedDocuments) {
      const docCandidate = documentCandidates.find(
        (d) => d.title === selected.title,
      );
      if (!docCandidate?.content) continue;
      const imageRefs = this.parseImageReferencesFromMarkdown(
        docCandidate.content,
      );
      for (const imageRef of imageRefs) {
        const fullPath = this.resolveImagePath(imageRef, docCandidate.path);
        const pathWithoutExt = fullPath.replace(/\.(png|jpe?g|gif|webp)$/i, '');
        const r = filteredResources.find(
          (x) =>
            x.formats?.includes('png') &&
            !addedPaths.has(x.path) &&
            (x.path === fullPath ||
              x.path === pathWithoutExt ||
              x.path.toLowerCase() === fullPath.toLowerCase() ||
              x.path.toLowerCase() === pathWithoutExt.toLowerCase()),
        );
        if (r) {
          usedResources.push({ path: r.path, formats: ['png'] });
          addedPaths.add(r.path);
        }
      }
    }

    const finalUsedResources = usedResources.slice(0, 5);

    // 하위 문서 중 질문과 관련된 문서 찾아서 추가로 가져오기
    if (allSubDocuments.length > 0) {
      const relevantSubDocuments = this.findRelevantSubDocuments(
        question,
        allSubDocuments,
        3, // 최대 3개의 하위 문서만 추가로 가져오기
      );

      if (relevantSubDocuments.length > 0) {
        this.logger.log(
          `Fetching ${relevantSubDocuments.length} relevant sub-document(s)`,
        );
        t0 = Date.now();
        const subDocumentContents =
          await this.fetchSubDocumentContents(relevantSubDocuments);
        this.logger.log(
          `[PERF] fetchSubDocumentContents(${relevantSubDocuments.length}개): ${Date.now() - t0}ms`,
        );
        if (subDocumentContents) {
          contents.push('\n\n---\n\n## 관련 하위 문서\n' + subDocumentContents);
        }
      }
    }

    return {
      content: contents.join('\n'),
      usedResources: finalUsedResources,
    };
  }

  private generateResourceUrl(resourcePath: string): string {
    const encodedPath = encodeURIComponent(resourcePath);
    return encodedPath;
  }
}
