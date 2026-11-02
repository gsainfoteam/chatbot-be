/**
 * Offline smoke checks for PDF processor pieces (no GCS/LLM required).
 *
 * Usage: bun src/scripts/smoke-pdf-processor.ts
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseChunksFromMarkdown,
  toResourceName,
} from '../pdf-processor/pdf-chunk-parser';
import {
  isLikelyMojibake,
  normalizeExtractedText,
} from '../pdf-processor/mojibake';
import {
  PdfTextService,
  type PdfPageContent,
} from '../pdf-processor/pdf-text.service';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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

/**
 * Multi-page PDF sharing one resource set: /Latin (Helvetica), /Korean (non-embedded
 * font that needs the KSCms-UHC-H CMap), /Photo (2x2 raw image), /Broken (undecodable JPX),
 * /Oversized (undecodable JPX that declares too many pixels to be decoded at all).
 */
function buildPdfWithPages(contents: string[]): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (value: string | Buffer) => {
    const part = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    parts.push(part);
    length += part.length;
  };
  const addObject = (id: number, body: string | Buffer) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from('\nendstream'),
    ]);

  const firstPageId = 8;
  const pageIds = contents.map((_, i) => firstPageId + i * 2);
  push('%PDF-1.4\n');
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${contents.length} >>`,
  );
  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  addObject(
    4,
    `<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /KSCms-UHC-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor << /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /StemV 80 /CapHeight 700 >> >>] >>`,
  );
  addObject(
    5,
    stream(
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8',
      Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    ),
  );
  addObject(
    6,
    stream(
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
      Buffer.from('not a jpeg2000 stream'),
    ),
  );
  addObject(
    7,
    stream(
      '/Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
      Buffer.from('not a jpeg2000 stream'),
    ),
  );
  contents.forEach((content, i) => {
    addObject(
      pageIds[i],
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /Latin 3 0 R /Korean 4 0 R >> /XObject << /Photo 5 0 R /Broken 6 0 R /Oversized 7 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`,
    );
    addObject(pageIds[i] + 1, stream('', Buffer.from(content, 'latin1')));
  });

  const objectCount = firstPageId + contents.length * 2 - 1;
  const xrefStart = length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return Buffer.concat(parts);
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

  // 3) chunk parser (relative path + overview preservation)
  const parsed = parseChunksFromMarkdown(
    `<summary>요약</summary>\n\n# 개요\n\n소개입니다.\n\n<document path="a" description="설명">본문</document>`,
    'doc.pdf',
  );
  if (parsed.metadata.description !== '요약') {
    throw new Error('summary parse failed');
  }
  if (parsed.documents['doc/a.md'] !== '본문') {
    throw new Error('chunk content parse failed');
  }
  if (!parsed.documents['doc.md']?.includes('소개입니다.')) {
    throw new Error('overview content not preserved');
  }
  if (parsed.metadata.chunks[0]?.path !== 'doc') {
    throw new Error('root chunk missing from metadata');
  }
  const deduped = parseChunksFromMarkdown(
    `<summary>s</summary>\n# o\n\n<document path="doc/a" description="d">x</document>`,
    'doc.pdf',
  );
  if (!deduped.documents['doc/a.md'] || deduped.documents['doc/doc/a.md']) {
    throw new Error('baseName path dedupe failed');
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

  // 5) predefined CMap font (bytes are CP949 for 가나)
  const latinText = `BT /Latin 12 Tf 14 TL 50 700 Td ${"(Plain text page with enough characters on each line) ' ".repeat(4)}ET`;
  const fullPage = (image: string) => `q 612 0 0 792 0 0 cm /${image} Do Q`;
  const pages: PdfPageContent[] = [];
  await new PdfTextService().forEachPage(
    buildPdfWithPages([
      'BT /Korean 18 Tf 72 700 Td <B0A1B3AA> Tj ET',
      latinText,
      fullPage('Photo'),
      `${latinText}\nq 60 0 0 60 500 700 cm /Photo Do Q`,
      'q Q',
      fullPage('Broken'),
      fullPage('Oversized'),
    ]),
    async (page) => {
      pages.push(page);
    },
  );
  const [korean, textOnly, photo, smallLogo, blank, broken, oversized] = pages;
  if (korean.text.replace(/\s+/g, '') !== '가나') {
    throw new Error(`predefined CMap text extract failed: "${korean.text}"`);
  }
  console.log('OK predefined CMap text extract');

  // 6) page images
  if (!textOnly.text.includes('Plain text page') || textOnly.image) {
    throw new Error('text-only page should keep its text and get no image');
  }
  if (!photo.image?.startsWith('data:image/jpeg;base64,')) {
    throw new Error('image-only page was not rendered');
  }
  // The photo's top-left pixel is red, so a blank white render would fail this.
  const jpeg = Buffer.from(photo.image.split(',')[1], 'base64');
  const decoded = await loadImage(jpeg);
  const canvas = createCanvas(decoded.width, decoded.height);
  const context = canvas.getContext('2d');
  context.drawImage(decoded, 0, 0);
  const [red, green, blue] = context.getImageData(1, 1, 1, 1).data;
  if (red < 200 || green > 80 || blue > 80) {
    throw new Error(`rendered image is wrong: rgb(${red},${green},${blue})`);
  }
  if (smallLogo.image) {
    throw new Error('small logo on a text page should not send an image');
  }
  if (blank.image || blank.imageFailed) {
    throw new Error('blank page should be neither rendered nor failed');
  }
  if (broken.image || !broken.imageFailed) {
    throw new Error('undecodable image should be reported as failed');
  }
  // Dropped before decoding: an attempt to decode this stream would report a failure.
  if (oversized.image || oversized.imageFailed) {
    throw new Error('oversized image should be dropped without decoding');
  }
  console.log('OK page images');

  console.log('=== smoke passed ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
