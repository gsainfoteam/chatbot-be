import { describe, expect, it, jest } from '@jest/globals';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import {
  allImagesFailedToDecode,
  exceedsImageBudget,
  needsPageImage,
  pageFigureRegion,
  renderPageImage,
  type PageCanvasFactory,
} from './pdf-page-image';

// pdf.js의 OPS 값과 같다. Jest는 pdf.mjs를 로드할 수 없어 필요한 값만 옮겨 둔다.
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  fill: 22,
  endPath: 28,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  shadingFill: 62,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  constructPath: 91,
};

type Op = [fn: number, args?: unknown[]];

const LETTER_AREA = 612 * 792;
const LONG_TEXT = '가'.repeat(300);

function operatorList(...ops: Op[]) {
  return {
    fnArray: ops.map(([fn]) => fn),
    argsArray: ops.map(([, args]) => args ?? null),
  };
}

function image(width: number, height: number): Op[] {
  return [
    [OPS.save],
    [OPS.transform, [width, 0, 0, height, 0, 0]],
    [OPS.paintImageXObject, ['img_p0_1', 2, 2]],
    [OPS.restore],
  ];
}

function paths(count: number, paintOp = OPS.fill): Op[] {
  return Array.from(
    { length: count },
    (): Op => [OPS.constructPath, [paintOp, [new Float32Array()], null]],
  );
}

function decide(text: string, ...ops: Op[]) {
  return needsPageImage(
    text,
    operatorList(...ops) as never,
    OPS as never,
    LETTER_AREA,
  );
}

describe('needsPageImage', () => {
  const textOps = [
    OPS.showText,
    OPS.showSpacedText,
    OPS.nextLineShowText,
    OPS.nextLineSetSpacingShowText,
  ];

  it.each<[string, string, Op[], boolean]>([
    ['nothing is drawn', '', [], false],
    ['only graphics state changes', '', [[OPS.save], [OPS.restore]], false],
    ['a scan without a text layer', '', image(612, 792), true],
    ['an image with whitespace-only text', ' \n ', image(612, 792), true],
    ['a text-only page', LONG_TEXT, [[OPS.showText]], false],
    [
      'a text layer with many private-use characters',
      `${'가'.repeat(90)}${'\uE000'.repeat(10)}`,
      [[OPS.showText]],
      true,
    ],
    [
      'a text layer with many replacement characters',
      `${'가'.repeat(90)}${'\uFFFD'.repeat(10)}`,
      [[OPS.showText]],
      true,
    ],
    ['a stray broken character', `${LONG_TEXT}�`, [[OPS.showText]], false],
    ['a small logo on a text page', LONG_TEXT, image(60, 60), false],
    ['a figure on a text page', LONG_TEXT, image(200, 200), true],
    [
      'a rotated figure',
      LONG_TEXT,
      [
        [OPS.save],
        [OPS.transform, [0, 200, -200, 0, 200, 0]],
        [OPS.paintImageXObject, ['img_p0_1', 2, 2]],
        [OPS.restore],
      ],
      true,
    ],
    [
      'a figure scaled up by its form XObject',
      LONG_TEXT,
      [
        [
          OPS.paintFormXObjectBegin,
          [
            [4, 0, 0, 4, 0, 0],
            [0, 0, 612, 792],
          ],
        ],
        ...image(50, 50),
        [OPS.paintFormXObjectEnd],
      ],
      true,
    ],
    [
      'a form XObject without its own matrix',
      LONG_TEXT,
      [
        [OPS.paintFormXObjectBegin, [null, [0, 0, 612, 792]]],
        ...image(200, 200),
        [OPS.paintFormXObjectEnd],
      ],
      true,
    ],
    [
      'a logo after a scaling form XObject ends',
      LONG_TEXT,
      [
        [
          OPS.paintFormXObjectBegin,
          [
            [10, 0, 0, 10, 0, 0],
            [0, 0, 612, 792],
          ],
        ],
        [OPS.paintFormXObjectEnd],
        ...image(60, 60),
      ],
      false,
    ],
    [
      'a logo after a scaling transform is restored',
      LONG_TEXT,
      [
        [OPS.save],
        [OPS.transform, [10, 0, 0, 10, 0, 0]],
        [OPS.restore],
        ...image(60, 60),
      ],
      false,
    ],
    ['a vector chart', LONG_TEXT, paths(50), true],
    ['a few ruled lines', LONG_TEXT, paths(3), false],
    ['clip-only paths', LONG_TEXT, paths(50, OPS.endPath), false],
    ['a shading fill', LONG_TEXT, [[OPS.shadingFill, ['pattern']]], true],
    ['short text with a small image', '표지', image(60, 60), true],
    ['short text with one path', '표지', paths(1), true],
    ['short text with nothing else drawn', '12', [[OPS.showText]], false],
  ])('%s', (_name, text, ops, expected) => {
    expect(decide(text, ...ops)).toBe(expected);
  });

  it.each(textOps)(
    'sends the page when text op %i draws glyphs the text layer lacks',
    (fn) => {
      expect(decide('', [fn, []])).toBe(true);
    },
  );
});

