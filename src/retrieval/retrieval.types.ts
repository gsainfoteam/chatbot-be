/**
 * Document catalog shapes used by chat selection (formerly MCP list_resources).
 */

export type ListResourceItem = {
  path: string;
  description: string;
  /** text 문서는 원본 PDF가 없어 FE 참조 목록에서 제외한다. */
  sourceType?: 'pdf' | 'text';
  chunks: Array<{ path: string; description: string }>;
};

export type ListResourcesResult = {
  raw: unknown;
  texts: string[];
  resourceLinks: unknown[];
  embeddedResources: unknown[];
  resources?: ListResourceItem[];
  chunks?: Array<{ path: string; description: string }>;
  total?: number;
};

export type ChunkContentHit = {
  path: string;
  content: string;
};
