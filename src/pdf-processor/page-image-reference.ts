const NO_TEXT_LAYER_CHARS = 10;

const IMAGE_REFERENCE = /!\[([^\]]*)\]\(([^)]*)\)/g;

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

export function appendPageImageReference(
  markdown: string,
  filename: string,
  pageNumber: number,
): string {
  const name = filename.replace(/\.pdf$/i, '').replace(/[[\]]/g, '');
  return `${markdown}\n\n![${name} ${pageNumber}쪽](${referenceTarget(pageNumber)})`;
}
