import sharp from 'sharp';
import type { Lang } from '../notifications/templates.js';

export interface ShareCardInput {
  product: string;
  supplier: string;
  currentPriceNaira: string;
  nextBreak?: { unitsToGo: number; priceNaira: string };
  unitsToMoq: number;
  progressPct: number;
  /** Fill deadline; formatted here so every card shows it the same way in every language. */
  deadline: Date;
}

/**
 * `wide` is the 1200x630 Open Graph size WhatsApp, X and most chat apps use for link previews; `square` is 1080x1080
 * for status updates and apps that crop previews to a square (#175).
 */
export type ShareCardVariant = 'wide' | 'square';

export const SHARE_CARD_SIZES: Record<ShareCardVariant, { width: number; height: number }> = {
  wide: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
};

/**
 * Copy per language (#176). Only ASCII plus the arrow, middle dot and ellipsis the English card already used, so the
 * default sans-serif font renders every label. Naira is written `N` (not the naira sign) for the same reason.
 */
const LABELS: Record<Lang, { tagline: string; perUnitNow: string; moreUnits: string; bestPrice: string; unitsToGo: string; minimumReached: string; closes: string; builtOn: string }> = {
  EN: {
    tagline: 'Buy together. Pay on delivery.',
    perUnitNow: ' / unit now',
    moreUnits: 'more units',
    bestPrice: 'Best price reached',
    unitsToGo: 'units to go',
    minimumReached: 'Minimum reached',
    closes: 'closes',
    builtOn: 'Built on Stellar',
  },
  PCM: {
    tagline: 'Buy together. Pay when goods reach.',
    perUnitNow: ' / unit now',
    moreUnits: 'more units remain',
    bestPrice: 'Best price don reach',
    unitsToGo: 'units remain',
    minimumReached: 'Minimum don reach',
    closes: 'go close',
    builtOn: 'Built on Stellar',
  },
};

/** Layout per variant: font sizes, baselines and how many characters fit on a line before it is ellipsised. */
const LAYOUT: Record<ShareCardVariant, {
  pad: number; tagline: [number, number]; product: [number, number, number]; supplier: [number, number, number];
  price: [number, number]; next: [number, number]; bar: number; goal: [number, number]; footer: [number, number];
}> = {
  // [fontSize, y] or [fontSize, y, maxChars]
  wide: { pad: 60, tagline: [30, 110], product: [64, 210, 34], supplier: [30, 262, 48], price: [96, 380], next: [34, 440], bar: 480, goal: [30, 560], footer: [24, 590] },
  square: { pad: 60, tagline: [34, 130], product: [64, 300, 27], supplier: [34, 370, 44], price: [110, 560], next: [38, 650], bar: 710, goal: [36, 820], footer: [28, 1020] },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Truncates by code point so a name never ends in half a surrogate pair. */
export const clip = (s: string, n: number) => {
  const cps = [...s];
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : s;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Deadline in West Africa Time (UTC+1, no DST), e.g. `21 Nov 2026`, identical for every language and server locale. */
export function formatDeadline(d: Date): string {
  const wat = new Date(d.getTime() + 3_600_000);
  return `${wat.getUTCDate()} ${MONTHS[wat.getUTCMonth()]} ${wat.getUTCFullYear()}`;
}

/** Share card SVG. All text is escaped; nothing user-supplied is trusted. */
export function shareCardSvg(i: ShareCardInput, variant: ShareCardVariant = 'wide', lang: Lang = 'EN'): string {
  const { width, height } = SHARE_CARD_SIZES[variant];
  const L = LAYOUT[variant];
  const t = LABELS[lang];
  const pct = Math.max(0, Math.min(100, Math.round(i.progressPct)));
  const barWidth = width - 2 * L.pad;
  const next = i.nextBreak
    ? `${i.nextBreak.unitsToGo} ${t.moreUnits} → N${i.nextBreak.priceNaira}/unit`
    : t.bestPrice;
  const goal = i.unitsToMoq > 0 ? `${i.unitsToMoq} ${t.unitsToGo}` : t.minimumReached;
  const text = (size: number, y: number, fill: string, body: string, extra = '') =>
    `<text x="${L.pad}" y="${y}" font-family="sans-serif" font-size="${size}" fill="${fill}"${extra}>${body}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<rect width="${width}" height="14" fill="#0b6b3a"/>
${text(L.tagline[0], L.tagline[1], '#0b6b3a', esc(t.tagline), ' font-weight="700"')}
${text(L.product[0], L.product[1], '#111', esc(clip(i.product, L.product[2])), ' font-weight="700"')}
${text(L.supplier[0], L.supplier[1], '#555', esc(clip(i.supplier, L.supplier[2])))}
${text(L.price[0], L.price[1], '#0b6b3a', `N${esc(i.currentPriceNaira)}<tspan font-size="${Math.round(L.price[0] * 0.375)}" fill="#555">${esc(t.perUnitNow)}</tspan>`, ' font-weight="700"')}
${text(L.next[0], L.next[1], '#111', esc(next))}
<rect x="${L.pad}" y="${L.bar}" width="${barWidth}" height="28" rx="14" fill="#e5e7eb"/>
<rect x="${L.pad}" y="${L.bar}" width="${Math.round(barWidth * pct / 100)}" height="28" rx="14" fill="#0b6b3a"/>
${text(L.goal[0], L.goal[1], '#111', `${esc(goal)} · ${esc(t.closes)} ${esc(formatDeadline(i.deadline))}`)}
<text x="${width - L.pad}" y="${L.footer[1]}" font-family="sans-serif" font-size="${L.footer[0]}" fill="#777" text-anchor="end">${esc(t.builtOn)}</text>
</svg>`;
}

/** Rendered PNGs, keyed by the full SVG (so by variant, language and every value on the card). Bounded. */
const RENDER_CACHE_MAX = 200;
const renderCache = new Map<string, Buffer>();

export async function renderShareCard(i: ShareCardInput, variant: ShareCardVariant = 'wide', lang: Lang = 'EN'): Promise<Buffer> {
  const svg = shareCardSvg(i, variant, lang);
  const hit = renderCache.get(svg);
  if (hit) return hit;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value!);
  renderCache.set(svg, png);
  return png;
}

/** Test seam. */
export const clearShareCardCache = () => renderCache.clear();
