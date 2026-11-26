/**
 * Claim writers (01-PRODUCT rewards; ECO-04, ECO-07, ECO-16; ADR-0011 §6).
 *
 * - R = Q: `ledger.claim(account)` on the ledger the registry records for the pair.
 * - R = T: `claimAsT(bytes32 pairId, minTOut, deadline)` on the deployment's converter, converting the WHOLE
 *   entitlement. `minTOut` comes from an `eth_call` quote of that very conversion (same pair id, the holder as sender,
 *   `minTOut = 0`, the same deadline) at the latest block: `minTOut = floor(quote × (10000 − 100) / 10000)`, the
 *   documented 1% tolerance (`CLAIM_AS_T_TOLERANCE_BPS`, not a user setting), deadline = now + 20 minutes.
 * - The emergency payout in Q (`claimAsQWhenSoldOut`) is a DIFFERENT payout: it is prepared only on its own explicit
 *   request, and only while the converter reports the pool sold out (`isSoldOut`), i.e. conversion is impossible. It is
 *   never chosen automatically; a sold-out conversion attempt is refused with `fallback` naming it.
 * A zero entitlement is refused before simulation: `claim` would succeed and pay nothing, which is not a claim.
 * Every prepare first re-checks the manifest's wiring on chain and that the RPC serves the manifest's chain
 * (`checkDeploymentWiring`, ADR-0012 Part B §4), as createLaunch does: the ledger target of `claim` comes from the
 * registry the RPC answers for, so that registry must be the reviewed one.
 */
import { minPayoutRaw, type Address } from '@squarehole/domain';
import type { Hex } from 'viem';
import { squareHoleClaimConverterAbi as converterAbi } from '../abi/squareHoleClaimConverter';
import { rewardLedgerAbi as ledgerAbi } from '../abi/rewardLedger';
import { claimAsQWhenSoldOutCall, claimAsTCall, claimCall } from './calls';
import { testnetMockDisclosure, type WriteDeployment } from './deployment';
import { PrepareRefusal, type PreparedWrite, type VerifyOutcome } from './prepared';
import { checkDeploymentWiring, eventsFrom, readContract, readRegistryPair, registryPairId, type RegistryPair } from './registry-reads';
import { decodeRevert, revertDataOf, revertReason } from './revert';
import type { ChainReader, TxReceipt } from './rpc';
import { RpcRequestError } from './rpc';

/** Signed-minimum tolerance of an R = T conversion (1%; same documented constant as ADR-0008's draft tolerance). */
export const CLAIM_AS_T_TOLERANCE_BPS = 100;
/** Quote validity: the on-chain `deadline` and the app's pre-signing expiry (ADR-0008 "Quote expiry": 20 minutes). */
export const CLAIM_AS_T_DEADLINE_SECONDS = 20 * 60;

const MAX_UINT256 = 2n ** 256n - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

export interface ClaimContext {
  readonly reader: ChainReader;
  readonly deployment: WriteDeployment;
  readonly account: Address;
}

export interface ClaimedQ {
  readonly kind: 'claimed_q';
  readonly amountQRaw: bigint;
  readonly quote: Address;
}
export interface ConvertedToT {
  readonly kind: 'converted_to_t';
  readonly qInRaw: bigint;
  readonly tOutRaw: bigint;
  readonly token: Address;
}
export interface PaidInQSoldOut {
  readonly kind: 'paid_in_q_sold_out';
  readonly amountQRaw: bigint;
  readonly quote: Address;
}
export type ClaimOutcome = ClaimedQ | ConvertedToT | PaidInQSoldOut;

function withMockDisclosure(deployment: WriteDeployment, quote: Address, details: { label: string; value: string }[]): readonly { label: string; value: string }[] {
  const mock = testnetMockDisclosure(deployment, quote);
  return Object.freeze(mock === null ? details : [...details, { label: 'Testnet mock quote', value: mock }]);
}

