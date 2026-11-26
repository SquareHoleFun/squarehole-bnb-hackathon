import { TickReads, readWindows } from './tick-reads';
import { HookCodeCache } from './hook-code';
import { emptyMemory, inboxJob, type Memory } from './plan';
import { readPayInTV21 } from './pay-in-t-v21';
import { IncomeCache, readIncome, ZeroedIncomeLog } from './income-read';
import { type IncomeSpend } from './income';
import { readEthParityPrice } from './income-parity';
import { readIncomePrice, TOKEN_INCOME_MAX_AGE } from './income-price';
import { maxFeeFor } from './drand-fee';
import { jobSpec } from './jobs';
import { DrandReader, START_INCLUSION_SECONDS } from './drand';
import { backupHeader, type BackupHeaderPath } from './backup-header';
import { isRevert, readFailed } from './read-failure';
import { fetchQuicknet } from './drand-relays';
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseTransaction, toHex, type Address, type Hex,
  type LocalAccount, type PublicClient, type Transport,
} from 'viem';
import {
  abiFor, boxRegistryAbi, coordinatorAbi, coordinatorV1Abi, executorAbi, hookAbi, hookV2Abi, receiverV2Abi,
  royaltyRouterV2Abi, poolManagerAbi, priceSourceAbi, receiverAbi, receiverPileV21Abi, receiverModulesV21Abi, receiverEatV21Abi, drandSourceAbi,
  listingRegistryV2Abi, holderBatchAbi, receiverCursorsAbi,
} from './abi';
import { readM2, type M2Scan } from './m2';
import { itemSyncPending, readM3 } from './m3';
import type { KeeperConfig } from './config';
import { DEFAULT_GAS_CONSTRAINTS, FeeUnavailableError, readGasPriceQuote, zeroBasePrice, estimatePending, readPendingBlock, readPendingGasEnvelope, type Fees, type GasConstraints, type PendingGasEstimate, type PendingGasEstimator } from './gas';
import type { Logger } from './log';
import type { BackupHeaderCheck } from './monitor';
import { nextNonce, nonceAhead } from './nonce';
import type { ChainPort } from './run';
import { HANG_BLOCKS, MAX_IN_FLIGHT, REBROADCAST_BLOCKS, SendWait, SentBook, UNDERPRICED_HEADS, bump, journalName, txCost,
  type SentEntry, type SentReservation, type SentTx, type SignedSend } from './sent';
import type { JobName } from './types';
import type { Candidate, Sim } from './types';
import type { BoxState, InboxCoin, V2State, World } from './world';
import { readSetRoles, verifySetRelease } from './set';

/** Registry v2's roles the keeper reads (`ROLE_V2`, packages/chain/src/core/roles.ts; test/abi.test.ts pins them). */
export const ROLES = { coordinator: 0, hook: 2, receiver: 5 } as const;
/** RC6 inbox: at most this many frozen-list coins are read per box and tick; later rows wait for a later release. */
export const MAX_INBOX_COINS = 32n;
/** A read source's failure is logged at most this often. */
const READ_WARN_SECONDS = 3_600n;

/** The keys the keeper signs with: the public one, and a second for private sends (review round 1, H2). */
export interface Signers {
  readonly public: LocalAccount | null;
  readonly private: LocalAccount | null;
}

/** The destination's reviewed fork policy and estimate-specific state gas, never inferred from chain id alone. */
export type DestinationGasReader = (
  candidate: Candidate, estimate: bigint, pending: { readonly timestamp: bigint; readonly gasLimit: bigint },
  paired?: PendingGasEstimate,
) => Promise<Omit<GasConstraints, 'blockGasLimit'>>;

export { isRevert };

/** Refuses an RPC on another chain: the keeper signs for `expected` (review round 1, L7). */
export async function checkChainId(client: { getChainId(): Promise<number> }, expected: number, allowMainnet = false): Promise<void> {
  if (expected === 1 && !allowMainnet) throw new Error('mainnet requires SH_KEEPER_ALLOW_MAINNET=1');
  const id = await client.getChainId();
  if (id !== expected) throw new Error(`the RPC is on chain id ${id}, not ${expected} (SH_KEEPER_CHAIN_ID)`);
}

const notNull = <T>(x: T | null): x is T => x !== null;

/** v4's `Pool.State` slot of a pool: keccak256(PoolId, POOLS_SLOT = 6) (StateLibrary at 46c68346). */
export const poolStateSlot = (poolId: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));

/** The tick in a slot0 word: 24 signed bits above sqrtPriceX96's 160. */
export function tickOfSlot0(word: Hex): number {
  const raw = Number((BigInt(word) >> 160n) & 0xffffffn);
  return raw >= 0x800000 ? raw - 0x1000000 : raw;
}

interface Parts {
  readonly id: bigint;
  readonly version: 1 | 2;
  readonly coordinator: Address;
  readonly hook: Address;
  readonly receiver: Address;
  readonly router: Address | null;
  readonly priceSource: Address | null;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly ethPriced: boolean;
  readonly set?: boolean;
}


export class ViemChain implements ChainPort {
  private readonly tickReads: TickReads;
  private readonly parts = new Map<string, Parts>();
  private readonly warned = new Map<string, bigint>();
  /** SH-249: the saved record; in memory until `track` attaches the store's durable one (live entries do). */
  private sent = new SentBook();
  /** SH-250: per last transaction of an open nonce, the observed heads its maximum fee was below the base fee. */
  private readonly underpriced = new Map<string, { heads: number; block: bigint }>();
  /** Re-check note 1: contested nonces (signer:nonce) the signer's count has passed at the finalized block. */
  private readonly spent = new Set<string>();
  /** SH-250 B6: per nonce (signer:nonce), the block of its last search for the transaction that used it. */
  private readonly searched = new Map<string, bigint>();
  /** SH-250 B2: this round's replacements the runner may pay for. */
  private proposals: Replacement[] = [];
  /** One round's reads (keyed by the pending block number): counts per signer, receipts per hash. */
  private round = { block: -1n, followed: false, counts: new Map<string, Promise<{ latest: bigint; pending: bigint }>>(),
    receipts: new Map<string, Promise<Receipt | null>>(), finalized: undefined as Promise<{ number: bigint; hash: Hex } | null> | undefined };
  private last: World | null = null;
  private now = 0n;
  private snapshotBlock = 0n;
  private m2Scan: M2Scan = {};
  private readonly pendingEstimates = new WeakMap<Candidate, PendingGasEstimate>();
  private readonly hookCode = new HookCodeCache();
  private readonly drand: DrandReader;
  private memory: Memory = emptyMemory();
  private readonly inboxLists = new Map<string, { relayer: Address; tokens: readonly Address[]; lots: Map<string, bigint> }>();
  private readonly inboxState = new Map<string, { hour: bigint; block: bigint; coin: InboxCoin }>();
  private readonly incomeCache = new IncomeCache();
  private readonly zeroedIncome = new ZeroedIncomeLog((msg, data) => this.log.warn(msg, data));
  /** This read's guarded fallbacks, for the monitor view's `complete` flags. */
  private failedReads = 0;
  private drandFailed = false;
  private backupHeaderCheck?: BackupHeaderCheck;
  private checkingBackupHeader = false;
  private readonly headerPub: PublicClient | null;

  constructor(
    private readonly cfg: KeeperConfig,
    private readonly pub: PublicClient,
    private readonly keeper: Address,
    private readonly signers: Signers,
    private readonly privatePub: PublicClient | null,
    private readonly log: Logger,
    private readonly destinationGas?: DestinationGasReader,
    private readonly pendingEstimator?: PendingGasEstimator,
    private readonly relayFetch: typeof fetch = fetch,
  ) {
    if (signers.private && cfg.privateSendAddress
      && signers.private.address.toLowerCase() !== cfg.privateSendAddress.toLowerCase()) {
      throw new Error('SH_KEEPER_PRIVATE_SEND_ADDRESS does not match private signer');
    }
    this.tickReads = new TickReads(pub);
    this.pub = this.tickReads.client;
    this.drand = new DrandReader(cfg, this.pub, keeper, log);
    const diagnosticTransport = pub.transport?.diagnosticTransport as Transport | undefined;
    this.headerPub = diagnosticTransport ? createPublicClient({ chain: pub.chain, transport: diagnosticTransport }) : null;
  }

  private backupWarning(c: Candidate, message: string) {
    const key = `${message}:${c.to.toLowerCase()}:${c.args[0]}`;
    const last = this.warned.get(key);
    if (last === undefined || this.now < last || this.now - last >= READ_WARN_SECONDS) {
      this.warned.set(key, this.now);
      this.log.warn(message, { round: c.args[0] });
    }
  }

