import { Injectable, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  normalizeExtractedText,
  isLikelyMojibake,
  removeLoneSurrogates,
} from './mojibake';
import {
  MAX_IMAGE_PIXELS,
  allImagesFailedToDecode,
  needsPageImage,
  renderPageImage,
  type PageCanvasFactory,
  type PdfDocument,
  type PdfPage,
} from './pdf-page-image';
import { Trace } from '@gsainfoteam/nest-observability';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

export type PdfPageContent = {
  pageNumber: number;
  text: string;
  /** JPEG data URL, set only when the text layer alone would lose content. */
  image: string | null;
  /** The page needed an image, but rendering or decoding it failed. */
  imageFailed: boolean;
};

@Trace()
@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name);
  private pdfjsPromise: Promise<PdfjsModule> | null = null;

  private loadPdfjs(): Promise<PdfjsModule> {
    if (!this.pdfjsPromise) {
      this.pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return this.pdfjsPromise;
  }

  /**
   * pdf.js loads these on demand: CMaps for CJK fonts, standard fonts, and the
   * JPX/JBIG2 decoders. Without them that text and those images are lost.
   */
  private pdfjsAssetOptions() {
    const root = dirname(
      createRequire(__filename).resolve('pdfjs-dist/package.json'),
    );
    return {
      cMapUrl: `${root}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${root}/standard_fonts/`,
      wasmUrl: `${root}/wasm/`,
    };
  }

  private async loadPageImage(
    page: PdfPage,
    pdf: PdfDocument,
    text: string,
    ops: PdfjsModule['OPS'],
  ): Promise<Pick<PdfPageContent, 'image' | 'imageFailed'>> {
    try {
      const operatorList = await page.getOperatorList();
      const [x1, y1, x2, y2] = page.view;
      if (!needsPageImage(text, operatorList, ops, (x2 - x1) * (y2 - y1))) {
        return { image: null, imageFailed: false };
      }
      if (await allImagesFailedToDecode(page, operatorList, ops)) {
        throw new Error('every image on the page failed to decode');
      }

      // render() decodes images again, so free the first copy before it starts.
      page.cleanup();
      // pdf.js runs on this thread; let waiting HTTP traffic through between decodes.
      await new Promise((resolve) => setImmediate(resolve));
      const canvasFactory = pdf.canvasFactory as PageCanvasFactory;
      const image = await renderPageImage(page, canvasFactory);
      return { image, imageFailed: false };
    } catch (error) {
      this.logger.warn(
        `Page ${page.pageNumber}: Page image unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { image: null, imageFailed: true };
    }
  }

  /**
   * Visit each page in order, keeping only the current page image in memory.
   */
  async forEachPage(
    pdfBytes: Buffer,
    onPage: (page: PdfPageContent, totalPages: number) => Promise<void>,
  ): Promise<void> {
    const pdfjs = await this.loadPdfjs();
    const data = new Uint8Array(pdfBytes);
    const loadingTask = pdfjs.getDocument({
      data,
      ...this.pdfjsAssetOptions(),
      maxImageSize: MAX_IMAGE_PIXELS,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;

    try {
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        let content: PdfPageContent;
        try {
          const textContent = await page.getTextContent();
          const raw = removeLoneSurrogates(
            textContent.items
              .map((item) => ('str' in item ? String(item.str) : ''))
              .join(' '),
          );

          let text = raw;
          if (isLikelyMojibake(raw)) {
            const normalized = normalizeExtractedText(raw);
            if (!normalized) {
              this.logger.warn(
                `Page ${pageNum}: Mojibake detected but recovery failed, skipping extracted text`,
              );
            } else {
              this.logger.log(
                `Page ${pageNum}: Fixed mojibake in extracted text`,
              );
            }
            text = normalized;
          }

          content = {
            pageNumber: pageNum,
            text,
            ...(await this.loadPageImage(page, pdf, text, pdfjs.OPS)),
          };
        } finally {
          page.cleanup();
        }
        await onPage(content, pdf.numPages);
      }
    } finally {
      // destroy() also cleans up; pdf.cleanup() would throw and hide the cause
      // when an error interrupts a page that is still rendering.
      await loadingTask.destroy();
    }
  }
}
