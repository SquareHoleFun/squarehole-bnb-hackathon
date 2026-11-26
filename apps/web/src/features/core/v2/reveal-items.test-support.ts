import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { openRevealFixture } from '../../../../../../packages/chain/src/core/v2/test-support/open-reveal-fixture';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { TEST_FEE_READER } from '../../../../../../packages/chain/src/write/test-support';
import { loadRevealItems, prepareRevealItems, runRevealItems, type RevealIdentity, type RevealPlan, type RevealPorts, type RevealReceipt, type RevealRun, type RevealSnapshot } from './reveal-items';
import type { RevealLock } from './reveal-items-store';

export const addr = (n: number): Address => toHex(n, { size: 20 });
export const digest = (n: number): Hex => toHex(n, { size: 32 });
export function must<T>(value: T | undefined | null): T { if (value == null) throw new Error('fixture-missing'); return value; }
export function memoryLock(): RevealLock {
  const active = new Set<string>();
  return { async run(key, work) {
    if (active.has(key)) return { acquired: false };
    active.add(key);
    try { return { acquired: true, value: await work() }; } finally { active.delete(key); }
  } };
}
export function runFixture(n = 4) {
  const file = openRevealFixture(n);
  const identity: RevealIdentity = { chainId: 11155111, registry: addr(90), boxId: 7n, token: addr(2), creator: addr(50), specHash: file.specHash };
  const block = { number: 100n, hash: digest(100) };
  const record = { boxId: 7n, templateId: zeroHash, specHash: file.specHash, creator: identity.creator, pricingListingId: 1, q: zeroAddress, raise: 1n,
    poolManager: addr(60), poolId: zeroHash, creationBlock: 1n, openAt: 1n, randomness: addr(61),
    contracts: Array.from({ length: 24 }, (_, i) => addr(i + 1)), codeHashes: Array.from({ length: 24 }, () => keccak256('0x6000')) };
  const snapshot: RevealSnapshot = { ...identity, record, block, encodedSpec: file.encoded, collectionCode: '0x6000', root: file.spec.revealRoot as Hex, size: BigInt(n), firstId: 1n, triggers: 4 };
  const saved = new Map<string, string>(), finalized = new Set<bigint>(), latest = new Set<bigint>(), receipts = new Map<Hex, RevealReceipt>();
  const sends: { ids: bigint[]; nonce: bigint; gas: bigint; maxFee: bigint }[] = [];
  const controller = new AbortController();
  let time = 0, attempt = 0, nonce = 0n, sequence = 0;
  let account = identity.creator, network = identity.chainId;
  let onSend: (ids: bigint[], hash: Hex) => Promise<void> = async ids => { for (const id of ids) { latest.add(id); finalized.add(id); } };
  const ports: RevealPorts = {
    store: { get: async key => saved.get(key) ?? null, put: async (key, value) => { saved.set(key, value); } }, lock: memoryLock(),
    chain: {
      chainId: async () => identity.chainId,
      snapshot: async (_identity, tag) => ({ ...snapshot, block: tag === 'finalized' ? block : { number: block.number + 1n, hash: digest(101) } }),
      canonical: async () => true, revealed: async (_collection, ids, at) => ids.map(id => (at.number <= block.number ? finalized : latest).has(id)),
      nonce: async () => nonce, receipt: async hash => receipts.get(hash) ?? null,
    },
    wallet: async request => {
      if (request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return toHex(network);
      if (request.method !== 'eth_sendTransaction') throw new Error('unexpected-wallet-method');
      const tx = must((request.params as readonly Record<string, Hex>[])[0]);
      const calls = decodeFunctionData({ abi: multicall3Abi, data: must(tx.data) }).args[0];
      const ids = calls.map(c => {
        const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: c.callData });
        if (decoded.functionName !== 'reveal') throw new Error('unexpected-selector');
        return decoded.args[0];
      });
      const hash = digest(++sequence);
      sends.push({ ids, nonce: BigInt(must(tx.nonce)), gas: BigInt(must(tx.gas)), maxFee: BigInt(must(tx.maxFeePerGas)) });
      receipts.set(hash, { hash, from: identity.creator, block, status: 'success', logs: [], nonce: BigInt(must(tx.nonce)), to: must(tx.to), input: must(tx.data), value: 0n });
      await onSend(ids, hash);
      nonce++;
      return hash;
    },
    feeReader: { ...TEST_FEE_READER, getBalance: async () => 10n ** 30n },
    estimate: async call => BigInt(decodeFunctionData({ abi: multicall3Abi, data: call.data }).args[0].length) * 300_000n,
    simulate: async call => encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result:
      decodeFunctionData({ abi: multicall3Abi, data: call.data }).args[0].map(() => ({ success: true, returnData: '0x' as const })) }),
    clock: () => ({ wall: time, tick: time, epoch: 'test' }), now: () => time, attemptId: () => `attempt-${++attempt}`, sleep: async ms => { time += ms; },
  };
  authorizeRevealTestTarget(ports); authorizeRevealTestTarget(ports.store);
  return { file, identity, snapshot, record, saved, finalized, latest, receipts, sends, ports, controller,
    set time(v: number) { time = v; }, get time() { return time; }, set nonce(v: bigint) { nonce = v; },
    set account(v: Address) { account = v; }, set network(v: number) { network = v; },
    set onSend(v: typeof onSend) { onSend = v; },
    async source() {
      const result = await loadRevealItems(identity, identity.creator, new Blob([JSON.stringify(file)]), ports.chain);
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    },
    async plan() {
      const source = await this.source();
      const result = await prepareRevealItems(source, ports);
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    },
  };
}

