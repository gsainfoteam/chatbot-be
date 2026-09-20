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
  resources?: ListResourceItem[];
  chunks?: Array<{ path: string; description: string }>;
  total?: number;
};

export type ChunkContentHit = {
  path: string;
  content: string;
};
