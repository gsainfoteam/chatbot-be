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
 * Parse <summary> and <document> tags from chunked markdown.
 * Ported from worker.py `_parse_chunks_from_markdown`.
 */
export function parseChunksFromMarkdown(
  markdown: string,
  resourceName: string,
): ChunkParseResult {
  const baseName =
    resourceName.includes('.') && resourceName.toLowerCase().endsWith('.pdf')
      ? resourceName.slice(0, -4)
      : resourceName.includes('.')
        ? resourceName.replace(/\.[^.]+$/, '')
        : resourceName;

  const summaryMatch = markdown.match(/<summary>(.+?)<\/summary>/s);
  const summary = summaryMatch?.[1]?.trim() ?? '';

  const chunkPattern =
    /<document\s+path="([^"]+)"\s+description="([^"]+)">(.+?)<\/document>/gs;
  const chunks: ParsedChunk[] = [];
  for (const match of markdown.matchAll(chunkPattern)) {
    chunks.push({
      path: match[1],
      description: match[2],
      content: match[3].trim(),
    });
  }

  if (chunks.length === 0) {
    return {
      documents: { [`${baseName}.md`]: markdown },
      metadata: { description: summary, chunks: [] },
    };
  }

  const documents: Record<string, string> = {};
  const mainDocParts: string[] = [];
  const chunkMetadata: { path: string; description: string }[] = [];

  for (const chunk of chunks) {
    documents[`${baseName}/${chunk.path}.md`] = chunk.content;
    mainDocParts.push(
      `<document path="${baseName}/${chunk.path}" description="${chunk.description}"></document>`,
    );
    chunkMetadata.push({
      path: `${baseName}/${chunk.path}`,
      description: chunk.description,
    });
  }

  documents[`${baseName}.md`] = mainDocParts.join('\n\n');

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
