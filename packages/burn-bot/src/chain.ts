import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, pad, stringToHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { reconcileExecutions } from './chain-reconcile';
import type { Bot } from './bot';
import { z } from 'zod';
import { boxCoordinatorAbi } from '../../chain/src/abi/boxCoordinator';
import { fitBuybackExecutorAbi } from '../../chain/src/abi/fitBuybackExecutor';
import { poolManagerAbi } from '../../chain/src/abi/poolManager';
import { boxTokenAbi } from '../../chain/src/abi/boxToken';
import { coordinatorV2Abi, receiverV2Abi } from '../../chain/src/core/v2/abi-v2';
import { assetDecimals, validateSnapshot } from './builders';
import { requireChain } from './config';
import { safeReadAbi } from './chain-abi';
import { address, blockSchema, present, requireThat, roleSchema, uint } from './schema';
import type { ChainReader, Manifest, ReceiptLot, QuarantinedReceipt, Role, SafeTransaction, Snapshot } from './types';

export interface ChainLog {
  address: Address; data: Hex; topics: readonly Hex[]; blockNumber: bigint | null; blockHash: Hex | null;
  transactionHash: Hex | null; logIndex: number | null; removed?: boolean;
}
export interface ReaderRpc {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag?: 'finalized' | 'latest'; blockNumber?: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getBalance(args: { address: Address; blockNumber: bigint }): Promise<bigint>;
  getStorageAt(args: { address: Address; slot: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
  getTransaction(args: { hash: Hex }): Promise<{ to: Address | null; input: Hex }>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: ChainLog[] }>;
  call(args: { to: Address; data: Hex; blockNumber: bigint; account?: Address; gas?: bigint;
    stateOverride?: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] }): Promise<{ data?: Hex }>;
}
export interface CreditState { boxId: string; receiver: Address; fitOwed: bigint }
/** FIT Safe evidence only. The platform Safe, its receipts and box 0's platform ledger are not the bot's (F164 D2). */
export interface ChainObservation {
  snapshots: Record<Role, Snapshot>; lots: ReceiptLot[]; quarantined?: QuarantinedReceipt[]; credits: CreditState[];
  executor?: { budget: bigint; totalBurned: bigint; totalEthSpent: bigint };
}
export interface ScanPolicy { startBlock: bigint; logChunk: bigint; maxScanBlocks: bigint }
export function decodeLog(abi: Abi, log: ChainLog): { eventName: string; args: Record<string, unknown> } | null {
  try {
    const event = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    if (typeof event.eventName !== 'string' || !event.args) return null;
    return { eventName: event.eventName, args: event.args as unknown as Record<string, unknown> };
  } catch { return null; }
}
function matchesTransfer(log: ChainLog, asset: Address, sender: Address, safe: Address, amount: bigint) {
  if (asset === zeroAddress) {
    const e = log.address.toLowerCase() === safe ? decodeLog(safeReadAbi, log) : null;
    return e?.eventName === 'SafeReceived' && address.parse(e.args.sender) === sender && uint.parse(e.args.value) === amount;
  }
  const e = log.address.toLowerCase() === asset ? decodeLog(boxTokenAbi, log) : null;
  return e?.eventName === 'Transfer' && address.parse(e.args.from) === sender
    && address.parse(e.args.to) === safe && uint.parse(e.args.amount) === amount;
}
// V2 emits Paid after at most four int128 burn/take pairs.
function matchClaims(logs: ChainLog[], paid: ChainLog, manager: Address, asset: Address, safe: Address,
  amount: bigint, used: Set<string>) {
  const maxPart = (1n << 127n) - 1n, parts: bigint[] = [];
  requireThat(amount > 0n && amount <= maxPart * 4n, 'receipt transfer exceeds payout bound');
  for (let left = amount; left > 0n;) { const part = left > maxPart ? maxPart : left; parts.push(part); left -= part; }
  const ordered = [...logs].sort((a, b) => present(a.logIndex, 'missing receipt index') - present(b.logIndex, 'missing receipt index'));
  const anchor = ordered.findIndex(l => l.address.toLowerCase() === paid.address.toLowerCase()
    && l.logIndex === paid.logIndex && l.data === paid.data && l.topics.join() === paid.topics.join());
  requireThat(anchor >= 0, 'missing receipt attribution');
  const start = anchor - parts.length * 2;
  for (const [i, part] of parts.entries()) {
    const burn = ordered[start + i * 2], take = ordered[start + i * 2 + 1];
    const e = burn?.address.toLowerCase() === manager ? decodeLog(poolManagerAbi, burn) : null;
    const key = (l: ChainLog) => `${paid.transactionHash}:${l.logIndex}`;
    requireThat(burn && take && e?.eventName === 'Transfer' && address.parse(e.args.caller) === paid.address.toLowerCase()
      && address.parse(e.args.from) === paid.address.toLowerCase() && address.parse(e.args.to) === zeroAddress
      && uint.parse(e.args.id) === BigInt(asset) && uint.parse(e.args.amount) === part
      && matchesTransfer(take, asset, manager, safe, part) && !used.has(key(burn)) && !used.has(key(take)),
    'receipt transfer does not match claim redemption');
    used.add(key(burn)); used.add(key(take));
  }
}
export class ViemChainReader implements ChainReader {
  private knownBlocks = new Map<bigint, Snapshot['block']>();
  constructor(readonly manifest: Manifest, readonly rpc: ReaderRpc, readonly scan: ScanPolicy, allowMainnet = false) {
    requireChain(manifest.chainId, allowMainnet);
    requireThat(scan.startBlock > 0n && scan.logChunk > 0n && scan.maxScanBlocks > 0n, 'bounded scan starting before deployment required');
  }
  async block(args: Parameters<ReaderRpc['getBlock']>[0]): Promise<Snapshot['block']> {
    const { number, hash, timestamp } = await this.rpc.getBlock(args);
    return blockSchema.parse({ number, hash, timestamp });
  }
  async canonical(block: Snapshot['block']) {
    const actual = await this.rpc.getBlock({ blockNumber: block.number });
    requireThat(actual.hash === block.hash && actual.timestamp === block.timestamp, 'canonical block changed');
  }
  async remember(block: Snapshot['block']) { await this.canonical(block); this.knownBlocks.set(block.number, block); }
  private async pin() {
    requireThat(BigInt(await this.rpc.getChainId()) === this.manifest.chainId, 'RPC chain mismatch');
    const block = await this.block({ blockTag: 'finalized' });
    for (const old of this.knownBlocks.values()) await this.canonical(old);
    this.knownBlocks.set(block.number, block); return block;
  }
  async read(target: Address, abi: Abi, functionName: string, block: Snapshot['block'], args?: readonly unknown[]) {
    return this.rpc.readContract({ address: target, abi, functionName, blockNumber: block.number, ...(args ? { args } : {}) });
  }
  async balance(safe: Address, asset: Address, block: Snapshot['block']) {
    return asset === zeroAddress ? this.rpc.getBalance({ address: safe, blockNumber: block.number })
      : uint.parse(await this.read(asset, boxTokenAbi, 'balanceOf', block, [safe]));
  }
  async snapshot(role: Role): Promise<Snapshot> { return this.snapshotAt(role, await this.pin()); }
  private async snapshotAt(role: Role, block: Snapshot['block']): Promise<Snapshot> {
    const m = this.manifest, safe = m.safes[role];
    const readSafe = (name: string, args?: readonly unknown[]) => this.read(safe, safeReadAbi, name, block, args);
    const storageAddress = async (slot: Hex) => {
      const value = present(await this.rpc.getStorageAt({ address: safe, slot, blockNumber: block.number }), 'Safe storage unavailable');
      return address.parse(`0x${value.slice(-40)}`);
    };
    const singleton = await storageAddress(pad('0x00'));
    const guard = await storageAddress(keccak256(stringToHex('guard_manager.guard.address')));
    const fallbackHandler = await storageAddress(keccak256(stringToHex('fallback_manager.handler.address')));
    const modules = z.tuple([z.array(address), address]).parse(await readSafe('getModulesPaginated', [pad('0x01', { size: 20 }), 100n]));
    requireThat(modules[1] === pad('0x01', { size: 20 }), 'Safe module pagination not exhausted');
    const codeHashes: Snapshot['codeHashes'] = {};
    const targets = new Set([safe, singleton, guard, fallbackHandler, m.multiSend.address, m.weth,
      ...m.routes.flatMap(r => r.kind === 'v4' ? [r.router, r.permit2] : [r.router])]);
    for (const target of targets) if (target !== zeroAddress) {
      const code = present(await this.rpc.getCode({ address: target, blockNumber: block.number }), 'contract code unavailable');
      requireThat(code !== '0x', 'empty contract code'); codeHashes[target] = keccak256(code);
    }
    const balances: Snapshot['balances'] = {};
    for (const asset of [zeroAddress, ...Object.keys(m.assetDecimals) as Address[]]) balances[asset] = await this.balance(safe, asset, block);
    const readBox0 = (name: string) => this.read(m.box0.coordinator, boxCoordinatorAbi, name, block);
    const executor = address.parse(await readBox0('executor')), fit = address.parse(await readBox0('token'));
    requireThat(executor === m.box0.executor && fit === m.box0.fit, 'box-0 wiring mismatch');
    const boxes: Snapshot['boxes'] = [];
    for (const b of m.boxes) {
      const view = (name: string) => this.read(b.receiver, receiverV2Abi, name, block);
      const coordinator = address.parse(await view('coordinator'));
      const coord = (name: string) => this.read(coordinator, coordinatorV2Abi, name, block);
      requireThat(address.parse(await view('q')) === b.p && uint.parse(await view('boxId')).toString() === b.id
        && address.parse(await coord('receiver')) === b.receiver && uint.parse(await coord('boxId')).toString() === b.id,
      'v2 box identity mismatch');
      requireThat(address.parse(await view('FIT_SAFE')) === m.safes.fit, 'v2 Safe wiring mismatch');
      const failed = z.boolean().parse(await coord('failed'));
      const graduated = z.boolean().parse(await coord('graduated'));
      boxes.push({ ...b,
        phase: failed ? 'failed' : graduated ? 'graduated' : 'pre-graduation' });
    }
    await this.canonical(block);
    return validateSnapshot(m, { chainId: m.chainId, block, canonical: true, finalized: true,
      quoteBlocks: [...this.knownBlocks.values()], safe, singleton, guard, fallbackHandler, codeHashes, balances, boxes,
      nonce: await readSafe('nonce'), owners: await readSafe('getOwners'), threshold: await readSafe('getThreshold'), version: await readSafe('VERSION'), modules: modules[0],
      // Core v1 has no failed state; never invent one from its Closed launch phase.
      box0: { coordinator: m.box0.coordinator, executor, fit, graduated: z.boolean().parse(await readBox0('graduated')), failed: false },
    }, role);
  }
  async logs(target: Address, block: Snapshot['block']): Promise<ChainLog[]> {
    requireThat(block.number >= this.scan.startBlock && block.number - this.scan.startBlock + 1n <= this.scan.maxScanBlocks, 'history exceeds scan budget');
    const rows: ChainLog[] = [], seen = new Set<string>();
    for (let from = this.scan.startBlock; from <= block.number; from += this.scan.logChunk) {
      const end = from + this.scan.logChunk - 1n;
      for (const log of await this.rpc.getLogs({ address: target, fromBlock: from, toBlock: end > block.number ? block.number : end })) {
        requireThat(log.address.toLowerCase() === target && !log.removed && log.blockNumber !== null && log.blockNumber >= from
          && log.blockNumber <= (end > block.number ? block.number : end) && log.blockHash && log.transactionHash && log.logIndex !== null, 'invalid finalized log');
        const key = `${log.transactionHash}:${log.logIndex}`;
        requireThat(!seen.has(key), 'duplicate RPC log'); seen.add(key);
        const canonical = await this.rpc.getBlock({ blockNumber: log.blockNumber });
        requireThat(canonical.hash === log.blockHash, 'orphaned receipt'); rows.push(log);
      }
    }
    return rows.sort((a, b) => a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1);
  }
  private async completeHistory(target: Address) {
    const code = await this.rpc.getCode({ address: target, blockNumber: this.scan.startBlock - 1n });
    requireThat(!code || code === '0x', 'history must begin before receiver deployment');
  }
  private async poolManager(receiver: Address, coordinator: Address, block: Snapshot['block']) {
    const manager = address.parse(await this.read(receiver, receiverV2Abi, 'poolManager', block));
    requireThat(manager !== zeroAddress && manager === address.parse(await this.read(coordinator,
      coordinatorV2Abi, 'poolManager', block)), 'receiver PoolManager wiring mismatch');
    const code = await this.rpc.getCode({ address: manager, blockNumber: block.number });
    requireThat(code && code !== '0x', 'PoolManager code unavailable');
    return manager;
  }
  async observe(): Promise<ChainObservation> {
    const block = await this.pin();
    const snapshots = { fit: await this.snapshotAt('fit', block) };
    const quarantined: QuarantinedReceipt[] = [];
    const lots: ReceiptLot[] = [], credits: CreditState[] = [], usedTransfers = new Set<string>();
    for (const b of this.manifest.boxes) {
      await this.completeHistory(b.receiver);
      const manager = await this.poolManager(b.receiver, address.parse(await this.read(b.receiver, receiverV2Abi, 'coordinator', block)), block);
      credits.push({ boxId: b.id, receiver: b.receiver,
        fitOwed: uint.parse(await this.read(b.receiver, receiverV2Abi, 'fitOwed', block)) });
      const receiverLogs = await this.logs(b.receiver, block);
      for (const log of receiverLogs) {
        const event = decodeLog(receiverV2Abi, log);
        // Only FIT's payouts are the bot's; the platform's PlatformPaid share is not read (F164 D2).
        if (event?.eventName !== 'FitPaid') continue;
        const safe = address.parse(event.args.safe), amount = uint.parse(event.args.amount);
        if (amount === 0n) continue;
        requireThat(safe === this.manifest.safes.fit, 'receipt Safe mismatch');
        const asset = b.p;
        const txHash = present(log.transactionHash, 'missing transaction');
        const receipt = await this.rpc.getTransactionReceipt({ hash: txHash });
        requireThat(receipt.status === 'success' && receipt.blockHash === log.blockHash && receipt.blockNumber === log.blockNumber, 'receipt finality mismatch');
        requireThat(receipt.logs.some(l => l.address.toLowerCase() === b.receiver && l.logIndex === log.logIndex && l.data === log.data
          && l.topics.join() === log.topics.join()), 'missing receipt attribution');
        matchClaims(receipt.logs, log, manager, asset, safe, amount, usedTransfers);
        const sourceBlock = await this.block({ blockNumber: receipt.blockNumber });
        const lot: QuarantinedReceipt['lot'] = { id: `${txHash}:${log.logIndex}`, role: 'fit', chainId: this.manifest.chainId, safe, asset, amount,
          boxId: null,
          receiver: null, kind: 'fee',
          source: { txHash, logIndex: BigInt(present(log.logIndex, 'missing log index')), blockNumber: sourceBlock.number,
            blockHash: sourceBlock.hash, timestamp: sourceBlock.timestamp } };
        const reason = asset !== zeroAddress && !this.manifest.assetDecimals[asset] ? 'unsupported-asset' : null;
        if (reason) {
          // Foreign tokens can satisfy the receiver's exact-balance checks without standard Transfer logs.
          // The canonical receiver event establishes backlog provenance, never spendable inventory.
          quarantined.push({ lot, reason });
          continue;
        }
        // Admission (including after manifest migration) always needs the complete transfer proof.
        lots.push({ ...lot, decimals: assetDecimals(this.manifest, asset) });
      }
    }
    const executorRead = (name: string) => this.read(this.manifest.box0.executor, fitBuybackExecutorAbi, name, block);
    requireThat(address.parse(await executorRead('token')) === this.manifest.box0.fit, 'executor token mismatch');
    const executor = { budget: uint.parse(await executorRead('budget')), totalBurned: uint.parse(await executorRead('totalBurned')),
      totalEthSpent: uint.parse(await executorRead('totalEthSpent')) };
    lots.sort((a, b) => a.source.blockNumber === b.source.blockNumber ? a.source.logIndex < b.source.logIndex ? -1 : 1 : a.source.blockNumber < b.source.blockNumber ? -1 : 1);
    await this.canonical(block); return { snapshots, lots, quarantined, credits, executor };
  }
  reconcile(bot: Bot, observation: ChainObservation) { return reconcileExecutions(this, bot, observation); }
  async simulate(safe: Address, tx: SafeTransaction, block: Snapshot['block'], gasLimit: bigint): Promise<boolean> {
    // Approved-owner signature via eth_call only. Safe 1.4.1/1.5.0 fixed layout: threshold slot 4, nonce slot 5.
    // Threshold override tests the whole call tree, not signature sufficiency; owners still co-sign for execution.
    requireThat(Object.values(this.manifest.safes).includes(safe), 'unknown simulation Safe');
    requireThat(BigInt(await this.rpc.getChainId()) === this.manifest.chainId, 'simulation RPC chain mismatch');
    await this.canonical(block);
    const owner = this.manifest.owners.founder;
    const signatures = `${pad(owner)}${pad('0x00').slice(2)}01` as Hex;
    const data = encodeFunctionData({ abi: safeReadAbi, functionName: 'execTransaction', args: [tx.to, tx.value, tx.data,
      tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures] });
    try {
      const head = await this.block({ blockTag: 'latest' });
      const role = roleSchema.options.find(r => this.manifest.safes[r] === safe);
      requireThat(role, 'unknown Safe');
      // Recheck the full reviewed configuration at the head without claiming that head is finalized.
      // snapshotAt validates the same fields; its returned finality marker is not published here.
      const fresh = await this.snapshotAt(role, head);
      requireThat(fresh.nonce <= tx.nonce, 'simulation nonce consumed');
      for (const at of [block, head]) {
        const result = await this.rpc.call({ to: safe, data, blockNumber: at.number, account: owner, gas: gasLimit,
          stateOverride: [{ address: safe, stateDiff: [{ slot: pad('0x04'), value: pad('0x01') },
            { slot: pad('0x05'), value: pad(`0x${tx.nonce.toString(16)}`) }] }] });
        requireThat(decodeFunctionResult({ abi: safeReadAbi, functionName: 'execTransaction', data: present(result.data, 'empty simulation') }), 'Safe simulation failed');
        await this.canonical(at);
      }
      return true;
    } catch { return false; }
  }
}
