import type { Address, PublicClient } from 'viem';
import { erc20Abi } from '../abi/feeRules';
import { railStakeAbi, railStakeFactoryAbi, ruleSplitterAbi, rulesFactoryAbi, rulesLaunchAbi, rulesVaultAbi } from '../abi/railStake';
import { formatBps, parseAmount, shareBps } from './amounts';
import type { Checked } from './forms';

/**
 * SH-290: holder payouts on a Flap or Four.meme token: the holders panel's model (components/HoldersPanel.tsx), pure where
 * it can be. Every amount is a bigint to the last unit; the panel shows them with the app's own formatter.
 */

export const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** The stake's fixed settings. */
export interface StakeInfo {
  stake: Address;
  token: Address;
  /** ZERO: the native coin. */
  asset: Address;
  period: bigint;
}

/** What the panel shows, read at one block. */
export interface StakeNow {
  totalStaked: bigint;
  arrived: bigint;
  claimed: bigint;
  undistributed: bigint;
  streamEnd: bigint;
  unsynced: bigint;
  /** The stream's rate for all stakers together, times 1e27 (`ratePerSecondScaled`; the whole-unit rate can read 0). */
  rateScaled: bigint;
  /** The block's time (seconds). */
  now: bigint;
  /** The visitor's numbers; undefined without a wallet. */
  mine?: { staked: bigint; claimable: bigint; balance: bigint };
}

/** Who a launch's tax pays: the targets of its rules (none where the launch has no rules, or they cannot be read). */
export type Payees = (c: PublicClient) => Promise<readonly Address[]>;

/** A Flap rules launch: `rulesOf(launcher)` at the factory that holds its rules. */
export const flapPayees = (launcher: Address): Payees => async (c) => {
  try {
    const factory = await c.readContract({ address: launcher, abi: rulesLaunchAbi, functionName: 'pileVaultFactory' });
    const rules = await c.readContract({ address: factory, abi: rulesFactoryAbi, functionName: 'rulesOf', args: [launcher] });
    return rules.map((r) => r.target);
  } catch {
    return [];
  }
};

/** A Four.meme rules tax vault: its splitter's rules. */
export const fourPayees = (vault: Address): Payees => async (c) => {
  try {
    const splitter = await c.readContract({ address: vault, abi: rulesVaultAbi, functionName: 'splitter' });
    const n = await c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'ruleCount' });
    const rules = await Promise.all(Array.from({ length: Number(n > 8n ? 8n : n) }, (_, i) => c.readContract({ address: splitter, abi: ruleSplitterAbi, functionName: 'rule', args: [BigInt(i)] })));
    return rules.map((r) => r[2]);
  } catch {
    return [];
  }
};

/**
 * The token creator's stake made by OUR factory, and paid by the launch's own rules, or null: the factory's
 * `stakeOf(creator, token)`, non-zero, `isStake`, the stake's own `token()` and `factory()` the ones asked about, and the
 * stake one of the targets the launch's tax pays (`payees`). A stake someone else made for this token is never this one
 * (its creator is not the token's), and a stake no rule pays is never shown (staking there would earn nothing).
 */
export async function findStake(c: PublicClient, factory: Address, creator: Address, token: Address, payees: Payees): Promise<StakeInfo | null> {
  const stake = (await c.readContract({ address: factory, abi: railStakeFactoryAbi, functionName: 'stakeOf', args: [creator, token] })) as Address;
  if (stake.toLowerCase() === ZERO) return null;
  if (!(await payees(c)).some((p) => p.toLowerCase() === stake.toLowerCase())) return null;
  const [ours, own, from, asset, period] = await Promise.all([
    c.readContract({ address: factory, abi: railStakeFactoryAbi, functionName: 'isStake', args: [stake] }),
    c.readContract({ address: stake, abi: railStakeAbi, functionName: 'token' }),
    c.readContract({ address: stake, abi: railStakeAbi, functionName: 'factory' }),
    c.readContract({ address: stake, abi: railStakeAbi, functionName: 'asset' }),
    c.readContract({ address: stake, abi: railStakeAbi, functionName: 'period' }),
  ]);
  if (!ours || (own as string).toLowerCase() !== token.toLowerCase() || (from as string).toLowerCase() !== factory.toLowerCase()) return null;
  return { stake, token, asset: asset as Address, period: period as bigint };
}

