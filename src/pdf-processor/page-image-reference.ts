const NO_TEXT_LAYER_CHARS = 10;

// Bounded because page text full of unclosed `![](` made the unbounded form
// backtrack for 85s on 20KB, with the event loop stalled.
const IMAGE_REFERENCE = /!\[(.{0,300}?)\]\(([^()]{0,200})\)/gs;

/** Where a page with a stored image starts, so only that page speaks for the image. */
export const PAGE_START = '<!-- page -->';

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

/** Brackets in the description would end the syntax early for readers. */
function reference(description: string, pageNumber: number): string {
  const label = description.replace(/[[\]]/g, '');
  return `![${label}](${referenceTarget(pageNumber)})`;
}

/**
 * Keeps references to this page's stored image, in the one form readers parse. Any
 * other reference would point nowhere, so only its description stays.
 * @param pageNumber null for a page without a stored image
 */
export function normalizeImageReferences(
  markdown: string,
  pageNumber: number | null,
): string {
  return markdown.replace(
    IMAGE_REFERENCE,
    (_match, description: string, target: string) =>
      pageNumber !== null && target.trim() === referenceTarget(pageNumber)
        ? reference(description, pageNumber)
        : description,
  );
}

export function hasPageImageReference(
  markdown: string,
  pageNumber: number,
): boolean {
  return markdown.includes(`(${referenceTarget(pageNumber)})`);
}

export function appendPageImageReference(
  markdown: string,
  filename: string,
  pageNumber: number,
): string {
  const name = filename.replace(/\.pdf$/i, '');
  return `${markdown}\n\n${reference(`${name} ${pageNumber}쪽`, pageNumber)}`;
}
