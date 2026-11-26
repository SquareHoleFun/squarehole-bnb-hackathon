import type { JobName } from './types';
import { V2_GAS_FLOORS } from './gas';
import { M2_GAS } from './m2-gas';
import { M3_GAS } from './m3-gas';

/** Where a job's tip comes from (ADR-0017 § 11; F95 R19F). `none`: the job moves no money, or pays no tip. */
export type TipSource = 'none' | 'collect' | 'deepen' | 'buyBack' | 'sellFees' | 'closer';

export interface JobSpec {
  readonly name: JobName;
  /** One line, plain words, for the published list. */
  readonly what: string;
  readonly tip: TipSource;
  /** Private-only job flag; CQ11 permissionless jobs do not require it. */
  readonly privately: boolean;
  /** Lower runs first when a block's rate limit binds. */
  readonly priority: number;
  /** Whose budget pays when the tip does not: the pokes have their own (the ticket's review lens). */
  readonly budget: 'ours' | 'pokes';
  /**
   * May spend the day's reserve, the last part of the ours budget and of the daily ceiling, which no other job may
   * touch. V2 protects exits, fixed-Safe payments and recovery retries; ordinary pool work stays outside. A call the
   * reader marks `ordinary` (a purchased-T tranche, a T residue burn) cannot spend it even when its job is reserved.
   */
  readonly reserved: boolean;
  /** Published outer operating allowance; pending estimates plus headroom may require more. */
  readonly gasPerRun: bigint;
}

const job = (
  name: JobName,
  tip: TipSource,
  priority: number,
  gasPerRun: bigint,
  what: string,
  extra: Partial<Pick<JobSpec, 'privately' | 'budget' | 'reserved'>> = {},
): JobSpec => ({ name, what, tip, priority, gasPerRun, privately: false, budget: 'ours', reserved: false, ...extra });

const RESERVED = { reserved: true } as const;