/** Records completed read/wallet requests, including the immediate predecessor of every send. */
export function traceRevealSends(ports: RevealPorts) {
  const answers: string[] = [], predecessors: (string | undefined)[] = [];
  const trace = (target: object, prefix: string, names: readonly string[]) => {
    const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of names) {
      const original = must(methods[name]);
      methods[name] = async (...args) => { const value = await original(...args); answers.push(`${prefix}:${name}${name === 'chainId' ? `:${String(value)}` : ''}`); return value; };
    }
  };
  trace(ports.chain, 'read', ['chainId', 'snapshot', 'canonical', 'revealed', 'nonce', 'receipt']);
  trace(ports.feeReader, 'read', ['getBlock', 'maxPriorityFeePerGas', 'getBalance']);
  trace(ports, 'read', ['estimate', 'simulate']);
  const wallet = ports.wallet;
  Object.assign(ports, { wallet: async (request: Parameters<typeof wallet>[0]) => {
    if (request.method === 'eth_sendTransaction') predecessors.push(answers.at(-1));
    const value = await wallet(request); answers.push(`wallet:${request.method}`); return value;
  } });
  return predecessors;
}

/**
 * SH-203 af5 (R4-L3a): one Start press sends at most the transactions its plan showed; a press that would need one more
 * ends with `plan-changed`, and the creator prepares again. This presses Start, then Prepare and Start again while a press
 * ends that way (at most `limit` presses), and records for each press the count shown and the sends it made.
 */
export async function runPresses(f: ReturnType<typeof runFixture>, first?: RevealPlan, limit = 6) {
  const presses: { shown: number; sent: number; run: RevealRun }[] = [];
  let plan = first ?? await f.plan();
  for (let press = 0; press < limit; press++) {
    const before = f.sends.length;
    const result = await runRevealItems(plan, f.ports, f.controller.signal);
    if (!result.ok) throw new Error(result.reason);
    presses.push({ shown: plan.batches.length, sent: f.sends.length - before, run: result.value });
    if (result.value.reason !== 'plan-changed') break;
    plan = await f.plan();
    if (!plan.batches.length) break;
  }
  const last = presses.at(-1);
  if (!last) throw new Error('no-press');
  return { presses, last: last.run };
}
