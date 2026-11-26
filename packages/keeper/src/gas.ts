import { decodeFunctionResult, encodeFunctionData, formatBlock, multicall3Abi, parseAbi, type Address, type Hex, type PublicClient, type RpcBlock } from 'viem';
import { M2_GAS } from './m2-gas';
import { M3_GAS } from './m3-gas';

/**
 * Gas and fees (core-v2-plan.md:312, risk 7: "Estimate with fee fields against the pending block, plus 20% or 150k").
 * An estimate that leaves out fee fields or uses the latest block can miss one new slot, about 108k gas, so the keeper
 * estimates against the pending block with its fee fields and adds the larger of 20% and 150,000 [P: "the larger"].
 */
export const HEADROOM_BPS = 2_000n;
export const HEADROOM_MIN = 150_000n;
export const EIP7825_GAS_CAP = 16_777_216n;

/** Destination rules, supplied by the chain adapter for this particular pending estimate.
 * stateGas is the state gas funded by the reservoir above transactionCap, not all state work.
 * EIP-8037's reservoir is evm_gas - min(2^24 - intrinsic, evm_gas): zero for tx.gas <= 2^24.
 * The reviewed no-reservoir adapter returns 0n; admission keeps limits at or below the configured cap.
 * blockGasLimit is the destination's total per-transaction block allowance, not gasUsed.
 */
export interface GasConstraints {
  readonly fork: 'cancun' | 'osaka' | 'amsterdam';
  readonly transactionCap: bigint | null;
  readonly blockGasLimit: bigint;
  readonly stateGas?: bigint;
}

export type DestinationGasPolicy = Pick<GasConstraints, 'fork' | 'transactionCap'>;

/** One pending estimate: gas covers execution and state work; stateGas is its reservoir-funded portion.
 * The reviewed 0n follows from the protocol for signed limits at or below transactionCap (at most 2^24).
 * A nonzero reservoir needs a reviewed paired estimate, never a second trace or configured guess.
 */
export interface PendingGasEstimate {
  readonly gas: bigint;
  readonly stateGas?: bigint;
}

/** Only inject a reviewed destination estimator. Ordinary eth_estimateGas supplies total gas without a split. */
export type PendingGasEstimator = (request: CallRequest & {
  readonly blockTag: 'pending'; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint;
}) => Promise<PendingGasEstimate>;

/** Legacy callers have no fork input: retain the conservative Osaka transaction envelope. */
export const DEFAULT_GAS_CONSTRAINTS: GasConstraints = Object.freeze({
  fork: 'osaka', transactionCap: EIP7825_GAS_CAP, blockGasLimit: EIP7825_GAS_CAP,
});

export class GasAdmissionError extends Error {
  constructor(reason: string) { super(`gas admission: ${reason}`); }
}

export interface Fees {
  readonly baseFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
}

export type CallRequest = {
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
};