/** The job table: every job the keeper runs, in one place (tickets § 2, M1-51; ADR-0017 § 3, § 8, § 11). */
export const JOBS: readonly JobSpec[] = Object.freeze([
  job('backupStart', 'none', 2, 300_000n, "Starts box 0's RANDAO backup for a requested round drand has left unposted, only between 5 days and 5 days 18 hours after the round's time (F143, R63-LATEST)", RESERVED),
  job('backupFix', 'none', 1, 300_000n, "Fixes a started backup with its target block's header once that block is final, inside the proof window and before the consumers' deadline (F143)", RESERVED),
  job('drandPostRound', 'none', 1, 600_000n, 'Posts a due quicknet round shared by known consumers; its bounty is a separate pull credit, never assumed gas income', RESERVED),
  job('drandRequestWord', 'none', 2, 200_000n, 'Retries a missing ticket assignment-word request after graduation or the v2 failure window, with zero bounty value', RESERVED),
  job('drandAcceptWord', 'none', 2, 200_000n, 'Accepts a timely posted graduation/assignment word on v1 or v2 tickets', RESERVED),
  job('drandSettle', 'none', 2, 1_000_000n, 'Settles at most eight queued draws with timely words; owners open and claim their own items', RESERVED),
  job('drandGraduationBounty', 'none', 3, 100_000n, 'Optionally tops up box 0’s unposted graduation round to the configured bounty; ordinary ours gas plus value, no protected reserve'),
  job('drandWithdrawBounty', 'none', 3, 100_000n, 'Withdraws only this keeper address\'s credited drand bounties to itself; ordinary daily budget'),
  job('itemSync', 'none', 3, M3_GAS.itemSync, 'Replays up to 32 item receipts and 32 lifecycle records; owners claim their own P', RESERVED),
  job('itemResidue', 'none', 3, M3_GAS.itemResidue, 'Flushes only proved item P rounding/cancellation residue to fixed hook depth; burns item T residue of at least 0.01 T as ordinary F111 work', RESERVED),
  job('pileLoadSeed', 'none', 3, M3_GAS.pileLoadSeed, 'Retries a pending exact ERC-20 seed pull from the recorded seeder; native seed is loaded by its owner', RESERVED),
  job('pileReturnSeed', 'none', 3, M3_GAS.pileReturnSeed, 'Retries a failed pile seed return only to its recorded seeder; never redeems holder T', RESERVED),
  job('holderSettle', 'none', 3, M2_GAS.holderSettle, 'Advances sixteen closed, funded notice/holder pairs: a P batch completes before claims or residue; a purchased T tranche is ordinary F111 work, never sent before a purchase', RESERVED),
  job('holderResidue', 'none', 3, M2_GAS.holderResidue, 'Flushes only proved P residue to depth while live or to the failed receiver, whose next collect adds it to the claim pot; burns holder T residue of at least 0.01 T as ordinary F111 work', RESERVED),
  job('shopBurn', 'none', 3, M2_GAS.shopBurn, 'Retries burns of quarantined failed-shop liquid and claims-backed T; never returns seed', RESERVED),
  job('shopReturn', 'none', 3, M2_GAS.shopReturn, 'Retries one failed-shop starter NFT only to its fixed creator', RESERVED),
  job('fail', 'closer', 1, V2_GAS_FLOORS.fail, "CQ11-E: closes an expired box or uses the seven-day graduation hatch; the closer tip is real P, paid last", RESERVED),
  job('failClosed', 'closer', 1, V2_GAS_FLOORS.failClosed, 'Closes a box whose open gate still holds 14 days after its open; the same tip, so the same', RESERVED),
  job('graduate', 'none', 2, V2_GAS_FLOORS.graduate, "Graduates a box whose curve filled; it credits its caller the D6 reserve as a reward in P (v1's `graduate()`), claimed by this keeper through claimReward(to) only when rewardOf(keeper) is positive", RESERVED),
  job('claimReward', 'none', 3, 200_000n, "Claims only this keeper graduator's recorded D6 reward to itself", RESERVED),
  job('buyBack', 'buyBack', 4, V2_GAS_FLOORS.buyBack, 'Buys T in the box pool, burns or leaves it pending, tips on actual P spent; takes the pool step in turn with deepen and shopFees'),
  job('shopFees', 'none', 4, V2_GAS_FLOORS.shopFees, 'Sellers core shop purchase or holder refund; shared pool step, ordinary F111 income limits'),
  job('sellFees', 'sellFees', 4, V2_GAS_FLOORS.sellFees, 'F137: after graduation, presses the plain hook\'s public step that sells waiting T fees for P in the box pool (49 ticks, minimum output, FIFO page ends at the step minimum or 32 sources); our keeper probes hourly when idle and presses again on its next rotation turn after any conversion of T; a zero-P page, or one worth less than a hundredth of the step minimum, uses the daily unblocking allowance; signed at no less than 8.2M before Amsterdam and 16M on it, 3.5M for a zero-P page; tips 5% of the step\'s own P, capped'),
  job('executeModule', 'none', 4, V2_GAS_FLOORS.executeModule, 'After graduation, converts one fixed module side through private submission; no tip and ordinary F111 income limits', { privately: true }),
  job('moveToPile', 'none', 4, V2_GAS_FLOORS.moveToPile, 'After graduation, moves pending P into the fixed pile, in bounded portions; no tip and ordinary F111 income limits'),
  job('eatPriceCoin', 'none', 4, V2_GAS_FLOORS.eatPriceCoin, 'After graduation, burns checked P or locks unchecked P at the fixed dead address; only while pending, never after failure, under F111 with no tip'),
  job('burnPending', 'none', 3, V2_GAS_FLOORS.burnPending, 'Retries a refused T burn; never sells T', RESERVED),
  job('routerSweep', 'none', 3, V2_GAS_FLOORS.routerSweep, 'Sweeps launch tax after graduation or failure; the contract fixes its destination', RESERVED),
  job('royaltyFlush', 'none', 3, V2_GAS_FLOORS.royaltyFlush, 'Flushes the income inbox\'s ETH/WETH: wraps it for sale in a box priced in another coin, or delivers it as P to the receiver; our keeper does not call it for failed boxes', RESERVED),
  job('royaltySweep', 'none', 3, V2_GAS_FLOORS.royaltySweep, 'Sweeps the income inbox\'s price coin into phase accounting; our keeper does not call it for failed boxes', RESERVED),
  job('royaltyRefresh', 'none', 4, V2_GAS_FLOORS.royaltyRefresh, 'Registers or refreshes an income inbox coin\'s CoW standing order, at most once per clock hour per coin from the hour\'s start, when whole lots wait above its approval; never for failed boxes; uses the daily unblocking allowance; anyone may call it'),
  job('royaltyObserve', 'none', 4, V2_GAS_FLOORS.royaltyObserve, 'Records a frozen-list coin\'s unobserved sale in its own clock hour at any balance, or starts a below-lot coin\'s zero clock, at most once per clock hour per coin; never for failed boxes; uses the daily unblocking allowance'),
  job('poke', 'none', 2, 62_000n, "Pokes Box 0's FIT executor each block while spot is more than 1% from its latest sample (F96 R19G)", { budget: 'pokes' }),
  job('deepen', 'deepen', 4, V2_GAS_FLOORS.deepen, "V2 deepen alternates with buyBack each block; Box 0 retains its hourly cadence"),
  job('collect', 'collect', 3, V2_GAS_FLOORS.collect, "Public V2 P fee collection and lazy escrow settlement; signed floor 5M before Amsterdam, 8M on it, sized for an ordinary price coin; allocates up to two quota sources plus five passes for sources below 15 raw P per side; below its batching floor at a lag of two closed buyers or three closed sellers, counting every source, as unblocking work on consecutive blocks; our keeper does not call it for failed boxes; Box 0 retains its two-hour cadence"),
  // 12M covers the measured four-part v2 activation envelope (PAYOUT_GAS 2.7M each).
  // It is an operating allowance, not a floor: pending estimates determine each signed limit.
  job('receiverPayFit', 'none', 3, 12_000_000n, 'Pays positive raw P debt only to the immutable FIT Safe in any v2 phase (F130); Box 0 keeps its payout policy', RESERVED),
  job('receiverPayPlatform', 'none', 3, 12_000_000n, 'Pays positive raw P debt only to the immutable platform Safe in any v2 phase (F130); independent of FIT, with no caller tip', RESERVED),
  // Box 0 retains its own executor checkpoint maintenance; CQ11 removes only v2 samplers.
  job('executorTopUp', 'none', 7, 62_000n, "Pokes Box 0's FIT executor once its newest checkpoint is 515 seconds old"),
  job('executorExecute', 'none', 3, 500_000n, "Executes Box 0's funded FIT budget with bounded maxChunks after graduation and TWAP readiness; simulation must buy or burn FIT"),
]);

