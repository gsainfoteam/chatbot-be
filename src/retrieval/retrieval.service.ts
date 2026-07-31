import { Injectable, Logger } from '@nestjs/common';
import { RetrievalRepository } from './retrieval.repository';
import type {
  ChunkContentHit,
  ListResourceItem,
  ListResourcesResult,
} from './retrieval.types';

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(private readonly retrievalRepo: RetrievalRepository) {}

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

  private stripKnownExtension(path: string): string {
    if (!path.includes('.')) return path;
    const lastDot = path.lastIndexOf('.');
    const extension = path.substring(lastDot + 1);
    if (extension.length <= 5 && /^[a-z0-9]+$/i.test(extension)) {
      return path.substring(0, lastDot);
    }
    return path;
  }
}
