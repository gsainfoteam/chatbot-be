import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { PlatformImageFile } from './platform-input';

// libvips may expose only the first frame of an APNG. Check its animation
// control chunk as well as the decoder's page count to enforce static input.
function isAnimatedPng(bytes: Buffer): boolean {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += 12 + length;
  }
  return false;
}

export interface NormalizedPlatformImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  size: number;
}

@Injectable()
export class PlatformImageService {
  async normalize(
    file: PlatformImageFile,
    signal?: AbortSignal,
  ): Promise<NormalizedPlatformImage> {
    signal?.throwIfAborted();
    try {
      if (isAnimatedPng(file.bytes)) throw new Error('Animated PNG');
      const image = sharp(file.bytes, {
        limitInputPixels: 40_000_000,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      const expected: Record<string, string> = {
        'image/jpeg': 'jpeg',
        'image/png': 'png',
        'image/webp': 'webp',
      };
      if (
        metadata.format !== expected[file.mimeType] ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error('Invalid format');
      const { data, info } = await image
        .rotate()
        .resize({
          width: 2048,
          height: 2048,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
      signal?.throwIfAborted();
      if (data.length > 4 * 1024 * 1024)
        throw new Error('Normalized image too large');
      return {
        id: file.id,
        dataUrl: 'data:image/jpeg;base64,' + data.toString('base64'),
        width: info.width,
        height: info.height,
        size: data.length,
      };
    } catch {
      signal?.throwIfAborted();
      throw new BadRequestException(
        '이미지를 읽을 수 없습니다. 정적 JPEG·PNG·WebP 및 40MP 이하 이미지를 사용해 주세요.',
      );
    }
  }
}