/** Historical Box 0 allowances; no v2 stipend is applied to these transactions. */
export const BOX0_GAS: Readonly<Partial<Record<JobName, bigint>>> = Object.freeze({
  fail: 3_500_000n, failClosed: 3_500_000n, graduate: 6_150_000n, claimReward: 200_000n,
  deepen: 400_000n, collect: 300_000n, receiverPayFit: 80_000n, receiverPayPlatform: 80_000n,
  poke: 62_000n, executorTopUp: 62_000n, executorExecute: 500_000n,
});

export function jobSpec(name: JobName, version: 1 | 2 = 2): JobSpec {
  const spec = JOBS.find((j) => j.name === name);
  if (!spec) throw new Error(`unknown job ${name}`);
  // Shared payment names retain Box 0's ordinary-budget policy.
  return version === 1 && BOX0_GAS[name] !== undefined ? { ...spec, gasPerRun: BOX0_GAS[name],
    reserved: spec.reserved && name !== 'receiverPayFit' && name !== 'receiverPayPlatform' } : spec;
}

export interface OursEntry {
  /** A job's name (a string, so a table under test may name jobs this release does not have). */
  readonly job: string;
  readonly what: string;
  readonly when: 'always' | 'when its tip does not cover its gas';
  readonly gasPerRun: bigint;
  readonly ethPerRunAt1Gwei: string;
}

