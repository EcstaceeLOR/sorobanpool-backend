import { mulDivFloor } from '../common/money.js';

/** Mirrors the contract math in sorobanpool-contracts `sp_common::math`; parity-tested against pricing-vectors.json. */
export interface Tier {
  minUnits: number;
  unitPrice: bigint;
}

/** Index of the highest tier reached, or null below MOQ. */
export function tierIndex(tiers: readonly Tier[], totalUnits: number): number | null {
  let found: number | null = null;
  tiers.forEach((t, i) => {
    if (totalUnits >= t.minUnits) found = i;
  });
  return found;
}

/** The price a committer pays: the tier price before their units (the most they could end up paying). */
export function ceilingPrice(tiers: readonly Tier[], totalBefore: number): bigint {
  return tiers[tierIndex(tiers, totalBefore) ?? 0]!.unitPrice;
}

export const finalUnitPrice = ceilingPrice;

export function quoteCommit(tiers: readonly Tier[], totalBefore: number, units: number): bigint {
  return ceilingPrice(tiers, totalBefore) * BigInt(units);
}

/** Shortfall allocation in commit order; allocations sum to exactly `received`. */
export function cumulativeAlloc(cumBefore: number, units: number, received: number, total: number): number {
  const hi = mulDivFloor(BigInt(cumBefore + units), BigInt(received), BigInt(total));
  const lo = mulDivFloor(BigInt(cumBefore), BigInt(received), BigInt(total));
  return Number(hi - lo);
}

export function refundFor(paid: bigint, allocatedUnits: number, finalPrice: bigint): bigint {
  return paid - BigInt(allocatedUnits) * finalPrice;
}

export interface CommitCaps {
  tiers: readonly Tier[];
  poolTotalUnits: number;
  maxPerMember: number;
  maxUnits: number;
  maxMemberShareBp: number;
  maxMembersPerPool: number;
  traderTierCaps: readonly bigint[];
  memberUnits: number;
  memberPaid: bigint;
  memberCount: number;
  listedMembers: number;
  isListed: boolean;
  registryLevel: number;
  reputationTier: number;
  units: number;
}

export interface CommitCapFailure {
  error: 'OVER_MEMBER_LIMIT' | 'OVER_MEMBER_SHARE' | 'OVER_POOL_MAX' | 'TOO_MANY_MEMBERS' | 'OVER_TIER_CAP';
  contractCode: number;
  message: string;
  limit: number | string;
}

export function validateCommitCaps(c: CommitCaps): CommitCapFailure | undefined {
  const newUnits = c.memberUnits + c.units;
  if (newUnits > c.maxPerMember) {
    return { error: 'OVER_MEMBER_LIMIT', contractCode: 315, message: `You can commit at most ${c.maxPerMember} units to this pool`, limit: c.maxPerMember };
  }
  const shareCap = Math.max(1, Math.floor((c.maxUnits * c.maxMemberShareBp) / 10_000));
  const onlyMember = c.memberCount === 0 || (c.memberCount === 1 && c.memberUnits > 0);
  if (!onlyMember && newUnits > shareCap) {
    return { error: 'OVER_MEMBER_SHARE', contractCode: 316, message: `One member can take at most ${shareCap} units while others have joined`, limit: shareCap };
  }
  if (c.poolTotalUnits + c.units > c.maxUnits) {
    return { error: 'OVER_POOL_MAX', contractCode: 317, message: `This pool has room for ${Math.max(0, c.maxUnits - c.poolTotalUnits)} more units`, limit: c.maxUnits };
  }
  if (!c.isListed && c.listedMembers >= c.maxMembersPerPool) {
    return { error: 'TOO_MANY_MEMBERS', contractCode: 319, message: `This pool is full at ${c.maxMembersPerPool} members`, limit: c.maxMembersPerPool };
  }
  const traderTier = c.registryLevel === 0 ? 0 : c.reputationTier >= 2 ? 2 : 1;
  const cap = c.traderTierCaps[traderTier] ?? c.traderTierCaps[c.traderTierCaps.length - 1];
  if (cap === undefined) return undefined;
  const newPaid = c.memberPaid + quoteCommit(c.tiers, c.poolTotalUnits, c.units);
  if (newPaid > cap) {
    return { error: 'OVER_TIER_CAP', contractCode: 318, message: `Your verification tier allows ${formatCap(cap)} USDC in a pool`, limit: cap.toString() };
  }
  return undefined;
}

const formatCap = (stroops: bigint) => (Number(stroops) / 10_000_000).toLocaleString('en-US');

export interface CommitQuote {
  /** Maximum the member pays now. */
  amountNow: bigint;
  /** Price per unit if the pool closed right now. */
  currentUnitPrice: bigint;
  /** Refund if the pool closed at the current tier after this commit. */
  expectedRefundIfClosedNow: bigint;
  nextBreak: { minUnits: number; unitPrice: bigint; unitsToGo: number } | null;
}

/** Everything the "before you pay" screen shows. */
export function quote(tiers: readonly Tier[], totalUnits: number, units: number): CommitQuote {
  const amountNow = quoteCommit(tiers, totalUnits, units);
  const after = totalUnits + units;
  const currentUnitPrice = finalUnitPrice(tiers, Math.max(after, tiers[0]!.minUnits));
  const nextIdx = (tierIndex(tiers, after) ?? -1) + 1;
  const next = tiers[nextIdx];
  return {
    amountNow,
    currentUnitPrice,
    expectedRefundIfClosedNow: amountNow - currentUnitPrice * BigInt(units),
    nextBreak: next ? { minUnits: next.minUnits, unitPrice: next.unitPrice, unitsToGo: next.minUnits - after } : null,
  };
}