async function pairFor(ctx: ClaimContext, token: Address): Promise<RegistryPair> {
  const pairId = registryPairId(ctx.deployment.chainId, token);
  let pair: RegistryPair | null;
  try {
    pair = await readRegistryPair(ctx.reader, ctx.deployment, pairId);
  } catch (error) {
    throw new PrepareRefusal('read_failed', `the registry could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
  }
  if (pair === null) throw new PrepareRefusal('unknown_pair', `the registry has no pair for token ${token} on chain ${ctx.deployment.chainId}`);
  return pair;
}

async function claimableOf(ctx: ClaimContext, pair: RegistryPair): Promise<bigint> {
  const claimable = await readContract<bigint>(ctx.reader, pair.ledger, ledgerAbi, 'claimable', [ctx.account]);
  if (claimable === 0n) throw new PrepareRefusal('nothing_to_claim', 'this account has nothing claimable for this pair');
  return claimable;
}

/** Conversion state for a page deciding which R = T actions to offer. Read failures throw (never "not sold out"). */
export interface ConversionStatus {
  readonly soldOut: boolean;
  readonly claimableQRaw: bigint;
}

export async function readConversionStatus(ctx: ClaimContext, token: Address): Promise<ConversionStatus> {
  const pair = await pairFor(ctx, token);
  if (pair.rewardSide !== 1 || ctx.deployment.converter === null) throw new PrepareRefusal('wrong_payout_side', 'this pair does not pay claims in T');
  const [soldOut, claimableQRaw] = await Promise.all([
    readContract<boolean>(ctx.reader, ctx.deployment.converter, converterAbi, 'isSoldOut', [pair.token]),
    readContract<bigint>(ctx.reader, pair.ledger, ledgerAbi, 'claimable', [ctx.account]),
  ]);
  return Object.freeze({ soldOut, claimableQRaw });
}

/** R = Q claim of the whole entitlement. */
export async function prepareClaim(ctx: ClaimContext, token: Address): Promise<PreparedWrite<ClaimOutcome>> {
  await checkDeploymentWiring(ctx.reader, ctx.deployment);
  const pair = await pairFor(ctx, token);
  if (pair.rewardSide !== 0) throw new PrepareRefusal('wrong_payout_side', 'this pair pays claims in T: claim through the converter (claim as T)');
  const [payoutAsset, ledgerToken] = await Promise.all([
    readContract<number>(ctx.reader, pair.ledger, ledgerAbi, 'payoutAsset'),
    readContract<Address>(ctx.reader, pair.ledger, ledgerAbi, 'token'),
  ]);
  if (payoutAsset !== 0 || ledgerToken.toLowerCase() !== pair.token.toLowerCase()) throw new PrepareRefusal('wiring', 'the ledger does not match the registry record');
  const claimable = await claimableOf(ctx, pair);
  return Object.freeze({
    call: claimCall(pair.ledger, ctx.account),
    expectedLedger: pair.ledger,
    details: withMockDisclosure(ctx.deployment, pair.quote, [
      { label: 'Contract', value: `RewardLedger ${pair.ledger} · claim` },
      { label: 'Claimable now', value: `${claimable} raw Q (${pair.quote})` },
      { label: 'Paid to', value: `${ctx.account} (the connected account only)` },
    ]),
    verify: async (receipt: TxReceipt): Promise<VerifyOutcome<ClaimOutcome>> => {
      const claimed = eventsFrom<{ account: Address; recipient: Address; amount: bigint }>(receipt.logs, pair.ledger, ledgerAbi, 'Claimed');
      const own = claimed.filter((c) => c.account.toLowerCase() === ctx.account.toLowerCase() && c.recipient.toLowerCase() === ctx.account.toLowerCase());
      if (own.length !== 1 || (own[0]?.amount ?? 0n) === 0n) return { ok: false, reason: 'the receipt has no Claimed event paying this account' };
      return { ok: true, result: Object.freeze({ kind: 'claimed_q', amountQRaw: own[0]?.amount ?? 0n, quote: pair.quote }) };
    },
  });
}

export interface ClaimAsTQuote {
  readonly qInRaw: bigint;
  readonly tOutRaw: bigint;
  readonly minTOutRaw: bigint;
  readonly toleranceBps: number;
  readonly deadline: bigint;
  readonly quotedAtBlock: bigint;
}

/** `eth_call` of the exact conversion with `minTOut = 0` from the holder: the quote `minTOut` is derived from. */
export async function quoteClaimAsT(ctx: ClaimContext, pairId: Hex, deadline: bigint): Promise<ClaimAsTQuote> {
  const converter = ctx.deployment.converter;
  if (converter === null) throw new PrepareRefusal('wrong_payout_side', 'this deployment has no claim converter');
  const block = await ctx.reader.blockNumber();
  let result: readonly [bigint, bigint];
  try {
    result = await readContract<readonly [bigint, bigint]>(ctx.reader, converter, converterAbi, 'claimAsT', [pairId, 0n, deadline], block, ctx.account);
  } catch (error) {
    const data = revertDataOf(error);
    if (data === null && !(error instanceof RpcRequestError && error.code === 3)) {
      throw new PrepareRefusal('read_failed', `the conversion quote could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
    }
    throw new PrepareRefusal('quote_failed', `The conversion cannot be quoted: ${revertReason(data ? decodeRevert(data) : null, 'the quote call reverted')}`);
  }
  const [qInRaw, tOutRaw] = result;
  if (tOutRaw === 0n) throw new PrepareRefusal('quote_failed', 'The conversion would pay no T.');
  return Object.freeze({
    qInRaw,
    tOutRaw,
    minTOutRaw: minPayoutRaw(tOutRaw, CLAIM_AS_T_TOLERANCE_BPS),
    toleranceBps: CLAIM_AS_T_TOLERANCE_BPS,
    deadline,
    quotedAtBlock: block,
  });
}

