/** [left, top, right, bottom] in canvas pixels. */
export type Box = readonly [number, number, number, number];

/** A page this wide was composed as one screen, so its text and pictures stay together. */
const SLIDE_RATIO = 1.1;
/** A scan or a background rather than a figure. */
const BACKGROUND_SHARE = 0.9;
/** A page needs an image this large before its pictures are shown on their own. */
const MAIN_FIGURE_SHARE = 0.1;
/** Smaller images are logos and bullets. */
const MIN_FIGURE_SHARE = 0.01;

/** Lighter than this on every channel counts as blank paper. */
const BLANK_ABOVE = 215;
/** Rows and columns with fewer drawn pixels than this share are specks. */
const SPECK_SHARE = 0.002;
/** Keeps the faint antialiased edge of what is drawn. */
const PADDING = 4;

// A line in the outer EDGE_ZONE, shorter than EDGE_LINE and at least EDGE_GAP away
// from the rest is a page number or running title: it would keep the blank paper
// between it and the body. All three are shares of the height.
const EDGE_ZONE = 0.12;
const EDGE_LINE = 0.035;
const EDGE_GAP = 0.05;

/** Figures covering this share of the page content leave nothing worth losing it for. */
const NO_BENEFIT_SHARE = 0.75;
/** A crop keeping this share of the canvas is not worth encoding again. */
const WORTH_CROPPING_SHARE = 0.9;

function area([left, top, right, bottom]: Box): number {
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function union(a: Box, b: Box): Box {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** An edge through a line of text looks like a mistake, so a line it touches goes in whole. */
function withWholeTextLines(region: Box, textBoxes: Box[]): Box {
  let box = region;
  const outside = [...textBoxes];
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = outside.length - 1; i >= 0; i -= 1) {
      const text = outside[i];
      // A line often arrives as separate runs, a text height or less apart.
      const reach = Math.min(text[2] - text[0], text[3] - text[1]);
      if (
        text[0] - reach < box[2] &&
        box[0] < text[2] + reach &&
        text[1] < box[3] &&
        box[1] < text[3]
      ) {
        box = union(box, text);
        outside.splice(i, 1);
        grew = true;
      }
    }
  }
  return box;
}

/**
 * Where a page's pictures are, when they can stand apart from the text around them.
 * Null leaves the whole page content in the picture.
 */
export function figureRegion(
  images: Box[],
  textBoxes: Box[],
  width: number,
  height: number,
): Box | null {
  if (width / height >= SLIDE_RATIO) return null;

  const clamp = ([left, top, right, bottom]: Box): Box => [
    Math.max(0, left),
    Math.max(0, top),
    Math.min(width, right),
    Math.min(height, bottom),
  ];
  const pageArea = width * height;
  const figures = images
    .map(clamp)
    .filter(
      (box) =>
        area(box) >= pageArea * MIN_FIGURE_SHARE &&
        area(box) < pageArea * BACKGROUND_SHARE,
    );
  if (!figures.some((box) => area(box) >= pageArea * MAIN_FIGURE_SHARE)) {
    return null;
  }

  const [left, top, right, bottom] = clamp(
    withWholeTextLines(figures.reduce(union), textBoxes),
  );
  return [
    Math.floor(left),
    Math.floor(top),
    Math.ceil(right),
    Math.ceil(bottom),
  ];
}

function countDrawn(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  [left, top, right, bottom]: Box,
) {
  const rows = new Uint32Array(bottom - top);
  const cols = new Uint32Array(right - left);
  for (let y = 0; y < rows.length; y += 1) {
    let i = ((top + y) * canvasWidth + left) * 4;
    for (let x = 0; x < cols.length; x += 1, i += 4) {
      if (
        rgba[i] < BLANK_ABOVE ||
        rgba[i + 1] < BLANK_ABOVE ||
        rgba[i + 2] < BLANK_ABOVE
      ) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  return { rows, cols };
}

/** Indexes of the rows or columns with more than specks in them. */
function drawnLines(counts: Uint32Array, crossLength: number): number[] {
  const lines: number[] = [];
  counts.forEach((count, index) => {
    if (count >= crossLength * SPECK_SHARE) lines.push(index);
  });
  return lines;
}

function withoutStrayEdgeLines(
  rows: number[],
  height: number,
): [number, number] {
  const blocks: Array<[number, number]> = [];
  for (const y of rows) {
    const block = blocks[blocks.length - 1];
    if (block && y === block[1] + 1) block[1] = y;
    else blocks.push([y, y]);
  }

  const isLine = ([start, end]: [number, number]) =>
    end - start < height * EDGE_LINE;
  const farApart = (upper: [number, number], lower: [number, number]) =>
    lower[0] - upper[1] >= height * EDGE_GAP;
  let first = 0;
  let last = blocks.length - 1;
  while (
    first < last &&
    blocks[first][1] < height * EDGE_ZONE &&
    isLine(blocks[first]) &&
    farApart(blocks[first], blocks[first + 1])
  ) {
    first += 1;
  }
  while (
    last > first &&
    blocks[last][0] > height * (1 - EDGE_ZONE) &&
    isLine(blocks[last]) &&
    farApart(blocks[last - 1], blocks[last])
  ) {
    last -= 1;
  }
  return [blocks[first][0], blocks[last][1]];
}

/** What is drawn inside `within`, or null when it is blank. */
export function drawnBounds(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  within: Box,
  ignoreStrayEdgeLines: boolean,
): Box | null {
  const [left, top, right, bottom] = within;
  const width = right - left;
  const height = bottom - top;
  const rows = drawnLines(countDrawn(rgba, canvasWidth, within).rows, width);
  if (rows.length === 0) return null;

  const [first, last] = ignoreStrayEdgeLines
    ? withoutStrayEdgeLines(rows, height)
    : [rows[0], rows[rows.length - 1]];
  // Counted over the kept rows, so a dropped line does not widen the crop.
  const cols = drawnLines(
    countDrawn(rgba, canvasWidth, [left, top + first, right, top + last + 1])
      .cols,
    last - first + 1,
  );
  if (cols.length === 0) return null;

  return [
    Math.max(left, left + cols[0] - PADDING),
    Math.max(top, top + first - PADDING),
    Math.min(right, left + cols[cols.length - 1] + 1 + PADDING),
    Math.min(bottom, top + last + 1 + PADDING),
  ];
}

/** The part of the canvas readers should see, or null to keep it whole. */
export function storedCrop(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  figures: Box | null,
): Box | null {
  const content = drawnBounds(rgba, width, [0, 0, width, height], true);
  if (!content) return null;

  const crop =
    figures && area(figures) < area(content) * NO_BENEFIT_SHARE
      ? (drawnBounds(rgba, width, figures, false) ?? content)
      : content;
  return area(crop) < width * height * WORTH_CROPPING_SHARE ? crop : null;
}
