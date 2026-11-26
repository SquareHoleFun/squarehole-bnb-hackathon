import { afterEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeErrorResult, encodeFunctionData, encodeFunctionResult, zeroAddress, type Address, type Hex } from 'viem';
import { auditSpecs, readBox, readDisplay } from '../../src/core/audit';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { RpcCoreReader } from '../../src/core/core-reader';
import { coordinatorV2Abi, royaltyRouterV2Abi } from '../../src/core/v2/chain-v2';
import { readMoneyV2, refusedAtHash } from '../../src/core/v2/money-v2';
import { readSetState } from '../../src/core/set-v2/state';
import { boxHookAbi, boxItemStreamAbi, boxTokenAbi } from '@squarehole/chain/abi';
import { claimsRpcReaderV2 } from '../../src/core/v2/claims-reads-v2';
import { createPublicClient, http, parseAbi } from 'viem';
import { MAX_VIEW_CALLS } from '../../src/core/multicall';
import { agreeingCalls, synthBox, synthManifest, World } from './core-synth';
import { boxLogsV2, listingAddedLog, loadCoreLife, requiredV2, ScriptedCoreChain, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from './scripted-core-chain';
import { aggregateAbi, fakeRpc, fixtureRpc, MULTICALL } from './rpc-fixture';
import { membersFixture } from './set-v2/members-fixture';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function recordedBox() {
  const life = loadCoreLife();
  const indexer = new CoreChainIndexer({ reader: life.chain, manifest: life.manifest });
  await indexer.start();
  const row = requiredV2([...indexer.boxes.values()][0]).row;
  const hash = requiredV2([...life.auditHashes][0]) as Hex;
  const block = requiredV2(life.chain.byHash.get(hash)).number;
  indexer.stop();
  return { ...life, row, hash, block };
}

it.each([true, false])('RPC-1: recorded display and audit match single calls; Multicall3 code=%s', async available => {
  const f = await recordedBox();
  const expected = await readBox(f.chain, f.row, f.block, f.hash);
  const display = await readDisplay(f.chain, f.row, f.hash);
  const requests = fixtureRpc(f.chain, available);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  expect(await readBox(reader, f.row, f.block, f.hash)).toEqual(expected);
  expect(await readDisplay(reader, f.row, f.hash)).toEqual(display);
  expect(requests.filter(r => r.method === 'eth_getCode')).toHaveLength(1);
  const calls = requests.filter(r => r.method === 'eth_call');
  expect(calls.length).toBeLessThanOrEqual(available ? 3 : 30);
  expect(calls.every(r => (r.params[1] as { blockHash: Hex }).blockHash === f.hash)).toBe(true);
  expect(calls.some(r => (r.params[0] as { to: Address }).to.toLowerCase() === MULTICALL.toLowerCase())).toBe(available);
});

it('RPC-1: a failed sub-call fails the audit/display with its revert bytes; a refused hash remains a transport refusal', async () => {
  const f = await recordedBox();
  const call = f.chain.callAt.bind(f.chain);
  let refusal = false;
  f.chain.callAt = async (to, data, hash) => {
    if (refusal) throw new Error('header not found');
    const spec = requiredV2(auditSpecs(f.row).find(spec => spec.fn === 'depthBudget'));
    if (to.toLowerCase() === spec.to.toLowerCase() && data === encodeFunctionData({ abi: spec.abi, functionName: spec.fn })) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0xdeadbeef' });
    return call(to, data, hash);
  };
  fixtureRpc(f.chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  for (const read of [() => readBox(reader, f.row, f.block, f.hash), () => readDisplay(reader, f.row, f.hash)]) {
    await expect(read()).rejects.toSatisfy(refusedAtHash);
  }
  refusal = true;
  await expect(readBox(reader, f.row, f.block, f.hash)).rejects.toSatisfy(error => !refusedAtHash(error));
});

it('RPC-1: money failures keep isolation and InvalidClaim exhaustion identical to single calls', async () => {
  const box = serviceBoxV2(); const world = new World('batch-failures');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]); world.to(101n);
  const chain = serviceChainV2(world, [box]); chain.tip = 100n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  await indexer.start();
  const entry = requiredV2([...indexer.boxesV2.values()][0]); const state = requiredV2(entry.states.at(-1));
  const hash = chain.header(100n).hash;
  const original = chain.callAt.bind(chain);
  let failing = false;
  chain.callAt = async (to, data, at) => {
    if (to.toLowerCase() === box.record.contracts[0]?.toLowerCase()) {
      const { functionName } = decodeFunctionData({ abi: coordinatorV2Abi, data });
      if (functionName === 'quoteClaim' || (failing && functionName === 'claimState')) throw Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' }) });
    }
    return original(to, data, at);
  };
  fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  expect(await readMoneyV2(reader, entry.row, state.view, 100n, hash)).toEqual(await readMoneyV2(chain, entry.row, state.view, 100n, hash));
  const noBuyers = { ...state.view, claim: { initialPot: 0n, initialT: 0n, pot: 0n, tLeft: 0n, tip: 0n, closer: zeroAddress, claimedP: 0n, claimedT: 0n, creatorClaimed: true } };
  const exhausted = await readMoneyV2(reader, entry.row, noBuyers, 100n, hash);
  expect(exhausted).toEqual(await readMoneyV2(chain, entry.row, noBuyers, 100n, hash));
  expect(exhausted.claim.creatorEntitlement).toBe(0n);
  failing = true;
  await expect(readMoneyV2(reader, entry.row, state.view, 100n, hash)).rejects.toSatisfy(refusedAtHash);
  const batched = new CoreChainIndexer({ reader, manifest: synthManifestV2(), auditEvery: 10_000 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await batched.start();
  expect(batched.head()?.number).toBe(100n);
  expect(batched.v2BoxView(requiredV2(box.record.contracts[1]))?.money).toBeNull();
  expect(batched.boxesV2.values().next().value?.moneyFailing).toBe(true);
  indexer.stop(); batched.stop();
}, shLimit(30_000));

it('RPC-1: set reads preserve every decoded value and use one aggregate', async () => {
  const f = membersFixture(); f.reads.inside = 7n; f.reads.loaded = 19;
  const chain = new ScriptedCoreChain(31337, [f.header(51n)], []);
  chain.callAt = f.reader.callAt.bind(f.reader);
  const requests = fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  expect(await readSetState(reader, f.row, f.header(51n).hash, '900719925474099312345')).toEqual(await readSetState(f.reader, f.row, f.header(51n).hash, '900719925474099312345'));
  const calls = requests.filter(r => r.method === 'eth_call');
  expect(calls).toHaveLength(1);
  expect(decodeFunctionData({ abi: aggregateAbi, data: (calls[0]?.params[0] as { data: Hex }).data }).args[0]).toHaveLength(6);
});

it('RPC-1: sender simulations and state overrides retain a single eth_call with their original parameters', async () => {
  const quoteAbi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
  const calls = fakeRpc(() => encodeFunctionResult({ abi: quoteAbi, functionName: 'quote', result: 2n ** 120n }));
  const client = createPublicClient({ transport: http('https://fixture.invalid', { retryCount: 0 }) });
  const reader = claimsRpcReaderV2(client);
  const f = membersFixture(); const wallet = f.row.creator, receiver = f.row.contracts.receiver as Address, hash = f.header(51n).hash;
  await reader.callFromAt?.(wallet, receiver, '0x1234', hash);
  expect(await reader.creatorEntitlementAt?.(wallet, receiver, zeroAddress, hash)).toBe(2n ** 120n);
  expect(calls.map(c => c.method)).toEqual(['eth_call', 'eth_call']);
  expect(calls[0]?.params).toMatchObject([{ from: wallet, to: receiver, data: '0x1234' }, { blockHash: hash, requireCanonical: true }]);
  expect(calls[1]?.params).toMatchObject([{ from: wallet, to: wallet }, { blockHash: hash, requireCanonical: true }, { [wallet]: { code: expect.any(String) } }]);
});

it('RPC-1: direct eth_call remains single (including non-view callers)', async () => {
  const f = await recordedBox(); const requests = fixtureRpc(f.chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const data = encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'failed' });
  // The arbitrary calldata need not be supported by this fixture to establish that it is never wrapped.
  await reader.callAt(f.row.contracts.coordinator as Address, data, f.hash).catch(() => {});
  expect(requests.every(r => r.method === 'eth_call' && (r.params[0] as { to: Address }).to !== MULTICALL)).toBe(true);
});

it('RPC-1: very large batches split at the call cap and preserve result order and individual failures', async () => {
  const f = membersFixture();
  const chain = new ScriptedCoreChain(31337, [f.header(51n)], []);
  const data = encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'failed' });
  const to = f.row.contracts.coordinator as Address;
  chain.callAt = async (_to, data) => {
    if (data === '0xdeadbeef') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x1234' });
    return data;
  };
  const requests = fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const calls = Array.from({ length: 257 }, (_, i) => ({ to, data: i === MAX_VIEW_CALLS ? '0xdeadbeef' as Hex : data }));
  const results = await reader.callViewsAt(calls, f.header(51n).hash);
  expect(results).toHaveLength(calls.length);
  expect(results[MAX_VIEW_CALLS]).toMatchObject({ status: 'rejected', reason: { code: 3, data: '0x1234' } });
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(calls.length - 1);
  expect(requests.filter(r => r.method === 'eth_call').map(r => decodeFunctionData({ abi: aggregateAbi, data: (r.params[0] as { data: Hex }).data }).args[0].length)).toEqual([128, 128, 1]);
});

