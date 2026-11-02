import { figureRegion, storedCrop, type Box } from './page-image-crop';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfOps = PdfjsModule['OPS'];
export type PdfDocument = Awaited<
  ReturnType<PdfjsModule['getDocument']>['promise']
>;
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfOperatorList = Awaited<ReturnType<PdfPage['getOperatorList']>>;
export type PdfTextContent = Awaited<ReturnType<PdfPage['getTextContent']>>;
type PdfTextItem = Extract<PdfTextContent['items'][number], { str: string }>;
type Point = [number, number];

type PageCanvas = {
  canvas: {
    width: number;
    height: number;
    encode(format: 'jpeg', quality: number): Promise<Buffer>;
  };
  context: {
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
    drawImage(
      source: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
    getImageData(
      x: number,
      y: number,
      width: number,
      height: number,
    ): { data: Uint8ClampedArray };
  };
};

export type PageCanvasFactory = {
  create(width: number, height: number): PageCanvas;
  destroy(canvasAndContext: PageCanvas): void;
};

/**
 * pdf.js drops larger images with a warning instead of decoding them. A single
 * 25MP image already costs about 270MB and freezes the event loop for 5s, which
 * a pod shared with chat traffic cannot afford.
 */
export const MAX_IMAGE_PIXELS = 20_000_000;

const SPARSE_TEXT_CHARS = 100;
const BROKEN_TEXT_RATIO = 0.05;
const MIN_IMAGE_COVERAGE = 0.03;
const MIN_PAINTED_PATHS = 20;
const BROKEN_CHARS = /[\uE000-\uF8FF\uFFFD]/g;

const RENDER_SCALE = 2;
const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 80;
/**
 * Of the crop width: every image is shown at the same width, so this looks the
 * same on all of them. Content touching the edge of a picture looks cut off.
 */
const CROP_MARGIN = 0.04;

const UNIT_SQUARE: Point[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

function applyMatrix([a, b, c, d, e, f]: number[], [x, y]: Point): Point {
  return [a * x + c * y + e, b * x + d * y + f];
}

function scanOperators(list: PdfOperatorList, ops: PdfOps) {
  const stack: number[][] = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  const scan = {
    imageArea: 0,
    images: [] as Point[][],
    hasImage: false,
    hasUnmeasuredImage: false,
    paintedPaths: 0,
    hasShading: false,
    hasText: false,
  };

  const applyTransform = (t: number[]) => {
    const [a, b, c, d, e, f] = matrix;
    matrix = [
      a * t[0] + c * t[1],
      b * t[0] + d * t[1],
      a * t[2] + c * t[3],
      b * t[2] + d * t[3],
      a * t[4] + c * t[5] + e,
      b * t[4] + d * t[5] + f,
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
        scan.images.push(
          UNIT_SQUARE.map((corner) => applyMatrix(matrix, corner)),
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

/** Covers, thank-you slides and the like: too little text to lose if dropped. */
export function isSparseText(text: string): boolean {
  return text.replace(/\s+/g, '').length < SPARSE_TEXT_CHARS;
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

  return hasGraphics && isSparseText(text);
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
  // A vector chart still renders without a broken logo.
  const { paintedPaths, hasShading } = scanOperators(operatorList, ops);
  if (paintedPaths >= MIN_PAINTED_PATHS || hasShading) return false;

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

function renderViewport(page: PdfPage) {
  const { width, height } = page.getViewport({ scale: 1 });
  const scale = Math.min(
    RENDER_SCALE,
    MAX_IMAGE_EDGE / Math.max(width, height),
  );
  return page.getViewport({ scale });
}

function boundsOf(points: Point[]): Box {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function textCorners({ transform, width, height }: PdfTextItem): Point[] {
  const [a, b, , , x, y] = transform as number[];
  const scale = Math.hypot(a, b) || 1;
  const along: Point = [(a / scale) * width, (b / scale) * width];
  const up: Point = [(-b / scale) * height, (a / scale) * height];
  return [
    [x, y],
    [x + along[0], y + along[1]],
    [x + up[0], y + up[1]],
    [x + along[0] + up[0], y + along[1] + up[1]],
  ];
}

/**
 * Where the pictures of a page land on its rendered canvas, or null to keep all
 * of its content together.
 */
export function pageFigureRegion(
  page: PdfPage,
  text: string,
  textContent: PdfTextContent,
  operatorList: PdfOperatorList,
  ops: PdfOps,
): Box | null {
  // Nothing but its image may back a page with hardly any text.
  if (isSparseText(text)) return null;
  const { images, hasUnmeasuredImage } = scanOperators(operatorList, ops);
  if (hasUnmeasuredImage) return null;

  const viewport = renderViewport(page);
  const onCanvas = (points: Point[]) =>
    boundsOf(points.map((point) => applyMatrix(viewport.transform, point)));
  return figureRegion(
    images.map(onCanvas),
    textContent.items.flatMap((item) =>
      'str' in item && item.str.trim() ? [onCanvas(textCorners(item))] : [],
    ),
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
}

async function encodeCrop(
  source: PageCanvas,
  canvasFactory: PageCanvasFactory,
  [left, top, right, bottom]: Box,
): Promise<Buffer> {
  const width = right - left;
  const height = bottom - top;
  const margin = Math.round(width * CROP_MARGIN);
  const target = canvasFactory.create(width + 2 * margin, height + 2 * margin);
  try {
    target.context.fillStyle = '#ffffff';
    target.context.fillRect(0, 0, width + 2 * margin, height + 2 * margin);
    target.context.drawImage(
      source.canvas,
      left,
      top,
      width,
      height,
      margin,
      margin,
      width,
      height,
    );
    return await target.canvas.encode('jpeg', JPEG_QUALITY);
  } finally {
    canvasFactory.destroy(target);
  }
}

/**
 * Render a page: the LLM reads all of it as a JPEG data URL, while readers get
 * only `storedImage`, cropped to what they came to see.
 */
export async function renderPageImage(
  page: PdfPage,
  canvasFactory: PageCanvasFactory,
  figures: Box | null,
): Promise<{ image: string; storedImage: Buffer }> {
  const viewport = renderViewport(page);
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
    const { width, height } = entry.canvas;
    const crop = storedCrop(
      entry.context.getImageData(0, 0, width, height).data,
      width,
      height,
      figures,
    );
    return {
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      storedImage: crop ? await encodeCrop(entry, canvasFactory, crop) : jpeg,
    };
  } finally {
    canvasFactory.destroy(entry);
  }
}
