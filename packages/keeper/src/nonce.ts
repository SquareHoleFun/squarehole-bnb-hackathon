/**
 * The keeper's own nonces, per signing key (review round 1, H2; SH-249 A3). viem's `prepareTransactionRequest` reads its
 * nonce manager from the request, not the account (viem 2.56.8, `prepareTransactionRequest.ts:309-315`), so the adapter
 * numbers each key's sends itself.
 *
 * SH-249: the source is the saved record (sent.ts), not the node's pending count. The next nonce follows the key's
 * highest saved nonce and is never below the mined (`latest`) count. A saved nonce may have been broadcast, so it is
 * never given to another call: no nonce is given back after an error and none is taken again after a quiet spell (the
 * earlier counter did both). The pending count is a check: it can only raise the nonce, so a transaction this record does
 * not know (signed elsewhere with the same key) is never replaced by ours.
 */
export function nextNonce(latest: bigint, pending: bigint, recorded?: bigint): bigint {
  let next = latest;
  if (recorded !== undefined && recorded > next) next = recorded;
  return pending > next ? pending : next;
}

/** The pending count shows transactions this record does not hold. */
export const nonceAhead = (latest: bigint, pending: bigint, recorded?: bigint) =>
  pending > (recorded !== undefined && recorded > latest ? recorded : latest);
