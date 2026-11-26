import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, erc20Abi, parseAbi, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import type { CoreReader } from '../core-reader';
import type { BoxRowV2 } from '../core-row';
import { coordinatorV2Abi, royaltyRouterV2Abi, INBOX_CLAIM_NOTICE_V21 } from './chain-v2';
import type { HolderClaimReaderV2 } from './m2-reads-v2';
import { creatorQuoteCodeV2 } from './claims-quote-code';
import type { CreatorClaimReaderV2 } from '../../../../chain/src/core/v2/creator-claim-reader';
export { readCreatorClaimV2 } from '../../../../chain/src/core/v2/creator-claim-reader';

export type ClaimsReaderV2 = CreatorClaimReaderV2 & Pick<CoreReader, 'headerByNumber'>;
/** Read-only simulations are bounded, including token payout callbacks. No gas or value is spent. */
export const CLAIM_SIMULATION_GAS = 5_000_000n;
const creatorQuoteAbi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
/** Canonical EIP-1898 reads and sender-aware simulations for creator claims (including lazy graduation). */
export function claimsRpcReaderV2(client: Pick<PublicClient, 'request' | 'getBlock'>): ClaimsReaderV2 {
  const call = (to: Address, data: Hex, hash: Hex, from?: Address) => client.request({ method: 'eth_call',
    params: [{ to, data, ...(from ? { from, gas: toHex(CLAIM_SIMULATION_GAS) } : {}) }, { blockHash: hash, requireCanonical: true }] } as never) as Promise<Hex>;
  return {
    callAt: call, callFromAt: (from, to, data, hash) => call(to, data, hash, from),
    creatorEntitlementAt: async (wallet, receiver, asset, hash) => {
      // Only the payee's code is overridden for this isolated eth_call. Receiver/PM code and storage remain
      // canonical. The helper invokes the non-P settlement path, then reads creatorP; it never pays anyone.
      const data = await client.request({ method: 'eth_call', params: [
        { from: wallet, to: wallet, data: encodeFunctionData({ abi: creatorQuoteAbi, functionName: 'quote', args: [receiver, asset] }), gas: toHex(CLAIM_SIMULATION_GAS) },
        { blockHash: hash, requireCanonical: true }, { [wallet]: { code: creatorQuoteCodeV2 } },
      ] } as never) as Hex;
      return decodeFunctionResult({ abi: creatorQuoteAbi, functionName: 'quote', data });
    },
    headerByNumber: async number => {
      const block = await client.getBlock({ blockNumber: number });
      if (block.number === null || block.hash === null) return null;
      return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
    },
  };
}

export async function claimReadV2<T>(r: HolderClaimReaderV2, hash: Hex, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> {
  return decodeFunctionResult({ abi, functionName: fn, data: await r.callAt(to, encodeFunctionData({ abi, functionName: fn, args }), hash) }) as T;
}

/** Decode contract refusals through RPC/viem wrappers; never classify by an error's message. */
function claimErrorName(error: unknown): string | undefined {
  for (let i = 0; i < 10 && error && typeof error === 'object'; i++) {
    const e = error as { data?: unknown; cause?: unknown };
    let decoded: { errorName: string; args?: readonly unknown[] } | undefined;
    if (typeof e.data === 'string' && /^0x[0-9a-f]+$/i.test(e.data)) {
      try { decoded = decodeErrorResult({ abi: coordinatorV2Abi, data: e.data as Hex }); } catch { /* not a contract refusal */ }
    } else if (e.data && typeof e.data === 'object' && 'errorName' in e.data) decoded = e.data as typeof decoded;
    if (decoded) return decoded.errorName;
    error = e.cause;
  }
  return undefined;
}

/**
 * Anyone may read; only decoded exhaustion is null. The quote and its backing share a canonical hash: the pot, plus for
 * the final holder share the inbox's pending P read at that hash (RC6-RR-INBOX: that quote includes it).
 */
export async function readFailureQuoteV2(r: HolderClaimReaderV2, coordinator: Address, hash: Hex, coinsT: bigint, pot: bigint, pendingP = 0n): Promise<bigint | null> {
  let amountP: bigint;
  try { amountP = await claimReadV2<bigint>(r, hash, coordinator, coordinatorV2Abi, 'quoteClaim', [coinsT]); }
  catch (error) { if (coinsT === 0n && claimErrorName(error) === 'InvalidClaim') return null; throw error; }
  if (amountP > pot + pendingP) throw new Error('failure quote exceeds live pot and pending inbox P');
  return amountP;
}

export async function readFailureClaimV2(r: HolderClaimReaderV2, row: BoxRowV2, wallet: Address, hash: Hex, noBuyer: boolean) {
  if (noBuyer && row.creator.toLowerCase() !== wallet.toLowerCase()) return null;
  const coordinator = row.contracts.coordinator; const token = row.contracts.token;
  if (!coordinator || !token) throw new Error('missing failure claim roles');
  const read = <T>(to: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => claimReadV2<T>(r, hash, to, abi, fn, args);
  if (!await read<boolean>(coordinator, coordinatorV2Abi, 'failed')) return null;
  const [pot, tLeft] = await read<readonly [bigint, bigint]>(coordinator, coordinatorV2Abi, 'claimState');
  if (noBuyer ? tLeft !== 0n : tLeft === 0n) return null;
  const coinsT = noBuyer ? 0n : await read<bigint>(token, erc20Abi, 'balanceOf', [wallet]);
  if (!noBuyer && coinsT === 0n) return null;
  if (coinsT > tLeft) throw new Error('wallet coins exceed failure claim supply');
  const inbox = row.contracts.royaltyRouter;
  const finalShare = !noBuyer && coinsT === tLeft;
  let amountP: bigint;
  let collectFirst: { readonly pendingP: bigint; readonly message: typeof INBOX_CLAIM_NOTICE_V21 } | undefined;
  try { amountP = await claimReadV2<bigint>(r, hash, coordinator, coordinatorV2Abi, 'quoteClaim', [coinsT]); }
  catch (error) {
    if (noBuyer && claimErrorName(error) === 'InvalidClaim') return null;
    throw error;
  }
  // RC6-RR-INBOX: the final holder share and the no-buyer creator are quoted with the inbox's readable P, which their
  // claim first moves into the pot, conditional on that intake. The same-hash read backs the final share beyond
  // claimState's pot and names that P on both rows. A creator's claimState pot already includes it: never added
  // twice. An unreadable inbox counts nothing in the creator's quote, so its note is left out; a final share's quote
  // succeeded only because the coordinator read the inbox, so a failure here is transport and stays an error.
  const waiting = !inbox || !(finalShare || noBuyer) ? 0n
    : noBuyer ? await read<bigint>(inbox, royaltyRouterV2Abi, 'pendingPriceCoin').catch(() => 0n)
      : await read<bigint>(inbox, royaltyRouterV2Abi, 'pendingPriceCoin');
  if (amountP > pot + (finalShare ? waiting : 0n)) throw new Error('failure quote exceeds live pot and pending inbox P');
  if (waiting > 0n) collectFirst = { pendingP: waiting, message: INBOX_CLAIM_NOTICE_V21 };
  const allowanceT = noBuyer ? null : await read<bigint>(token, erc20Abi, 'allowance', [wallet, coordinator]);
  return { amountP, coinsT, allowanceT, pot, tLeft, ...(collectFirst ? { collectFirst } : {}) };
}