describe('exceedsImageBudget', () => {
  const exceeds = (...ops: Op[]) =>
    exceedsImageBudget(operatorList(...ops) as never, OPS as never);
  const photo = (id: string, megapixels: number): Op => [
    OPS.paintImageXObject,
    [id, megapixels * 1_000_000, 1],
  ];

  it('adds up the images of a page', () => {
    expect(exceeds(photo('a', 12), photo('b', 12), photo('c', 6))).toBe(false);
    expect(exceeds(photo('a', 12), photo('b', 12), photo('c', 7))).toBe(true);
  });

  it('counts an image painted repeatedly once', () => {
    expect(exceeds(photo('a', 12), photo('a', 12), photo('a', 12))).toBe(false);
  });

  it('ignores ops that hold no decoded image', () => {
    expect(
      exceeds(
        [OPS.showText],
        [OPS.paintImageMaskXObject, [{ width: 9000, height: 9000 }]],
      ),
    ).toBe(false);
  });
});

describe('allImagesFailedToDecode', () => {
  function objects(store: Record<string, unknown>) {
    return {
      get: (id: string, callback: (data: unknown) => void) => {
        queueMicrotask(() => callback(store[id]));
        return null;
      },
    };
  }

  function check(
    list: ReturnType<typeof operatorList>,
    objs: Record<string, unknown>,
    commonObjs: Record<string, unknown> = {},
  ) {
    return allImagesFailedToDecode(
      { objs: objects(objs), commonObjs: objects(commonObjs) } as never,
      list as never,
      OPS as never,
    );
  }

  it('is true when every drawn image failed', async () => {
    const list = operatorList(
      [OPS.paintImageXObject, ['img_1', 2, 2]],
      [OPS.paintImageXObject, ['img_2', 2, 2]],
    );

    await expect(check(list, { img_1: null, img_2: null })).resolves.toBe(true);
  });

  it('is false when any drawn image decoded', async () => {
    const list = operatorList(
      [OPS.paintImageXObject, ['img_1', 2, 2]],
      [OPS.paintImageXObject, ['img_2', 2, 2]],
    );

    await expect(check(list, { img_1: null, img_2: {} })).resolves.toBe(false);
  });

  it('is false when the page draws no image objects', async () => {
    await expect(check(operatorList([OPS.showText]), {})).resolves.toBe(false);
  });

  it('is false when a vector chart stands without the broken image', async () => {
    const list = operatorList(
      [OPS.paintImageXObject, ['img_1', 2, 2]],
      ...paths(20),
    );

    await expect(check(list, { img_1: null })).resolves.toBe(false);
  });

  it('is true when only a few ruled lines stand without the broken image', async () => {
    const list = operatorList(
      [OPS.paintImageXObject, ['img_1', 2, 2]],
      ...paths(3),
    );

    await expect(check(list, { img_1: null })).resolves.toBe(true);
  });

  it('reads globally cached images from the document store', async () => {
    const list = operatorList([OPS.paintImageXObject, ['g_d0_img_1', 2, 2]]);

    await expect(
      check(list, { g_d0_img_1: {} }, { g_d0_img_1: null }),
    ).resolves.toBe(true);
  });
});