/** The panel's numbers, at the latest block. */
export async function readStakeNow(c: PublicClient, info: StakeInfo, account?: Address): Promise<StakeNow> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const read = (functionName: 'totalStaked' | 'arrived' | 'claimed' | 'undistributed' | 'streamEnd' | 'unsynced' | 'ratePerSecondScaled') =>
    c.readContract({ address: info.stake, abi: railStakeAbi, functionName, ...at }) as Promise<bigint>;
  const [totalStaked, arrived, claimed, undistributed, streamEnd, unsynced, rateScaled] = await Promise.all([
    read('totalStaked'), read('arrived'), read('claimed'), read('undistributed'), read('streamEnd'), read('unsynced'), read('ratePerSecondScaled'),
  ]);
  let mine: StakeNow['mine'];
  if (account) {
    const [staked, claimable, balance] = await Promise.all([
      c.readContract({ address: info.stake, abi: railStakeAbi, functionName: 'stakedOf', args: [account], ...at }) as Promise<bigint>,
      c.readContract({ address: info.stake, abi: railStakeAbi, functionName: 'claimable', args: [account], ...at }) as Promise<bigint>,
      c.readContract({ address: info.token, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at }) as Promise<bigint>,
    ]);
    mine = { staked, claimable, balance };
  }
  return { totalStaked, arrived, claimed, undistributed, streamEnd, unsynced, rateScaled, now: block.timestamp, mine };
}

/** The scale of `ratePerSecondScaled` (lane f: the whole-unit rate times 1e27). */
export const RATE_SCALE = 10n ** 27n;

/**
 * One holder's share of the stream over `seconds`, in the asset's last units: the stream's scaled rate times its stake
 * over all that is staked, divided by the scale last (0 with nothing staked).
 */
export function holderRate(rateScaled: bigint, staked: bigint, totalStaked: bigint, seconds = 1n): bigint {
  return totalStaked === 0n ? 0n : (rateScaled * seconds * staked) / (totalStaked * RATE_SCALE);
}

/**
 * What the panel says about the stream, from the numbers alone: nothing to pay, paying until the end, paused while
 * nobody is staked (the contract's own rule; the end then moves), or a leftover after the end: stakers exist, the end
 * has passed and `undistributed()` is above zero while nothing pays (it goes out with the next income).
 */
export function streamState(n: Pick<StakeNow, 'undistributed' | 'streamEnd' | 'totalStaked' | 'now'>): 'none' | 'streaming' | 'paused' | 'leftover' {
  if (n.undistributed === 0n) return 'none';
  if (n.totalStaked === 0n) return 'paused';
  return n.streamEnd > n.now ? 'streaming' : 'leftover';
}

/** Seconds as the panel shows a time left: "2 d 3 h", "4 h 5 min", "6 min", "40 s". */
export function timeLeft(seconds: bigint): string {
  if (seconds <= 0n) return '0 s';
  const d = seconds / 86_400n;
  const h = (seconds % 86_400n) / 3_600n;
  const m = (seconds % 3_600n) / 60n;
  if (d > 0n) return `${d} d ${h} h`;
  if (h > 0n) return `${h} h ${m} min`;
  if (m > 0n) return `${m} min`;
  return `${seconds} s`;
}

/** The visitor's share of all that is staked, in basis points. */
export const stakeShareBps = (staked: bigint, totalStaked: bigint): bigint => shareBps(staked, totalStaked);

/** The share as the panel shows it: "12.5%", and "<0.01%" for a stake that earns but rounds to 0. */
export function stakeShareText(staked: bigint, totalStaked: bigint): string {
  const bps = stakeShareBps(staked, totalStaked);
  return bps === 0n && staked > 0n ? '<0.01%' : formatBps(bps);
}

/** The amount typed in Stake: a number, not zero, at most what the visitor holds. */
export function checkStake(text: string, decimals: number, balance?: bigint): Checked<bigint> {
  const a = parseAmount(text, decimals);
  if (!a.ok) return { ok: false, refusal: a.reason };
  if (balance !== undefined && a.value > balance) return { ok: false, refusal: 'over-balance' };
  return { ok: true, value: a.value };
}

/** The amount typed in Unstake: a number, not zero, at most what the visitor has staked. */
export function checkUnstake(text: string, decimals: number, staked?: bigint): Checked<bigint> {
  const a = parseAmount(text, decimals);
  if (!a.ok) return { ok: false, refusal: a.reason };
  if (staked !== undefined && a.value > staked) return { ok: false, refusal: 'over-staked' };
  return { ok: true, value: a.value };
}
