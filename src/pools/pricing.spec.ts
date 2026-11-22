import { quote, type Tier } from './pricing.js';
import { formatUsdc, toStroops } from '../common/money.js';

const tiers: Tier[] = [
  { minUnits: 100, unitPrice: toStroops('1') },
  { minUnits: 200, unitPrice: toStroops('0.9') },
  { minUnits: 400, unitPrice: toStroops('0.8') },
];

describe('quote', () => {
  it('charges the ceiling price and shows the next break', () => {
    const q = quote(tiers, 120, 100); // pool at 120 (tier 1), member adds 100 -> 220 (tier 2)
    expect(formatUsdc(q.amountNow)).toBe('100');
    expect(formatUsdc(q.currentUnitPrice)).toBe('0.9');
    expect(formatUsdc(q.expectedRefundIfClosedNow)).toBe('10');
    expect(q.nextBreak).toEqual({ minUnits: 400, unitPrice: toStroops('0.8'), unitsToGo: 180 });
  });

  it('has no next break at the top tier', () => {
    expect(quote(tiers, 450, 10).nextBreak).toBeNull();
    expect(quote(tiers, 400, 1).nextBreak).toBeNull();
  });

  it('reports the next break at each tier boundary and the unit before it', () => {
    expect(quote(tiers, 0, 10).nextBreak).toEqual({ minUnits: 100, unitPrice: toStroops('1'), unitsToGo: 90 });
    expect(quote(tiers, 99, 1).nextBreak).toEqual({ minUnits: 200, unitPrice: toStroops('0.9'), unitsToGo: 100 });
    expect(quote(tiers, 100, 1).nextBreak).toEqual({ minUnits: 200, unitPrice: toStroops('0.9'), unitsToGo: 99 });
    expect(quote(tiers, 199, 1).nextBreak).toEqual({ minUnits: 400, unitPrice: toStroops('0.8'), unitsToGo: 200 });
    expect(quote(tiers, 200, 1).nextBreak).toEqual({ minUnits: 400, unitPrice: toStroops('0.8'), unitsToGo: 199 });
    expect(quote(tiers, 399, 0).nextBreak).toEqual({ minUnits: 400, unitPrice: toStroops('0.8'), unitsToGo: 1 });
    expect(quote(tiers, 399, 1).nextBreak).toBeNull();
  });

  it('formats and parses money round trip', () => {
    expect(formatUsdc(toStroops('12.3456789'))).toBe('12.3456789');
    expect(() => toStroops('1.12345678')).toThrow();
  });
});
