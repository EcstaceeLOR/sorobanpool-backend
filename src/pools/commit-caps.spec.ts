import { toStroops } from '../common/money.js';
import { validateCommitCaps, type CommitCaps } from './pricing.js';

const oneUsdc = toStroops('1');
const base = (): CommitCaps => ({
  tiers: [{ minUnits: 100, unitPrice: oneUsdc }],
  poolTotalUnits: 0,
  maxPerMember: 10,
  maxUnits: 100,
  maxMemberShareBp: 5000,
  maxMembersPerPool: 200,
  traderTierCaps: [toStroops('50'), toStroops('500'), toStroops('2500')],
  memberUnits: 0,
  memberPaid: 0n,
  memberCount: 1,
  listedMembers: 1,
  isListed: false,
  registryLevel: 1,
  reputationTier: 0,
  units: 10,
});

describe('validateCommitCaps', () => {
  it('allows the per-member limit and rejects one unit over with code 315', () => {
    expect(validateCommitCaps(base())).toBeUndefined();
    expect(validateCommitCaps({ ...base(), units: 11 })).toMatchObject({ error: 'OVER_MEMBER_LIMIT', contractCode: 315, limit: 10 });
  });

  it('allows the member share cap and rejects one unit over with code 316', () => {
    const c = { ...base(), maxPerMember: 100, memberCount: 2, isListed: true, registryLevel: 0, units: 50 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 51 })).toMatchObject({ error: 'OVER_MEMBER_SHARE', contractCode: 316, limit: 50 });
  });

  it('allows a full pool and rejects one unit over with code 317', () => {
    const c = { ...base(), maxPerMember: 100, maxUnits: 60, memberCount: 0, listedMembers: 0, isListed: false, units: 60 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 61 })).toMatchObject({ error: 'OVER_POOL_MAX', contractCode: 317, limit: 60 });
  });

  it('allows a new member below the member cap and rejects one over with code 319', () => {
    const c = { ...base(), maxMembersPerPool: 1, listedMembers: 0, isListed: false, units: 1 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, listedMembers: 1 })).toMatchObject({ error: 'TOO_MANY_MEMBERS', contractCode: 319, limit: 1 });
  });

  it('allows the verification-tier cap and rejects one unit over with code 318', () => {
    const c = { ...base(), maxPerMember: 1000, maxUnits: 1000, memberCount: 0, listedMembers: 0, isListed: false, units: 500 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 501 })).toMatchObject({ error: 'OVER_TIER_CAP', contractCode: 318, limit: toStroops('500').toString() });
  });

  it('uses the tier-2 cap once the member has a reputation tier', () => {
    const c = { ...base(), maxPerMember: 3000, maxUnits: 3000, memberCount: 0, listedMembers: 0, isListed: false, reputationTier: 2, units: 2500 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 2501 })).toMatchObject({ error: 'OVER_TIER_CAP', limit: toStroops('2500').toString() });
  });

  it('falls back to the last trader tier cap when the computed tier is missing', () => {
    const c = {
      ...base(),
      maxPerMember: 3000,
      maxUnits: 3000,
      memberCount: 0,
      listedMembers: 0,
      isListed: false,
      reputationTier: 2,
      traderTierCaps: [toStroops('50'), toStroops('500')],
      units: 500,
    };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 501 })).toMatchObject({ error: 'OVER_TIER_CAP', limit: toStroops('500').toString() });
  });

  it('skips tier cap checks when no trader tier cap is configured', () => {
    const c = {
      ...base(),
      maxPerMember: 3000,
      maxUnits: 3000,
      memberCount: 0,
      listedMembers: 0,
      isListed: false,
      reputationTier: 2,
      traderTierCaps: [],
      units: 3000,
    };
    expect(validateCommitCaps(c)).toBeUndefined();
  });

  it('counts already paid units towards the tier cap when a member increases', () => {
    const c = { ...base(), maxPerMember: 1000, maxUnits: 1000, memberCount: 1, isListed: true, memberUnits: 400, memberPaid: 400n * oneUsdc, units: 100 };
    expect(validateCommitCaps(c)).toBeUndefined();
    expect(validateCommitCaps({ ...c, units: 101 })).toMatchObject({ error: 'OVER_TIER_CAP', limit: toStroops('500').toString() });
  });
});
