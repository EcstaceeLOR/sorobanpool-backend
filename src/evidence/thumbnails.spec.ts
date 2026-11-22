import sharp from 'sharp';
import { THUMB_WIDTHS, thumbKey, toPublicThumbnail } from './evidence.js';

const sample = (format: 'jpeg' | 'png') =>
  sharp({ create: { width: 1200, height: 900, channels: 3, background: '#c33' } })[format]().toBuffer();

describe('product thumbnails (#104)', () => {
  it.each(['jpeg', 'png'] as const)('creates 320 and 800 px WebP thumbnails from a %s', async (format) => {
    const input = await sample(format);
    for (const width of THUMB_WIDTHS) {
      const out = await toPublicThumbnail(input, width);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(Math.round((900 * width) / 1200));
    }
  });

  it('never enlarges a source smaller than the thumbnail width', async () => {
    const small = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#33c' } }).png().toBuffer();
    const meta = await sharp(await toPublicThumbnail(small, 320)).metadata();
    expect(meta.width).toBe(200);
  });

  it('rejects bytes that are not an image, so the caller can skip the thumbnail', async () => {
    await expect(toPublicThumbnail(Buffer.from('not an image'), 320)).rejects.toThrow();
  });

  it('stores thumbnails beside the original under a width-specific key', () => {
    expect(thumbKey('product/abc', 320)).toBe('product/abc@320.webp');
    expect(thumbKey('product/abc', 800)).toBe('product/abc@800.webp');
  });
});
