import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EIP7825_GAS_CAP, V2_GAS_FLOORS, feesFor, gasLimitFrom, transactionGas } from '../../src/gas';
import { JOBS } from '../../src/jobs';
import { loadConfig } from '../../src/config';
import { charge, decide, openBudget } from '../../src/decide';
const AMSTERDAM = { fork: 'amsterdam', transactionCap: EIP7825_GAS_CAP, blockGasLimit: 60_000_000n, stateGas: 0n } as const;

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRoot = resolve(root, 'contracts/src/box-v2');
// Strict successful Amsterdam bounds from FINAL2-GAS; the whole-v2 execution rechecks the actual
// cold/half-cap/exhaustion properties. These are conservative measured bounds, not universal issuer limits.
const measured = [
  ['BoxReceiverV2Base.sol', 'RECEIVER_BURN_GAS', '1000000', '442926'],
  ['BoxReceiverV2Base.sol', 'PAYOUT_GAS', '2700000', '1205646'],
  // V2.1 complete cold unlock, rechecked in keeper/test/contracts/EatEnvelope.t.sol.
  // PF11 complete cold Amsterdam unlock; first linked ledger-token recipient.
  ['BoxReceiverV2Base.sol', 'PILE_MOVE_GAS', '2800000', '776731'],
  ['BoxReceiverV2Base.sol', 'EAT_GAS', '2800000', '1213156'],
  ['interfaces/ReleaseConstantsV2.sol', 'BURN_GAS', '2500000', '1040232'],
  ['interfaces/ReleaseConstantsV2.sol', 'TIP_GAS', '2800000', '1257661'],
  ['interfaces/ReleaseConstantsV2.sol', 'SWEEP_GAS', '1600000', '731599'],
  ['interfaces/ReleaseConstantsV2.sol', 'HOLDER_NOTICE_GAS', '1400000', '615644'],
  ['interfaces/ReleaseConstantsV2.sol', 'TOKEN_SETTLEMENT_GAS', '600000', '46231'],
  // RC6-CLAIM-COLLECT: a failed-box claim's capped receiver collect and collectable-P preview. Cold zero-pot
  // collect in rc6-claim-collect/ClaimCollect.t.sol: 94,929 default, 186,649 Amsterdam (SH-V21-RC6-INT).
  ['interfaces/ReleaseConstantsV2.sol', 'FAILED_COLLECT_GAS', '400000', '186649'],
  // RC6-RR-INBOX (RC6RR-FC-2): failure's and every claim's inbox P sweep, two history-writing transfers. Cold
  // sweepPriceCoin in stipends/Protocol.t.sol at the merged tree: 1,388,098 to 1,482,648 Amsterdam; the release
  // review's larger 1,512,077 is the bound its test_RR_inboxAllowanceCoversAmsterdam pins (SH-V21-RC6-INT part 5).
  ['interfaces/ReleaseConstantsV2.sol', 'INBOX_SWEEP_GAS', '3200000', '1512077'],
  ['ShopVaultV2.sol', 'LIQUID_BURN_GAS', '1250000', '526090'],
  ['ShopVaultV2.sol', 'CLAIMS_BURN_GAS', '2500000', '1099213'],
  ['interfaces/IShopVaultV2.sol', 'NFT_RETURN_GAS', '800000', '315434'],
  ['ItemLedgerV2.sol', 'CLAIM_GAS', '2600000', '1288401'],
  // V2.1 step 2 holder T claims (docs/evidence/SH-V21-02-PAY-IN-T.md: first eligible 7702 recipient).
  ['HolderLedgerV2.sol', 'CLAIM_T_GAS', '2600000', '1187766'],
  ['BoxVaultV2.sol', 'ITEM_LEDGER_GAS', '1000000', '48367'],
  ['BoxCoordinatorV2.sol', 'POKE_GAS', '2600000', '1070828'],
  ['BoxTicketsV2.sol', '_WORD_GAS', '50000', '7894'],
  // FIX-D: cold optional getters measured in alchemist/Admission.t.sol on both EVMs.
  ['libraries/ReceiverPendingV21.sol', 'MODULE_CAP_GAS', '30000', '6000'],
  ['libraries/ReceiverPendingV21.sol', 'MODULE_TRIGGER_GAS', '30000', '6000'],
  ['libraries/BoxTokenProof.sol', 'INITIAL_HOLDER_GAS', '30000', '12211'],
] as const;
// SH-V21-04 cold complete steps against supplied base, default / Amsterdam net deltas:
// Eat first linked dead-wallet unlock: -44 / -144; Pile first linked recipient: +126 / +26.
// Holders T buyBack: +4470 / +6070; Items T buyBack: -1461 / -461.
// Built-in actions replace the old callback delegatecall. Fixed core links and impossible-debt
// read elimination are included in these end-to-end deltas. No named allowance changes.
// Future CALL actions use PILE_MOVE_GAS plus its reserve: the same 3.5M envelope. FM19/FM20
// prove full-cap exhaustion and unspent-budget rollback at that envelope on both EVMs.
// SH-V21-05 remeasurement (StepGas and items-pool/Lifecycle): Depth removes inside P before
// buying outside T. Its complete cold call still fits the existing 3M buyBack envelope; no cap rises.
const moduleRewardSteps = [['holders T', 417_788n, 1_156_548n], ['items T', 397_854n, 967_874n],
  ['Depth items T', 419_566n, 1_077_606n]] as const;
