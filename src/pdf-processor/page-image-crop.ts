/** [left, top, right, bottom] in canvas pixels. */
export type Box = readonly [number, number, number, number];

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

/** A crop keeping this share of the canvas is not worth encoding again. */
const WORTH_CROPPING_SHARE = 0.9;

function area([left, top, right, bottom]: Box): number {
  return Math.max(0, right - left) * Math.max(0, bottom - top);
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
): Box | null {
  const content = drawnBounds(rgba, width, [0, 0, width, height], true);
  if (!content) return null;
  return area(content) < width * height * WORTH_CROPPING_SHARE ? content : null;
}