/** Wei as a decimal ETH string, no Number on the way (CLAUDE.md). */
export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac === '' ? `${whole}.0` : `${whole}.${frac}`;
}

/** Ours on every run: no tip, or a tip the keeper cannot value yet (the closer's, change request 2). */
export const alwaysOurs = (j: JobSpec) => j.tip === 'none' || j.tip === 'closer';

/** The public list of what stays ours (F95 R19S), generated from the table so no job can be left out of it. */
export function oursList(jobs: readonly JobSpec[] = JOBS): OursEntry[] {
  return jobs.map((j) => ({
    job: j.name,
    what: j.what,
    when: alwaysOurs(j) ? 'always' : 'when its tip does not cover its gas',
    gasPerRun: j.gasPerRun,
    ethPerRunAt1Gwei: formatEth(j.gasPerRun * 10n ** 9n),
  }));
}

export function renderOursList(jobs: readonly JobSpec[] = JOBS): string {
  const rows = oursList(jobs).map((e) => `| \`${e.job}\` | ${e.what} | ${e.when} | ${e.gasPerRun} | ${e.ethPerRunAt1Gwei} |`);
  return [
    '# What our keeper runs at its own cost',
    '',
    'Generated from `src/jobs.ts` by `pnpm --filter @squarehole/keeper ours:write`; do not edit by hand (F95 R19S;',
    'ADR-0017 § 11). The ordinary fee ceiling is 3 gwei. R62-FEE allows drandPostRound, drandRequestWord,',
    'backupStart and backupFix below 72 hours to their deadline to use up to 50 gwei and their own 0.05 ETH daily rescue cap',
    'when the ordinary fee or daily limits refuse. Requested words must still be within their deadline; an unrequested',
    'assignment can be rescued after it. A timely word never expires: acceptance keeps ordinary limits and protected reserve.',
    'Ordinary drand sends have no second allowance. Fixed daily limits are 0.102 ETH ours,',
    '0.012 ETH Box 0 pokes and 0.114 ETH total, including 0.051 ETH protected for recovery.',
    'F111 also caps v2 collect/buyBack/deepen/shopFees/sellFees/eatPriceCoin/moveToPile/executeModule by',
    'each box’s confirmed platform share and one quarter of confirmed platform income over the rolling 24 hours, each',
    'send counted at its whole signed gas limit times its maximum fee. Received valued tips repay',
    'that income budget; no tip increases a fixed daily limit. Unvalued tokens create no wei room.',
    'Sepolia reviewed price-coin pins scale raw receipts by decimals and a fixed rate approved in F182; tETH remains 1:1.',
    'F182: only after an income-cap refusal, a live registered v2 collect or positive fee sale may start on its own',
    'pending simulation’s paid tip. Its separate approved valuation must cover the whole signed cost, at most 0.05 ETH,',
    'with zero call value. That tip helps only this candidate in both income caps; it is not received income.',
    'Every start is charged as ours inside the ordinary daily limits. Before broadcast, its full cost, unpaid lock and hash',
    'are saved in the starts file before the ordinary journal. Other ordinary work waits; reserved recovery remains available.',
    'Only its final canonical transaction’s authenticated tip covering that cost releases the lock. Otherwise the debt',
    'survives midnight, 24 hours and restarts. Later same-box income may repay it once under both caps; its debit then',
    'stays charged for another 24 hours. Unknown hashes never clear automatically (only starts from before SH-249 lack one). Finality is final: paid records then drop.',
    'Proofs are read only inside the rolling window. The pending block must match before simulation and after estimation.',
    'Rollback leaves the separate starts file and its required marker intact; returning restores unpaid locks.',
    'The old keeper can run but does not enforce start locks. Preserve all books. Dry starts settle only in the dry books.',
    'The fixed daily limits reserve each send at its whole signed gas limit times its maximum fee plus any bounty value before broadcast,',
    'then count what it paid (gas used times the effective gas price, retaining bounty value) once its receipt is final and canonical;',
    'a send without such a receipt, failed or ambiguous, stays charged in full for the day.',
    'The same caps apply to the routine T calls of three recovery jobs: a purchased-T holder tranche (`holderSettle`)',
    'and T residue burns of at least 0.01 T (`holderResidue`, `itemResidue`). No claim waits on them and they never',
    'use the protected reserve; a T batch with no purchased T is never settled.',
    'Unblocking work instead spends no F111 credit: royaltyRefresh, royaltyObserve, a simulated sellFees page that sells',
    'for zero P or for less than a hundredth of the step minimum, and a collect below its batching floor sent while',
    'closed sources wait out of a collect\'s reach. It takes a per-box UTC daily allowance of signed gas',
    '(SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY, default 816,000,000: 24 of each job at its published floor) and two',
    'wei ceilings: all boxes together never reserve more than SH_KEEPER_UNBLOCKING_WEI_PER_DAY (default half the',
    'ordinary ours room, 0.0255 ETH), and a box waits once it has spent SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY (default',
    'a quarter of that), so its last send can cross its share by that send alone. Each can be set to zero. The fixed',
    'daily wei ceilings and the 3 gwei ceiling still apply; this work cannot use the protected recovery reserve.',
    'Positive-P sales above a hundredth of the step minimum remain F111 work.',
    'Recovery jobs keep their reserve and are exempt from income caps. The jobs below that say',
    '"always" pay none, or a tip this keeper cannot value yet, and stay ours; the others become ours only while their',
    'tip does not cover their gas. Gas per run is an operating allowance; pending estimates with headroom may',
    'require more. V2 uses FINAL2-GAS floors, with graduation raised by FINAL3-G01 to 13.5M',
    'for both burns, both pokes and ledger-token history; failure/failClosed take 15M for their five optional calls',
    '(both burns, the router sweep, the inbox sweep and the tip). 15M admits the worst a price coin can cause, which spends',
    'the sweeps and the tip (at most 12,815,029 submitted gas on Amsterdam at rc7). It does not admit all five spent on',
    'Amsterdam (up to 15,292,746 submitted); both burns call our own token, which nobody else can make spend its allowance.',
    'sellFees signs at no less than 8.2M before Amsterdam, 16M on it and 3.5M for a simulated zero-P page; the table shows the largest.',
    'collect signs at no less than 5M before Amsterdam and 8M on it; the table shows the largest.',
    'V2.1 eating and pile moves use a 3.5M floor covering EAT_GAS / PILE_MOVE_GAS 2.8M, admission and the 200k continuation reserve;',
    'it shares ordinary income/daily budgets and cannot consume the protected recovery reserve.',
    'Shop burn/return floors remain 5M/2M. Safe payments use pending estimates; their 12M allowance',
    'covers four parts. Every published allowance fits the 16,777,216 Osaka cap; headroom above a floor is clipped at',
    'the destination ceiling, so a 15M failure is signed at no more than that cap.',
    'The table uses v2 allowances for shared job names; Box 0 values are listed separately below.',
    '',
    '| Job | What it does | Ours | Gas per run | ETH per run at 1 gwei |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Box 0 operating allowances',
    '',
    'Box 0 keeps its estimate/headroom policy and 3.5M failure floor; v2 floors do not apply.',
    '',
    '| Job | Gas per run | ETH per run at 1 gwei |',
    '|---|---|---|',
    ...Object.entries(BOX0_GAS).map(([name, gas]) => `| \`${name}\` | ${gas} | ${formatEth(gas * 10n ** 9n)} |`),
    '',
  ].join('\n');
}
