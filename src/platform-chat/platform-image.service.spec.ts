import sharp from 'sharp';
import { PlatformImageService } from './platform-image.service';

describe('platform image normalization', () => {
  const service = new PlatformImageService();
  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodes %s, bounds size and strips metadata',
    async (format) => {
      const bytes = await sharp({
        create: { width: 3000, height: 40, channels: 3, background: 'white' },
      })
        .withMetadata({ orientation: 1 })
        .toFormat(format)
        .toBuffer();
      const result = await service.normalize({
        id: 'image',
        mimeType: 'image/' + format,
        bytes,
      });
      expect(result.width).toBe(2048);
      expect(result.size).toBeLessThan(4 * 1024 * 1024);
      const output = await sharp(
        Buffer.from(result.dataUrl.split(',')[1], 'base64'),
      ).metadata();
      expect(output.format).toBe('jpeg');
      expect(output.exif).toBeUndefined();
    },
  );
  it('rejects a spoofed MIME type and corrupted file', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(
      service.normalize({ id: 'i', mimeType: 'image/jpeg', bytes: png }),
    ).rejects.toThrow();
    await expect(
      service.normalize({
        id: 'i',
        mimeType: 'image/png',
        bytes: Buffer.from('%PDF-1.7'),
      }),
    ).rejects.toThrow();
  });
  it('does not start work after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.normalize(
        { id: 'i', mimeType: 'image/png', bytes: Buffer.alloc(0) },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it('rejects animated WebP and PNG animation control chunks', async () => {
    const frames = Buffer.alloc(2 * 4 * 3);
    frames.fill(255, 2 * 2 * 3);
    const webp = await sharp(frames, {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(webp).metadata()).pages).toBe(2);
    await expect(
      service.normalize({ id: 'i', mimeType: 'image/webp', bytes: webp }),
    ).rejects.toThrow();
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const control = Buffer.alloc(20);
    control.writeUInt32BE(8);
    control.write('acTL', 4);
    control.writeUInt32BE(2, 8);
    const apng = Buffer.concat([
      png.subarray(0, 33),
      control,
      png.subarray(33),
    ]);
    await expect(
      service.normalize({ id: 'i', mimeType: 'image/png', bytes: apng }),
    ).rejects.toThrow();
  });
});
