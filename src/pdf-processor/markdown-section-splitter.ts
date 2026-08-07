export type MarkdownSection = {
  index: number;
  title: string;
  content: string;
};

export const CHUNK_MIN_CHARS = 4_000;
export const CHUNK_TARGET_CHARS = 8_000;
export const CHUNK_MAX_CHARS = 12_000;

type HeadingBlock = {
  level: number;
  title: string;
  body: string;
  /** Full markdown including the heading line (if any). */
  content: string;
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Split markdown into retrieval-sized sections.
 *
 * Policy:
 * - `#` is contextual only (not a split boundary)
 * - `##` is the preferred split candidate
 * - `###` stays inside its parent `##` unless that section exceeds CHUNK_MAX_CHARS
 * - merge small adjacent `##` until ~CHUNK_TARGET_CHARS / at least CHUNK_MIN_CHARS when possible
 * - oversized sections split by `###`, then by blank-line paragraphs
 * - child splits keep parent heading context
 */
export function splitMarkdownIntoSections(markdown: string): MarkdownSection[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  const h2Blocks = collectLevelBlocks(trimmed, 2);
  if (h2Blocks.length === 0) {
    return indexSections(
      splitByLength(trimmed, '', CHUNK_MAX_CHARS).map((content, i) => ({
        title: `section-${i + 1}`,
        content,
      })),
    );
  }

  const expanded: Array<{ title: string; content: string }> = [];
  for (const block of h2Blocks) {
    if (block.content.length <= CHUNK_MAX_CHARS) {
      expanded.push({ title: block.title, content: block.content });
      continue;
    }

    const h3Parts = splitOversizedByH3(block);
    for (const part of h3Parts) {
      if (part.content.length <= CHUNK_MAX_CHARS) {
        expanded.push(part);
      } else {
        expanded.push(
          ...splitByLength(part.content, part.title, CHUNK_MAX_CHARS).map(
            (content) => ({
              title: part.title,
              content,
            }),
          ),
        );
      }
    }
  }

  return indexSections(mergeSmallSections(expanded));
}

function collectLevelBlocks(markdown: string, level: number): HeadingBlock[] {
  const lines = markdown.split('\n');
  const blocks: HeadingBlock[] = [];
  let preamble: string[] = [];
  let current: { level: number; title: string; lines: string[] } | null = null;

  const flushCurrent = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    if (!content) {
      current = null;
      return;
    }
    const bodyLines = current.lines.slice(1);
    blocks.push({
      level: current.level,
      title: current.title,
      body: bodyLines.join('\n').trim(),
      content,
    });
    current = null;
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    const headingLevel = match ? match[1].length : 0;
    if (match && headingLevel === level) {
      flushCurrent();
      if (preamble.length > 0) {
        const preambleText = preamble.join('\n').trim();
        if (preambleText) {
          blocks.push({
            level: 0,
            title: extractTitle(preambleText) || '서론',
            body: preambleText,
            content: preambleText,
          });
        }
        preamble = [];
      }
      current = {
        level: headingLevel,
        title: match[2].trim(),
        lines: [line],
      };
      continue;
    }

    // Treat `#` as contextual prose; never start a new top-level block for it.
    if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  flushCurrent();
  if (preamble.length > 0) {
    const preambleText = preamble.join('\n').trim();
    if (preambleText) {
      blocks.push({
        level: 0,
        title: extractTitle(preambleText) || '서론',
        body: preambleText,
        content: preambleText,
      });
    }
  }

  return blocks;
}

function splitOversizedByH3(
  h2Block: HeadingBlock,
): Array<{ title: string; content: string }> {
  const lines = h2Block.content.split('\n');
  const parentHeading = lines[0]?.match(HEADING_RE)
    ? lines[0]
    : `## ${h2Block.title}`;
  const rest = lines[0]?.match(HEADING_RE) ? lines.slice(1) : lines;

  const h3Blocks = collectLevelBlocks(rest.join('\n'), 3);
  if (h3Blocks.length <= 1) {
    return [{ title: h2Block.title, content: h2Block.content }];
  }

  return h3Blocks.map((block) => {
    const title = `${h2Block.title} / ${block.title}`;
    const content = [parentHeading, block.content].join('\n\n').trim();
    return { title, content };
  });
}

function mergeSmallSections(
  sections: Array<{ title: string; content: string }>,
): Array<{ title: string; content: string }> {
  if (sections.length === 0) return [];

  const merged: Array<{ title: string; content: string }> = [];
  let current = { ...sections[0] };

  for (let i = 1; i < sections.length; i += 1) {
    const next = sections[i];
    const combinedLength = current.content.length + 2 + next.content.length;

    // Keep merging while under target, and prefer not leaving tiny leftovers.
    const shouldMerge =
      current.content.length < CHUNK_MIN_CHARS ||
      (combinedLength <= CHUNK_TARGET_CHARS &&
        current.content.length < CHUNK_TARGET_CHARS);

    if (shouldMerge && combinedLength <= CHUNK_MAX_CHARS) {
      current = {
        title: `${current.title} · ${next.title}`,
        content: `${current.content}\n\n${next.content}`,
      };
      continue;
    }

    merged.push(current);
    current = { ...next };
  }
  merged.push(current);
  return merged;
}

function splitByLength(
  content: string,
  title: string,
  maxChars: number,
): string[] {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const contextPrefix =
    title && !HEADING_RE.test(trimmed.split('\n')[0] ?? '')
      ? `## ${title}\n\n`
      : '';
  // Continuations may prepend a heading, so leave room for that prefix.
  const bodyMax = Math.max(1_000, maxChars - contextPrefix.length);

  const paragraphs = trimmed.split(/\n{2,}/);
  const parts: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const value = current.trim();
    if (value) parts.push(value);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= bodyMax) {
      current = candidate;
      continue;
    }

    if (current) pushCurrent();

    if (paragraph.length <= bodyMax) {
      current = paragraph;
      continue;
    }

    // Hard split only as last resort (very long paragraph / table-less blob).
    for (let i = 0; i < paragraph.length; i += bodyMax) {
      parts.push(paragraph.slice(i, i + bodyMax).trim());
    }
    current = '';
  }
  pushCurrent();

  if (!contextPrefix) return parts.filter(Boolean);
  return parts.map((part, idx) => {
    if (idx === 0 || HEADING_RE.test(part.split('\n')[0] ?? '')) return part;
    return `${contextPrefix}${part}`;
  });
}

function extractTitle(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const match = line.match(HEADING_RE);
    if (match) return match[2].trim();
  }
  return '';
}

function indexSections(
  sections: Array<{ title: string; content: string }>,
): MarkdownSection[] {
  return sections
    .filter((section) => section.content.trim().length > 0)
    .map((section, index) => ({
      index,
      title: section.title || `section-${index + 1}`,
      content: section.content.trim(),
    }));
}