  async prepare(c: Candidate, fees: Fees): Promise<Candidate> {
    if (c.job === 'backupStart' || c.job === 'backupFix') {
      await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
      try {
        // A start proves its parent's header (latest - 1): accepted whether a provider simulates `pending` at the latest
        // block's number or the next one (the contract refuses the current block's own header), as the second poster
        // and the laptop recipe do; it still lands up to 7 blocks after the latest.
        const latest = c.job === 'backupStart' ? (await this.pub.getBlock({ blockTag: 'latest' })).number : null;
        const number = c.job === 'backupStart' ? (typeof latest === 'bigint' && latest > 0n ? latest - 1n : null) : c.args[1];
        if (typeof number !== 'bigint' || typeof c.args[0] !== 'bigint') throw new Error();
        const header = await backupHeader({ request: args => this.pub.request(args as never) }, number);
        return { ...c, args: c.job === 'backupStart' ? [c.args[0], number, header] : [c.args[0], header] };
      } catch {
        this.backupWarning(c, 'backup header mismatch');
        throw new Error('backup header mismatch');
      }
    }
    if (c.job !== 'drandPostRound') return c;
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    const round = c.args[0];
    if (typeof round !== 'bigint') throw new Error('invalid drand candidate');
    const signature = await fetchQuicknet(round, async signature => {
      await this.pub.simulateContract({ account: this.keeper, address: c.to, abi: drandSourceAbi, functionName: 'postRound',
        args: [round, signature], blockTag: 'pending', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    }, this.relayFetch);
    return { ...c, args: [round, signature] };
  }

  /** Admission input for the runner: pending block allowance and explicit destination fork rules. */
  async gasConstraints(c: Candidate, estimate: bigint): Promise<GasConstraints> {
    const paired = this.pendingEstimates.get(c);
    this.pendingEstimates.delete(c);
    const block = await readPendingGasEnvelope(this.pub);
    const rules = this.destinationGas ? await this.destinationGas(c, estimate, block, paired) : DEFAULT_GAS_CONSTRAINTS;
    // The policy reader cannot enlarge the node's block allowance. Admission validates every component.
    return { ...rules, blockGasLimit: block.gasLimit };
  }

  private call<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args, blockNumber: this.snapshotBlock } as never) as Promise<T>;
  }

  /** One read source: on failure only its jobs are skipped this tick, logged once an hour per source (M5). */
  private async guard<T>(source: string, read: () => Promise<T>, fallback: () => T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (source === 'drand') this.drandFailed = true;
      else if (readFailed(error)) this.failedReads++;
      const at = this.warned.get(source);
      if (at === undefined || this.now - at >= READ_WARN_SECONDS) {
        this.warned.set(source, this.now);
        this.log.warn('read failed', { source, error });
      }
      return fallback();
    }
  }

  /** Diagnostic only: never await this RPC path on the candidate read/send path. */
  private async checkBackupHeader() {
    if (!this.cfg.box0 || this.checkingBackupHeader
      || (this.backupHeaderCheck && this.now - this.backupHeaderCheck.checkedAt < 86400n)) return;
    this.checkingBackupHeader = true;
    const checkedAt = this.now;
    // If latest itself is unreadable, report the expected parent from this tick's snapshot height.
    let block = this.snapshotBlock > 0n ? this.snapshotBlock - 1n : 0n;
    try {
      // A custom adapter without a diagnostic transport reports failure; never reuse a potentially batched client.
      const pub = this.headerPub;
      if (!pub) throw new Error();
      const latest = (await pub.getBlock({ blockTag: 'latest' })).number;
      if (typeof latest !== 'bigint' || latest <= 0n) throw new Error();
      block = latest - 1n;
      let path: BackupHeaderPath | null = null;
      await backupHeader({ request: args => pub.request(args as never) }, block, used => { path = used; });
      this.backupHeaderCheck = { checkedAt, block, ok: true, path };
      this.log.info('backup header self-check ok', { block, path });
    } catch {
      this.backupHeaderCheck = { checkedAt, block, ok: false, path: null };
      this.log.warn('backup header self-check failed', { block });
    } finally { this.checkingBackupHeader = false; }
  }

  /** SH-259 rule A: this tick's eth_gasPrice on a chain whose base fee is 0 (null: unread, or not such a chain). */
  private quote: bigint | null = null;
  tickGasPrice(): bigint | null { return this.quote; }
  /** SH-259 rule A: the lowest hanging nonce on a chain whose base fee is 0, for the log and the health record. */
  private hangNote: string | null = null;
  hangingNote(): string | null { return this.hangNote; }

  /** SH-259 rule A: the price a chain whose base fee is 0 may sign or broadcast at now (null: wait), for `c`'s ceiling. */
  private zeroBase(c: Pick<Candidate, 'job' | 'drandDeadline'> = { job: 'collect' }): bigint | null {
    return zeroBasePrice(this.quote, this.cfg.priorityFeeWei, maxFeeFor(c, this.now, this.cfg.limits));
  }

  async read(m2Scan: M2Scan = this.m2Scan, mem: Memory = emptyMemory()): Promise<World> {
    this.tickReads.begin();
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    const block = await readPendingBlock(this.pub).catch(error => {
      if (error instanceof FeeUnavailableError) this.log.warn('fee unavailable');
      throw error;
    });
    // Copy the journal: failed ticks must not mutate the caller's last durable checkpoint.
    this.m2Scan = { ...m2Scan };
    // A pending block's number can be typed null; the next block after the head is the one being built.
    const number = block.number ?? (await this.pub.getBlockNumber()) + 1n;
    this.memory = mem;
    this.now = block.timestamp;
    this.snapshotBlock = number - 1n;
    if (this.round.block !== number) this.round = { block: number, followed: false, counts: new Map(), receipts: new Map(), finalized: undefined };
    // SH-259 rule A: on a chain whose base fee is 0 the quote is read before saved sends are followed (and broadcast).
    this.quote = null;
    if (block.baseFeePerGas === 0n) {
      this.quote = await readGasPriceQuote(this.pub as never);
      if (this.quote === null) this.log.warn('gas price unread');
    }
    await this.hookCode.begin(this.pub, this.snapshotBlock, block.number === null ? undefined : block.parentHash);
    void this.checkBackupHeader();
    this.failedReads = 0;
    this.drandFailed = false;
    const snapshotBlock = this.snapshotBlock;
    const [boxes, fitGraduated, drand, snapshot] = await Promise.all([
      this.boxes(), this.guard('fitGraduated', () => this.fitGraduated(), () => false),
      this.cfg.setRelease ? Promise.resolve([]) : this.guard('drand', () => this.drand.read(this.snapshotBlock, this.now,
        block.number === null ? undefined : block.parentHash), () => []),
      // Monitor view only: the snapshot block's own time, never the pending block's. Unreadable: nothing is published.
      this.cfg.monitorFile ? this.pub.getBlock({ blockNumber: snapshotBlock }).then(
        b => b.number === snapshotBlock ? { number: snapshotBlock, timestamp: b.timestamp } : null, () => null) : null,
    ]);
    const world: World = {
      block: { number, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas },
      fitGraduated, boxes, drand,
      m2Scan: { ...this.m2Scan },
      ...(this.cfg.monitorFile ? { monitor: {
        complete: this.failedReads === 0, failedReads: this.failedReads, snapshot,
        drand: this.drandFailed ? { complete: false, requests: [] } : this.drand.observation(),
        ...(this.backupHeaderCheck ? { backupHeader: this.backupHeaderCheck } : {}),
      } } : {}),
    };
    this.last = world;
    try { await this.follow(); } catch (error) { this.log.warn('saved transactions not followed', { error }); }
    return world;
  }

  /** SH-249: attach the durable record (live mode). */
  track(book: SentBook): void { this.sent = book; }

  /** The saved record, for reports and tests. */
  get sentBook(): SentBook { return this.sent; }

  /** One latest and one pending count per signer and round (SH-249 read counts); both from the public node, as before. */
  private counts(signer: string) {
    let counts = this.round.counts.get(signer.toLowerCase());
    if (!counts) {
      const address = signer as Address;
      counts = Promise.all([this.pub.getTransactionCount({ address, blockTag: 'latest' }), this.pub.getTransactionCount({ address, blockTag: 'pending' })])
        .then(([latest, pending]) => ({ latest: BigInt(latest), pending: BigInt(pending) }));
      this.round.counts.set(signer.toLowerCase(), counts);
    }
    return counts;
  }

  /** At most one receipt read per hash and round, shared by settlement and the follow-up; unreadable reads as absent. */
  private receipt(hash: string): Promise<Receipt | null> {
    let r = this.round.receipts.get(hash);
    if (!r) {
      r = this.pub.getTransactionReceipt({ hash: hash as Hex }).then(x => x as Receipt, () => null);
      this.round.receipts.set(hash, r);
    }
    return r;
  }

  /**
   * SH-249 A2: each round, a saved transaction whose nonce is still unused is broadcast again from its bytes when this
   * process has no answer for it yet (after a restart or a lost reply) or its last answer is REBROADCAST_BLOCKS old.
   * SH-250: a nonce is resolved once one of its own transactions has a final canonical receipt from its signer (B1: the
   * winner's call is renamed to the winner's hash, every other call at the nonce released), or once the transaction that
   * used it is found in a final block and is none of ours (B6: every call at it released). Anything else keeps the entry
   * and every charge. A nonce that hangs with its maximum fee below the base fee is proposed for a replacement (B2).
   */
  private async follow(): Promise<void> {
    if (this.round.followed || this.cfg.dryRun) return;
    this.round.followed = true;
    this.proposals = [];
    const lastNote = this.hangNote;
    let countsUnread = false;
    this.hangNote = null;
    this.sent.tidy();
    const open = this.sent.entries.filter(e => e.state === 'sent');
    if (!open.length) return;
    const block = this.round.block, base = this.last?.block.baseFeePerGas;
    for (const e of open) {
      // Guarantee 2: only the highest-fee transaction of a nonce is broadcast again.
      const tx = e.txs.reduce<SentTx | undefined>((h, x) => !h || x.maxFeePerGas > h.maxFeePerGas ? x : h, undefined);
      if (!tx) continue;
      let latest: bigint;
      try { ({ latest } = await this.counts(e.signer)); } catch { countsUnread = true; continue; }
      if (latest > e.nonce) {
        // Re-check note 1: once the count passed a contested nonce at a final block, no call at it can land any more.
        if (e.txs.some(t => t.call) && !this.spent.has(`${e.signer}:${e.nonce}`)) {
          try {
            const final = BigInt(await this.pub.getTransactionCount({ address: e.signer as Address, blockTag: 'finalized' }));
            if (final > e.nonce) this.spent.add(`${e.signer}:${e.nonce}`);
          } catch { /* Not proved: the jobs stay in flight. */ }
        }
        await this.resolveNonce(e, block);
        continue;
      }
      if (base === 0n) {
        // SH-259 rule A: on a chain whose base fee is 0 a send is never replaced and its nonce never taken; unmined, its
        // same bytes go out again (only with a usable quote this tick) and the keeper says that it waits.
        if (block - tx.block >= HANG_BLOCKS) {
          const note = `hanging since block ${tx.block} at price ${tx.maxFeePerGas}; the chain asks ${this.quote ?? 'unread'}`;
          this.hangNote ??= `nonce ${e.nonce} ${note}`;
          const key = `hang:${e.signer}:${e.nonce}`, at = this.warned.get(key);
          if (at === undefined || this.now - at >= READ_WARN_SECONDS) {
            this.warned.set(key, this.now);
            this.log.warn('saved transaction hangs; the keeper waits', { nonce: e.nonce, hash: tx.hash, since: tx.block, price: tx.maxFeePerGas,
              asks: this.quote });
          }
        }
        if (this.zeroBase() === null) continue;
      }
      const proposal = base === undefined || base === 0n ? null : this.hanging(e, tx, block, base);
      // Note 4: a proposed replacement may wait (ceiling, income): the bytes still go out on the usual cadence.
      if (proposal) this.proposals.push(proposal);
      const answered = this.sent.answeredAt(tx.hash);
      if (answered === -1n) { this.sent.markAnswered(tx.hash, block); continue; }
      if (answered !== undefined && block - answered < REBROADCAST_BLOCKS) continue;
      await this.rebroadcast(e, tx, block);
    }
    // A nonce read that failed this round keeps the last confirmed hang in view, marked as unconfirmed.
    if (this.hangNote === null && countsUnread && lastNote) this.hangNote = `${lastNote.replace(/ \(nonce read failed\)$/, '')} (nonce read failed)`;
  }

  private async rebroadcast(e: SentEntry, tx: SentTx, block: bigint): Promise<void> {
    const target = e.privately ? this.privatePub : this.pub;
    if (!target) return;
    try {
      await target.sendRawTransaction({ serializedTransaction: tx.raw });
      this.sent.markAnswered(tx.hash, block);
      this.log.warn('saved transaction broadcast again', { nonce: e.nonce, hash: tx.hash });
    } catch (error) {
      // Review note 5: "already known" means the node holds these bytes: a broadcast that happened.
      if (alreadyKnown(error)) {
        this.sent.markAnswered(tx.hash, block);
        this.log.warn('saved transaction broadcast again', { nonce: e.nonce, hash: tx.hash });
      } else {
        // Refused (or no answer): the next round tries again; the log says so at most hourly per transaction.
        const key = `refused:${tx.hash}`, at = this.warned.get(key);
        if (at === undefined || this.now - at >= READ_WARN_SECONDS) {
          this.warned.set(key, this.now);
          this.log.warn('saved transaction broadcast refused', { nonce: e.nonce, hash: tx.hash });
        }
      }
    }
  }

  /**
   * SH-250 Q2 and B2: the nonce's latest transaction hangs once it is unmined HANG_BLOCKS after it was signed, or its
   * maximum fee was below the base fee for UNDERPRICED_HEADS observed heads. A hanging transaction priced below the base
   * fee is replaced: both fee fields raised by at least an eighth (Q1), the maximum to what the pending block needs, never
   * above the fee ceiling of the counter it was charged to. Each replacement starts a new hanging period (B4). A first
   * collection (start) is never replaced: its own tip was checked against its signed cost (F182), see SH-250 evidence.
   */
  private hanging(e: SentEntry, tx: SentTx, block: bigint, base: bigint): Replacement | null {
    const seen = this.underpriced.get(tx.hash) ?? { heads: 0, block: -1n };
    if (seen.block !== block) {
      this.underpriced.set(tx.hash, { heads: tx.maxFeePerGas < base ? seen.heads + 1 : 0, block });
    }
    const heads = this.underpriced.get(tx.hash)?.heads ?? 0;
    if (!(block - tx.block >= HANG_BLOCKS || heads >= UNDERPRICED_HEADS) || tx.maxFeePerGas >= base) return null;
    const r = e.reservation;
    // B: a reservation of stage A (no `v: 2`) carries no counters: only broadcast again, never replaced (it can lose
    // its nonce under A).
    if (!r || r.v !== 2 || r.income?.start || e.txs.some(t => t.call)) return null;
    const cap = maxFeeFor({ job: e.job as JobName, ...(r.counter === 'drandRescue' && e.drandDeadline !== undefined ? { drandDeadline: e.drandDeadline } : {}) },
      this.now, this.cfg.limits);
    const priority = bump(tx.maxPriorityFeePerGas) > this.cfg.priorityFeeWei ? bump(tx.maxPriorityFeePerGas) : this.cfg.priorityFeeWei;
    const wanted = 2n * base + priority > bump(tx.maxFeePerGas) ? 2n * base + priority : bump(tx.maxFeePerGas);
    const maxFeePerGas = wanted > cap ? cap : wanted;
    if (maxFeePerGas < bump(tx.maxFeePerGas) || priority > maxFeePerGas) {
      const key = `ceiling:${e.signer}:${e.nonce}`, at = this.warned.get(key);
      if (at === undefined || this.now - at >= READ_WARN_SECONDS) {
        this.warned.set(key, this.now);
        this.log.warn('saved transaction hangs at its fee ceiling', { nonce: e.nonce, hash: tx.hash });
      }
      return null;
    }
    let highest = 0n;
    for (const t of e.txs) if (txCost(e, t) > highest) highest = txCost(e, t);
    return { entry: e, maxFeePerGas, maxPriorityFeePerGas: priority, costWei: tx.gas * maxFeePerGas + (e.value ?? 0n), highestWei: highest };
  }

  /** SH-250: this round's replacements (computed by the read's follow-up). */
  hangingSends(): readonly Replacement[] { return this.proposals; }

  /** SH-250: the record's settled outcomes the journal must carry. */
  outcomes() { return this.sent.outcomes; }

  /**
   * SH-250 B2: signs a replacement of the same call at the same nonce with the proposed fees, saves it (the runner has
   * already reserved its maximum) and broadcasts the saved bytes. A broadcast error keeps it, as any send.
   */
  async replace(p: Replacement): Promise<string> {
    const e = this.sent.entries.find(x => x.signer === p.entry.signer && x.nonce === p.entry.nonce);
    const first = e?.txs[0];
    const account = p.entry.privately ? this.signers.private : this.signers.public;
    const target = p.entry.privately ? this.privatePub : this.pub;
    if (!e || !first || !account || !target || account.address.toLowerCase() !== e.signer) throw new Error('replacement refused');
    // SH-259 rule A: no replacement at all on a chain whose base fee is 0.
    if (this.last?.block.baseFeePerGas === 0n) throw new SendWait('no replacement on this chain');
    const old = parseTransaction(first.raw);
    if (old.to === undefined || old.to === null) throw new Error('replacement refused');
    const raw = await account.signTransaction({ type: 'eip1559', chainId: this.cfg.chainId, to: old.to, data: old.data ?? '0x', gas: first.gas,
      nonce: Number(e.nonce), ...(old.value ? { value: old.value } : {}), maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas });
    const hash = keccak256(raw).toLowerCase();
    const block = this.last?.block.number ?? 0n;
    this.sent.addTx(e.signer, e.nonce, { hash, raw, gas: first.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas, block });
    this.log.warn('saved transaction replaced', { nonce: e.nonce, hash });
    try {
      await target.sendRawTransaction({ serializedTransaction: raw });
      this.sent.markAnswered(hash, block);
    } catch { /* Kept: broadcast again on the next round. */ }
    return hash;
  }

  /** B1 and B6: the outcome of a used nonce, or nothing while it is not proven. */
  private async resolveNonce(e: SentEntry, block: bigint): Promise<void> {
    let winner: SentTx | undefined;
    for (const t of e.txs) {
      const r = await this.receipt(t.hash);
      if (r && r.transactionHash.toLowerCase() === t.hash && r.from.toLowerCase() === e.signer && await this.finalCanonical(r)) { winner = t; break; }
    }
    const names = [...new Set(e.txs.map(t => journalName(e, t)))];
    if (winner) {
      const won = journalName(e, winner);
      this.sent.resolve(e, winner.call ? [] : [[won, winner.hash]], names.filter(n => n !== won), block);
      return;
    }
    const key = `${e.signer}:${e.nonce}`, last = this.searched.get(key);
    if (last !== undefined && block - last < HANG_BLOCKS) return;
    this.searched.set(key, block);
    const used = await this.usedBy(e);
    if (used?.kind === 'foreign') {
      this.searched.delete(key);
      this.log.warn('saved transaction released: another transaction used its nonce', { nonce: e.nonce, hash: e.txs[0]?.hash });
      this.sent.resolve(e, [], names, block);
    } else if (used?.kind === 'own') {
      // Re-check note 1: one of ours is in a final block: it is the winner. Its charges stay until its receipt is read.
      const own = e.txs.find(t => t.hash === used.hash);
      if (!own) return;
      this.searched.delete(key);
      const won = journalName(e, own);
      this.sent.resolve(e, own.call ? [] : [[won, own.hash]], names.filter(n => n !== won), block);
    }
  }

  /**
   * B6: finds, by the signer's count at final blocks, the block that used the nonce, then the transaction in it. Only a
   * transaction from the signer at that nonce whose hash is none of ours is proof; any unreadable step proves nothing.
   */
  private async usedBy(e: SentEntry): Promise<{ readonly kind: 'foreign' | 'own'; readonly hash: string } | null> {
    try {
      this.round.finalized ??= this.pub.getBlock({ blockTag: 'finalized' })
        .then(b => b.number === null || b.hash === null ? null : { number: b.number, hash: b.hash }, () => null);
      const final = await this.round.finalized;
      if (!final) return null;
      const address = e.signer as Address;
      const at = async (blockNumber: bigint) => BigInt(await this.pub.getTransactionCount({ address, blockNumber }));
      let hi = final.number;
      if (await at(hi) <= e.nonce) return null;
      let lo = e.txs.reduce((m, t) => t.block < m ? t.block : m, e.txs[0]?.block ?? 0n);
      lo = lo > 1n ? lo - 2n : 0n;
      if (await at(lo) > e.nonce) return null;
      while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (await at(mid) > e.nonce) hi = mid; else lo = mid; }
      const body = await this.pub.request({ method: 'eth_getBlockByNumber', params: [toHex(hi), true] } as never) as
        { transactions?: readonly { hash?: string; from?: string; nonce?: string }[] } | null;
      const used = body?.transactions?.find(t => t.from?.toLowerCase() === e.signer && t.nonce !== undefined && BigInt(t.nonce) === e.nonce);
      if (!used?.hash) return null;
      const hash = used.hash.toLowerCase();
      return { kind: e.txs.some(t => t.hash === hash) ? 'own' : 'foreign', hash };
    } catch { return null; }
  }

  private async finalCanonical(r: Receipt): Promise<boolean> {
    this.round.finalized ??= this.pub.getBlock({ blockTag: 'finalized' })
      .then(b => b.number === null || b.hash === null ? null : { number: b.number, hash: b.hash }, () => null);
    const final = await this.round.finalized;
    if (!final || r.blockNumber > final.number) return false;
    try { return (await this.pub.getBlock({ blockNumber: r.blockNumber })).hash === r.blockHash; } catch { return false; }
  }

  async readIncome(spend: readonly IncomeSpend[]) {
    if (!this.last) throw new Error('world not read');
    const zeroed = this.zeroedIncome.tick(this.last.block.timestamp);
    const income = await readIncome(this.pub, this.last.boxes, this.keeper, this.last.block.timestamp, this.cfg.fromBlock, spend,
      this.incomeCache, zeroed.report);
    zeroed.done();
    return income;
  }

  private async discover(): Promise<Parts[]> {
    const box0 = this.cfg.box0;
    if (box0 && !this.parts.has('1:0')) {
      const { coordinator, hook, receiver, executor } = box0;
      const [poolId, poolManager] = await Promise.all([this.call<Hex>(hook, hookAbi, 'poolId'), this.call<Address>(hook, hookAbi, 'poolManager')]);
      this.parts.set('1:0', { id: 0n, version: 1, coordinator, hook, receiver, router: null, priceSource: executor, poolManager, poolId, ethPriced: true });
    }
    const v2 = await this.guard('registry v2', () => this.discoverV2(), () => []);
    return [...this.parts.values(), ...v2];
  }

  private async discoverV2(): Promise<Parts[]> {
    const registry = this.cfg.boxRegistry;
    if (!registry) return [];
    const set = this.cfg.setRelease;
    if (set) {
      if (set.chainId !== this.cfg.chainId || set.registry.address.toLowerCase() !== registry.toLowerCase() || this.cfg.box0) {
        throw new Error('set keeper instance mismatch');
      }
      await verifySetRelease(this.pub,set,this.snapshotBlock);
    }
    const count = await this.call<bigint>(registry, boxRegistryAbi, 'boxCount');
    // Re-read canonical registry roles every tick. No orphaned discovery survives a reorg.
    function* ids() { for (let id = 0n; id < count; id++) yield id; }
    const out = await readWindows(ids(), id => this.guard(`v2 roles ${id}`, async (): Promise<Parts> => {
        const role = (n: bigint) => this.call<Address>(registry, boxRegistryAbi, 'roleOf', [id, n]);
        const roles = set ? await readSetRoles(this.pub,set,id,this.snapshotBlock) : null;
        const [coordinator, hook, receiver, router] = roles ? [roles[0],roles[2],roles[5],roles[6]]
          : await Promise.all([role(0n), role(2n), role(5n), role(6n)]);
        if (!coordinator || !hook || !receiver || !router || [coordinator, hook, receiver, router].some((a) => /^0x0{40}$/i.test(a))) throw new Error('missing v2 part');
        const [poolId, poolManager, q] = await Promise.all([
          this.call<Hex>(hook, hookV2Abi, 'poolId'), this.call<Address>(hook, hookV2Abi, 'poolManager'), this.call<Address>(hook, hookV2Abi, 'q'),
        ]);
        if (set && poolManager.toLowerCase() !== set.poolManager.address.toLowerCase()) throw new Error('set keeper PoolManager mismatch');
        return { id, version: 2, coordinator, hook, receiver, router, priceSource: null, poolId, poolManager, ethPriced: /^0x0{40}$/i.test(q), ...(set ? {set:true} : {}) };
      }, () => null));
    return out.filter(notNull);
  }

  private async boxes(): Promise<BoxState[]> {
    const parts = await this.guard('boxes', () => this.discover(), () => [...this.parts.values()]);
    const read = await readWindows(parts, p => this.guard(`box ${p.version}:${p.id}`, () => this.box(p), () => null));
    return read.filter(notNull);
  }

  private async box(p: Parts): Promise<BoxState> {
    if (p.version === 2) return this.boxV2(p);
    const [graduated, curveClosed, fitOwed, platformOwed] = await Promise.all([
      this.call<boolean>(p.coordinator, coordinatorV1Abi, 'graduated'),
      this.call<boolean>(p.hook, hookAbi, 'closed'),
      this.call<bigint>(p.receiver, receiverAbi, 'fitOwed'),
      this.call<bigint>(p.receiver, receiverAbi, 'platformOwed'),
    ]);
    const source = graduated ? p.priceSource : null;
    const executor = source ? await this.guard(`${source}:execution`, async () => {
      const [registered, launchPhase, budget, batchThreshold, twap] = await Promise.all([
        this.call<Address>(p.coordinator, coordinatorV1Abi, 'executor'),
        this.call<Address>(source, executorAbi, 'launchPhase'),
        this.call<bigint>(source, executorAbi, 'budget'), this.call<bigint>(source, executorAbi, 'batchThreshold'),
        this.call<readonly [boolean, number, number]>(source, executorAbi, 'twap'),
      ]);
      if (registered.toLowerCase() !== source.toLowerCase() || launchPhase.toLowerCase() !== p.coordinator.toLowerCase()) {
        throw new Error('box-0 executor identity mismatch');
      }
      return { budget, batchThreshold, twapReady: twap[0] };
    }, () => undefined) : undefined;
    const sample = source ? await this.call<{ tick: number; time: number; head: number }>(source, priceSourceAbi, 'oracle') : null;
    const [spot, checkpoint] = await Promise.all([
      sample ? this.call<Hex>(p.poolManager, poolManagerAbi, 'extsload', [poolStateSlot(p.poolId)]).then(tickOfSlot0) : null,
      source && sample ? this.call<{ time: number }>(source, priceSourceAbi, 'checkpointAt', [BigInt(sample.head)]) : null,
    ]);
    const qPerEthX18 = 10n ** 18n;
    return {
      id: p.id, version: p.version, coordinator: p.coordinator, hook: p.hook, receiver: p.receiver,
      priceSource: p.priceSource, graduated, failed: false, curveClosed, gateOpen: true, openAt: 0n, deadline: 0n, spotTick: spot,
      sampleTick: sample?.tick ?? null, checkpointTime: BigInt(checkpoint?.time ?? 0), fitOwed, platformOwed,
      qPerEthX18, executor,
    };
  }

  private async boxV2(p: Parts): Promise<BoxState> {
    if (p.set) return this.boxSet(p);
    const router = p.router;
    if (!router) throw new Error('missing v2 launch router');
    const co = <T>(fn: string, args: readonly unknown[] = []) => this.call<T>(p.coordinator, coordinatorAbi, fn, args);
    const hk = <T>(fn: string) => this.call<T>(p.hook, hookV2Abi, fn);
    const rc = <T>(fn: string, args: readonly unknown[] = []) => this.call<T>(p.receiver, receiverV2Abi, fn, args);
    const [graduated, failed, gateOpen, openAt, deadline, curveClosed, closedAt, lastProtocolBlock, q] = await Promise.all([
      co<boolean>('graduated'), co<boolean>('failed'), co<boolean>('gateOpen'), co<bigint>('openAt'), co<bigint>('deadline'),
      hk<boolean>('closed'), hk<bigint>('closedAt'), hk<bigint>('lastProtocolBlock'), hk<Address>('q'),
    ]);
    // Auxiliary read failures suppress only their own jobs; they cannot suppress a failure exit or the other Safe.
    const readAmount = (name: string) => this.guard(`${p.receiver}:${name}`, () => rc<bigint>(name), () => 0n);
    const [fitOwed, platformOwed, buyBackP, tBurnPending, reward, claim, depthBudget, royalty, graduationSettled, qDecimals, shopPendingP, pilePendingP, eatPendingP, modulePendingP, sources, stepMinQ, m2, m3, payInT] = await Promise.all([
      readAmount('fitOwed'), readAmount('platformOwed'), readAmount('buyBackP'), readAmount('tBurnPending'),
      graduated ? this.guard(`${p.coordinator}:reward`, () => co<bigint>('rewardOf', [this.keeper]), () => 0n) : 0n,
      failed ? this.guard(`${p.coordinator}:claimState`, () => co<readonly [bigint, bigint]>('claimState'), () => [0n, 1n] as const) : [0n, 1n] as const,
      graduated ? this.guard(`${p.hook}:depthBudget`, () => hk<bigint>('depthBudget'), () => 0n) : 0n,
      this.guard(`${p.coordinator}:royalty`, async () => {
        const address = await co<Address>('roleAddress', [8n]);
        if (BigInt(address) === 0n) return undefined;
        // Always read actual balances at this snapshot; empty calldata ETH receipts emit no event.
        const weth = await this.call<Address>(address, royaltyRouterV2Abi, 'weth');
        const balance = (token: Address) => this.call<bigint>(token, erc20Abi, 'balanceOf', [address]);
        const [eth, wrapped, price] = await Promise.all([
          this.pub.getBalance({ address, blockNumber: this.snapshotBlock }), balance(weth),
          BigInt(q) === 0n ? Promise.resolve(0n) : balance(q),
        ]);
        // RC6: an unreadable frozen list or coin schedules no refresh; flush and sweep stay scheduled.
        const coins = failed ? [] : await this.guard(`${address}:inboxCoins`, () => this.inboxCoins(address, weth, eth, p.hook), () => []);
        return { address, eth, wrapped: weth.toLowerCase() === q.toLowerCase() ? 0n : wrapped, price, coins };
      }, () => undefined),
      graduated ? this.guard(`${p.receiver}:graduationSettled`, () => rc<boolean>('graduationSettled'), () => true) : false,
      p.ethPriced ? 18 : this.guard(`${q}:decimals`, async () => {
        const decimals = await this.call<number>(q, erc20Abi, 'decimals');
        if (!Number.isInteger(decimals) || decimals < 6 || decimals > 18) throw new Error('unsupported price-coin decimals');
        return decimals;
      }, () => null),
      this.guard(`${p.receiver}:shopPendingP`, async () => {
        if (await rc<number>('sellersChoice') !== 11) return 0n;
        return this.call<bigint>(p.receiver, receiverModulesV21Abi, 'modulePendingP', [true]);
      }, () => null),
      this.guard(`${p.receiver}:pilePendingP`, async () => {
        const [buyers, sellers] = await Promise.all([rc<number>('buyersChoice'), rc<number>('sellersChoice')]);
        if (buyers !== 9 && sellers !== 9) return 0n;
        return this.call<bigint>(p.receiver, receiverPileV21Abi, 'pilePendingP');
      }, () => null),
      this.guard(`${p.receiver}:eatPendingP`, async () => {
        // FeeChoice.EatPriceCoin = 6 is additive. Old receivers keep their old views;
        // neither a token ticker nor its apparent burn method selects this action.
        const [buyers, sellers] = await Promise.all([rc<number>('buyersChoice'), rc<number>('sellersChoice')]);
        if (buyers !== 6 && sellers !== 6) return 0n;
        return this.call<bigint>(p.receiver, receiverEatV21Abi, 'eatPendingP');
      }, () => null),
      Promise.all([false, true].map(sellers => this.guard(`${p.receiver}:modulePendingP:${sellers}`, async () => {
        const choice = await rc<number>(sellers ? 'sellersChoice' : 'buyersChoice');
        if (choice !== 10) return 0n;
        return this.call<bigint>(p.receiver, receiverModulesV21Abi, 'modulePendingP', [sellers]);
      }, () => null))),
      failed ? undefined : this.guard(`${p.receiver}:sources`, () => this.sources(p), () => undefined),
      failed ? undefined : this.guard(`${p.hook}:stepMinQ`, () => this.hookCode.minimum(this.pub, p.hook, this.snapshotBlock), () => undefined),
      this.cfg.boxRegistry ? readM2({ registry: this.cfg.boxRegistry, id: p.id,
        hook: p.hook, receiver: p.receiver, coordinator: p.coordinator, failed, scan: this.m2Scan,
        code: (address) => this.pub.getBytecode({ address, blockNumber: this.snapshotBlock }),
        call: this.call.bind(this), guard: this.guard.bind(this) }) : [],
      this.cfg.boxRegistry ? readM3({ registry: this.cfg.boxRegistry, id: p.id,
        receiver: p.receiver, coordinator: p.coordinator, failed, graduated, gateOpen,
        call: this.call.bind(this), guard: this.guard.bind(this) }) : [],
      readPayInTV21(p.receiver, this.call.bind(this), this.guard.bind(this)),
    ]);
    return { id: p.id, version: 2, coordinator: p.coordinator, hook: p.hook, receiver: p.receiver, priceSource: null,
      graduated, failed, gateOpen, openAt, deadline, curveClosed, fitOwed, platformOwed,
      spotTick: null, sampleTick: null, checkpointTime: 0n, qPerEthX18: p.ethPriced ? 10n ** 18n : null,
      v2: { ...payInT, router, q, qDecimals, closedAt, lastProtocolBlock, depthBudget, graduationSettled, buyBackP, eatPendingP, pilePendingP, shopPendingP, modulePendingP: [modulePendingP[0] ?? null, modulePendingP[1] ?? null], tBurnPending, reward,
        pot: claim[0], tLeft: claim[1], royalty, m2, m3, ...(sources ? { sources } : {}), ...(stepMinQ !== undefined ? { stepMinQ } : {}) } };
  }

  /** Only lifecycle state is needed; absent set modules cannot suppress graduation or exits. */
  private async boxSet(p: Parts): Promise<BoxState> {
    const co = <T>(fn: string) => this.call<T>(p.coordinator,coordinatorAbi,fn);
    const [graduated,failed,gateOpen,openAt,deadline,curveClosed,closedAt] = await Promise.all([
      co<boolean>('graduated'),co<boolean>('failed'),co<boolean>('gateOpen'),co<bigint>('openAt'),co<bigint>('deadline'),
      this.call<boolean>(p.hook,hookV2Abi,'closed'),this.call<bigint>(p.hook,hookV2Abi,'closedAt'),
    ]);
    return {id:p.id,version:2,coordinator:p.coordinator,hook:p.hook,receiver:p.receiver,priceSource:null,
      graduated,failed,gateOpen,openAt,deadline,curveClosed,setLifecycle:{closedAt},
      spotTick:null,sampleTick:null,checkpointTime:0n,fitOwed:0n,platformOwed:0n,qPerEthX18:null};
  }

  /**
   * RC6RR2-MONEY-1, RC6RR2-HP-1: allocation lag from rc7's additive view at the snapshot, followed by up to three
   * closed seller sources, never past the open seller id. Unsourced boxes and rc6 receivers without the view have
   * no readable lag. The guard also leaves sources absent on a failed read or inconsistent cursor.
   */
  private async sources(p: Parts): Promise<V2State['sources']> {
    const [lastBuyer, lastSeller, current, openSeller] = await this.call<readonly [bigint, bigint, bigint, bigint]>(
      p.receiver, receiverCursorsAbi, 'allocationCursors');
    if (current === 0n) return undefined;
    const nextBuyer = lastBuyer === 0n ? 1n : lastBuyer + 2n;
    if (current % 2n !== 1n || nextBuyer % 2n !== 1n || nextBuyer > current || lastSeller % 2n !== 0n || lastSeller > openSeller
      || openSeller !== current + 1n) {
      throw new Error('receiver cursor inconsistent');
    }
    let sellerRun = 0n;
    for (let id = lastSeller + 2n; sellerRun < 3n && id < openSeller; id += 2n) {
      const batch = await this.call<{ closed: boolean }>(p.hook, holderBatchAbi, 'tradeBatch', [id]);
      if (!batch.closed) break;
      sellerRun++;
    }
    return { buyerLag: (current - nextBuyer) / 2n, sellerRun };
  }

  /**
   * The inbox's frozen sellable list (its creation-time list version) at the snapshot: coins with a positive lot (the
   * inbox excludes P, native P's WETH and its own T), their balances, VaultRelayer allowances and order registration.
   */
  private async inboxCoins(inbox: Address, weth: Address, eth: bigint, hook: Address): Promise<InboxCoin[]> {
    const router = <T>(fn: string, args: readonly unknown[] = []) => this.call<T>(inbox, royaltyRouterV2Abi, fn, args);
    const key = inbox.toLowerCase();
    let list = this.inboxLists.get(key);
    if (!list) {
      const [listings, version, relayer] = await Promise.all([
        router<Address>('listingRegistry'), router<bigint>('listVersion'), router<Address>('vaultRelayer'),
      ]);
      const count = BigInt(listings) === 0n ? 0n : await this.call<bigint>(listings, listingRegistryV2Abi, 'sellableCount', [version]);
      const n = count < MAX_INBOX_COINS ? count : MAX_INBOX_COINS;
      const tokens = await Promise.all(Array.from({ length: Number(n) }, (_, i) =>
        this.call<Address>(listings, listingRegistryV2Abi, 'sellableToken', [BigInt(i)])));
      list = { relayer, tokens, lots: new Map() };
      this.inboxLists.set(key, list);
      if (this.inboxLists.size > 1024) { const oldest = this.inboxLists.keys().next().value; if (oldest !== undefined) this.inboxLists.delete(oldest); }
    }
    const { relayer, tokens, lots } = list;
    const coins = await Promise.all(tokens.map(coin => this.guard(`${inbox}:inboxCoin:${coin}`, async (): Promise<InboxCoin | null> => {
      let lot = lots.get(coin.toLowerCase());
      if (lot === undefined) { lot = await router<bigint>('lotSize', [coin]); lots.set(coin.toLowerCase(), lot); }
      if (lot === 0n) return null;
      const stateKey = `${key}:${coin.toLowerCase()}`;
      const cached = this.inboxState.get(stateKey);
      const hour = this.now / 3600n;
      const due = (job: 'royaltyRefresh' | 'royaltyObserve') => {
        const attempt = this.memory.attempts[`${job}:2:${hook.toLowerCase()}:${coin.toLowerCase()}`];
        return this.snapshotBlock + 1n >= (attempt?.next ?? 0n) && this.now >= (attempt?.nextAt ?? 0n);
      };
      if (cached && cached.hour === hour && cached.block <= this.snapshotBlock && !inboxJob(cached.coin, due)) return cached.coin;
      // Never retain a stale positive value if this refresh fails.
      this.inboxState.delete(stateKey);
      // RC6's immutable layout: _coins is mapping slot 0; CoinState.approved is its fourth uint256.
      // There is no public getter. Read the clone's storage at the same snapshot as its public clock and allowance.
      const base = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [coin, 0n])));
      const [held, registered, allowance, oldestUnsoldAt, approvalWord] = await Promise.all([
        this.call<bigint>(coin, erc20Abi, 'balanceOf', [inbox]), router<boolean>('orderRegistered', [coin]),
        this.call<bigint>(coin, erc20Abi, 'allowance', [inbox, relayer]),
        router<bigint>('oldestUnsoldAt', [coin]),
        this.pub.getStorageAt({ address: inbox, slot: toHex((base + 3n) % (1n << 256n), { size: 32 }), blockNumber: this.snapshotBlock }),
      ]);
      if (!approvalWord || !/^0x[0-9a-fA-F]{64}$/.test(approvalWord)) throw new Error('inbox recorded approval unavailable');
      // refreshOrder(WETH) wraps the inbox's ETH first, so ETH counts toward WETH's lots.
      const value = { coin, lot, balance: coin.toLowerCase() === weth.toLowerCase() ? held + eth : held,
        allowance, approved: BigInt(approvalWord), oldestUnsoldAt, registered };
      this.inboxState.set(stateKey, { hour, block: this.snapshotBlock, coin: value });
      if (this.inboxState.size > 32_768) { const oldest = this.inboxState.keys().next().value; if (oldest !== undefined) this.inboxState.delete(oldest); }
      return value;
    }, () => null)));
    return coins.filter((c): c is InboxCoin => c !== null);
  }

  private async fitGraduated(): Promise<boolean> {
    const executor = this.cfg.box0?.executor;
    return executor ? this.call<boolean>(executor, executorAbi, 'fitGraduated') : false;
  }

  /** Simulates against the pending block: a revert is nothing to do; a node that could not answer throws (M4). */
  async simulate(c: Candidate, fees: Fees, start = false): Promise<Sim> {
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    this.pendingEstimates.delete(c);
    const account = jobSpec(c.job, c.version).privately
      ? this.signers.private?.address ?? (this.cfg.dryRun ? this.cfg.privateSendAddress : null) : this.keeper;
    if (!account) throw new Error('no private trigger identity');
    const abi = abiFor(c);
    const none: Sim = { ok: false, tipWei: null, estimate: 0n };
    try {
      const pendingCall = <T>(address: Address, readAbi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
        this.pub.readContract({ address, abi: readAbi, functionName, args, blockTag: 'pending' } as never) as Promise<T>;
      if (c.job === 'itemSync' && (!c.syncSources
        || !await itemSyncPending(pendingCall, c.to, c.syncSources[0], c.syncSources[1]))) return none;
      const mayStart = start && c.version === 2 && (c.job === 'collect' || c.job === 'sellFees');
      const pendingNumber = async () => {
        try { return (await this.pub.getBlock({ blockTag: 'pending' })).number; } catch { return null; }
      };
      const before = mayStart ? await pendingNumber() : null;
      const { result } = await this.pub.simulateContract({ account, address: c.to, abi, functionName: c.fn, args: c.args, ...(c.value === undefined ? {} : { value: c.value }), blockTag: 'pending', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } as never);
      const box = this.last?.boxes.find((b) => b.id === c.boxId && [b.hook, b.receiver, b.coordinator, b.v2?.router, ...(b.v2?.m2 ?? []).map((m) => m.to)].includes(c.to));
      const sim = interpret(c, result, box?.qPerEthX18 ?? null);
      if (!sim.ok) return sim;
      const startTipWei = mayStart && sim.paidTipRaw !== undefined ? await this.startTip(c, sim.paidTipRaw, box, account) : undefined;
      const data = encodeFunctionData({ abi, functionName: c.fn, args: c.args } as never);
      const request = { account, to: c.to, data, ...(c.value === undefined ? {} : { value: c.value }) };
      const paired = this.pendingEstimator
        ? await this.pendingEstimator({ ...request, blockTag: 'pending', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
        : { gas: await estimatePending(this.pub, request, fees) };
      const after = mayStart ? await pendingNumber() : null;
      this.pendingEstimates.set(c, { ...paired });
      return { ...sim, estimate: paired.gas, ...(mayStart ? { startBlockPaired: typeof before === 'bigint' && before === after } : {}), ...(mayStart ? { startTipWei } : {}) };
    } catch (error) {
      if (isRevert(error)) return none;
      throw error;
    }
  }

  /** F182 uses the very same pending result and calldata; pricing never changes ordinary tipWei. */
  private async startTip(c: Candidate, raw: bigint, box: BoxState | undefined, account: Address): Promise<bigint | null> {
    if (raw <= 0n || c.version !== 2 || !box?.v2 || box.failed || account.toLowerCase() !== this.keeper.toLowerCase()
      || (c.value ?? 0n) !== 0n) return null;
    const same = (a: unknown, b: Address) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
    if (!(c.job === 'collect' && c.fn === 'collect' && same(c.to, box.receiver) && same(c.args[0], this.keeper))
      && !(c.job === 'sellFees' && c.fn === 'sellFees' && same(c.to, box.hook) && c.args.length === 0)) return null;
    if (BigInt(box.v2.q) === 0n) return raw;
    try {
      const final = await this.pub.getBlock({ blockTag: 'finalized' });
      if (final.number === null || final.hash === null || final.timestamp > this.now
        || this.now - final.timestamp > TOKEN_INCOME_MAX_AGE) return null;
      const price = await readEthParityPrice(this.pub, box.v2.q, final)
        ?? await readIncomePrice(this.pub, box.coordinator, box.v2.q, final, this.now);
      const value = price.quote(raw);
      if ((await this.pub.getBlock({ blockNumber: final.number })).hash !== final.hash) return null;
      return value;
    } catch { return null; }
  }

  /**
   * RC6RR2-HP-2: what each hash paid, gasUsed times its effective gas price, only for a receipt this keeper's public or
   * private signer sent, in a block at or below the finalized one whose canonical hash matches the receipt's. Anything
   * unreadable, unproven or inconsistent is left out, and its reservation stays whole.
   */
  async settled(hashes: readonly string[]): Promise<Readonly<Record<string, bigint>>> {
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    const final = await this.pub.getBlock({ blockTag: 'finalized' });
    if (final.number === null || final.hash === null) return {};
    const senders = new Set([this.keeper, this.signers.public?.address, this.signers.private?.address]
      .filter((a): a is Address => a !== undefined).map(a => a.toLowerCase()));
    const out: Record<string, bigint> = {};
    for (const hash of hashes) {
      if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
      try {
        const r = await this.receipt(hash);
        if (!r || r.transactionHash.toLowerCase() !== hash || !senders.has(r.from.toLowerCase()) || r.blockNumber > final.number
          || typeof r.gasUsed !== 'bigint' || typeof r.effectiveGasPrice !== 'bigint' || r.gasUsed <= 0n || r.effectiveGasPrice <= 0n) continue;
        const block = await this.pub.getBlock({ blockNumber: r.blockNumber });
        if (block.hash !== r.blockHash) continue;
        out[hash] = r.gasUsed * r.effectiveGasPrice;
      } catch { /* Not proved final: the reservation stays whole. */ }
    }
    // A finalized-chain change during this read settles nothing.
    const end = await this.pub.getBlock({ blockNumber: final.number });
    return end.hash === final.hash ? out : {};
  }

  /** Only a final canonical revert proves this bounty transferred nothing. Absence is not proof of a drop. */
  async bountyReverted(source: Address, hash: string): Promise<boolean> {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return false;
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    try {
      const final = await this.pub.getBlock({ blockTag: 'finalized' });
      if (final.number === null || final.hash === null) return false;
      const r = await this.pub.getTransactionReceipt({ hash: hash as Hex });
      if (r.status !== 'reverted' || r.transactionHash.toLowerCase() !== hash
        || r.from.toLowerCase() !== this.keeper.toLowerCase() || r.to?.toLowerCase() !== source.toLowerCase()
        || r.blockNumber > final.number) return false;
      const block = await this.pub.getBlock({ blockNumber: r.blockNumber });
      if (block.hash === null || block.hash !== r.blockHash) return false;
      // A finalized-chain change during this read grants no retry.
      const end = await this.pub.getBlock({ blockNumber: final.number });
      return end.hash === final.hash;
    } catch { return false; }
  }

  /**
   * SH-249: signs one call in memory with the keeper's own nonce (H2), from the saved record (A3): the public key for the
   * public RPC, the private-send key for the private endpoint, each with its own nonces. Nothing is saved or broadcast
   * here; every refusal is thrown before the signature.
   */
  async sign(c: Candidate, gas: bigint, fees: Fees, privately: boolean, take?: Takeover): Promise<SignedSend> {
    await checkChainId(this.pub, this.cfg.chainId, this.cfg.allowMainnet);
    if (this.cfg.dryRun) throw new Error('dry run: sending disabled');
    if (c.job === 'backupStart' && (c.drandDeadline === undefined || this.now + START_INCLUSION_SECONDS > c.drandDeadline)) {
      this.backupWarning(c, 'backup start window closed');
      throw new Error('backup start window closed');
    }
    if (fees.maxFeePerGas > maxFeeFor(c, this.now, this.cfg.limits)) throw new Error('fee ceiling reached');
    // SH-259 rule A: on a chain whose base fee is 0, nothing is signed without this tick's quote, nor under its price.
    if (this.last?.block.baseFeePerGas === 0n) {
      const price = this.zeroBase(c);
      if (price === null || fees.maxPriorityFeePerGas < price || take) throw new SendWait('gas price unread');
    }
    if (jobSpec(c.job, c.version).privately && !privately) throw new Error('private submission required');
    const account = privately ? this.signers.private : this.signers.public;
    const target = privately ? this.privatePub : this.pub;
    if (!account || !target) throw new Error(privately ? 'no private endpoint or private-send key' : 'no key: dry run only');
    await checkChainId(target, this.cfg.chainId, this.cfg.allowMainnet);
    this.sent.tidy();
    const signer = account.address.toLowerCase();
    const { latest, pending } = await this.counts(signer);
    const recorded = this.sent.after(signer);
    // SH-250 A: a takeover planned this round, still the signer's lowest unconfirmed nonce and still open.
    const taken = take && take.signer === signer && take.nonce >= latest
      && this.sent.entries.some(e => e.signer === signer && e.nonce === take.nonce && e.state === 'sent') ? take : null;
    if (take && !taken) throw new SendWait('takeover no longer open');
    // SH-250 B5: a new nonce waits while MAX_IN_FLIGHT of this signer's transactions are unconfirmed.
    const open = BigInt(this.sent.entries.filter(e => e.signer === signer && e.nonce >= latest).length);
    if (!taken && open >= MAX_IN_FLIGHT) throw new SendWait('unconfirmed transactions at limit');
    const nonce = taken?.nonce ?? nextNonce(latest, pending, recorded);
    const priority = fees.maxPriorityFeePerGas;
    if (nonceAhead(latest, pending, recorded)) {
      const key = `nonce ahead:${signer}`, at = this.warned.get(key);
      if (at === undefined || this.now - at >= READ_WARN_SECONDS) { this.warned.set(key, this.now); this.log.warn('nonce count ahead of the record'); }
    }
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('nonce out of range');
    const data = encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args } as never);
    const raw = await account.signTransaction({
      type: 'eip1559', chainId: this.cfg.chainId, to: c.to, data, gas, nonce: Number(nonce), ...(c.value === undefined ? {} : { value: c.value }),
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: priority,
    });
    const hash = keccak256(raw).toLowerCase();
    return { signer, nonce, privately, job: c.job, key: c.key, to: c.to.toLowerCase(), ...(c.value === undefined ? {} : { value: c.value }),
      ...(c.drandDeadline === undefined ? {} : { drandDeadline: c.drandDeadline }),
      txs: [{ hash, raw, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: priority, block: this.last?.block.number ?? 0n }], hash,
      ...(taken ? { takeover: true } : {}) };
  }

  /**
   * SH-250 A (the fix round): any admitted job may take the signer's lowest unconfirmed nonce once its latest transaction
   * has been unmined for HANG_BLOCKS observed blocks, whatever its fee against the base fee (a first collection, a
   * takeover, a stage A entry, a replacement that waits, bytes a node refuses all end here). The taker's two fee fields
   * are at least the replacement step above the highest transaction ever signed at that nonce and its own; it must stay
   * under its own fee ceiling (an urgent random-number job's is R62-FEE's whatever counter the decision then picks),
   * or it does not take the nonce. A job whose call is already at that nonce never takes it. Each takeover starts a new
   * hanging period, so at most one per nonce per period. The private-send key's nonces go only to private jobs (each
   * key's own nonces). Returns the nonce and the fees the runner decides and reserves with.
   */
  async takeover(c: Candidate, privately: boolean, fees: Fees): Promise<Takeover | null> {
    // SH-259 rule A: on a chain whose base fee is 0 no other job takes a hanging nonce (only the same call is repriced).
    if (this.cfg.dryRun || this.last?.block.baseFeePerGas === 0n) return null;
    const account = privately ? this.signers.private : this.signers.public;
    if (!account) return null;
    const signer = account.address.toLowerCase();
    if (!this.sent.entries.some(e => e.signer === signer)) return null;
    let latest: bigint;
    try { ({ latest } = await this.counts(signer)); } catch { return null; }
    const lowest = this.sent.entries.filter(e => e.signer === signer && e.nonce >= latest && e.state === 'sent')
      .sort((a, b) => a.nonce < b.nonce ? -1 : 1)[0];
    if (!lowest || lowest.key === c.key || lowest.txs.some(t => t.call?.key === c.key || t.state === 'signed')) return null;
    const block = this.last?.block.number ?? 0n;
    let newest = 0n, highestMax = 0n, highestPriority = 0n;
    for (const t of lowest.txs) {
      if (t.block > newest) newest = t.block;
      if (t.maxFeePerGas > highestMax) highestMax = t.maxFeePerGas;
      if (t.maxPriorityFeePerGas > highestPriority) highestPriority = t.maxPriorityFeePerGas;
    }
    if (block - newest < HANG_BLOCKS) return null;
    const priority = bump(highestPriority) > fees.maxPriorityFeePerGas ? bump(highestPriority) : fees.maxPriorityFeePerGas;
    let maxFeePerGas = bump(highestMax) > fees.maxFeePerGas ? bump(highestMax) : fees.maxFeePerGas;
    if (priority > maxFeePerGas) maxFeePerGas = priority;
    if (maxFeePerGas > maxFeeFor(c, this.now, this.cfg.limits)) return null;
    return { signer, nonce: lowest.nonce, over: lowest.txs.reduce((h, t) => t.maxFeePerGas >= h.maxFeePerGas ? t : h).hash,
      fees: { ...fees, maxFeePerGas, maxPriorityFeePerGas: priority } };
  }

  /**
   * Guarantee 3: a job whose call is at a nonce another call took (or that took one) is in flight until the record
   * resolves that nonce, or until the signer's count passed the nonce at the finalized block (re-check note 1): before
   * that, planned again, it could run twice; after it, no call at that nonce can land and a new simulation sees the chain.
   */
  inFlight(key: string): boolean {
    return this.sent.entries.some(e => e.txs.some(t => t.call) && !this.spent.has(`${e.signer}:${e.nonce}`)
      && (e.key === key || e.txs.some(t => t.call?.key === key)));
  }

  /** SH-249 A1: saves the signed transaction with its reservation, durably, before the journal names its hash. */
  async keep(s: SignedSend, reservation?: SentReservation): Promise<void> {
    const t = s.txs[0];
    if (!s.takeover || !t) { this.sent.add(s, reservation); return; }
    // SH-250 A: the taker's transaction joins the hanging nonce, saved `signed` until the journal names it.
    const over = this.sent.entries.find(e => e.signer === s.signer && e.nonce === s.nonce)?.txs.reduce((h, x) => x.maxFeePerGas >= h.maxFeePerGas ? x : h).hash;
    this.log.warn('saved transaction taken over', { nonce: s.nonce, hash: t.hash, over });
    this.sent.addTx(s.signer, s.nonce, { ...t, state: 'signed', call: { job: s.job, key: s.key, to: s.to,
      ...(s.value === undefined ? {} : { value: s.value }), ...(s.drandDeadline === undefined ? {} : { drandDeadline: s.drandDeadline }),
      ...(reservation ? { reservation } : {}) } });
  }

  /**
   * SH-249 A1: after the journal names the hash, marks the entry sent (durably) and broadcasts its saved bytes. A failure
   * may follow node acceptance: the entry, its nonce and the reservation stay, and the next round broadcasts it again.
   */
  async broadcast(s: SignedSend): Promise<void> {
    const e = this.sent.commit(s.hash);
    const tx = e.txs.find(t => t.hash === s.hash.toLowerCase());
    const target = e.privately ? this.privatePub : this.pub;
    if (!tx || !target) throw new Error('transaction not saved');
    await target.sendRawTransaction({ serializedTransaction: tx.raw });
    this.sent.markAnswered(tx.hash, this.last?.block.number);
  }

  /** One direct call outside the scheduler (no reservation): signed, saved, then broadcast from the saved bytes. */
  async send(c: Candidate, gas: bigint, fees: Fees, privately: boolean): Promise<string> {
    const s = await this.sign(c, gas, fees, privately);
    await this.keep(s);
    await this.broadcast(s);
    return s.hash;
  }
}