/** What the keeper needs of a viem public client. */
export interface GasClient {
  estimateGas(args: CallRequest & { blockTag: 'pending'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<bigint>;
}

interface PendingBlockClient {
  request(args: { method: 'eth_getBlockByNumber'; params: ['pending', false] }): Promise<unknown>;
}

export class FeeUnavailableError extends Error {
  constructor() { super('fee unavailable'); }
}

/** Validate the node's quantity before viem can coerce booleans, numbers or whitespace into bigint.
 * Use the same client's transport, and format that same response so the fee and World share one snapshot.
 */
export async function readPendingBlock(client: PendingBlockClient) {
  const raw = await client.request({ method: 'eth_getBlockByNumber', params: ['pending', false] });
  const fee = raw !== null && typeof raw === 'object' && 'baseFeePerGas' in raw ? raw.baseFeePerGas : undefined;
  if (typeof fee !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(fee)) throw new FeeUnavailableError();
  return { ...formatBlock(raw as RpcBlock), baseFeePerGas: BigInt(fee) };
}

/** SH-259 rule A: the node's raw eth_gasPrice, validated as the base fee is (a hex quantity without leading zeros, above
 * zero); anything else (a boolean, an empty string, zero, a number, whitespace) is no quote: null. */
export async function readGasPriceQuote(client: { request(args: { method: 'eth_gasPrice' }): Promise<unknown> }): Promise<bigint | null> {
  let raw: unknown;
  try { raw = await client.request({ method: 'eth_gasPrice' }); } catch { return null; }
  if (typeof raw !== 'string' || !/^0x[1-9a-fA-F][0-9a-fA-F]*$/.test(raw)) return null;
  return BigInt(raw);
}

/** Fresh admission observation after estimation. Read only the two EVM block fields needed
 * by the destination policy, together in one pending call to the configured deployment.
 * Clients without Multicall3 metadata keep the ordinary pending header path.
 */
const gasEnvelopeAbi = parseAbi(['function getCurrentBlockGasLimit() view returns (uint256)', 'function getCurrentBlockTimestamp() view returns (uint256)']);
export async function readPendingGasEnvelope(client: PublicClient) {
  const address = client.chain?.contracts?.multicall3?.address;
  if (!address) return client.getBlock({ blockTag: 'pending' });
  const functions = ['getCurrentBlockGasLimit', 'getCurrentBlockTimestamp'] as const;
  const results = await client.readContract({ address, abi: multicall3Abi, functionName: 'aggregate3', blockTag: 'pending',
    args: [functions.map(functionName => ({ target: address, allowFailure: false,
      callData: encodeFunctionData({ abi: gasEnvelopeAbi, functionName }) }))] });
  const values = functions.map((functionName, i) => {
    const result = results[i];
    if (!result?.success) throw new Error('pending gas envelope unavailable');
    return decodeFunctionResult({ abi: gasEnvelopeAbi, functionName, data: result.returnData });
  });
  const [gasLimit, timestamp] = values;
  if (gasLimit === undefined || gasLimit <= 0n || timestamp === undefined || timestamp <= 0n) throw new Error('invalid pending gas envelope');
  return { gasLimit, timestamp };
}

/**
 * SH-259 rule A: the price a chain whose base fee is 0 (BNB Chain testnet) signs at, both fee fields: the tick's own
 * eth_gasPrice plus a quarter of it (rounded up), never under the configured floor, at most the ceiling. Null means
 * wait (nothing is signed or broadcast): the quote failed, or the network's price is above the ceiling.
 * 100,000,000 -> 125,000,000; 120,000,000 -> 150,000,000; 180,000,000 -> 200,000,000 (ceiling); 250,000,000 -> null.
 */
export function zeroBasePrice(quote: bigint | null, floor: bigint, ceiling: bigint): bigint | null {
  if (quote === null || quote <= 0n || quote > ceiling) return null;
  const headroom = quote + (quote + 3n) / 4n;
  const price = headroom > floor ? headroom : floor;
  return price > ceiling ? ceiling : price;
}

/** The fee fields: room for the base fee to double, plus the priority fee. */
export function feesFor(baseFeePerGas: bigint, maxPriorityFeePerGas: bigint): Fees {
  return { baseFeePerGas, maxPriorityFeePerGas, maxFeePerGas: 2n * baseFeePerGas + maxPriorityFeePerGas };
}

export async function pendingFees(client: PendingBlockClient, maxPriorityFeePerGas: bigint): Promise<Fees> {
  const block = await readPendingBlock(client);
  return feesFor(block.baseFeePerGas, maxPriorityFeePerGas);
}

export async function estimatePending(client: GasClient, req: CallRequest, fees: Fees): Promise<bigint> {
  return client.estimateGas({
    ...req,
    blockTag: 'pending',
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}

/** Pad within the destination allowance; never clip the estimate or a required floor. */
export function gasLimitFrom(estimate: bigint, floor = 0n, constraints: GasConstraints = DEFAULT_GAS_CONSTRAINTS): bigint {
  const { fork, transactionCap, blockGasLimit } = constraints;
  const stateGas = constraints.stateGas ?? 0n;
  if (typeof estimate !== 'bigint' || typeof floor !== 'bigint' || typeof blockGasLimit !== 'bigint'
    || estimate <= 0n || floor < 0n || blockGasLimit <= 0n
    || (transactionCap !== null && (typeof transactionCap !== 'bigint' || transactionCap <= 0n))) {
    throw new GasAdmissionError('invalid estimate, floor or destination limit');
  }
  if (!['cancun', 'osaka', 'amsterdam'].includes(fork)
    || (fork !== 'cancun' && (transactionCap === null || transactionCap > EIP7825_GAS_CAP))) {
    throw new GasAdmissionError('invalid fork transaction cap');
  }
  if ((constraints.stateGas !== undefined && typeof constraints.stateGas !== 'bigint')
    || stateGas < 0n || stateGas > estimate || (fork !== 'amsterdam' && stateGas !== 0n)
    || (fork === 'amsterdam' && constraints.stateGas === undefined)) {
    throw new GasAdmissionError('invalid or missing state gas estimate');
  }
  const transactionLimit = transactionCap === null ? blockGasLimit : transactionCap + stateGas;
  const ceiling = transactionLimit < blockGasLimit ? transactionLimit : blockGasLimit;
  if (estimate > ceiling) throw new GasAdmissionError('estimate exceeds destination limit');
  if (floor > ceiling) throw new GasAdmissionError('required floor exceeds destination limit');
  const pct = (estimate * HEADROOM_BPS) / 10_000n;
  const limit = estimate + (pct > HEADROOM_MIN ? pct : HEADROOM_MIN);
  const padded = limit > floor ? limit : floor;
  return padded < ceiling ? padded : ceiling;
}

/**
 * The `sellFees` press's signed floor (second release review: RC6RR2-HP-2, RR2-LIM-1, RC6RR2-KEEPER-1). A positive-P
 * page may pay its presser's tip through the 2.8M TIP_GAS stipend: the cold 32-source press whose price coin exhausts
 * that stipend measured up to 4,001,971 gas before Amsterdam and 7,668,544 on it (SH-RC7-HOOK-PAGE, integrator probe).
 * The rc7 page stops at STEP_MIN_Q or 32 sources, whatever each is worth; 8.2M and 16M keep twice those measurements.
 * Part 4 review (P4R-1): pressed after trades nobody has collected yet (the usual case), the same page costs more:
 * up to 4,122,741 / 8,236,914 gas, least succeeding limit 4,160,008 / 8,345,458 (rc7-hook-page/UncollectedPage.t.sol),
 * so these floors keep 1.97x / 1.92x of that limit, not twice; unchanged here (rc7 open item 60).
 * A simulated zero-P page pays no tip: the cold 32-dust page measured 760,852 and 1,581,472 gas
 * (rc6rr2/ZeroPageFloor.t.sol), and 3.5M keeps more than twice the larger. A page that turns positive by
 * inclusion needs the stipend: at 3.5M it runs exactly as at the positive-P floor when the stipend fits, else it
 * reverts whole (out of gas, or GasTooLow at the stipend's pre-check; a 32-valued page does so on either EVM), never
 * a partial press.
 */
export const SELL_FEES_FLOORS = Object.freeze({ beforeAmsterdam: 8_200_000n, amsterdam: 16_000_000n, zeroOutput: 3_500_000n });
export const sellFeesFloor = (fork: GasConstraints['fork'], zeroOutput = false): bigint =>
  zeroOutput ? SELL_FEES_FLOORS.zeroOutput : fork === 'amsterdam' ? SELL_FEES_FLOORS.amsterdam : SELL_FEES_FLOORS.beforeAmsterdam;

/** RC7: second-tip admission, including EIP-8037 state gas, binds before total gas used does.
 * The cold least-gas probe plus one fresh slot (107,920 gas) and 20% fits these floors on each fork.
 * See test/box-v2/rc7/ReceiverQuotaGas.t.sol and SH-RC7-RECEIVER-QUOTA af2; TIP_GAS stays 2.8M.
 * SH-V21-RC7-INT part 3 review: an items-buyers/holders-sellers box needs 5,864,206 on Amsterdam, padded
 * 7,166,552, above af2's 7M; 8M covers it (3,936,154 before Amsterdam, padded 4,852,889, still under 5M).
 * Ordinary P only (SH-RC7-RECEIVER-QUOTA's limitation; release review GK-2): a P whose transfer burns the whole tip
 * stipend, estimated with one tip due and included with two, needs up to 6,817,624 before Amsterdam and 9,900,372 on
 * it, above what is signed; that collect reverts whole and costs only the keeper's gas (rc7/ReceiverQuotaGas.t.sol).
 */
export const COLLECT_FLOORS = Object.freeze({ beforeAmsterdam: 5_000_000n, amsterdam: 8_000_000n });
export const collectFloor = (fork: GasConstraints['fork']): bigint =>
  fork === 'amsterdam' ? COLLECT_FLOORS.amsterdam : COLLECT_FLOORS.beforeAmsterdam;

/** FINAL2-GAS: supplied outer envelopes admit the full named stipends, including EIP-150/continuation.
 * FINAL3-G01 raises graduation for both burns, both pokes and mandatory ledger-token history.
 * Net successful estimates can omit optional work, so these are floors. Higher pending estimates still win.
 * Safe payouts retain estimate-driven admission: their mandatory pre-checks cannot silently skip payment.
 */
export const V2_GAS_FLOORS = Object.freeze({
  // RC6-RR-INBOX added failure's fifth optional call, the inbox's P sweep under INBOX_SWEEP_GAS (3.2M). A failure
  // whose five calls (both burns, the router sweep, the inbox sweep, the tip) all spend their allowances uses 13,232,153
  // gas (default EVM) and 14,553,878 (Amsterdam) gross when sent with 16,777,215 (SH-RC7-CLAIM-RESERVE). A floor must
  // cover the least SUBMITTED gas, which is higher because the tip's admission comes last: 13,634,920 to 13,736,895
  // before Amsterdam and 15,004,252 to 15,292,746 on it (SH-V21-RC7-INT release review GK-1, rc7rr/FailFloor.t.sol).
  // So 15M does not admit that case on Amsterdam; such a send reverts whole (GasTooLow), never half done. Nobody else
  // can make the burns spend their allowance (BURN_GAS calls into our own BoxTokenV2). The reachable worst, a hostile
  // P spending the router sweep, the inbox sweep and the tip, needs at most 10,253,855 submitted before Amsterdam and
  // 12,815,029 on it, which 15M admits. rc7's 4M reserve after the inbox sweep is admission, not spend: the router
  // sweep's and the inbox's admissions with it come to 8,938,189, also inside 15M. Any padding above the floor is
  // clipped at the destination's ceiling, never sent beyond the EIP-7825 cap.
  fail: 15_000_000n, failClosed: 15_000_000n, graduate: 13_500_000n,
  // Publish the largest collect floor; transactionGas signs by fork, as for sellFees.
  collect: COLLECT_FLOORS.amsterdam, buyBack: 8_000_000n, deepen: 8_000_000n,
  // RC7-HOOK-PAGE: stop at STEP_MIN_Q or 32 FIFO sources. The integrator measured cold exhausted-tip presses
  // at 4,001,971 / 7,668,544 gas (before Amsterdam / on it); after uncollected trades up to 4,122,741 / 8,236,914
  // (P4R-1, sellFeesFloor above). Publish the largest floor; transactionGas
  // signs by fork and simulated output (sellFeesFloor above), preserving the 816M daily unblocking allowance.
  sellFees: SELL_FEES_FLOORS.amsterdam,
  // RC6 inbox refreshOrder: one TOKEN_GAS approval call at a time (2.7M) plus the registration, measured against
  // mainnet's ComposableCoW at 286,182 gas (default EVM) and 988,142 (Amsterdam) since the part 2 fix round registers
  // without dispatch (289,401 and 991,361 with it); the rc6-cow suites' largest was 1,058,360 at the merge.
  royaltyRefresh: 5_000_000n,
  // observe(WETH) may wrap ETH through the 2.7M TOKEN_GAS stipend before bounded reads and clock writes.
  royaltyObserve: 5_000_000n,
  burnPending: 1_500_000n, royaltyFlush: 8_000_000n, royaltySweep: 8_000_000n, routerSweep: 2_000_000n,
  // EAT_GAS 2.8M + EIP-150 admission + 200k reserve. EAT19 measured cold entry at
  // 3,141,263; 3.5M also funds intrinsic gas, clone forwarding and preparation.
  moveToPile: 3_500_000n,
  executeModule: 3_500_000n,
  // G1-D2 cold Amsterdam first purchase + refund: 2,751,883 gas. 3.5M exceeds
  // that measurement plus 20%; higher pending-state estimates still win.
  shopFees: 3_500_000n,
  eatPriceCoin: 3_500_000n,
  ...M2_GAS, ...M3_GAS,
});
export const FAILURE_GAS_FLOOR = V2_GAS_FLOORS.fail;
export const BOX0_FAILURE_GAS_FLOOR = 3_500_000n;
/** `zeroOutput`: the pending simulation of a v2 `sellFees` press sold for zero P (and so pays no tip). */
export function transactionGas(job: string, estimate: bigint, constraints: GasConstraints = DEFAULT_GAS_CONSTRAINTS,
  version: 1 | 2 = 2, zeroOutput = false): bigint {
  const floor = version === 1
    ? (job === 'fail' || job === 'failClosed' ? BOX0_FAILURE_GAS_FLOOR : 0n)
    : job === 'sellFees' ? sellFeesFloor(constraints.fork, zeroOutput)
      : job === 'collect' ? collectFloor(constraints.fork)
        : (V2_GAS_FLOORS as Readonly<Record<string, bigint>>)[job] ?? 0n;
  return gasLimitFrom(estimate, floor, constraints);
}
export const reservedCostWei = (job: string, estimate: bigint, fees: Fees, constraints?: GasConstraints, version: 1 | 2 = 2,
  zeroOutput = false) => transactionGas(job, estimate, constraints, version, zeroOutput) * fees.maxFeePerGas;

/** What a call is expected to cost at these fees: the estimate at the base fee plus the priority fee. */
export function costWei(estimate: bigint, fees: Fees): bigint {
  return estimate * (fees.baseFeePerGas + fees.maxPriorityFeePerGas);
}

/** Whether a tip (in wei) pays for the call it rides on. An unknown tip never does. */
export function tipPays(tipWei: bigint | null, estimate: bigint, fees: Fees): boolean {
  return tipWei !== null && tipWei >= costWei(estimate, fees);
}
