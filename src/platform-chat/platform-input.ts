import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isUUID } from 'class-validator';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export interface PlatformHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageSummary?: string;
}
export interface PlatformImageRef {
  id: string;
  /** Omit for the current question. Otherwise this must reference a user history message. */
  messageId?: string;
}
export interface PlatformChatInput {
  localConversationId: string;
  question: string;
  history: PlatformHistoryMessage[];
  images: PlatformImageRef[];
}
export interface PlatformImageFile {
  id: string;
  mimeType: string;
  bytes: Buffer;
}

function bad(message: string): never {
  throw new BadRequestException(message);
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return bad('Expected an object');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !allowed.includes(key)))
    return bad('Unknown field');
  return obj;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value))
    return bad('Expected a UUID');
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    return bad('Invalid text length');
  return value;
}

export function parsePlatformPayload(
  value: unknown,
  regeneration = false,
): PlatformChatInput {
  const obj = object(value, [
    'localConversationId',
    'question',
    'history',
    'images',
  ]);
  const localConversationId = uuid(obj.localConversationId);
  const question = string(obj.question ?? '', 4000).trim();
  if (regeneration && question)
    return bad('Regeneration uses the original question');
  const rawHistory = obj.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > 20)
    return bad('At most 20 history messages are allowed');
  let historyChars = 0;
  const ids = new Set<string>();
  const history = rawHistory.map((value): PlatformHistoryMessage => {
    const item = object(value, ['id', 'role', 'content', 'imageSummary']);
    const id = uuid(item.id);
    if (ids.has(id)) return bad('Duplicate history ID');
    ids.add(id);
    if (item.role !== 'user' && item.role !== 'assistant')
      return bad('Only user and assistant history is allowed');
    const content = string(item.content, 32000);
    const imageSummary =
      item.imageSummary == null ? undefined : string(item.imageSummary, 6000);
    if (imageSummary && item.role !== 'user')
      return bad('Image summaries belong to user messages');
    historyChars += content.length + (imageSummary?.length ?? 0);
    return {
      id,
      role: item.role,
      content,
      ...(imageSummary ? { imageSummary } : {}),
    };
  });
  if (historyChars > 32000) return bad('History exceeds 32000 characters');
  const rawImages = obj.images ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > 3)
    return bad('At most 3 images are allowed');
  const imageIds = new Set<string>();
  const images = rawImages.map((value): PlatformImageRef => {
    const item = object(value, ['id', 'messageId']);
    const id = uuid(item.id);
    if (imageIds.has(id)) return bad('Duplicate image ID');
    imageIds.add(id);
    const messageId = item.messageId == null ? undefined : uuid(item.messageId);
    if (
      messageId &&
      !history.some((m) => m.id === messageId && m.role === 'user')
    )
      return bad('Image history message not found');
    return { id, ...(messageId ? { messageId } : {}) };
  });
  if (!regeneration && !question && !images.some((i) => !i.messageId))
    return bad('A question or current image is required');
  return { localConversationId, question, history, images };
}

export async function readPlatformInput(
  req: FastifyRequest,
  regeneration = false,
): Promise<{
  input: PlatformChatInput;
  files: PlatformImageFile[];
}> {
  const files: PlatformImageFile[] = [];
  let payload: unknown;
  try {
    if (req.isMultipart()) {
      let seenPayload = false;
      for await (const part of req.parts({
        limits: {
          files: 3,
          fileSize: MAX_IMAGE_BYTES,
          fields: 1,
          fieldSize: MAX_PAYLOAD_BYTES,
          fieldNameSize: 64,
          parts: 4,
        },
      })) {
        if (part.type === 'field') {
          if (
            seenPayload ||
            part.fieldname !== 'payload' ||
            part.valueTruncated ||
            typeof part.value !== 'string'
          )
            return bad('Expected one JSON payload field');
          seenPayload = true;
          try {
            payload = JSON.parse(part.value);
          } catch {
            return bad('Invalid payload JSON');
          }
        } else {
          if (!part.fieldname.startsWith('image_'))
            return bad('Image field must be image_<id>');
          const id = uuid(part.fieldname.slice(6));
          if (files.some((f) => f.id === id))
            return bad('Duplicate image file');
          if (
            !['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype)
          )
            return bad('Only JPEG, PNG and WebP images are allowed');
          const bytes = await part.toBuffer();
          if (part.file.truncated || bytes.length > MAX_IMAGE_BYTES)
            throw new HttpException(
              'Image exceeds 10 MiB',
              HttpStatus.PAYLOAD_TOO_LARGE,
            );
          if (!bytes.length) return bad('Empty image');
          files.push({ id, mimeType: part.mimetype, bytes });
        }
      }
      if (!seenPayload) return bad('Missing payload');
    } else {
      if (!req.headers['content-type']?.startsWith('application/json'))
        return bad('Expected JSON or multipart/form-data');
      payload = req.body;
      if (Buffer.byteLength(JSON.stringify(payload) ?? '') > MAX_PAYLOAD_BYTES)
        throw new HttpException(
          'Payload too large',
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
    }
    const input = parsePlatformPayload(payload, regeneration);
    if (
      files.length !== input.images.length ||
      input.images.some((ref) => !files.some((f) => f.id === ref.id))
    )
      return bad('Image manifest does not match files');
    return { input, files };
  } catch (error) {
    files.length = 0;
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('FST_'))
      throw new HttpException(
        'Upload limit exceeded',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    throw error;
  }
}
