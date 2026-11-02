import { Injectable, Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { normalizeExtractedText, isLikelyMojibake } from './mojibake';
import { Trace } from '@gsainfoteam/nest-observability';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

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

  /**
   * Extract text per page from a PDF buffer (1-indexed page order in logs; array is 0-indexed).
   */
  async extractPageTexts(pdfBytes: Buffer): Promise<string[]> {
    const pdfjs = await this.loadPdfjs();
    const data = new Uint8Array(pdfBytes);
    const loadingTask = pdfjs.getDocument({
      data,
      ...this.pdfjsAssetOptions(),
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];

    try {
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        try {
          const textContent = await page.getTextContent();
          const raw = textContent.items
            .map((item) => ('str' in item ? String(item.str) : ''))
            .join(' ');

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
            pageTexts.push(normalized);
          } else {
            pageTexts.push(raw);
          }
        } finally {
          page.cleanup();
        }
      }
      return pageTexts;
    } finally {
      // pdfjs-dist v6: document uses cleanup(); loadingTask.destroy() tears down the worker.
      await pdf.cleanup();
      await loadingTask.destroy();
    }
  }
}
