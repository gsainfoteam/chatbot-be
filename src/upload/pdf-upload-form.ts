import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'stream';

export const PDF_MIME = 'application/pdf';

/** multipart/form-data PDF 업로드 요청의 필드 */
export interface PdfUploadForm {
  file: Buffer;
  filename: string;
  title: string;
  expiresAt?: string;
  organizationId?: string;
}

const PDF_UPLOAD_OPTIONAL_PROPERTIES = {
  expiresAt: {
    type: 'string',
    format: 'date-time',
    description:
      '문서 유효기간 (ISO-8601, optional). 미전송/빈 값이면 무기한. 과거 시각은 400.',
    nullable: true,
  },
  organizationId: {
    type: 'string',
    format: 'uuid',
    description:
      '소유 조직 UUID. 생략한 경우에만 출시 호환성을 위해 기본 조직을 사용하며, 빈 값은 잘못된 입력입니다.',
  },
};

/** 문서 업로드 multipart Swagger 스키마 */
export const PDF_UPLOAD_FORM_SCHEMA = {
  type: 'object',
  required: ['file', 'title'],
  properties: {
    file: { type: 'string', format: 'binary', description: 'PDF 파일' },
    title: { type: 'string', description: '파일 제목' },
    ...PDF_UPLOAD_OPTIONAL_PROPERTIES,
  },
};

/** 미답변 질문 PDF 지식 등록 multipart Swagger 스키마 (title 생략 시 파일명 사용) */
export const PDF_KNOWLEDGE_FORM_SCHEMA = {
  type: 'object',
  required: ['file'],
  properties: {
    file: { type: 'string', format: 'binary', description: 'PDF 파일' },
    title: {
      type: 'string',
      description: '문서 제목. 생략하면 파일명(확장자 제외)을 사용',
    },
    ...PDF_UPLOAD_OPTIONAL_PROPERTIES,
  },
};

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readPdfUploadForm(
  req: FastifyRequest,
  options: { titleFromFilename?: boolean } = {},
): Promise<PdfUploadForm> {
  const fastifyReq = req as FastifyRequest & {
    isMultipart: () => boolean;
    parts: () => AsyncIterable<MultipartPart>;
  };
  if (!fastifyReq.isMultipart?.()) {
    throw new BadRequestException('Content-Type must be multipart/form-data');
  }

  const parts = fastifyReq.parts();
  let title = '';
  let expiresAt: string | undefined;
  let organizationId: string | undefined;
  let fileBuffer: Buffer | null = null;
  let filename = 'document.pdf';
  let mimetype = '';

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname === 'title') {
        const v = part.value;
        title = typeof v === 'string' ? v : '';
      } else if (part.fieldname === 'expiresAt') {
        const v = part.value;
        expiresAt = typeof v === 'string' ? v : undefined;
      } else if (part.fieldname === 'organizationId') {
        const v = part.value;
        organizationId = typeof v === 'string' ? v : undefined;
      }
    } else if (part.type === 'file' && part.fieldname === 'file') {
      const filePart = part;
      mimetype = filePart.mimetype ?? '';
      filename = filePart.filename ?? 'document.pdf';
      fileBuffer = filePart.toBuffer
        ? await filePart.toBuffer()
        : await streamToBuffer(filePart.file);
    }
  }

  if (!title.trim() && options.titleFromFilename) {
    title = filename.replace(/\.pdf$/i, '');
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new BadRequestException('title is required');
  }
  if (!fileBuffer) {
    throw new BadRequestException('file is required');
  }
  if (mimetype !== PDF_MIME) {
    throw new BadRequestException('Only PDF files are allowed');
  }

  return {
    file: fileBuffer,
    filename,
    title: title.trim(),
    expiresAt,
    organizationId,
  };
}

interface FieldPart {
  type: 'field';
  fieldname: string;
  value: string;
}

interface FilePart {
  type: 'file';
  fieldname: string;
  filename: string;
  mimetype: string;
  file: NodeJS.ReadableStream;
  toBuffer?: () => Promise<Buffer>;
}

type MultipartPart = FieldPart | FilePart;
