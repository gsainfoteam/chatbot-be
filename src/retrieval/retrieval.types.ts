/**
 * Document catalog shapes used by chat selection (formerly MCP list_resources).
 */

export type ListResourceItem = {
  path: string;
  description: string;
  chunks: Array<{ path: string; description: string }>;
};

export type ListResourcesResult = {
  raw: unknown;
  texts: string[];
  resourceLinks: unknown[];
  embeddedResources: unknown[];
  /** Legacy flat list (unused when catalog comes from DB) */
  filteredResources: Array<{ path: string; formats: string[] }>;
  resources?: ListResourceItem[];
  chunks?: Array<{ path: string; description: string }>;
  total?: number;
};

export type ChunkContentHit = {
  path: string;
  content: string;
};

export type VectorChunkCandidate = {
  chunkId: string;
  documentId: string;
  title: string;
  resourceName: string;
  summary: string | null;
  path: string;
  description: string;
  sortOrder: number;
  distance: number;
};

export type VectorRootChunk = Omit<VectorChunkCandidate, 'distance'>;

export type VectorCatalogResult =
  | { available: true; catalog: ListResourcesResult }
  | { available: false; reason: string };
