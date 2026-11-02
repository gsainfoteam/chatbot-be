import { describe, expect, it } from '@jest/globals';
import { drawnBounds, storedCrop, type Box } from './page-image-crop';

const WIDTH = 600;
const HEIGHT = 800;
const PADDING = 4;
const WHOLE: Box = [0, 0, WIDTH, HEIGHT];
const BLACK = [0, 0, 0];

function canvas(...shapes: Array<Box | [Box, number[]]>) {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  for (const shape of shapes) {
    const [box, color] =
      shape.length === 2 ? shape : ([shape, BLACK] as [Box, number[]]);
    for (let y = box[1]; y < box[3]; y += 1) {
      for (let x = box[0]; x < box[2]; x += 1) {
        rgba.set(color, (y * WIDTH + x) * 4);
      }
    }
  }
  return rgba;
}

function padded([left, top, right, bottom]: Box): Box {
  return [left - PADDING, top - PADDING, right + PADDING, bottom + PADDING];
}

describe('drawnBounds', () => {
  const bounds = (rgba: Uint8ClampedArray, ignoreStrayEdgeLines = true) =>
    drawnBounds(rgba, WIDTH, WHOLE, ignoreStrayEdgeLines);
  const BODY: Box = [100, 100, 500, 400];

  it('finds nothing on a blank page', () => {
    expect(bounds(canvas())).toBeNull();
  });

  it('wraps what is drawn with a little padding', () => {
    expect(bounds(canvas(BODY))).toEqual(padded(BODY));
  });

  it('never reaches past the canvas', () => {
    expect(bounds(canvas([0, 0, WIDTH, 100]))).toEqual([0, 0, WIDTH, 104]);
  });

  it('ignores a stray speck', () => {
    expect(bounds(canvas(BODY, [10, 790, 11, 791]))).toEqual(padded(BODY));
  });

  it('treats a near-white background as blank', () => {
    const pale: [Box, number[]] = [
      [0, 0, WIDTH, HEIGHT],
      [230, 230, 230],
    ];

    expect(bounds(canvas(pale, BODY))).toEqual(padded(BODY));
  });

  it('counts a light color with one dark channel as drawn', () => {
    const lightYellow: [Box, number[]] = [BODY, [255, 250, 190]];

    expect(bounds(canvas(lightYellow))).toEqual(padded(BODY));
  });

  describe('lines at the edge of the page', () => {
    it('drops a page number far below the body', () => {
      expect(bounds(canvas(BODY, [290, 760, 310, 775]))).toEqual(padded(BODY));
    });

    it('drops a running title far above the body', () => {
      const body: Box = [100, 200, 500, 500];

      expect(bounds(canvas(body, [100, 10, 300, 25]))).toEqual(padded(body));
    });

    it('drops every stray line at an edge', () => {
      expect(
        bounds(canvas(BODY, [290, 720, 310, 735], [290, 780, 310, 795])),
      ).toEqual(padded(BODY));
    });

    it('does not widen the crop for a line it dropped', () => {
      const body: Box = [200, 300, 400, 500];

      expect(bounds(canvas(body, [50, 10, 550, 25]))).toEqual(padded(body));
    });

    it('keeps a footnote right below the body', () => {
      const body: Box = [100, 100, 500, 700];
      const note: Box = [100, 720, 300, 735];

      expect(bounds(canvas(body, note))).toEqual(padded([100, 100, 500, 735]));
    });

    it('keeps a tall block at the bottom', () => {
      expect(bounds(canvas(BODY, [100, 720, 500, 790]))).toEqual(
        padded([100, 100, 500, 790]),
      );
    });

    it('keeps a short line away from the edge', () => {
      expect(bounds(canvas(BODY, [100, 600, 300, 615]))).toEqual(
        padded([100, 100, 500, 615]),
      );
    });

    it('keeps a lone line when nothing else is drawn', () => {
      expect(bounds(canvas([290, 760, 310, 775]))).toEqual(
        padded([290, 760, 310, 775]),
      );
    });

    it('keeps them when asked to', () => {
      expect(bounds(canvas(BODY, [290, 760, 310, 775]), false)).toEqual(
        padded([100, 100, 500, 775]),
      );
    });
  });

  it('looks only inside the given box', () => {
    const rgba = canvas([100, 100, 200, 200], [300, 300, 400, 400]);

    expect(drawnBounds(rgba, WIDTH, [250, 250, 500, 500], false)).toEqual(
      padded([300, 300, 400, 400]),
    );
  });

  it('stays inside the given box', () => {
    const rgba = canvas([100, 100, 200, 200]);

    expect(drawnBounds(rgba, WIDTH, [100, 100, 200, 200], false)).toEqual([
      100, 100, 200, 200,
    ]);
  });
});

describe('storedCrop', () => {
  const crop = (rgba: Uint8ClampedArray) => storedCrop(rgba, WIDTH, HEIGHT);

  it('keeps a blank page whole', () => {
    expect(crop(canvas())).toBeNull();
  });

  it('keeps a page whole when cropping would barely change it', () => {
    expect(crop(canvas([10, 10, 590, 790]))).toBeNull();
  });

  it('crops to what is drawn when there are no figures', () => {
    const body: Box = [100, 100, 500, 400];

    expect(crop(canvas(body))).toEqual(padded(body));
  });
});