it('RPC-1: a refused capability probe is retried and never cached as missing code', async () => {
  const f = membersFixture(); const chain = new ScriptedCoreChain(31337, [f.header(51n)], []);
  chain.callAt = f.reader.callAt.bind(f.reader);
  const requests = fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const codeAt = vi.spyOn(reader, 'codeAt').mockRejectedValueOnce(new Error('header not found'));
  await expect(readSetState(reader, f.row, f.header(51n).hash, '1')).rejects.toThrow('header not found');
  expect(await readSetState(reader, f.row, f.header(51n).hash, '1')).toHaveProperty('totalSupply', '1');
  expect(codeAt).toHaveBeenCalledTimes(2);
  expect(requests.filter(r => r.method === 'eth_call')).toHaveLength(1);
});

async function batchBoxes(withV1 = false) {
  const boxes = [4n, 5n, 6n].map(id => serviceBoxV2(id));
  const base = withV1 ? synthBox({ boxId: 0n, creationBlock: 100n }) : null;
  const box0 = base ? { ...base, row: { ...base.row, poolManager: V2.poolManager, randomness: V2.randomness },
    record: { ...base.record, poolManager: V2.poolManager, randomness: V2.randomness } } : null;
  const world = new World('block-batch');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [...(box0 ? [world.created(box0)] : []), ...boxes.map(box => boxLogsV2(box))]); world.to(103n);
  const chain = serviceChainV2(world, boxes, (_box, key) => key === 'royaltyRouter.listingRegistry' ? zeroAddress : undefined);
  chain.tip = 100n;
  const requests = fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const manifest = { ...synthManifestV2(), ...(box0 ? { versions: synthManifest().versions } : {}) };
  const indexer = new CoreChainIndexer({ reader, manifest, auditEvery: 10_000 });
  if (box0) {
    const code = chain.codeAt.bind(chain), call = chain.callAt.bind(chain);
    chain.codeAt = async (address, hash) => box0.codes.get(address.toLowerCase()) ?? code(address, hash);
    const answer = agreeingCalls(indexer);
    chain.callAt = async (to, data, hash) => {
      const value = answer(to, data, hash);
      if (value !== undefined) return value;
      if (to === box0.row.contracts.hook && data === encodeFunctionData({ abi: boxHookAbi, functionName: 'depthBudget' })) return encodeFunctionResult({ abi: boxHookAbi, functionName: 'depthBudget', result: [0n, 0n] });
      if (to === box0.row.contracts.itemStream) return encodeFunctionResult({ abi: boxItemStreamAbi, functionName: 'index', result: 0n });
      return call(to, data, hash);
    };
  }
  await indexer.start(); await indexer.idle(); requests.splice(0);
  return { boxes, world, chain, reader, requests, indexer };
}

