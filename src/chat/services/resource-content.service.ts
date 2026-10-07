import { Injectable, Logger } from '@nestjs/common';
import type {
  ListResourcesResult,
  ListResourceItem,
} from '../../retrieval/retrieval.types';
import { RetrievalService } from '../../retrieval/retrieval.service';
import { ResourceSelectionService } from './resource-selection.service';
import { VectorChunkSelectionService } from './vector-chunk-selection.service';
import type { LlmUsage } from '../types/llm.types';
import { Trace } from '@gsainfoteam/nest-observability';

/**
 * FE·SSE용 참조 리소스 정보
 */
export interface ResourceInfo {
  path: string; // 문서 제목 (PDF/PNG인 경우 format 포함)
  formats: string[];
  url: string;
}

/**
 * DB Retrieval 기반 리소스 내용 fetch·파싱·FE 리소스 조립
 */
@Trace()
@Injectable()
export class ResourceContentService {
  private readonly logger = new Logger(ResourceContentService.name);

  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly resourceSelectionService: ResourceSelectionService,
    private readonly vectorChunkSelectionService: VectorChunkSelectionService,
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
    // 1차 선별: 벡터 검색 우선, 불가 시(비활성화·임베딩 실패·미백필) LLM 선별로 폴백
    let chunkSelection =
      await this.vectorChunkSelectionService.selectRelevantChunkPaths(
        question,
        5,
      );
    if (chunkSelection) {
      this.logger.log(
        `[PERF] selectRelevantChunkPaths(vector): ${Date.now() - t0}ms`,
      );
    } else {
      chunkSelection =
        await this.resourceSelectionService.selectRelevantChunkPaths(
          question,
          resources,
          5,
          tokenUsage,
        );
      this.logger.log(
        `[PERF] selectRelevantChunkPaths(LLM fallback): ${Date.now() - t0}ms`,
      );
    }

    const chunkPaths = [
      ...chunkSelection.rootPaths,
      ...chunkSelection.detailPaths,
    ];
    if (chunkPaths.length === 0) {
      return { content: '', usedResources: [] };
    }

    t0 = Date.now();
    const hits = await this.retrievalService.getContentsByPaths(chunkPaths);
    const contentByPath = new Map(hits.map((h) => [h.path, h.content]));
    const documentCandidates = chunkPaths
      .map((chunkPath) => {
        const content = contentByPath.get(
          this.normalizeResourcePath(chunkPath),
        );
        if (!content) return null;
        const title = chunkPath.split('/').pop() || chunkPath || '문서';
        return { title, content, path: chunkPath };
      })
      .filter(
        (r): r is { title: string; content: string; path: string } =>
          r !== null,
      );
    this.logger.log(
      `[PERF] getContentsByPaths(신 형식, ${chunkPaths.length}개): ${Date.now() - t0}ms`,
    );

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 최종 사용 문서: 루트 ${chunkSelection.rootPaths.length}개, 세부 chunk ${chunkSelection.detailPaths.length}개`,
    );

    const contents: string[] = [];
    const mdUsed: Array<{ path: string; formats: string[] }> = [];

    for (const doc of documentCandidates) {
      contents.push(`\n\n## 관련 정보\n\n${doc.content}`);
      mdUsed.push({ path: doc.path, formats: ['md'] });
    }

    const selectedPaths = documentCandidates.map((doc) => doc.path);
    const fromMarkdown: Array<{ path: string; formats: string[] }> = [];
    for (const doc of documentCandidates) {
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
   * 문서 catalog에서 관련 리소스 내용 가져오기
   * - 신 형식(resources + chunks): description 보고 chunk 경로 선별 → DB content
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
    return { content: '', usedResources: [] };
  }

  private generateResourceUrl(resourcePath: string): string {
    const encodedPath = encodeURIComponent(resourcePath);
    return encodedPath;
  }
}
