import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../../embedding/embedding.service';
import { RetrievalService } from '../../retrieval/retrieval.service';
import type { RelevantChunkSelection } from './resource-selection.service';

/**
 * 코사인 거리 상한 기본값. 이보다 먼 chunk는 "관련 없음"으로 간주합니다.
 * text-embedding-3-large 실측: 관련 질문 상위 chunk ≈ 0.35~0.62, 무관 질문 ≈ 0.78+.
 */
const DEFAULT_MAX_DISTANCE = 0.75;

/**
 * 벡터 임베딩(코사인 유사도) 기반 chunk 선별.
 * - LLM 선별(ResourceSelectionService.selectRelevantChunkPaths) 대비 저지연·저비용 경로.
 * - null 반환 = 벡터 검색 불가(비활성화/임베딩 실패/미백필) → 호출부가 LLM 선별로 폴백.
 * - 빈 선택 반환 = 임베딩된 chunk는 있으나 전부 임계값 밖 → 관련 자료 없음.
 */
@Injectable()
export class VectorChunkSelectionService {
  private readonly logger = new Logger(VectorChunkSelectionService.name);

  private readonly enabled: boolean;
  private readonly maxDistance: number;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly retrievalService: RetrievalService,
    configService: ConfigService,
  ) {
    const enabledRaw = configService.get<string>(
      'EMBEDDING_RETRIEVAL_ENABLED',
      'true',
    );
    this.enabled = String(enabledRaw).toLowerCase() !== 'false';

    const maxDistanceRaw = Number(
      configService.get<string>('EMBEDDING_MAX_DISTANCE'),
    );
    this.maxDistance =
      Number.isFinite(maxDistanceRaw) && maxDistanceRaw > 0
        ? maxDistanceRaw
        : DEFAULT_MAX_DISTANCE;
  }

  async selectRelevantChunkPaths(
    question: string,
    maxResults: number = 5,
  ): Promise<RelevantChunkSelection | null> {
    if (!this.enabled || !this.embeddingService.isEnabled()) {
      return null;
    }

    let queryEmbedding: number[];
    const t0 = Date.now();
    try {
      queryEmbedding = await this.embeddingService.embedText(question);
    } catch {
      this.logger.warn('Question embedding failed; falling back to LLM');
      return null;
    }

    let hits: Array<{ path: string; resourceName: string; distance: number }>;
    try {
      hits = await this.retrievalService.searchChunksByEmbedding(
        queryEmbedding,
        maxResults,
      );
    } catch (error) {
      this.logger.warn(
        `Vector search failed; falling back to LLM: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    this.logger.log(
      `[PERF] vector chunk selection(embed+search): ${Date.now() - t0}ms`,
    );

    if (hits.length === 0) {
      // 임베딩된 chunk가 하나도 없는 상태(백필 전 등) — LLM 선별로 폴백
      this.logger.warn('No embedded chunks available; falling back to LLM');
      return null;
    }

    const withinThreshold = hits.filter((h) => h.distance <= this.maxDistance);
    this.logger.log(
      `[DEBUG] 벡터 선별: 상위 ${hits.length}개 중 임계값(${this.maxDistance}) 이내 ${withinThreshold.length}개, ` +
        `최소 거리 ${hits[0].distance.toFixed(3)}`,
    );

    const rootPaths = new Set<string>();
    const detailPaths: string[] = [];
    for (const hit of withinThreshold.slice(0, maxResults)) {
      if (hit.path === hit.resourceName) {
        rootPaths.add(hit.path);
      } else {
        detailPaths.push(hit.path);
        // 세부 chunk 선택 시 루트 개요도 함께 참조 (LLM 선별과 동일한 동작)
        rootPaths.add(hit.resourceName);
      }
    }

    return { rootPaths: [...rootPaths], detailPaths };
  }
}
