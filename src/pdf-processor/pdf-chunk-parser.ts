export type ParsedChunk = {
  path: string;
  description: string;
  content: string;
};

export type ChunkParseResult = {
  /** GCS object path → markdown content */
  documents: Record<string, string>;
  metadata: {
    description: string;
    chunks: { path: string; description: string }[];
  };
};

/**
 * Strip leading baseName prefixes so LLM-relative and LLM-absolute paths
 * both normalize to the same relative segment.
 */
export function toRelativeChunkPath(raw: string, baseName: string): string {
  let p = raw.trim().replace(/^\/+|\/+$/g, '');
  const prefix = `${baseName}/`;
  while (p === baseName || p.startsWith(prefix)) {
    p = p === baseName ? '' : p.slice(prefix.length);
  }
  return p;
}

/**
 * Normalize an untrusted relative chunk path.
 * Dot segments are removed, while parent traversal is rejected rather than
 * resolved so an LLM path can never reference outside the document prefix.
 */
export function normalizeRelativeChunkPath(raw: string): string {
  const segments = raw.replace(/\\/g, '/').split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === '.') continue;
    if (trimmed === '..') return '';
    normalized.push(trimmed);
  }

  return normalized.join('/');
}

function resourceStem(resourceName: string): string {
  if (
    resourceName.includes('.') &&
    resourceName.toLowerCase().endsWith('.pdf')
  ) {
    return resourceName.slice(0, -4);
  }
  if (resourceName.includes('.')) {
    return resourceName.replace(/\.[^.]+$/, '');
  }
  return resourceName;
}

function extractOverviewMarkdown(markdown: string): string {
  return markdown
    .replace(/<summary>(.+?)<\/summary>/gs, '')
    .replace(
      /<document\s+path="[^"]+"\s+description="[^"]+">.*?<\/document>/gs,
      '',
    )
    .trim();
}

/**
 * Parse <summary> and <document> tags from chunked markdown.
 * Ported from worker.py `_parse_chunks_from_markdown`, with path
 * de-duplication and overview body preserved as a root chunk.
 */
export function parseChunksFromMarkdown(
  markdown: string,
  resourceName: string,
): ChunkParseResult {
  const baseName = resourceStem(resourceName);

  const summaryMatch = markdown.match(/<summary>(.+?)<\/summary>/s);
  const summary = summaryMatch?.[1]?.trim() ?? '';

  const chunkPattern =
    /<document\s+path="([^"]+)"\s+description="([^"]+)">(.+?)<\/document>/gs;
  const chunks: ParsedChunk[] = [];
  for (const match of markdown.matchAll(chunkPattern)) {
    const relative = normalizeRelativeChunkPath(
      toRelativeChunkPath(match[1], baseName),
    );
    if (!relative) continue;
    chunks.push({
      path: relative,
      description: match[2],
      content: match[3].trim(),
    });
  }

  if (chunks.length === 0) {
    const overviewOnly = extractOverviewMarkdown(markdown);
    const body =
      overviewOnly ||
      markdown.replace(/<summary>(.+?)<\/summary>/gs, '').trim();
    return {
      documents: { [`${baseName}.md`]: body || markdown },
      metadata: { description: summary, chunks: [] },
    };
  }

  const documents: Record<string, string> = {};
  const stubLinks: string[] = [];
  const chunkMetadata: { path: string; description: string }[] = [];

  for (const chunk of chunks) {
    const fullPath = `${baseName}/${chunk.path}`;
    documents[`${fullPath}.md`] = chunk.content;
    stubLinks.push(
      `<document path="${fullPath}" description="${chunk.description}"></document>`,
    );
    chunkMetadata.push({
      path: fullPath,
      description: chunk.description,
    });
  }

  const overview = extractOverviewMarkdown(markdown);
  if (overview) {
    const rootContent = [overview, '', ...stubLinks].join('\n').trim();
    documents[`${baseName}.md`] = rootContent;
    chunkMetadata.unshift({
      path: baseName,
      description: summary || '문서 개요',
    });
  } else {
    documents[`${baseName}.md`] = stubLinks.join('\n\n');
  }

  return {
    documents,
    metadata: { description: summary, chunks: chunkMetadata },
  };
}

/**
 * Normalize a filename to NFC resource_name (stem without .pdf).
 */
export function toResourceName(filename: string): string {
  const nfc = filename.normalize('NFC');
  const base = nfc.replace(/\\/g, '/').split('/').pop() ?? nfc;
  return base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base;
}