// RC5-C retryable call ceilings, not successful-execution guarantees for arbitrary tokens/payees.
// RoyaltyCustody.t.sol exercises full exhaustion and verifies custody rollback.
const royaltyCeilings = [
  ['BoxRoyaltyRouterV2.sol', 'READ_GAS', '50000'],
  ['BoxRoyaltyRouterV2.sol', 'TOKEN_GAS', '2700000'],
  ['BoxRoyaltyRouterV2.sol', 'SINK_GAS', '5000000'],
  ['BoxRoyaltyRouterV2.sol', 'PAYEE_GAS', '200000'],
] as const;
// Existing-NFTs add-on (SH-EXISTING-NFTS-E02, not part of the v2.1 release): bounded admission probe ceilings.
const setAdmissionCeilings = [
  ['set/SetAdmissionV2.sol', 'PROBE_GAS', '30000'],
  ['set/SetAdmissionV2.sol', 'MIN_PROBE_GAS', '40000'],
  // SH-E09C-COLLECTION-GAS: ownerOf alone gets a larger probe (ERC721A ownership walks).
  ['set/SetAdmissionV2.sol', 'OWNER_GAS', '300000'],
  ['set/SetAdmissionV2.sol', 'MIN_OWNER_GAS', '320000'],
] as const;
// SH-EXISTING-NFTS-E03: add-on custody transfer ceiling and pre-call forwarding/accounting floor.
// These bound hostile execution; E-07 still owns cold release transaction budgets.
const setCustodyCeilings = [
  ['set/SetVaultV2.sol', 'NFT_TRANSFER_GAS', '450000'],
  ['set/SetVaultV2.sol', 'MIN_TRANSFER_GAS', '1450000'],
  // SH-EXISTING-NFTS-E05: per-item creator recovery self-call ceiling.
  ['set/SetVaultV2.sol', 'RELEASE_GAS', '1900000'],
] as const;
const reserves = [
  ['BoxReceiverV2Base.sol', 'PILE_MOVE_RESERVE_GAS', '200000'],
  ['BoxReceiverV2Base.sol', 'EAT_RESERVE_GAS', '200000'],
  ['interfaces/ReleaseConstantsV2.sol', 'HOLDER_NOTICE_RESERVE_GAS', '1200000'],
  ['interfaces/ReleaseConstantsV2.sol', 'INBOX_SWEEP_RESERVE_GAS', '4000000'],
  ['interfaces/ReleaseConstantsV2.sol', 'POKE_OVERHEAD_GAS', '20000'],
  ['interfaces/IHolderLedgerV2.sol', 'TOKEN_SETTLEMENT_RESERVE_GAS', '1200000'],
  ['interfaces/IShopVaultV2.sol', 'NFT_RETURN_RESERVE_GAS', '200000'],
  ['ItemLedgerV2.sol', 'PAYOUT_RESERVE_GAS', '100000'],
  ['HolderLedgerV2.sol', 'PAYOUT_RESERVE_GAS', '200000'],
  ['BoxVaultV2.sol', '_ITEM_LEDGER_RESERVE_GAS', '1200000'],
  ['BoxCollectionV2.sol', 'OBSERVER_GAS', '460000'], // Dormant: transferObserver() is always zero.
  ['set/SetVaultV2.sol', 'RELEASE_RESERVE_GAS', '100000'], // SH-EXISTING-NFTS-E05 recovery batch reserve.
] as const;
const cap = (name: string) => {
  const row = measured.find(r => r[1] === name);
  if (!row) throw new Error(`missing allowance ${name}`);
  return BigInt(row[2]);
};
const admit = (gas: bigint, reserve = 0n) => gas + gas / 63n + 20_000n + reserve;
// Historical 3 gwei controls must opt into the old operating budgets explicitly.
const historicalEnv = {
  SH_KEEPER_MAX_FEE_WEI: '3000000000', SH_KEEPER_OURS_WEI_PER_DAY: '90000000000000000',
  SH_KEEPER_POKES_WEI_PER_DAY: '12000000000000000', SH_KEEPER_RESERVE_WEI_PER_DAY: '48600000000000000',
  SH_KEEPER_TOTAL_WEI_PER_DAY: '102000000000000000',
};