/** R = T: converts the whole entitlement with a quoted minimum. `deadline` is unix seconds (now + 20 minutes). */
export async function prepareClaimAsT(ctx: ClaimContext, token: Address, deadline: bigint): Promise<PreparedWrite<ClaimOutcome> & { readonly quote: ClaimAsTQuote }> {
  await checkDeploymentWiring(ctx.reader, ctx.deployment);
  const pair = await pairFor(ctx, token);
  const converter = ctx.deployment.converter;
  if (pair.rewardSide !== 1 || converter === null || pair.converter.toLowerCase() !== converter.toLowerCase() || pair.converter.toLowerCase() === ZERO) {
    throw new PrepareRefusal('wrong_payout_side', 'this pair does not pay claims in T through this deployment’s converter');
  }
  await claimableOf(ctx, pair);
  const soldOut = await readContract<boolean>(ctx.reader, converter, converterAbi, 'isSoldOut', [pair.token]);
  if (soldOut) {
    throw new PrepareRefusal(
      'sold_out',
      'The pool is sold out, so no conversion to T can fill. A different payout, the emergency payout in Q, is available as a separate, labelled request.',
      'claim_as_q_when_sold_out',
    );
  }
  const quote = await quoteClaimAsT(ctx, pair.pairId, deadline);
  return Object.freeze({
    quote,
    call: claimAsTCall(ctx.deployment, pair.pairId, quote.minTOutRaw, deadline),
    expectedLedger: null,
    details: withMockDisclosure(ctx.deployment, pair.quote, [
      { label: 'Contract', value: `SquareHoleClaimConverter ${converter} · claimAsT(bytes32,uint256,uint256)` },
      { label: 'Entitlement converted', value: `${quote.qInRaw} raw Q (the whole claimable amount)` },
      { label: 'Quoted payout', value: `${quote.tOutRaw} raw T (eth_call of this conversion at block ${quote.quotedAtBlock})` },
      { label: 'Signed minimum', value: `${quote.minTOutRaw} raw T (quote − ${CLAIM_AS_T_TOLERANCE_BPS / 100}%, fixed tolerance)` },
      { label: 'Deadline', value: new Date(Number(deadline) * 1000).toISOString() },
      { label: 'Fee', value: 'The conversion goes through the pair’s pool and pays its 3% LP fee from the converted Q' },
    ]),
    verify: async (receipt: TxReceipt): Promise<VerifyOutcome<ClaimOutcome>> => {
      const converted = eventsFrom<{ token: Address; holder: Address; qIn: bigint; tOut: bigint }>(receipt.logs, converter, converterAbi, 'ClaimConverted');
      const own = converted.filter((c) => c.holder.toLowerCase() === ctx.account.toLowerCase() && c.token.toLowerCase() === pair.token.toLowerCase());
      const event = own[0];
      if (own.length !== 1 || event === undefined) return { ok: false, reason: 'the receipt has no ClaimConverted event for this account and pair' };
      if (event.tOut < quote.minTOutRaw) return { ok: false, reason: 'the converted payout is below the signed minimum' };
      return { ok: true, result: Object.freeze({ kind: 'converted_to_t', qInRaw: event.qIn, tOutRaw: event.tOut, token: pair.token }) };
    },
  });
}

/**
 * The emergency payout in Q while the pool is sold out: only on the person's explicit choice of this labelled
 * request, and only while `isSoldOut(token)` is true (otherwise refused with `not_sold_out`).
 */
export async function prepareClaimAsQWhenSoldOut(ctx: ClaimContext, token: Address): Promise<PreparedWrite<ClaimOutcome>> {
  await checkDeploymentWiring(ctx.reader, ctx.deployment);
  const pair = await pairFor(ctx, token);
  const converter = ctx.deployment.converter;
  if (pair.rewardSide !== 1 || converter === null || pair.converter.toLowerCase() !== converter.toLowerCase()) {
    throw new PrepareRefusal('wrong_payout_side', 'this pair does not pay claims in T through this deployment’s converter');
  }
  const soldOut = await readContract<boolean>(ctx.reader, converter, converterAbi, 'isSoldOut', [pair.token]);
  if (!soldOut) throw new PrepareRefusal('not_sold_out', 'The pool is not sold out: the emergency payout in Q is unavailable; claim as T instead.');
  const claimable = await claimableOf(ctx, pair);
  return Object.freeze({
    call: claimAsQWhenSoldOutCall(ctx.deployment, pair.token, MAX_UINT256),
    expectedLedger: null,
    details: withMockDisclosure(ctx.deployment, pair.quote, [
      { label: 'Contract', value: `SquareHoleClaimConverter ${converter} · claimAsQWhenSoldOut` },
      { label: 'Payout', value: `EMERGENCY PAYOUT IN Q, not T: ${claimable} raw Q (${pair.quote}), because the pool is sold out` },
    ]),
    verify: async (receipt: TxReceipt): Promise<VerifyOutcome<ClaimOutcome>> => {
      const paid = eventsFrom<{ token: Address; holder: Address; qOut: bigint }>(receipt.logs, converter, converterAbi, 'ClaimPaidInQSoldOut');
      const own = paid.filter((p) => p.holder.toLowerCase() === ctx.account.toLowerCase() && p.token.toLowerCase() === pair.token.toLowerCase());
      if (own.length !== 1) return { ok: false, reason: 'the receipt has no ClaimPaidInQSoldOut event for this account and pair' };
      return { ok: true, result: Object.freeze({ kind: 'paid_in_q_sold_out', amountQRaw: own[0]?.qOut ?? 0n, quote: pair.quote }) };
    },
  });
}