it('BATCH-2: all audit boxes share bounded views and one canonical header, with unchanged ordered answers', async () => {
  const f = await batchBoxes();
  const results = await f.indexer.audit();
  expect(results.map(r => r.result.ok)).toEqual([true, true, true]);
  expect(results.map(r => r.token)).toEqual([...f.indexer.boxesV2.keys()]);
  expect(f.requests.filter(r => r.method === 'eth_getBlockByNumber')).toHaveLength(1);
  expect(f.requests.filter(r => r.method === 'eth_call').length).toBeLessThan(18);
  for (const r of f.requests.filter(r => r.method === 'eth_call')) expect(r.params[1]).toEqual({ blockHash: f.chain.header(100n).hash });
  f.indexer.stop();
});

it('BATCH-3: one reverted box stays isolated through publication and audit, then recovers on a fresh read', async () => {
  const f = await batchBoxes();
  const [bad, ...good] = [...f.indexer.boxesV2.values()];
  const entry = requiredV2(bad);
  const original = f.chain.callAt.bind(f.chain);
  let failing = true;
  f.chain.callAt = async (to, data, hash) => {
    if (failing && to.toLowerCase() === entry.row.contracts.coordinator?.toLowerCase()
      && data === encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claimState' })) {
      throw Object.assign(new Error('execution reverted'), { code: 3, data: '0xdeadbeef' });
    }
    return original(to, data, hash);
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.chain.tip = 101n; await f.indexer.enqueue(f.chain.header(101n)); await f.indexer.idle();
  expect(f.indexer.head()?.number).toBe(101n);
  expect(entry.moneyFailing).toBe(true);
  expect(entry.states.at(-1)?.money).toBeUndefined();
  for (const other of good) expect(other.states.at(-1)?.money?.hash).toBe(f.chain.header(101n).hash);
  expect((await f.indexer.audit()).map(r => r.token)).toEqual(good.map(e => e.row.contracts.token?.toLowerCase()));
  expect(entry.verified).toBeNull();
  failing = false;
  expect((await f.indexer.audit()).map(r => r.result.ok)).toEqual([true, true, true]);
  f.chain.tip = 102n; await f.indexer.enqueue(f.chain.header(102n)); await f.indexer.idle();
  expect(entry.moneyFailing).toBe(false);
  expect(entry.states.at(-1)?.money?.hash).toBe(f.chain.header(102n).hash);
  f.indexer.stop();
});

it('BATCH-3: a transport failure publishes no partial block and a retry reads every box again', async () => {
  const f = await batchBoxes();
  const before = f.indexer.v2FeedView();
  const original = f.reader.callViewsAt.bind(f.reader);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const call = vi.spyOn(f.reader, 'callViewsAt').mockRejectedValue(new Error('temporarily unavailable'));
  f.chain.tip = 101n; await f.indexer.enqueue(f.chain.header(101n)); await f.indexer.idle();
  expect(f.indexer.head()?.number).toBe(100n);
  expect(f.indexer.v2FeedView()).toEqual(before);
  call.mockImplementation(original);
  await f.indexer.enqueue(f.chain.header(101n)); await f.indexer.idle();
  expect(f.indexer.head()?.number).toBe(101n);
  for (const e of f.indexer.boxesV2.values()) expect(e.states.at(-1)?.money?.hash).toBe(f.chain.header(101n).hash);
  f.indexer.stop();
});

it('BATCH-2: a replacement header after the grouped audit reads cannot publish orphan verdicts', async () => {
  const f = await batchBoxes();
  const original = f.chain.callAt.bind(f.chain);
  let changed = false;
  f.chain.callAt = async (...args) => {
    const answer = await original(...args);
    if (!changed) {
      changed = true;
      const fork = f.world.fork(99n, 'audit-replacement'); fork.to(103n);
      f.chain.setBranch(fork.headers.filter(h => h.number > 99n), []);
    }
    return answer;
  };
  expect(await f.indexer.audit()).toEqual([]);
  for (const e of f.indexer.boxesV2.values()) expect(e.audit).toBeNull();
  f.indexer.stop();
});


it('BATCH-1: encoded calldata splits below 48 KiB and an oversized individual view stays single', async () => {
  const f = membersFixture();
  const chain = new ScriptedCoreChain(31337, [f.header(51n)], []);
  chain.callAt = async (_to, data) => data;
  const requests = fixtureRpc(chain);
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const to = f.row.contracts.coordinator as Address;
  const data = `0x${'ab'.repeat(8 * 1024)}` as Hex;
  const large = `0x${'cd'.repeat(48 * 1024)}` as Hex;
  const calls = [...Array.from({ length: 10 }, () => ({ to, data })), { to, data: large }];
  const results = await reader.callViewsAt(calls, f.header(51n).hash);
  expect(results).toEqual(calls.map(call => ({ status: 'fulfilled', value: call.data })));
  const chunks = requests.filter(r => r.method === 'eth_call').map(r => r.params[0] as { to: Address; data: Hex });
  expect(chunks.map(call => call.to.toLowerCase() === MULTICALL.toLowerCase()
    ? decodeFunctionData({ abi: aggregateAbi, data: call.data }).args[0].length : 'single')).toEqual([5, 5, 'single']);
  for (const call of chunks.filter(c => c.to.toLowerCase() === MULTICALL.toLowerCase())) expect((call.data.length - 2) / 2).toBeLessThanOrEqual(48 * 1024);
});

it('BATCH-3: silent donations refresh custody for every quiet box at its new hash', async () => {
  const f = await batchBoxes();
  const original = f.chain.callAt.bind(f.chain);
  const routers = new Set(f.boxes.map(b => b.record.contracts[8]?.toLowerCase()));
  f.chain.callAt = async (to, data, hash) => {
    if (routers.has(to.toLowerCase())) {
      const decoded = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
      if (decoded.functionName === 'heldBalance') return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance',
        result: (f.chain.byHash.get(hash)?.number ?? 0n) * 2n ** 100n });
    }
    return original(to, data, hash);
  };
  for (const number of [101n, 102n]) {
    f.chain.tip = number; await f.indexer.enqueue(f.chain.header(number)); await f.indexer.idle();
    for (const e of f.indexer.boxesV2.values()) {
      const money = e.states.at(-1)?.money;
      expect(money?.hash).toBe(f.chain.header(number).hash);
      expect(money?.block).toBe(number);
      expect(Object.values(requiredV2(money?.royalty).balances)).toEqual(Array(4).fill(number * 2n ** 100n));
    }
  }
  f.indexer.stop();
});

