/**
 * Offline smoke checks for PDF processor pieces (no GCS/LLM required).
 *
 * Usage: bun src/scripts/smoke-pdf-processor.ts
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseChunksFromMarkdown, toResourceName } from '../pdf-processor/pdf-chunk-parser';
import {
  isLikelyMojibake,
  normalizeExtractedText,
} from '../pdf-processor/mojibake';
import iconv from 'iconv-lite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Minimal one-page PDF with ASCII text (Helvetica). */
function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n',
    `4 0 obj<< /Length ${Buffer.byteLength(content)} >>stream\n${content}\nendstream\nendobj\n`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function extractFirstPageText(pdfBytes: Buffer): Promise<string> {
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    useWorkerFetch: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  return textContent.items
    .map((item) => ('str' in item ? String(item.str) : ''))
    .join(' ');
}

async function main() {
  console.log('=== PDF processor smoke (offline) ===');

  // 1) resource name NFC
  const name = toResourceName('학생-안내.pdf');
  if (name !== '학생-안내') {
    throw new Error(`toResourceName failed: ${name}`);
  }
  console.log('OK toResourceName');

  // 2) mojibake
  const original = '학사 일정';
  const mojibake = iconv.decode(Buffer.from(original, 'utf8'), 'latin1');
  if (!isLikelyMojibake(mojibake)) {
    throw new Error('mojibake not detected');
  }
  if (normalizeExtractedText(mojibake) !== original) {
    throw new Error('mojibake fix failed');
  }
  console.log('OK mojibake');

  // 3) chunk parser
  const parsed = parseChunksFromMarkdown(
    `<summary>요약</summary>\n<document path="a" description="설명">본문</document>`,
    'doc.pdf',
  );
  if (parsed.metadata.description !== '요약') {
    throw new Error('summary parse failed');
  }
  if (parsed.documents['doc/a.md'] !== '본문') {
    throw new Error('chunk content parse failed');
  }
  console.log('OK chunk parser');

  // 4) pdfjs text extract
  const pdfBytes = buildMinimalPdf('Hello Ziggle');
  const tmp = join(tmpdir(), `smoke-pdf-${Date.now()}.pdf`);
  writeFileSync(tmp, pdfBytes);
  try {
    const extracted = await extractFirstPageText(readFileSync(tmp));
    if (!extracted.includes('Hello Ziggle')) {
      throw new Error(`pdf text extract failed: "${extracted}"`);
    }
    console.log('OK pdfjs text extract:', extracted.trim());
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }

  console.log('=== smoke passed ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
