type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfOps = PdfjsModule['OPS'];
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfOperatorList = Awaited<ReturnType<PdfPage['getOperatorList']>>;

type PageCanvas = {
  canvas: { encode(format: 'jpeg', quality: number): Promise<Buffer> };
};

export type PageCanvasFactory = {
  create(width: number, height: number): PageCanvas;
  destroy(canvasAndContext: PageCanvas): void;
};

const SPARSE_TEXT_CHARS = 100;
const BROKEN_TEXT_RATIO = 0.05;
const MIN_IMAGE_COVERAGE = 0.03;
const MIN_PAINTED_PATHS = 20;
const BROKEN_CHARS = /[-�]/g;

const RENDER_SCALE = 2;
const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 80;

function scanOperators(list: PdfOperatorList, ops: PdfOps) {
  const stack: number[][] = [];
  let matrix = [1, 0, 0, 1];
  const scan = {
    imageArea: 0,
    hasImage: false,
    hasUnmeasuredImage: false,
    paintedPaths: 0,
    hasShading: false,
    hasText: false,
  };

  const applyTransform = (t: number[]) => {
    const [a, b, c, d] = matrix;
    matrix = [
      a * t[0] + c * t[1],
      b * t[0] + d * t[1],
      a * t[2] + c * t[3],
      b * t[2] + d * t[3],
    ];
  };

  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i];
    switch (fn) {
      case ops.save:
        stack.push(matrix);
        break;
      case ops.restore:
      case ops.paintFormXObjectEnd:
        matrix = stack.pop() ?? matrix;
        break;
      case ops.transform:
        applyTransform(args);
        break;
      case ops.paintFormXObjectBegin:
        stack.push(matrix);
        if (args[0]) applyTransform(args[0]);
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
        scan.hasImage = true;
        scan.imageArea += Math.abs(
          matrix[0] * matrix[3] - matrix[1] * matrix[2],
        );
        break;
      // The optimizer folds per-image transforms into these ops.
      case ops.paintImageXObjectRepeat:
      case ops.paintInlineImageXObjectGroup:
      case ops.paintImageMaskXObjectGroup:
      case ops.paintImageMaskXObjectRepeat:
        scan.hasImage = true;
        scan.hasUnmeasuredImage = true;
        break;
      case ops.constructPath:
        if (args[0] !== ops.endPath) scan.paintedPaths += 1;
        break;
      case ops.shadingFill:
        scan.hasShading = true;
        break;
      case ops.showText:
      case ops.showSpacedText:
      case ops.nextLineShowText:
      case ops.nextLineSetSpacingShowText:
        scan.hasText = true;
        break;
    }
  });

  return scan;
}

/**
 * Decide whether the text layer alone would lose page content.
 * A missed page silently loses content while an extra one only costs an LLM call,
 * so doubtful pages are sent.
 */
export function needsPageImage(
  text: string,
  operatorList: PdfOperatorList,
  ops: PdfOps,
  pageArea: number,
): boolean {
  const scan = scanOperators(operatorList, ops);
  const hasGraphics = scan.hasImage || scan.paintedPaths > 0 || scan.hasShading;
  if (!hasGraphics && !scan.hasText) return false;

  const chars = text.replace(/\s+/g, '');
  if (!chars) return true;

  const brokenChars = chars.match(BROKEN_CHARS)?.length ?? 0;
  if (brokenChars / chars.length >= BROKEN_TEXT_RATIO) return true;

  if (scan.hasUnmeasuredImage) return true;
  if (scan.imageArea / pageArea >= MIN_IMAGE_COVERAGE) return true;
  if (scan.paintedPaths >= MIN_PAINTED_PATHS || scan.hasShading) return true;

  return hasGraphics && chars.length < SPARSE_TEXT_CHARS;
}

/**
 * pdf.js keeps the paint op of an image it cannot decode and resolves the image
 * to null, so such a page would otherwise render blank and look like a success.
 */
export async function allImagesFailedToDecode(
  page: PdfPage,
  operatorList: PdfOperatorList,
  ops: PdfOps,
): Promise<boolean> {
  const imageIds: string[] = [];
  operatorList.fnArray.forEach((fn, i) => {
    if (fn === ops.paintImageXObject || fn === ops.paintImageXObjectRepeat) {
      imageIds.push(operatorList.argsArray[i][0]);
    }
  });
  if (imageIds.length === 0) return false;

  const images = await Promise.all(
    imageIds.map(
      (id) =>
        new Promise((resolve) => {
          const store = id.startsWith('g_') ? page.commonObjs : page.objs;
          store.get(id, resolve);
        }),
    ),
  );
  return images.every((image) => image === null);
}

/**
 * Render a page to a JPEG data URL.
 */
export async function renderPageImage(
  page: PdfPage,
  canvasFactory: PageCanvasFactory,
): Promise<string> {
  const { width, height } = page.getViewport({ scale: 1 });
  const scale = Math.min(
    RENDER_SCALE,
    MAX_IMAGE_EDGE / Math.max(width, height),
  );
  const viewport = page.getViewport({ scale });
  const entry = canvasFactory.create(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );

  try {
    const task = page.render({ canvas: entry.canvas as never, viewport });
    // Without this, pdf.js paints in a microtask loop and starves HTTP traffic.
    task.onContinue = (resume: () => void) => {
      setImmediate(resume);
    };
    await task.promise;
    const jpeg = await entry.canvas.encode('jpeg', JPEG_QUALITY);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } finally {
    canvasFactory.destroy(entry);
  }
}