it('BATCH-2: the shared audit header follows the slowest box and is never reused by a later audit', async () => {
  const f = await batchBoxes();
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const last = requiredV2(f.boxes.at(-1));
  const original = f.chain.callAt.bind(f.chain);
  f.chain.callAt = async (to, data, hash) => {
    if (to.toLowerCase() === last.record.contracts[8]?.toLowerCase()
      && data === encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'weth' })) { started(); await gate; }
    return original(to, data, hash);
  };
  const audit = f.indexer.audit();
  await waiting;
  expect(f.requests.filter(r => r.method === 'eth_getBlockByNumber')).toHaveLength(0);
  release();
  expect((await audit).map(r => r.result.ok)).toEqual([true, true, true]);
  expect(f.requests.filter(r => r.method === 'eth_getBlockByNumber')).toHaveLength(1);
  // The same head does not license caching an audit's header or money into the next audit.
  f.chain.callAt = original;
  await f.indexer.audit();
  expect(f.requests.filter(r => r.method === 'eth_getBlockByNumber')).toHaveLength(2);
  f.indexer.stop();
});

it('BATCH-2: a mismatch repairs only its box and performs fresh audit reads afterwards', async () => {
  const f = await batchBoxes();
  const entry = requiredV2([...f.indexer.boxesV2.values()][0]);
  const state = requiredV2(entry.states.at(-1));
  entry.states[entry.states.length - 1] = { ...state, supply: state.supply + 1n };
  const repair = vi.spyOn(f.indexer, 'repairBox');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const results = await f.indexer.audit();
  expect(results.map(r => r.result.ok)).toEqual([false, true, true, true]);
  expect(results[0]?.token).toBe(results[1]?.token);
  expect(repair).toHaveBeenCalledExactlyOnceWith(entry);
  expect(entry.verified).toBe(true);
  expect(entry.states.at(-1)?.supply).toBe(state.supply);
  f.indexer.stop();
});

