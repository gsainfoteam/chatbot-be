import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_CLIENT,
  type EmbeddingClient,
} from '../embedding/embedding-client.interface';
import { DEFAULT_VECTOR_CANDIDATE_LIMIT } from '../embedding/embedding.constants';
import { RetrievalRepository } from './retrieval.repository';
import type {
  ChunkContentHit,
  ListResourceItem,
  ListResourcesResult,
  VectorCatalogResult,
  VectorChunkCandidate,
  VectorRootChunk,
} from './retrieval.types';

export function buildVectorCandidateCatalog(
  candidates: VectorChunkCandidate[],
  roots: VectorRootChunk[],
): ListResourcesResult {
  const rootsByDocument = new Map(roots.map((root) => [root.documentId, root]));
  const seenChunks = new Set<string>();
  const grouped = new Map<
    string,
    {
      title: string;
      resourceName: string;
      summary: string | null;
      chunks: Array<{ path: string; description: string }>;
    }
  >();

  for (const candidate of candidates) {
    const dedupeKey = `${candidate.documentId}:${candidate.chunkId}`;
    if (seenChunks.has(dedupeKey)) continue;
    seenChunks.add(dedupeKey);

    let document = grouped.get(candidate.documentId);
    if (!document) {
      document = {
        title: candidate.title,
        resourceName: candidate.resourceName,
        summary: candidate.summary,
        chunks: [],
      };
      const root = rootsByDocument.get(candidate.documentId);
      if (root) {
        document.chunks.push({
          path: root.path,
          description: root.description,
        });
      }
      grouped.set(candidate.documentId, document);
    }

    if (!document.chunks.some((chunk) => chunk.path === candidate.path)) {
      document.chunks.push({
        path: candidate.path,
        description: candidate.description,
      });
    }
  }

  const resources: ListResourceItem[] = [...grouped.values()].map((doc) => ({
    path: `${doc.resourceName}.pdf`,
    description: doc.summary?.trim() || doc.title,
    chunks: doc.chunks,
  }));
  const chunks = resources.flatMap((resource) => resource.chunks);
  const payload = { resources, total: resources.length };
  return {
    raw: { source: 'db-vector', ...payload },
    texts: [JSON.stringify(payload)],
    resourceLinks: [],
    embeddedResources: [],
    filteredResources: [],
    resources,
    chunks,
    total: resources.length,
  };
}

@Injectable()
export class RetrievalService {
  private static readonly KNOWN_EXTENSIONS = new Set([
    'md',
    'pdf',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
  ]);

  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly retrievalRepo: RetrievalRepository,
    private readonly configService: ConfigService,
    @Inject(EMBEDDING_CLIENT)
    private readonly embeddingClient: EmbeddingClient,
  ) {}

  /**
   * Build the catalog shape previously provided by MCP list_resources (new format).
   */
  async listCatalog(): Promise<ListResourcesResult> {
    const docs = await this.retrievalRepo.listReadyWithChunks();
    const resources: ListResourceItem[] = docs.map((doc) => ({
      path: `${doc.resourceName}.pdf`,
      description: doc.summary?.trim() || doc.title,
      chunks: doc.chunks.map((c) => ({
        path: c.path,
        description: c.description,
      })),
    }));

    const chunks = resources.flatMap((r) =>
      r.chunks.map((c) => ({
        path: c.path,
        description: c.description,
      })),
    );

    const payload = { resources, total: resources.length };
    this.logger.debug(
      `listCatalog: ${resources.length} document(s), ${chunks.length} chunk(s)`,
    );

    return {
      raw: { source: 'db', ...payload },
      texts: [JSON.stringify(payload)],
      resourceLinks: [],
      embeddedResources: [],
      filteredResources: [],
      resources,
      chunks,
      total: resources.length,
    };
  }

  /**
   * Load chunk markdown bodies for selected paths (1 query).
   */
  async getContentsByPaths(paths: string[]): Promise<ChunkContentHit[]> {
    const normalized = paths
      .map((p) => this.stripKnownExtension(p))
      .filter((p) => p.length > 0);
    if (normalized.length === 0) return [];

    const rows = await this.retrievalRepo.findChunkContentsByPaths(normalized);
    const byPath = new Map(rows.map((r) => [r.path, r.content]));

    const hits: ChunkContentHit[] = [];
    for (const path of normalized) {
      const content = byPath.get(path);
      if (content == null) {
        this.logger.warn(`Chunk content not found for path=${path}`);
        continue;
      }
      hits.push({ path, content });
    }
    return hits;
  }

  async getVectorCatalog(question: string): Promise<VectorCatalogResult> {
    const enabled = this.configService.get<boolean | string>(
      'RAG_VECTOR_SEARCH_ENABLED',
      false,
    );
    if (!(enabled === true || enabled === 'true')) {
      return { available: false, reason: 'vector search is disabled' };
    }
    if (!question.trim()) {
      return { available: false, reason: 'question is empty' };
    }

    try {
      if (
        await this.retrievalRepo.hasIncompleteReadyEmbeddings(
          this.embeddingClient.model,
        )
      ) {
        return {
          available: false,
          reason: 'ready document embedding backfill is incomplete',
        };
      }

      const [questionEmbedding] = await this.embeddingClient.embedTexts([
        question,
      ]);
      if (!questionEmbedding) {
        return {
          available: false,
          reason: 'embedding endpoint returned no question vector',
        };
      }
      const configuredLimit = Number(
        this.configService.get<string | number>(
          'RAG_VECTOR_CANDIDATE_LIMIT',
          DEFAULT_VECTOR_CANDIDATE_LIMIT,
        ),
      );
      const limit =
        Number.isInteger(configuredLimit) && configuredLimit > 0
          ? configuredLimit
          : DEFAULT_VECTOR_CANDIDATE_LIMIT;
      const candidates = await this.retrievalRepo.findSimilarChunks(
        questionEmbedding,
        limit,
        this.embeddingClient.model,
      );
      const roots = await this.retrievalRepo.findRootChunksForDocuments(
        candidates.map((candidate) => candidate.documentId),
      );
      const catalog = buildVectorCandidateCatalog(candidates, roots);
      this.logger.debug(
        `getVectorCatalog: ${candidates.length} candidate chunk(s), ${catalog.resources?.length ?? 0} document(s)`,
      );
      return { available: true, catalog };
    } catch (error) {
      return {
        available: false,
        reason: `vector retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private stripKnownExtension(path: string): string {
    if (!path.includes('.')) return path;
    const lastDot = path.lastIndexOf('.');
    const extension = path.substring(lastDot + 1).toLowerCase();
    if (RetrievalService.KNOWN_EXTENSIONS.has(extension)) {
      return path.substring(0, lastDot);
    }
    return path;
  }
}
