/**
 * Revert decoding for simulations and reverted receipts. Custom errors are decoded with the generated ABIs of every
 * contract a write can reach (Square Hole and the Uniswap v4 code it calls), including ERC-7751 `WrappedError`s, which
 * v4 uses to bubble up a hook's revert (e.g. the ledger's `PoolOutflowAtFeeEvent` inside `afterSwap`). The original
 * error name and arguments are kept next to the explanation (06-ARCHITECTURE "Preserve original errors").
 */
import { decodeErrorResult, type Hex } from 'viem';
import { revertErrorsAbi } from '../abi/revertErrors';
import { cleanText, errorChain, isHexData } from './eip1193';

export interface DecodedRevert {
  /** Error name, e.g. `InsufficientOutput`, `Error` (require string) or `Panic`. */
  readonly name: string;
  /** Arguments rendered as text (bigint as decimal, bytes shortened). */
  readonly args: readonly string[];
  /** A person-readable explanation. */
  readonly explanation: string;
  /** The wrapped revert of an ERC-7751 `WrappedError` (the hook's or token's own error). */
  readonly inner: DecodedRevert | null;
  readonly data: Hex;
}

const PANIC_CODES: Readonly<Record<string, string>> = Object.freeze({
  '1': 'assertion failed',
  '17': 'arithmetic overflow or underflow',
  '18': 'division by zero',
  '33': 'invalid enum value',
  '50': 'array index out of bounds',
  '65': 'out of memory',
});

/** Explanations for the errors a person can actually hit when creating or claiming. Unknown errors show their name. */
const EXPLANATIONS: Readonly<Record<string, (args: readonly string[]) => string>> = Object.freeze({
  // Claim converter (R = T) and ledger.
  InsufficientOutput: (a) => `The conversion would pay ${a[0] ?? '?'} raw T, below the signed minimum of ${a[1] ?? '?'} raw T.`,
  Expired: () => 'The quote deadline has passed; refresh the quote and claim again.',
  PartialFill: () => 'The pool cannot convert the whole entitlement right now (it is close to selling out); nothing was claimed.',
  NothingToClaim: () => 'This account has nothing to claim for this pair.',
  PoolNotSoldOut: () => 'The emergency payout in Q is only available while the pool is sold out; convert to T instead.',
  NotPayoutT: () => 'This pair does not pay claims in T through this converter.',
  UnknownPairId: () => 'The registry has no pair with this id.',
  UnknownPair: () => 'The registry has no pair for this token.',
  WrongPayoutAsset: () => 'This pair pays claims in T: claim through the claim converter.',
  NotAccount: () => 'Only the holder can claim what is credited to it.',
  PoolOutflowAtFeeEvent: () =>
    'A fee-bearing buy of T ran after T left the Uniswap pool manager in the same transaction, so the flash-outflow guard refused it (ADR-0011 §3). Send claims and trades of the same T as separate transactions.',
  HolderQCapExceeded: () => 'The ledger’s lifetime holder-Q cap would be exceeded.',
  Reentrancy: () => 'The contract refused a re-entrant call.',
  // Launcher, registry, templates.
  CollectionTooLarge: (a) => `The collection has ${a[0] ?? '?'} NFTs; this template allows at most ${a[1] ?? '?'} (ADR-0011 §4).`,
  TemplateInactive: (a) => `Launch template ${a[0] ?? '?'} is retired or unknown.`,
  PayoutTUnavailable: () => 'This deployment has no claim converter, so launches that pay claims in T are refused.',
  InvalidParams: () => 'The name, symbol, supply or base URI is outside the launcher’s bounds.',
  InvalidFractionsPerNft: (a) => `${a[0] ?? '?'} fractions per NFT is not a power of ten from 1 to 1,000,000,000.`,
  InvalidCollectionSize: (a) => `A collection of ${a[0] ?? '?'} NFTs exceeds 1,000,000,000 fractions in total or is empty.`,
  InvalidSupply: (a) => `A supply of ${a[0] ?? '?'} whole tokens is outside 1 … 1,000,000,000.`,
  // Uniswap v4.
  AlreadyUnlocked: () => 'The call ran inside another Uniswap pool-manager unlock (for example a smart-account bundle); send it as its own transaction.',
  CurrencyNotSettled: () => 'The pool manager was left with an unsettled balance (a fee-on-transfer quote asset?).',
  PriceLimitAlreadyExceeded: () => 'The pool price is already beyond the limit (the range is sold out).',
  // Mock USDT-TEST (testnets only).
  Paused: () => 'The USDT-TEST issuer (the testnet deployer) has paused transfers.',
  BlackListed: (a) => `The USDT-TEST issuer has blacklisted ${a[0] ?? 'an account'}.`,
});