describe('FINAL3 complete named allowance inventory and transaction composition', () => {
  it('accounts for every literal named gas allowance or retained reserve in v2 sources', () => {
    const actual: Record<string, string> = {};
    for (const file of readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.sol'))) {
      const code = readFileSync(resolve(sourceRoot, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const match of code.matchAll(/\buint256\s+(?:(?:public|private|internal)\s+)?constant\s+(\w*GAS)\s*=\s*([\d_]+)\s*;/g)) {
        const [, name, gas] = match;
        if (!name || !gas) throw new Error('gas inventory match requires a name and value');
        actual[`${file}:${name}`] = BigInt(gas.replaceAll('_', '')).toString();
      }
    }
    expect(actual).toEqual(Object.fromEntries([...measured, ...reserves, ...royaltyCeilings, ...setAdmissionCeilings, ...setCustodyCeilings].map(([file, name, gas]) => [`${file}:${name}`, gas])));
  });

  it.each(measured)('%s:%s retains at least twice its measured strict bound', (_file, _name, gas, bound) => {
    expect(BigInt(gas)).toBeGreaterThanOrEqual(2n * BigInt(bound));
  });

  it.each(moduleRewardSteps)('%s shared action stays within the buyBack envelope', (_name, normal, amsterdam) => {
    expect(normal).toBeLessThan(3_000_000n);
    expect(amsterdam).toBeLessThan(3_000_000n);
    expect(transactionGas('buyBack', amsterdam)).toBe(V2_GAS_FLOORS.buyBack);
  });

  it('retains the plain-token 12.5M arithmetic control with an explicit 3 gwei / 0.045 ETH environment', () => {
    // Retained plain-token control only: the ledger-token variant fails this outer envelope.
    const floor = 12_500_000n;
    expect(gasLimitFrom(100_000n, floor)).toBe(floor);
    const padded = gasLimitFrom(floor, floor);
    expect(padded).toBe(15_000_000n);
    expect(padded).toBeLessThan(EIP7825_GAS_CAP);
    const cfg = loadConfig({ ...historicalEnv, SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RESERVE_WEI_PER_DAY: '45000000000000000' });
    const budget = openBudget(undefined, 1n, 0n);
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    const context = { fees, limits: cfg.limits, privateEndpoint: false, budget };
    const sim = { ok: true, tipWei: null, estimate: floor };
    expect(decide('graduate', sim, context)).toMatchObject({ send: true, gas: padded, costWei: 45_000_000_000_000_000n });
    expect(decide('graduate', sim, { ...context, budget: { ...budget,
      oursWei: cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay,
      totalWei: cfg.limits.totalWeiPerDay - cfg.limits.reserveWeiPerDay } }))
      .toMatchObject({ send: true, gas: padded, costWei: 45_000_000_000_000_000n });
  });

  it('with an explicit 3 gwei environment prices the ledger envelope at 0.0486 ETH and refuses 0.045 ETH', () => {
    // Published floor: same two burns/two pokes and ledger history as Graduation.t.sol.
    const floor = V2_GAS_FLOORS.graduate;
    expect(floor).toBe(13_500_000n);
    expect(transactionGas('graduate', 100_000n)).toBe(floor);
    const padded = transactionGas('graduate', floor);
    expect(padded).toBe(16_200_000n);
    expect(EIP7825_GAS_CAP - padded).toBe(577_216n);
    const cfg = loadConfig({ ...historicalEnv, SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    const budget = openBudget(undefined, 1n, 0n);
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    expect(fees.maxFeePerGas).toBe(3_000_000_000n);
    const context = { fees, limits: cfg.limits, privateEndpoint: false, budget };
    const sim = { ok: true, tipWei: null, estimate: floor };
    const sent = decide('graduate', sim, context);
    expect(sent).toMatchObject({ send: true, gas: padded, costWei: 48_600_000_000_000_000n });
    expect(charge(budget, 'graduate', sent)).toMatchObject({
      oursWei: 48_600_000_000_000_000n, totalWei: 48_600_000_000_000_000n, txInBlock: 1,
    });
    // Isolate the ours and total limits; a fresh day's successful send does not prove protected capacity.
    for (const [spent, why] of [
      [{ ...budget, oursWei: cfg.limits.oursWeiPerDay - 45_000_000_000_000_000n,
        totalWei: cfg.limits.oursWeiPerDay - 45_000_000_000_000_000n }, 'ours budget spent'],
      [{ ...budget, totalWei: cfg.limits.totalWeiPerDay - 45_000_000_000_000_000n }, 'daily ceiling reached'],
    ] as const) {
      const refused = decide('graduate', sim, { ...context, budget: spent });
      expect(refused).toEqual({ send: false, why });
      expect(charge(spent, 'graduate', refused)).toEqual(spent);
    }
  });

  it('admits the ledger envelope at 3 gwei from the default reserve and preserves exact capacity boundaries', () => {
    const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    expect(cfg.limits.reserveWeiPerDay).toBe(51_000_000_000_000_000n);
    expect(cfg.limits.oursWeiPerDay).toBe(102_000_000_000_000_000n);
    expect(cfg.limits.totalWeiPerDay).toBe(114_000_000_000_000_000n);
    expect(cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay).toBe(51_000_000_000_000_000n);
    const budget = { ...openBudget(undefined, 1n, 0n),
      oursWei: cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay,
      totalWei: cfg.limits.totalWeiPerDay - cfg.limits.reserveWeiPerDay };
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    expect(fees.maxFeePerGas).toBe(cfg.limits.maxFeePerGas);
    const context = { fees, limits: cfg.limits, privateEndpoint: false, budget };
    const sim = { ok: true, tipWei: null, estimate: V2_GAS_FLOORS.graduate };
    const sent = decide('graduate', sim, context);
    expect(sent).toMatchObject({ send: true, gas: 16_200_000n, costWei: 48_600_000_000_000_000n });
    const headroom = 2_400_000_000_000_000n;
    expect(charge(budget, 'graduate', sent)).toMatchObject({
      oursWei: cfg.limits.oursWeiPerDay - headroom, totalWei: cfg.limits.totalWeiPerDay - headroom,
    });
    // The reserve leaves 0.0024 ETH spare. Exactly 0.0486 ETH remaining still admits;
    // one wei less in either budget refuses and reserves nothing.
    const exact = { ...budget, oursWei: budget.oursWei + headroom, totalWei: budget.totalWei + headroom };
    const atBoundary = decide('graduate', sim, { ...context, budget: exact });
    expect(atBoundary).toEqual(sent);
    expect(charge(exact, 'graduate', atBoundary)).toMatchObject({
      oursWei: cfg.limits.oursWeiPerDay, totalWei: cfg.limits.totalWeiPerDay,
    });
    for (const [key, why] of [['oursWei', 'ours budget spent'], ['totalWei', 'daily ceiling reached']] as const) {
      const spent = { ...exact, [key]: exact[key] + 1n };
      const refused = decide('graduate', sim, { ...context, budget: spent });
      expect(refused).toEqual({ send: false, why });
      expect(charge(spent, 'graduate', refused)).toEqual(spent);
    }
  });

  it('retains Safe-payment capacity boundaries at 3/2.7 gwei with explicit historical budgets', () => {
    const cfg = loadConfig({ ...historicalEnv, SH_KEEPER_RPC_URL: 'http://fake.invalid',
      SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    // Leave 0.0414 ETH ours: the same capacity boundary, now after recovery spends 0.0486 ETH.
    const budget = { ...openBudget(undefined, 1n, 0n), oursWei: 48_600_000_000_000_000n,
      totalWei: 48_600_000_000_000_000n };
    const context = { fees: feesFor(1_475_000_000n, cfg.priorityFeeWei), limits: cfg.limits,
      privateEndpoint: false, budget };
    const sim = { ok: true, tipWei: null, estimate: 12_000_000n };
    for (const job of ['receiverPayFit', 'receiverPayPlatform'] as const) {
      expect(decide(job, sim, { ...context, budget: openBudget(undefined, 1n, 0n) }))
        .toMatchObject({ send: true, gas: 14_400_000n, costWei: 43_200_000_000_000_000n });
      const refused = decide(job, sim, context);
      expect(refused).toEqual({ send: false, why: 'ours budget spent' });
      expect(charge(budget, job, refused)).toEqual(budget);
      expect(decide(job, sim, { ...context, fees: feesFor(1_325_000_000n, cfg.priorityFeeWei) }))
        .toMatchObject({ send: true, gas: 14_400_000n, costWei: 38_880_000_000_000_000n });
    }
  });

  it('admits the least submitted gas of a failure whose price coin spends the sweeps and the tip, on both EVMs', () => {
    // SH-V21-RC7-INT release review GK-1, rc7rr/FailFloor.t.sol: least SUBMITTED gas (intrinsic included, cold state),
    // not gross use at a 16,777,215 submission. A hostile P spends the router sweep, the inbox sweep and the tip; the
    // burns call our own BoxTokenV2. Worst menu: 10,253,855 default, 12,815,029 Amsterdam.
    // With the burns spent too (all five), Amsterdam needs 15,004,252 to 15,292,746: not admitted, and not claimed.
    for (const job of ['fail', 'failClosed'] as const) {
      expect(transactionGas(job, 1n), job).toBeGreaterThanOrEqual(12_815_029n);
      expect(transactionGas(job, 1n), job).toBeLessThan(15_004_252n);
      expect(transactionGas(job, 1n), job).toBeLessThan(EIP7825_GAS_CAP);
    }
  });

  it('admits composed optional calls including EIP-150 before keeper padding', () => {
    // RC7: the retained post-inbox reserve overlaps the later burn/tip allowances.
    // Do not add it to the five-call expenditure sum a second time.
    const failureCalls = 2n * admit(cap('BURN_GAS')) + admit(cap('SWEEP_GAS'))
      + admit(cap('INBOX_SWEEP_GAS')) + admit(cap('TIP_GAS'));
    expect(failureCalls).toBe(12_899_997n);
    const inboxAdmission = admit(cap('SWEEP_GAS')) + admit(cap('INBOX_SWEEP_GAS'), 4_000_000n) + 22_000n;
    expect(inboxAdmission).toBe(8_938_189n);
    for (const job of ['fail', 'failClosed'] as const) {
      expect(V2_GAS_FLOORS[job]).toBe(15_000_000n);
      expect(inboxAdmission).toBeLessThan(V2_GAS_FLOORS[job]);
    }
    const envelopes = {
      // Failure's five optional calls: both burns, the launch-router sweep, the inbox's P sweep (RC6-RR-INBOX) and the tip.
      fail: [15_000_000n, 2n * admit(cap('BURN_GAS')) + admit(cap('SWEEP_GAS')) + admit(cap('INBOX_SWEEP_GAS')) + admit(cap('TIP_GAS'))],
      failClosed: [15_000_000n, 2n * admit(cap('BURN_GAS')) + admit(cap('SWEEP_GAS')) + admit(cap('INBOX_SWEEP_GAS')) + admit(cap('TIP_GAS'))],
      graduate: [13_500_000n, 2n * admit(cap('BURN_GAS')) + 2n * admit(cap('POKE_GAS'))],
      collect: [8_000_000n, admit(cap('TIP_GAS'))],
      buyBack: [8_000_000n, admit(cap('RECEIVER_BURN_GAS')) + admit(cap('TIP_GAS'))],
      moveToPile: [3_500_000n, admit(cap('PILE_MOVE_GAS'), 200_000n)],
      executeModule: [3_500_000n, admit(cap('MODULE_CAP_GAS')) + admit(cap('MODULE_TRIGGER_GAS')) + admit(cap('PILE_MOVE_GAS'), 200_000n)],
      eatPriceCoin: [3_500_000n, admit(cap('EAT_GAS'), 200_000n)],
      deepen: [8_000_000n, admit(cap('BURN_GAS')) + admit(cap('TIP_GAS'))],
      royaltyFlush: [8_000_000n, admit(5_000_000n) + admit(2_700_000n)],
      royaltySweep: [8_000_000n, admit(5_000_000n) + admit(2_700_000n)],
      // RC6 inbox refreshOrder: one TOKEN_GAS approval call at a time plus the largest measured call
      // (rc6-cow suites --gas-report: 266,680 gas default, 1,058,360 Amsterdam; mainnet fork 289,401 and 991,361).
      royaltyRefresh: [5_000_000n, admit(2_700_000n) + 1_058_360n],
      // RC7-HOOK-PAGE: page ends at STEP_MIN_Q or 32 sources. The integrator's cold 32-valued-source exhausted-tip
      // press measured 4,001,971 gas default and 7,668,544 Amsterdam; keep twice the larger measurement.
      sellFees: [16_000_000n, 2n * 7_668_544n],
      burnPending: [1_500_000n, admit(cap('RECEIVER_BURN_GAS'))],
      receiverPayFit: [12_000_000n, admit(4n * cap('PAYOUT_GAS'))],
      receiverPayPlatform: [12_000_000n, admit(4n * cap('PAYOUT_GAS'))],
      shopBurn: [5_000_000n, admit(cap('LIQUID_BURN_GAS'), 200_000n) + admit(cap('CLAIMS_BURN_GAS'), 200_000n)],
      shopReturn: [2_000_000n, admit(cap('NFT_RETURN_GAS'), 200_000n)],
    } as const;
    for (const [job, [envelope, admission]] of Object.entries(envelopes)) {
      expect(admission + 22_000n, job).toBeLessThan(envelope);
      expect(JOBS.find(j => j.name === job)?.gasPerRun, job).toBe(envelope);
      expect(transactionGas(job, envelope), job).toBeLessThanOrEqual(EIP7825_GAS_CAP);
      // The published sellFees and collect allowances are their Amsterdam floors; transactionGas signs by fork and simulated output.
      if (!job.startsWith('receiverPay')) expect(transactionGas(job, 1n, (job === 'sellFees' || job === 'collect') ? AMSTERDAM : undefined), job).toBe(envelope);
    }
    // RC6RR2-HP-2 / SH-RC7-HOOK-PAGE: the integrator's 4,001,971 before Amsterdam needs 8.2M for twice it.
    // A zero-P page pays no tip; rc6rr2/ZeroPageFloor.t.sol now measures 760,852 / 1,581,472,
    // so 3.5M keeps more than twice the larger on every fork.
    expect(transactionGas('sellFees', 1n)).toBe(8_200_000n);
    expect(2n * 4_001_971n).toBeLessThanOrEqual(8_200_000n);
    for (const rules of [undefined, AMSTERDAM]) expect(transactionGas('sellFees', 1n, rules, 2, true)).toBe(3_500_000n);
    expect(2n * 1_581_472n).toBeLessThanOrEqual(3_500_000n);
    expect(admit(cap('CLAIM_GAS'), 100_000n) + 22_000n).toBeLessThan(4_000_000n);
    expect(admit(cap('HOLDER_NOTICE_GAS'), 1_200_000n)).toBe(2_642_222n);
    expect(admit(cap('TOKEN_SETTLEMENT_GAS'), 1_200_000n)).toBe(1_829_523n);
    expect(cap('ITEM_LEDGER_GAS') + cap('ITEM_LEDGER_GAS') / 63n + 1_200_000n + 10_000n).toBe(2_225_873n);
  });
});
