import { describe, expect, it, jest } from '@jest/globals';
import {
  allImagesFailedToDecode,
  needsPageImage,
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
  paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
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
  const unmeasuredImageOps = [
    OPS.paintImageMaskXObjectGroup,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
  ];
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
      `${'가'.repeat(90)}${''.repeat(10)}`,
      [[OPS.showText]],
      true,
    ],
    [
      'a text layer with many replacement characters',
      `${'가'.repeat(90)}${'�'.repeat(10)}`,
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

  it.each(unmeasuredImageOps)(
    'sends the page when image op %i cannot be measured',
    (fn) => {
      expect(decide(LONG_TEXT, [fn, []])).toBe(true);
    },
  );

  it.each(textOps)(
    'sends the page when text op %i draws glyphs the text layer lacks',
    (fn) => {
      expect(decide('', [fn, []])).toBe(true);
    },
  );
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
      [OPS.paintImageXObjectRepeat, ['img_2', 2, 2, []]],
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

  it('reads globally cached images from the document store', async () => {
    const list = operatorList([OPS.paintImageXObject, ['g_d0_img_1', 2, 2]]);

    await expect(
      check(list, { g_d0_img_1: {} }, { g_d0_img_1: null }),
    ).resolves.toBe(true);
  });
});

describe('renderPageImage', () => {
  function setup(pageWidth: number, pageHeight: number) {
    const encode = jest.fn(async () => Buffer.from('jpeg-bytes'));
    const create = jest.fn((width: number, height: number) => {
      void width;
      void height;
      return { canvas: { encode } };
    });
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

    const image = await renderPageImage(page, factory);

    expect(create).toHaveBeenCalledWith(1224, 1584);
    expect(image).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
    );
  });

  it('caps the long edge of oversized pages', async () => {
    const { page, factory, create } = setup(3000, 1500);

    await renderPageImage(page, factory);

    expect(create).toHaveBeenCalledWith(2000, 1000);
  });

  it('releases the canvas after rendering', async () => {
    const { page, factory, destroy } = setup(612, 792);

    await renderPageImage(page, factory);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('releases the canvas when rendering fails', async () => {
    const { page, factory, destroy, task } = setup(612, 792);
    task.promise = Promise.reject(new Error('render failed'));

    await expect(renderPageImage(page, factory)).rejects.toThrow(
      'render failed',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('returns to the event loop between render chunks', async () => {
    const { page, factory, task } = setup(612, 792);
    await renderPageImage(page, factory);
    const resume = jest.fn();

    (task.onContinue as (resume: () => void) => void)(resume);

    expect(resume).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
