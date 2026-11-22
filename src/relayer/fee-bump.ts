import { Keypair, TransactionBuilder, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import { SponsorshipError } from './allowlist.js';

/**
 * Refuses any inner transaction that carries more than one operation. The sponsor pays for the whole envelope, so an
 * extra operation (a transfer or a second call bundled into a sponsored one) would be paid for without being checked.
 */
export function assertSingleOperation(inner: Transaction): void {
  if (inner.operations.length !== 1) {
    throw new SponsorshipError(
      'UNEXPECTED_OPERATIONS',
      `expected exactly one operation, found ${inner.operations.length}; the transaction is not sponsored`,
    );
  }
}

/**
 * Wraps a user-signed inner transaction in a fee bump paid by the sponsor, so users never hold XLM.
 * `baseFee` must be at least the inner transaction's fee rate or Stellar rejects the bump.
 */
export function feeBump(
  sponsor: Keypair,
  inner: Transaction,
  networkPassphrase: string,
  baseFee: string,
): FeeBumpTransaction {
  assertSingleOperation(inner);
  if (BigInt(baseFee) < BigInt(Math.ceil(Number(inner.fee) / Math.max(inner.operations.length, 1)))) {
    throw new Error('fee bump base fee is lower than the inner transaction fee rate');
  }
  const bumped = TransactionBuilder.buildFeeBumpTransaction(sponsor, baseFee, inner, networkPassphrase);
  bumped.sign(sponsor);
  return bumped;
}

/** Runway in days given balance, average daily spend; the sponsor-balance job alerts below 7. */
export function runwayDays(balanceStroops: bigint, avgDailySpendStroops: bigint): number {
  if (avgDailySpendStroops <= 0n) return Number.POSITIVE_INFINITY;
  return Number(balanceStroops / avgDailySpendStroops);
}
