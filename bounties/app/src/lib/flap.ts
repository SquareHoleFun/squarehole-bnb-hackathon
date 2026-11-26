import { concat, encodeAbiParameters, getAddress, hexToBytes, keccak256, type Address, type Hex } from 'viem';
import { parseAmount, parsePercentToBps } from './amounts';

/** The rules of a curve sale (bounties/flap/src/CurveLauncher.sol `CurveConfig`). */
export interface CurveConfig {
  name: string;
  symbol: string;
  meta: string;
  salt: Hex;
  saleTokens: bigint;
  targetRaise: bigint;
  virtualBnb: bigint;
  duration: bigint;
  tradeFeeBps: number;
  buyTaxBps: number;
  sellTaxBps: number;
  burnShareBps: number;
  taxDuration: number;
}

export interface Progress {
  phase: number;
  sold: bigint;
  saleTokens: bigint;
  curveBalance: bigint;
  raiseTarget: bigint;
  feePot: bigint;
  priceNow: bigint;
  deadline: bigint;
  holderCount: bigint;
}

export const PHASE = { selling: 0, launched: 1, failed: 2 } as const;

// ── The token address ────────────────────────────────────────────────────────────────────────────────────────────
// The Portal creates the token as an OpenZeppelin EIP-1167 clone of its token implementation with CREATE2, and a
// launch needs that address to end in 7777 (the factory's `predictToken`). The page mines a salt the same way the
// entry's CreateSale script does (keccak256(abi.encode(seed, i))) and the factory's own `predictToken` confirms it
// before anything is sent.

/** keccak256 of OpenZeppelin's clone init code for `impl` (55 bytes). */
export function cloneInitCodeHash(impl: Address): Hex {
  return keccak256(concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', impl, '0x5af43d82803e903d91602b57fd5bf3']));
}

/** The CREATE2 address `deployer` gets for `salt` and an init code hash. */
export function create2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  return getAddress('0x' + keccak256(concat(['0xff', deployer, salt, initCodeHash])).slice(26));
}

export function predictToken(tokenImpl: Address, portal: Address, salt: Hex): Address {
  return create2Address(portal, salt, cloneInitCodeHash(tokenImpl));
}

/** The i-th candidate salt for a seed, as the entry's CreateSale script: keccak256(abi.encode(seed, i)). */
export function candidateSalt(seed: Hex, i: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [seed, i]));
}

/**
 * Finds a salt whose token address ends in 7777, in slices so the page stays responsive. About 65,536 tries on
 * average. Works on bytes to stay fast.
 */
export async function mineSalt(
  tokenImpl: Address,
  portal: Address,
  seed: Hex,
  opts: { slice?: number; yieldFn?: () => Promise<void>; maxTries?: number } = {},
): Promise<{ salt: Hex; token: Address; tries: number }> {
  const slice = opts.slice ?? 4096;
  const maxTries = opts.maxTries ?? 4_000_000;
  const hash = hexToBytes(cloneInitCodeHash(tokenImpl));
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(portal), 1);
  buf.set(hash, 53);
  const enc = new Uint8Array(64);
  enc.set(hexToBytes(seed), 0);
  for (let i = 0; i < maxTries; i++) {
    // abi.encode(seed, i): the counter's big-endian bytes in the second word (i stays far below 2^32).
    enc[60] = (i >>> 24) & 0xff;
    enc[61] = (i >>> 16) & 0xff;
    enc[62] = (i >>> 8) & 0xff;
    enc[63] = i & 0xff;
    const salt = keccak256(enc, 'bytes');
    buf.set(salt, 21);
    const a = keccak256(buf, 'bytes');
    if (a[30] === 0x77 && a[31] === 0x77) {
      const saltHex = ('0x' + Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
      return { salt: saltHex, token: create2Address(portal, saltHex, cloneInitCodeHash(tokenImpl)), tries: i + 1 };
    }
    if (i % slice === slice - 1 && opts.yieldFn) await opts.yieldFn();
  }
  throw new Error('no salt found');
}

// ── The curve, for the picture ───────────────────────────────────────────────────────────────────────────────────
// R(s) = ceil(X0 * Y0 / (Y0 - s)) - X0: the BNB on the curve when s tokens are sold (bounties/flap README).

export function reserveAt(virtualBnb: bigint, virtualTokens: bigint, sold: bigint): bigint {
  if (sold >= virtualTokens) throw new RangeError('sold beyond the curve');
  const num = virtualBnb * virtualTokens;
  const den = virtualTokens - sold;
  return (num + den - 1n) / den - virtualBnb;
}