describe('pageFigureRegion', () => {
  function page(width = 612, height = 792) {
    return {
      getViewport: ({ scale }: { scale: number }) => ({
        width: width * scale,
        height: height * scale,
        transform: [scale, 0, 0, -scale, 0, height * scale],
      }),
    };
  }

  function region(
    ops: Op[],
    items: unknown[] = [],
    text = LONG_TEXT,
    target = page(),
  ) {
    return pageFigureRegion(
      target as never,
      text,
      { items } as never,
      operatorList(...ops) as never,
      OPS as never,
    );
  }

  function imageAt(x: number, y: number, width: number, height: number): Op[] {
    return [
      [OPS.save],
      [OPS.transform, [width, 0, 0, height, x, y]],
      [OPS.paintImageXObject, ['img_p0_1', 2, 2]],
      [OPS.restore],
    ];
  }

  function textAt(x: number, y: number, width: number, str = '본문') {
    return { str, width, height: 12, transform: [12, 0, 0, 12, x, y] };
  }

  // PDF y runs upward and the canvas is twice the size, so y 500 is row (792 - 500) * 2.
  const FIGURE = imageAt(100, 200, 300, 300);
  const FIGURE_ON_CANVAS = [200, 584, 800, 1184];

  it('places an image on the rendered canvas', () => {
    expect(region(FIGURE)).toEqual(FIGURE_ON_CANVAS);
  });

  it('follows a form XObject and the transforms inside it', () => {
    expect(
      region([
        [
          OPS.paintFormXObjectBegin,
          [
            [1, 0, 0, 1, 50, 50],
            [0, 0, 612, 792],
          ],
        ],
        ...imageAt(100, 100, 200, 300),
        [OPS.paintFormXObjectEnd],
      ]),
    ).toEqual([300, 684, 700, 1284]);
  });

  it('forgets a transform once it is restored', () => {
    expect(
      region([
        [OPS.save],
        [OPS.transform, [1, 0, 0, 1, 200, 200]],
        [OPS.restore],
        ...FIGURE,
      ]),
    ).toEqual(FIGURE_ON_CANVAS);
  });

  it('bounds a rotated image', () => {
    expect(
      region([
        [OPS.save],
        [OPS.transform, [0, 300, -300, 0, 400, 200]],
        [OPS.paintImageXObject, ['img_p0_1', 2, 2]],
        [OPS.restore],
      ]),
    ).toEqual(FIGURE_ON_CANVAS);
  });

  it('keeps everything on a page with hardly any text', () => {
    expect(region(FIGURE, [], '짧은 설명')).toBeNull();
  });

  it('keeps everything on a wide page', () => {
    expect(region(FIGURE, [], LONG_TEXT, page(792, 612))).toBeNull();
  });

  it('takes in a line of text the crop would cut', () => {
    expect(region(FIGURE, [textAt(50, 495, 300)])).toEqual([
      100, 570, 800, 1184,
    ]);
  });

  it('places rotated text by its reading direction', () => {
    const upward = {
      str: '측면',
      width: 100,
      height: 12,
      transform: [0, 12, -12, 0, 95, 300],
    };

    expect(region(FIGURE, [upward])).toEqual([166, 584, 800, 1184]);
  });

  it.each<[string, unknown]>([
    ['whitespace', textAt(50, 495, 300, '  ')],
    ['marked content', { type: 'beginMarkedContent', id: 'mc0' }],
  ])('ignores %s among the text items', (_name, item) => {
    expect(region(FIGURE, [item])).toEqual(FIGURE_ON_CANVAS);
  });
});

