/**
 * Below this, two readings of one page differ too much to trust: a model that
 * cannot read the text makes it up, differently each time. Measured on long
 * readings: 0.39-0.41 for gpt-4o-mini making up a map legend and a screenshot,
 * 0.72-0.93 for gemini-3.5-flash reading them.
 */
export const MIN_READING_AGREEMENT = 0.5;
/** A description of a line or two is reworded every time (0.14-0.30) and holds few facts. */
const MIN_COMPARED_CHARS = 200;
const NO_TEXT_LAYER_CHARS = 10;

const IMAGE_REFERENCE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const NOT_CONTENT = /!\[[^\]]*\]\([^)]*\)|<[^>]+>|[#*|\-_:`\s.,()[\]]+/g;

export function pageImageObjectPath(
  resourceName: string,
  pageNumber: number,
): string {
  return `${resourceName}/images/page-${pageNumber}.jpg`;
}

/** A page number alone does not count as text. */
export function hasNoTextLayer(pageText: string): boolean {
  return pageText.replace(/\s+/g, '').length < NO_TEXT_LAYER_CHARS;
}

function referenceTarget(pageNumber: number): string {
  return `IMAGE:page-${pageNumber}`;
}

/**
 * Keeps the one reference that points at this page's stored image. Any other
 * reference would point nowhere, so only its description stays.
 * @param pageNumber null for a page without a stored image
 */
export function normalizeImageReferences(
  markdown: string,
  pageNumber: number | null,
): string {
  let kept = false;
  return markdown.replace(
    IMAGE_REFERENCE,
    (reference, description: string, target: string) => {
      if (
        pageNumber !== null &&
        !kept &&
        target.trim() === referenceTarget(pageNumber)
      ) {
        kept = true;
        return reference;
      }
      return description;
    },
  );
}

export function hasPageImageReference(
  markdown: string,
  pageNumber: number,
): boolean {
  return markdown.includes(`(${referenceTarget(pageNumber)})`);
}

/** The reference alone, for a page whose text cannot be trusted. */
export function pageImageReferenceOnly(
  markdown: string,
  pageNumber: number,
): string {
  for (const match of markdown.matchAll(IMAGE_REFERENCE)) {
    if (match[2].trim() === referenceTarget(pageNumber)) return match[0];
  }
  return '';
}

export function appendPageImageReference(
  markdown: string,
  filename: string,
  pageNumber: number,
): string {
  const name = filename.replace(/\.pdf$/i, '').replace(/[[\]]/g, '');
  const reference = `![${name} ${pageNumber}쪽](${referenceTarget(pageNumber)})`;
  return markdown.trim() ? `${markdown}\n\n${reference}` : reference;
}

function bigrams(text: string): Set<string> {
  const content = text.replace(NOT_CONTENT, '').toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i < content.length - 1; i += 1) {
    grams.add(content.slice(i, i + 2));
  }
  return grams;
}

export function readingsDisagree(first: string, second: string): boolean {
  const longest = Math.max(
    first.replace(NOT_CONTENT, '').length,
    second.replace(NOT_CONTENT, '').length,
  );
  return (
    longest >= MIN_COMPARED_CHARS &&
    readingAgreement(first, second) < MIN_READING_AGREEMENT
  );
}

/** Jaccard similarity of character bigrams, ignoring markdown formatting. */
export function readingAgreement(first: string, second: string): number {
  const a = bigrams(first);
  const b = bigrams(second);
  if (a.size === 0 && b.size === 0) return 1;

  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}