it.each(['replacement', 'missing', 'rejected', 'money-revert', 'replacement-and-money-revert'] as const)(
  'BATCH-AF1: a real repair propagates its recheck canonicality to later boxes (%s)', async failure => {
    const f = await batchBoxes();
    const [first, ...later] = [...f.indexer.boxesV2.values()];
    const entry = requiredV2(first);
    const state = requiredV2(entry.states.at(-1));
    const head = requiredV2(f.indexer.head() ?? undefined);
    entry.states[entry.states.length - 1] = { ...state, supply: state.supply + 1n };
    const repairBox = f.indexer.repairBox.bind(f.indexer);
    let recheckHeaders = 0;
    let recheckReads = 0;
    const repair = vi.spyOn(f.indexer, 'repairBox').mockImplementation(async target => {
      await repairBox(target);
      // The repair really replayed and published its states before the chain changes. The processing
      // queue still holds the old local head, exactly as during a periodic audit.
      expect(target).toBe(entry);
      expect(entry.states.at(-1)?.supply).toBe(state.supply);
      expect(entry.states.at(-1)?.money?.hash).toBe(head.hash);
      const header = f.reader.headerByNumber.bind(f.reader);
      vi.spyOn(f.reader, 'headerByNumber').mockImplementation(async number => {
        recheckHeaders += 1;
        if (failure === 'rejected') throw new Error('canonical header unavailable');
        if (failure === 'missing') return null;
        return header(number);
      });
      const call = f.chain.callAt.bind(f.chain);
      f.chain.callAt = async (to, data, hash) => {
        recheckReads += 1;
        if (failure.includes('money-revert') && to.toLowerCase() === entry.row.contracts.coordinator?.toLowerCase()
          && data === encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claimState' })) {
          throw Object.assign(new Error('execution reverted'), { code: 3, data: '0xdeadbeef' });
        }
        return call(to, data, hash);
      };
      if (failure.startsWith('replacement')) {
        const fork = f.world.fork(99n, 'repair-recheck-reorg'); fork.to(103n);
        f.chain.setBranch(fork.headers.filter(h => h.number > 99n), []);
        expect(f.chain.header(head.number).hash).not.toBe(head.hash);
      }
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await f.indexer.audit();
      expect(repair).toHaveBeenCalledExactlyOnceWith(entry);
      expect(f.indexer.head()?.hash).toBe(head.hash);
      expect(recheckReads).toBeGreaterThan(0);
      const localFailure = failure === 'money-revert';
      expect(results.map(r => r.result.ok)).toEqual(localFailure ? [false, true, true] : [false]);
      expect(recheckHeaders).toBe(1);
      expect(entry.audit?.ok).toBe(false);
      if (localFailure) expect(entry.verified).toBeNull();
      for (const other of later) {
        expect(other.verified).toBe(localFailure ? true : null);
        if (localFailure) expect(other.audit?.ok).toBe(true);
        else expect(other.audit).toBeNull();
      }
    } finally { f.indexer.stop(); }
  },
);

it.each(['replacement', 'rejected'] as const)(
  'BATCH-AF1: a failed final repair anchor stops later staged verdicts (%s)', async failure => {
    const f = await batchBoxes();
    const [first, ...later] = [...f.indexer.boxesV2.values()];
    const entry = requiredV2(first);
    const state = requiredV2(entry.states.at(-1));
    entry.states[entry.states.length - 1] = { ...state, supply: state.supply + 1n };
    const states = entry.states;
    const header = f.reader.headerByNumber.bind(f.reader);
    let repairHeaders = 0;
    vi.spyOn(f.reader, 'headerByNumber').mockImplementation(async number => {
      if (entry.repairing && ++repairHeaders === 2) {
        if (failure === 'rejected') throw new Error('repair header unavailable');
        const fork = f.world.fork(99n, 'repair-anchor-reorg'); fork.to(103n);
        f.chain.setBranch(fork.headers.filter(h => h.number > 99n), []);
      }
      return header(number);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(f.indexer.audit()).rejects.toThrow(failure === 'rejected' ? 'repair header unavailable' : 'v2 repair head changed');
      expect(repairHeaders).toBe(2);
      expect(entry.states).toBe(states);
      expect(entry.repairing).toBe(false);
      expect(entry.audit?.ok).toBe(false);
      for (const other of later) {
        expect(other.audit).toBeNull();
        expect(other.verified).toBeNull();
      }
    } finally { f.indexer.stop(); }
  },
);

it.each(['initial', 'v1-recheck'] as const)(
  'BATCH-AF1: mixed v1/v2 staged verdicts respect the latest grouped header (%s)', async point => {
    const f = await batchBoxes(true);
    const entry = requiredV2([...f.indexer.boxes.values()][0]);
    const head = requiredV2(f.indexer.head() ?? undefined);
    const replace = () => {
      const fork = f.world.fork(99n, 'mixed-audit-reorg'); fork.to(103n);
      f.chain.setBranch(fork.headers.filter(h => h.number > 99n), []);
    };
    const call = f.chain.callAt.bind(f.chain);
    f.chain.callAt = async (to, data, hash) => {
      if (point === 'initial') replace();
      if (point === 'v1-recheck' && to.toLowerCase() === entry.row.contracts.token?.toLowerCase()
        && data === encodeFunctionData({ abi: boxTokenAbi, functionName: 'totalSupply' })) {
        return encodeFunctionResult({ abi: boxTokenAbi, functionName: 'totalSupply', result: requiredV2(entry.states.at(-1)).supply + 1n });
      }
      return call(to, data, hash);
    };
    const repairBox = f.indexer.repairBox.bind(f.indexer);
    const repair = vi.spyOn(f.indexer, 'repairBox').mockImplementation(async target => {
      await repairBox(target);
      replace();
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await f.indexer.audit()).map(r => r.result.ok)).toEqual(point === 'initial' ? [] : [false]);
      expect(repair).toHaveBeenCalledTimes(point === 'initial' ? 0 : 1);
      expect(f.indexer.head()?.hash).toBe(head.hash);
      expect(f.chain.header(head.number).hash).not.toBe(head.hash);
      for (const other of f.indexer.boxesV2.values()) {
        expect(other.audit).toBeNull();
        expect(other.verified).toBeNull();
      }
      if (point === 'initial') expect(entry.audit).toBeNull();
    } finally { f.indexer.stop(); }
  },
);