/** SH-250 A: a nonce a job may take, with the fees it must decide and reserve with. */
export interface Takeover {
  readonly signer: string;
  readonly nonce: bigint;
  /** The highest-fee transaction it takes the nonce over. */
  readonly over: string;
  readonly fees: Fees;
}

/** SH-250 B2: a replacement this round may pay for. */
export interface Replacement {
  readonly entry: SentEntry;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** The replacement's signed maximum, and the highest any transaction at the nonce signed before it. */
  readonly costWei: bigint;
  readonly highestWei: bigint;
}

/** A node's reply that it already holds these bytes (geth, Nethermind, Erigon, Reth wordings). */
export function alreadyKnown(error: unknown): boolean {
  for (let e = error as { message?: unknown; details?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    for (const text of [e.message, e.details]) if (typeof text === 'string' && /already known|known transaction|alreadyknown|already imported/i.test(text)) return true;
  }
  return false;
}

/** The receipt fields the keeper reads. */
interface Receipt {
  readonly transactionHash: Hex;
  readonly from: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly status?: string;
  readonly to?: Address | null;
}

/** A simulated call's result. Only native P has a wei value; ERC-20 tips remain unknown. */
export function interpret(c: Candidate, result: unknown, qPerEthX18: bigint | null): Sim {
  const inEth = (raw: bigint) => (qPerEthX18 === null ? null : (raw * 10n ** 18n) / qPerEthX18);
  const none: Sim = { ok: false, tipWei: null, estimate: 0n };
  switch (c.job) {
    case 'drandGraduationBounty':
    case 'drandRequestWord':
    case 'drandAcceptWord':
      return { ok: result === undefined, tipWei: null, estimate: 0n };
    case 'backupFix':
    case 'drandPostRound':
      return { ok: typeof result === 'string' && /^0x[0-9a-f]{64}$/i.test(result), tipWei: null, estimate: 0n };
    case 'backupStart':
    case 'drandSettle':
    case 'drandWithdrawBounty':
      return { ok: typeof result === 'bigint' && result > 0n, tipWei: null, estimate: 0n };
    case 'itemSync':
    case 'pileLoadSeed':
      // Void success: sync requires the pending backlog check above; loadSeed reverts if no longer due.
      return { ok: result === undefined, tipWei: null, estimate: 0n };
    case 'holderSettle':
      // false means a successful partial page, not no work; the canonical reader omits completed batches.
      return { ok: typeof result === 'boolean', tipWei: null, estimate: 0n };
    case 'executorExecute': {
      const [, spent, burned] = result as readonly [bigint, bigint, bigint];
      return spent > 0n || burned > 0n ? { ok: true, tipWei: null, estimate: 0n } : none;
    }
    case 'sellFees': {
      // (skip, tIn, pOut, tip): a step whenever it consumes waiting T; the tip is P to the caller. A page of raw-wei
      // sources sells for zero P and pays no tip, yet the queue behind it moves only when someone presses it.
      const [skip, tIn, pOut, tip] = result as readonly [number, bigint, bigint, bigint];
      if (skip !== 0 || tIn === 0n) return none;
      // RC6RR2-HP-3: a page worth less than a hundredth of the step minimum is unblocking work, though it pays a tip.
      const low = pOut > 0n && c.lowValueBelow !== undefined && pOut < c.lowValueBelow;
      return { ok: true, tipWei: inEth(tip), paidTipRaw: tip, estimate: 0n, ...(pOut === 0n ? { zeroOutput: true as const } : {}),
        ...(low ? { unblocking: true as const } : {}) };
    }
    case 'royaltyRefresh':
    case 'royaltyObserve':
      // Void: planning requires whole lots for refresh, or below-lot custody with an unobserved clock/sale.
      return { ok: result === undefined, tipWei: null, estimate: 0n };
    case 'buyBack':
    case 'deepen': {
      if (c.version === 2 || c.job === 'buyBack') {
        const [skip, moved, , tip] = result as readonly [number, bigint, bigint, bigint];
        return skip === 0 && moved > 0n ? { ok: true, tipWei: inEth(tip), estimate: 0n } : none;
      }
      const [, skip, , , tip] = result as readonly [number, number, bigint, bigint, bigint];
      return skip === 0 ? { ok: true, tipWei: inEth(tip), estimate: 0n } : none;
    }
    case 'collect':
      if (c.version === 2) {
        const b = result as { buyersP: bigint; sellersP: bigint; qToReserve: bigint; tip: bigint };
        // buyersP is already net of the tip; each returned component is counted exactly once.
        const amount = b.buyersP + b.sellersP + b.qToReserve + b.tip;
        const ok = c.settlesGraduation === true || (c.minAmountRaw !== undefined && amount > 0n && amount >= c.minAmountRaw);
        // RC6RR2-MONEY-1, RC6RR2-HP-1: below the floor, a collect still advances cursors that closed sources wait behind.
        if (!ok && c.cursorLag === true && c.minAmountRaw !== undefined) return { ok: true, tipWei: inEth(b.tip), paidTipRaw: b.tip, estimate: 0n, unblocking: true };
        return { ok, tipWei: inEth(b.tip), paidTipRaw: b.tip, estimate: 0n };
      }
      return { ok: true, tipWei: inEth((result as { tip: bigint }).tip), estimate: 0n };
    case 'holderResidue':
    case 'itemResidue':
      // P residue: any positive proved transfer. A T burn is ordinary work and also waits for its batching floor.
      return typeof result === 'bigint' && result > 0n && result >= (c.minAmountRaw ?? 0n) ? { ok: true, tipWei: null, estimate: 0n } : none;
    case 'pileReturnSeed':
    case 'shopBurn':
    case 'shopReturn':
    case 'burnPending':
    case 'claimReward':
    case 'routerSweep':
    case 'royaltyFlush':
    case 'royaltySweep':
      return (result as bigint) > 0n ? { ok: true, tipWei: null, estimate: 0n } : none;
    case 'receiverPayFit':
    case 'receiverPayPlatform':
      // F130 permits timing only: no recipient argument and no payment to the trigger.
      return typeof result === 'bigint' && result > 0n ? { ok: true, tipWei: null, estimate: 0n } : none;
    case 'shopFees':
    case 'executeModule':
    case 'moveToPile':
    case 'eatPriceCoin':
      // A refused optional burn/lock/pile transfer restores pending and returns zero. No successful
      // transaction or invented tip is credited; the runner backs off and retries.
      return typeof result === 'bigint' && result > 0n ? { ok: true, tipWei: null, estimate: 0n } : none;
    default:
      return { ok: true, tipWei: null, estimate: 0n };
  }
}
