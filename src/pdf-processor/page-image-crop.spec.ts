import { describe, expect, it } from '@jest/globals';
import {
  drawnBounds,
  figureRegion,
  storedCrop,
  type Box,
} from './page-image-crop';

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
  const crop = (rgba: Uint8ClampedArray, figures: Box | null = null) =>
    storedCrop(rgba, WIDTH, HEIGHT, figures);

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

  it('leaves a stray page number out of the page content', () => {
    const body: Box = [100, 100, 500, 400];

    expect(crop(canvas(body, [290, 760, 310, 775]))).toEqual(padded(body));
  });

  it('crops to the figures when they are much smaller than the page content', () => {
    const figure: Box = [150, 300, 450, 500];
    const rgba = canvas(figure, [100, 100, 500, 200], [100, 600, 500, 700]);

    expect(crop(rgba, figure)).toEqual(figure);
  });

  it('trims the blank part of the figures', () => {
    const rgba = canvas([200, 350, 400, 450], [100, 100, 500, 200]);

    expect(crop(rgba, [150, 300, 450, 500])).toEqual(
      padded([200, 350, 400, 450]),
    );
  });

  it('keeps stray lines that belong to the figures', () => {
    const figures: Box = [100, 200, 500, 600];
    const rgba = canvas(
      [100, 200, 500, 300],
      [290, 570, 310, 580],
      [100, 20, 500, 100],
      [100, 650, 500, 760],
    );

    expect(crop(rgba, figures)).toEqual([100, 200, 500, 584]);
  });

  it('falls back to the page content when figures cover most of it', () => {
    const body: Box = [100, 100, 500, 500];

    expect(crop(canvas(body), [100, 100, 500, 450])).toEqual(padded(body));
  });

  it('falls back to the page content when the figures render blank', () => {
    const body: Box = [100, 100, 500, 300];

    expect(crop(canvas(body), [100, 600, 500, 700])).toEqual(padded(body));
  });

  it('leaves the page whole when the figures fill it', () => {
    expect(
      crop(canvas([0, 0, WIDTH, HEIGHT]), [0, 0, WIDTH, HEIGHT]),
    ).toBeNull();
  });
});

describe('figureRegion', () => {
  const MAP: Box = [100, 200, 500, 500];
  const region = (images: Box[], text: Box[] = [], width = 600, height = 800) =>
    figureRegion(images, text, width, height);

  it('finds the only figure on a page', () => {
    expect(region([MAP])).toEqual(MAP);
  });

  it('has nothing to show on a page without images', () => {
    expect(region([])).toBeNull();
  });

  it('keeps a wide page together, since it was composed as one screen', () => {
    expect(region([[100, 100, 500, 400]], [], 800, 600)).toBeNull();
    expect(region([[100, 100, 500, 400]], [], 660, 600)).toBeNull();
  });

  it('treats a nearly square page as a document', () => {
    expect(region([[100, 100, 500, 400]], [], 640, 600)).toEqual([
      100, 100, 500, 400,
    ]);
  });

  it('does not treat small images alone as figures', () => {
    expect(
      region([
        [0, 0, 100, 100],
        [200, 0, 300, 100],
        [400, 0, 500, 100],
      ]),
    ).toBeNull();
  });

  it('takes in every smaller image next to a real figure', () => {
    const photo: Box = [100, 600, 200, 700];

    expect(region([MAP, photo])).toEqual([100, 200, 500, 700]);
  });

  it('leaves logos out', () => {
    expect(region([MAP, [540, 10, 590, 50]])).toEqual(MAP);
  });

  it('ignores a background or a scan', () => {
    expect(region([[0, 0, 600, 800]])).toBeNull();
    expect(region([[0, 0, 600, 800], MAP])).toEqual(MAP);
  });

  it('keeps the part of an image that is on the page', () => {
    expect(region([[300, 300, 900, 900]])).toEqual([300, 300, 600, 800]);
  });

  it('ignores an image off the page', () => {
    expect(region([[700, 900, 900, 1000]])).toBeNull();
  });

  it('rounds outward to whole pixels', () => {
    expect(region([[100.4, 200.4, 499.6, 499.6]])).toEqual(MAP);
  });

  describe('text at its edges', () => {
    it('takes in a whole line that the crop would cut', () => {
      expect(region([MAP], [[50, 195, 300, 215]])).toEqual([50, 195, 500, 500]);
    });

    it('takes in the rest of a cut line', () => {
      expect(
        region(
          [MAP],
          [
            [50, 195, 120, 215],
            [130, 195, 200, 215],
            [20, 195, 45, 215],
          ],
        ),
      ).toEqual([20, 195, 500, 500]);
    });

    it('takes in a label right beside the figure', () => {
      expect(region([MAP], [[510, 300, 590, 320]])).toEqual([
        100, 200, 590, 500,
      ]);
    });

    it('leaves out text that is clear of the figure', () => {
      expect(
        region(
          [MAP],
          [
            [100, 150, 500, 170],
            [100, 530, 500, 550],
          ],
        ),
      ).toEqual(MAP);
    });

    it('leaves out a line just above the figure', () => {
      expect(region([MAP], [[100, 180, 500, 200]])).toEqual(MAP);
    });

    it('leaves out text far beside the figure', () => {
      expect(region([[100, 200, 400, 500]], [[500, 300, 590, 320]])).toEqual([
        100, 200, 400, 500,
      ]);
    });
  });
});