/** Points (tokens sold, BNB on the curve) from 0 to `saleTokens`, `n` steps. */
export function curvePoints(virtualBnb: bigint, virtualTokens: bigint, saleTokens: bigint, n = 48): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let i = 0; i <= n; i++) {
    const s = (saleTokens * BigInt(i)) / BigInt(n);
    out.push([s, reserveAt(virtualBnb, virtualTokens, s)]);
  }
  return out;
}

// ── The create form ──────────────────────────────────────────────────────────────────────────────────────────────

export interface CreateForm {
  name: string;
  symbol: string;
  saleTokens: string; // whole tokens
  target: string; // BNB
  virtualBnb: string; // BNB
  durationHours: string;
  tradeFee: string; // percent
  buyTax: string;
  sellTax: string;
  burnShare: string;
  taxDays: string;
}

/** The entry's own defaults (bounties/flap/script/CreateSale.s.sol): the smallest round sale that clears the Portal's
 * floor today, a 2-day deadline, 1% curve fee, 3% buy and 5% sell tax with a fifth of it burned, tax for a year. */
export const CREATE_DEFAULTS: CreateForm = {
  name: 'Pile Curve',
  symbol: 'PILE',
  saleTokens: '600000000',
  target: '2.35',
  virtualBnb: '16',
  durationHours: '48',
  tradeFee: '1',
  buyTax: '3',
  sellTax: '5',
  burnShare: '20',
  taxDays: '365',
};

export type CreateRefusal = { field: keyof CreateForm; text: string };

const WHOLE = /^\d+$/;

/** Turns the form into a config (without the salt) or the first refusal, with the field it belongs to. */
/** `quoteDecimals`: the decimals of the coin the sale is paid in (the target and the curve depth are in it). */
export function readCreateForm(f: CreateForm, quoteDecimals = 18): { ok: true; config: Omit<CurveConfig, 'salt'> } | { ok: false; refusal: CreateRefusal } {
  const no = (field: keyof CreateForm, text: string) => ({ ok: false as const, refusal: { field, text } });
  if (f.name.trim() === '') return no('name', 'Enter a name.');
  if (f.symbol.trim() === '') return no('symbol', 'Enter a symbol.');
  const sale = parseAmount(f.saleTokens, 18);
  if (!sale.ok) return no('saleTokens', 'Enter the tokens for sale.');
  const target = parseAmount(f.target, quoteDecimals);
  if (!target.ok) return no('target', 'Enter the target in BNB.');
  const virt = parseAmount(f.virtualBnb, quoteDecimals);
  if (!virt.ok) return no('virtualBnb', 'Enter the curve’s virtual BNB.');
  if (!WHOLE.test(f.durationHours.trim()) || BigInt(f.durationHours.trim()) === 0n) return no('durationHours', 'Enter whole hours.');
  if (BigInt(f.durationHours.trim()) > 720n) return no('durationHours', 'At most 720 hours (30 days).');
  const fee = parsePercentToBps(f.tradeFee);
  if (!fee.ok || fee.value > 500n) return no('tradeFee', 'From 0 to 5%.');
  // A tax is 0, or from 1% to 10%: the Portal refuses 0.01% to 0.99% (the factory's MIN_TAX_BPS, MAX_TAX_BPS).
  const buy = parsePercentToBps(f.buyTax);
  if (!buy.ok || buy.value > 1000n || (buy.value > 0n && buy.value < 100n)) return no('buyTax', '0, or from 1% to 10%.');
  const sell = parsePercentToBps(f.sellTax);
  if (!sell.ok || sell.value > 1000n || (sell.value > 0n && sell.value < 100n)) return no('sellTax', '0, or from 1% to 10%.');
  if (buy.value === 0n && sell.value === 0n) return no('sellTax', 'With no tax the pile never fills.');
  const burn = parsePercentToBps(f.burnShare);
  if (!burn.ok || burn.value >= 10000n) return no('burnShare', 'Below 100%, or nothing reaches the pile.');
  if (!WHOLE.test(f.taxDays.trim()) || BigInt(f.taxDays.trim()) === 0n) return no('taxDays', 'At least 1 day, in whole days.');
  const taxSeconds = BigInt(f.taxDays.trim()) * 86400n;
  if (taxSeconds > 4_294_967_295n) return no('taxDays', 'Too long.');
  return {
    ok: true,
    config: {
      name: f.name.trim(),
      symbol: f.symbol.trim(),
      meta: '',
      saleTokens: sale.value,
      targetRaise: target.value,
      virtualBnb: virt.value,
      duration: BigInt(f.durationHours.trim()) * 3600n,
      tradeFeeBps: Number(fee.value),
      buyTaxBps: Number(buy.value),
      sellTaxBps: Number(sell.value),
      burnShareBps: Number(burn.value),
      taxDuration: Number(taxSeconds),
    },
  };
}