describe('renderPageImage', () => {
  function setup(pageWidth: number, pageHeight: number) {
    const encode = jest.fn(async () => Buffer.from('jpeg-bytes'));
    const create = jest.fn((width: number, height: number) => ({
      canvas: { width, height, encode },
      context: {
        getImageData: () => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      },
    }));
    const destroy = jest.fn();
    const task: { promise: Promise<void>; onContinue?: unknown } = {
      promise: Promise.resolve(),
    };
    const render = jest.fn(() => task);
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: pageWidth * scale,
        height: pageHeight * scale,
      }),
      render,
    };
    const factory = { create, destroy } as unknown as PageCanvasFactory;
    return { page: page as never, factory, create, destroy, task, encode };
  }

  it('renders a normal page at twice its size as a JPEG data URL', async () => {
    const { page, factory, create } = setup(612, 792);

    const { image } = await renderPageImage(page, factory, null);

    expect(create).toHaveBeenCalledWith(1224, 1584);
    expect(image).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
    );
  });

  it('caps the long edge of oversized pages', async () => {
    const { page, factory, create } = setup(3000, 1500);

    await renderPageImage(page, factory, null);

    expect(create).toHaveBeenCalledWith(2000, 1000);
  });

  it('releases the canvas when rendering fails', async () => {
    const { page, factory, destroy, task } = setup(612, 792);
    task.promise = Promise.reject(new Error('render failed'));

    await expect(renderPageImage(page, factory, null)).rejects.toThrow(
      'render failed',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('returns to the event loop between render chunks', async () => {
    const { page, factory, task } = setup(612, 792);
    await renderPageImage(page, factory, null);
    const resume = jest.fn();

    (task.onContinue as (resume: () => void) => void)(resume);

    expect(resume).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  describe('the stored image', () => {
    const destroy = jest.fn();
    const factory = {
      create(width: number, height: number) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
      },
      destroy,
    } as unknown as PageCanvasFactory;

    /** Paints like pdf.js: a white page on a 1224x1584 canvas, then the content. */
    function paintedPage(...ink: Array<[number, number, number, number]>) {
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 612 * scale,
          height: 792 * scale,
        }),
        render: ({
          canvas,
        }: {
          canvas: { getContext(type: '2d'): SKRSContext2D };
        }) => {
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 1224, 1584);
          context.fillStyle = '#000000';
          for (const [x0, y0, x1, y1] of ink) {
            context.fillRect(x0, y0, x1 - x0, y1 - y0);
          }
          return { promise: Promise.resolve() };
        },
      } as never;
    }

    async function pixels(jpeg: Buffer) {
      const decoded = await loadImage(jpeg);
      const canvas = createCanvas(decoded.width, decoded.height);
      const context = canvas.getContext('2d');
      context.drawImage(decoded, 0, 0);
      return {
        width: decoded.width,
        height: decoded.height,
        red: (x: number, y: number) => context.getImageData(x, y, 1, 1).data[0],
      };
    }

    it('gives the LLM the whole page and readers its content in a white margin', async () => {
      const { image, storedImage } = await renderPageImage(
        paintedPage([200, 200, 600, 500]),
        factory,
        null,
      );

      const whole = await pixels(
        Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'),
      );
      expect([whole.width, whole.height]).toEqual([1224, 1584]);

      // 400x300 of ink, 4px of padding around it, then 4% of 408 as a margin.
      const stored = await pixels(storedImage);
      expect([stored.width, stored.height]).toEqual([440, 340]);
      expect(stored.red(2, 2)).toBeGreaterThan(240);
      expect(stored.red(220, 170)).toBeLessThan(15);
    });

    it('keeps only the figures when told where they are', async () => {
      const { storedImage } = await renderPageImage(
        paintedPage(
          [100, 100, 1100, 500],
          [200, 600, 1000, 900],
          [100, 1000, 1100, 1400],
        ),
        factory,
        [200, 600, 1000, 900],
      );

      const stored = await pixels(storedImage);
      expect([stored.width, stored.height]).toEqual([864, 364]);
    });

    it('fills the margin with white, not with what surrounds the crop', async () => {
      const { storedImage } = await renderPageImage(
        paintedPage(
          [100, 100, 1100, 600],
          [200, 600, 1000, 900],
          [100, 900, 1100, 1400],
        ),
        factory,
        [200, 600, 1000, 900],
      );

      const stored = await pixels(storedImage);
      expect(stored.red(stored.width / 2, 5)).toBeGreaterThan(240);
      expect(stored.red(stored.width / 2, stored.height - 5)).toBeGreaterThan(
        240,
      );
      expect(stored.red(5, stored.height / 2)).toBeGreaterThan(240);
    });

    it('stores the rendered page as it is when there is nothing to crop', async () => {
      const { image, storedImage } = await renderPageImage(
        paintedPage([0, 0, 1224, 1584]),
        factory,
        null,
      );

      expect(storedImage.toString('base64')).toBe(
        image.slice(image.indexOf(',') + 1),
      );
    });

    it('releases both canvases, even when the crop cannot be encoded', async () => {
      const ink = new Uint8ClampedArray(1224 * 1584 * 4).fill(255);
      ink.fill(0, 800_000, 1_600_000);
      const encode = jest
        .fn<() => Promise<Buffer>>()
        .mockResolvedValueOnce(Buffer.from('page'))
        .mockRejectedValueOnce(new Error('encode failed'));
      const release = jest.fn();
      const failing = {
        create: (width: number, height: number) => ({
          canvas: { width, height, encode },
          context: {
            getImageData: () => ({ data: ink }),
            fillRect: jest.fn(),
            drawImage: jest.fn(),
          },
        }),
        destroy: release,
      } as unknown as PageCanvasFactory;

      await expect(
        renderPageImage(
          {
            getViewport: ({ scale }: { scale: number }) => ({
              width: 612 * scale,
              height: 792 * scale,
            }),
            render: () => ({ promise: Promise.resolve() }),
          } as never,
          failing,
          null,
        ),
      ).rejects.toThrow('encode failed');
      expect(release).toHaveBeenCalledTimes(2);
    });
  });
});