function render(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > 66 ? `${value.slice(0, 34)}…${value.slice(-8)}` : value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return cleanText(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? '', 80);
}

/** Decodes revert data, unwrapping ERC-7751 errors. Null when the data is empty or matches no known error. */
export function decodeRevert(data: Hex, depth = 0): DecodedRevert | null {
  if (data === '0x' || data.length < 10 || depth > 4) return null;
  let decoded: { errorName: string; args?: readonly unknown[] | undefined };
  try {
    decoded = decodeErrorResult({ abi: revertErrorsAbi, data }) as { errorName: string; args?: readonly unknown[] };
  } catch {
    return null;
  }
  const rawArgs = decoded.args ?? [];
  const args = rawArgs.map(render);
  if (decoded.errorName === 'WrappedError') {
    const reason = rawArgs[2];
    const inner = isHexData(reason) ? decodeRevert(reason, depth + 1) : null;
    const where = `${render(rawArgs[0])} (selector ${render(rawArgs[1])})`;
    return Object.freeze({
      name: 'WrappedError',
      args: Object.freeze(args),
      explanation: inner ? `${inner.explanation} (raised inside ${where})` : `A call inside ${where} reverted.`,
      inner,
      data,
    });
  }
  let explanation: string;
  if (decoded.errorName === 'Error') explanation = `Reverted: ${cleanText(String(rawArgs[0] ?? ''), 200)}`;
  else if (decoded.errorName === 'Panic') explanation = `Panic: ${PANIC_CODES[args[0] ?? ''] ?? `code ${args[0] ?? '?'}`}.`;
  else explanation = EXPLANATIONS[decoded.errorName]?.(args) ?? `The contract reverted with ${decoded.errorName}.`;
  return Object.freeze({ name: decoded.errorName, args: Object.freeze(args), explanation, inner: null, data });
}

/** The innermost error name of a decoded revert (e.g. `PoolOutflowAtFeeEvent` inside a `WrappedError`). */
export function rootRevertName(decoded: DecodedRevert): string {
  return decoded.inner ? rootRevertName(decoded.inner) : decoded.name;
}

/**
 * Revert data carried by an RPC or wallet error, wherever the provider put it (`data`, `data.data`, `data.result`,
 * nested under `cause`/`error`). Null when there is none.
 */
export function revertDataOf(error: unknown): Hex | null {
  for (const candidate of errorChain(error)) {
    const data = (candidate as { data?: unknown }).data;
    if (isHexData(data) && data.length >= 10) return data;
    if (typeof data === 'object' && data !== null) {
      const nested = (data as { data?: unknown; result?: unknown }).data ?? (data as { result?: unknown }).result;
      if (isHexData(nested) && nested.length >= 10) return nested;
    }
  }
  return null;
}

/** One-line reason for the transaction state (≤ 500 characters): explanation, then the original error. */
export function revertReason(decoded: DecodedRevert | null, fallback: string): string {
  if (!decoded) return cleanText(fallback, 480);
  let root = decoded;
  while (root.inner) root = root.inner;
  const original = `${root.name}(${root.args.join(', ')})`;
  return cleanText(`${decoded.explanation} [${original}]`, 480);
}
