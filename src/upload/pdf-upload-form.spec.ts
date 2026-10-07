import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import type { FastifyRequest } from 'fastify';
import { readPdfUploadForm } from './pdf-upload-form';

function multipartRequest(
  parts: Array<Record<string, unknown>>,
): FastifyRequest {
  return {
    isMultipart: () => true,
    parts: async function* () {
      yield* parts;
    },
  } as unknown as FastifyRequest;
}

const pdfPart = {
  type: 'file',
  fieldname: 'file',
  filename: '유학생 은행 안내.pdf',
  mimetype: 'application/pdf',
  toBuffer: async () => Buffer.from('%PDF-test'),
};

describe('readPdfUploadForm', () => {
  it('requires a title by default', async () => {
    await expect(
      readPdfUploadForm(multipartRequest([pdfPart])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back to the file name when titleFromFilename is set', async () => {
    const form = await readPdfUploadForm(multipartRequest([pdfPart]), {
      titleFromFilename: true,
    });

    expect(form.title).toBe('유학생 은행 안내');
    expect(form.filename).toBe('유학생 은행 안내.pdf');
  });

  it('keeps an explicit title', async () => {
    const form = await readPdfUploadForm(
      multipartRequest([
        { type: 'field', fieldname: 'title', value: ' 은행 ' },
        pdfPart,
      ]),
      { titleFromFilename: true },
    );

    expect(form.title).toBe('은행');
  });
});
