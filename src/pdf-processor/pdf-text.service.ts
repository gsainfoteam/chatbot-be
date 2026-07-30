import { Injectable, Logger } from '@nestjs/common';
import { normalizeExtractedText, isLikelyMojibake } from './mojibake';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

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
   * Extract text per page from a PDF buffer (1-indexed page order in logs; array is 0-indexed).
   */
  async extractPageTexts(pdfBytes: Buffer): Promise<string[]> {
    const pdfjs = await this.loadPdfjs();
    const data = new Uint8Array(pdfBytes);
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      useWorkerFetch: false,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
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
          this.logger.log(`Page ${pageNum}: Fixed mojibake in extracted text`);
        }
        pageTexts.push(normalized);
      } else {
        pageTexts.push(raw);
      }
    }

    return pageTexts;
  }
}
