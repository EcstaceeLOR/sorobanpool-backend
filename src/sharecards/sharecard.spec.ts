import sharp from 'sharp';
import { clearShareCardCache, clip, formatDeadline, renderShareCard, SHARE_CARD_SIZES, shareCardSvg, type ShareCardInput } from './sharecard.js';

const base: ShareCardInput = {
  product: 'Rice 50kg', supplier: 'Tunde Foods', currentPriceNaira: '45,000',
  nextBreak: { unitsToGo: 30, priceNaira: '43,500' }, unitsToMoq: 12, progressPct: 60,
  deadline: new Date('2026-11-21T22:30:00Z'), // 21 Nov 23:30 WAT
};
const longName = 'Premium Long Grain Parboiled Rice Extra Special Family Pack 50kg Bag';

/** Text content of every <text> element, tags stripped. */
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));

describe('share card variants (#175)', () => {
  beforeEach(() => clearShareCardCache());

  it.each(['wide', 'square'] as const)('%s renders at its documented size with short and very long names', async (variant) => {
    const { width, height } = SHARE_CARD_SIZES[variant];
    for (const product of ['Rice', longName]) {
      const svg = shareCardSvg({ ...base, product }, variant);
      expect(svg).toContain(`width="${width}" height="${height}"`);
      const meta = await sharp(await renderShareCard({ ...base, product }, variant)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', width, height]);
    }
  });

  it('truncates long product names with an ellipsis, tighter on the narrower square card', () => {
    const wide = texts(shareCardSvg({ ...base, product: longName }, 'wide'));
    const square = texts(shareCardSvg({ ...base, product: longName }, 'square'));
    const wideName = wide.find((t) => t.startsWith('Premium'))!;
    const squareName = square.find((t) => t.startsWith('Premium'))!;
    expect(wideName.endsWith('…')).toBe(true);
    expect([...wideName]).toHaveLength(34);
    expect(squareName.endsWith('…')).toBe(true);
    expect([...squareName]).toHaveLength(27);
    expect(texts(shareCardSvg(base, 'square'))).toContain('Rice 50kg'); // short names are untouched
  });

  it('clips by code point, never splitting a character', () => {
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
    expect(clip('abc', 3)).toBe('abc');
  });

  it('defaults to the wide card, and caches each variant separately', async () => {
    expect(shareCardSvg(base)).toBe(shareCardSvg(base, 'wide'));
    const a = await renderShareCard(base, 'wide');
    expect(await renderShareCard(base, 'wide')).toBe(a); // cache hit: same buffer
    expect(await renderShareCard(base, 'square')).not.toBe(a);
  });
});

describe('share card language (#176)', () => {
  it('defaults to English labels', () => {
    const t = texts(shareCardSvg(base));
    expect(t).toContain('Buy together. Pay on delivery.');
    expect(t.join('\n')).toContain('12 units to go · closes 21 Nov 2026');
    expect(t.join('\n')).toContain('30 more units → N43,500/unit');
  });

  it('renders Pidgin labels with lang=PCM, with the same naira and deadline formatting', () => {
    const t = texts(shareCardSvg(base, 'wide', 'PCM'));
    expect(t).toContain('Buy together. Pay when goods reach.');
    expect(t.join('\n')).toContain('12 units remain · go close 21 Nov 2026');
    expect(t.join('\n')).toContain('30 more units remain → N43,500/unit');
    expect(texts(shareCardSvg({ ...base, nextBreak: undefined, unitsToMoq: 0 }, 'square', 'PCM'))).toEqual(
      expect.arrayContaining(['Best price don reach']),
    );
  });

  it('only uses characters the default sans-serif font covers', () => {
    for (const lang of ['EN', 'PCM'] as const) {
      const body = texts(shareCardSvg(base, 'square', lang)).join('');
      expect(body).toMatch(/^[\x20-\x7e→·…]*$/);
    }
  });

  it('formats the deadline in West Africa Time regardless of server timezone', () => {
    expect(formatDeadline(new Date('2026-11-21T23:30:00Z'))).toBe('22 Nov 2026'); // 00:30 WAT next day
    expect(formatDeadline(new Date('2026-01-05T10:00:00Z'))).toBe('5 Jan 2026');
  });
});
