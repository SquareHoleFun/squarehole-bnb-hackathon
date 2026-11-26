// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroHash, type Hex } from 'viem';
import { boxCollectionAbi, boxTicketsAbi } from '@squarehole/chain/abi';
import { registryV2Abi } from '../../../../../../packages/chain/src/core/v2/abi-v2';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { boundedRevealRequest, createRevealRPC, REVEAL_RPC_BYTES } from './reveal-rpc';
import type { RevealBox } from './reveal-rpc';
import type { V2Source } from './indexer-v2';
import type { Eip1193Request } from '../../../../../../packages/chain/src/write/eip1193';
import { installRevealTestSeam } from './reveal-test-seam.test-support';
import { addr, digest, must, runFixture } from './reveal-items.test-support';
import { createRevealSession, type RevealSessionOptions } from './reveal-session';
import { readRevealProgress, revealProgressKey, saveRevealIntent } from './reveal-items-store';
afterEach(() => vi.useRealTimers());
function fixture(hidden = false, n = 41) {
  const f = runFixture(n), calls: Parameters<Eip1193Request>[0][] = [];
  if (hidden) {
    const encodedSpec = encodeBoxSpecV2({ ...decodeBoxSpecV2(f.file.encoded), artMode: 2 });
    Object.assign(f.identity, { specHash: keccak256(encodedSpec) });
    Object.assign(f.record, { specHash: f.identity.specHash });
    Object.assign(f.snapshot, { specHash: f.identity.specHash, encodedSpec, triggers: 1 });
  }
  const release = { registry: { address: f.identity.registry, codeHash: keccak256('0x6000') } };
  const rpc = { rpc: 'http://localhost:8552', manifest: { chainId: f.identity.chainId, releases: [release] } } as unknown as Pick<V2Source, 'manifest' | 'rpc'>;
  const box = { record: f.record, spec: decodeBoxSpecV2(f.snapshot.encodedSpec), release } as unknown as RevealBox;
  const block = { number: '0x64', hash: digest(100), timestamp: '0x99', baseFeePerGas: '0x10000000000000000', transactions: [] };
  const history = new Map<string, typeof block>();
  let wrong = false, chainId = f.identity.chainId, revealed = true, balance = 0x100000000000000000000n;
  let intercept: (r: Parameters<Eip1193Request>[0]) => Promise<void> = async () => {};
  const answers: { owner: 'read' | 'wallet'; method: string; value?: unknown }[] = [];
  const request: Eip1193Request = async r => {
    calls.push(r); await intercept(r); const params = r.params as readonly unknown[];
    if (r.method === 'eth_chainId') return toHex(chainId);
    if (r.method === 'eth_getBlockByNumber') return history.get(String(params[0])) ?? block;
    if (r.method === 'eth_getCode') return '0x6000';
    if (r.method === 'eth_getBalance') return toHex(balance);
    if (r.method === 'eth_feeHistory') return { reward: [['0x10000000000000000']] };
    if (r.method === 'eth_getTransactionCount') return '0x63';
    if (r.method === 'eth_estimateGas') return '0x493e0';
    if (r.method === 'eth_getTransactionByHash') return { hash: digest(1), from: f.identity.creator, to: addr(5), nonce: '0x63', input: wrong ? '0x1234' : '0x12345678',
      value: '0x0', gas: '0x493e0', blockNumber: '0x64', blockHash: digest(100) };
    if (r.method === 'eth_getTransactionReceipt') return { transactionHash: digest(1), from: f.identity.creator, to: addr(5), blockNumber: '0x64', blockHash: digest(100), status: '0x1', gasUsed: '0x111', logs: [] };
    if (r.method === 'eth_call') {
      const tx = params[0] as { to: string; data: Hex; gas?: string };
      if (tx.to.toLowerCase() === addr(90).toLowerCase()) return encodeFunctionResult({ abi: registryV2Abi, functionName: 'recordOf', result: f.record } as never);
      if (tx.to.toLowerCase() === addr(8).toLowerCase()) {
        const d = decodeFunctionData({ abi: boxTicketsAbi, data: tx.data });
        if (d.functionName === 'openDraw') return '0x';
        const result = d.functionName === 'status' ? { minted: 0, slots: 41, wordRequestedAt: 0, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 2, drawsSettled: 2 }
          : { drawer: addr(50), status: 2, requestedAt: 1n, itemId: 3n, revealFallbackAt: 100n };
        return encodeFunctionResult({ abi: boxTicketsAbi, functionName: d.functionName, result } as never);
      }
      if (tx.to.toLowerCase().startsWith('0xca11')) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: decoded.args[0].map(() => ({ success: true, returnData:
          encodeFunctionResult({ abi: boxCollectionAbi, functionName: 'traitsOf', result: [revealed, 0n, zeroHash, zeroHash] }) })) });
      }
      const d = decodeFunctionData({ abi: boxCollectionAbi, data: tx.data });
      const values: Record<string, unknown> = { revealRoot: f.snapshot.root, collectionSize: BigInt(n), firstId: 1n, revealTriggers: f.snapshot.triggers };
      return encodeFunctionResult({ abi: boxCollectionAbi, functionName: d.functionName, result: values[d.functionName] } as never);
    }
    throw new Error(`unexpected-${r.method}`);
  };
  installRevealTestSeam(rpc, { rpc: async r => { const value = await request(r); answers.push({ owner: 'read', method: r.method, value }); return value; } });
  return { f, rpc, box, calls, block, history, answers, set intercept(v: typeof intercept) { intercept = v; }, advance: () => { history.set(block.number, { ...block }); block.number = '0x65'; block.hash = digest(101); },
    adapter: createRevealRPC(rpc, box), set wrong(v: boolean) { wrong = v; }, set chainId(v: number) { chainId = v; },
    set revealed(v: boolean) { revealed = v; }, set balance(v: bigint) { balance = v; } };
}
it('af2 A pins identity, bulk state, code, fees, balance and exact-gas simulation', async () => {
  const f = fixture();
  await f.adapter.chain.snapshot(f.adapter.identity, 'finalized');
  expect(await f.adapter.chain.revealed(addr(5), Array.from({ length: 41 }, (_, n) => BigInt(n + 1)), { number: 100n, hash: digest(100) })).toHaveLength(41);
  const batch = must((await f.f.plan()).batches[0]).batch; const data = batch.data;
  const result = await f.adapter.simulate({ to: batch.to, data, value: 0n }, f.f.identity.creator, 600_000n);
  expect(result).toMatch(/^0x/);
  await f.adapter.estimate({ to: addr(5), data, value: 0n }, f.f.identity.creator);
  expect(await f.adapter.feeReader.getBalance(addr(50), 'latest')).toBe(0x100000000000000000000n);
  expect(await f.adapter.feeReader.maxPriorityFeePerGas()).toBe(0x10000000000000000n);
  for (const call of f.calls.filter(c => ['eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getBalance'].includes(c.method))) {
    expect((call.params as unknown[])[1]).toEqual({ blockHash: digest(100), requireCanonical: true });
  }
  expect(f.calls.some(c => c.method === 'eth_call' && ((c.params as Record<string, unknown>[])[0]?.gas === '0x927c0'))).toBe(true);
  const bulk = f.calls.filter(c => c.method === 'eth_call' && String((c.params as { to: string }[])[0]?.to).toLowerCase().startsWith('0xca11') && !(c.params as { gas?: string }[])[0]?.gas);
  expect(bulk).toHaveLength(2);
});
it('af2 A receipt fields come from the actual transaction by hash', async () => {
  const f = fixture();
  expect(await f.adapter.chain.receipt(digest(1))).toMatchObject({ nonce: 99n, input: '0x12345678', from: f.f.identity.creator, block: { number: 100n, hash: digest(100) } });
  f.wrong = true; expect((await f.adapter.chain.receipt(digest(1)))?.input).toBe('0x1234');
  expect(f.calls.filter(c => c.method === 'eth_getTransactionByHash')).toHaveLength(2);
});
it('af2 A bounds response bytes before parsing', async () => {
  let cancelled = false;
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(REVEAL_RPC_BYTES + 1)); }, cancel() { cancelled = true; } })));
  await expect(boundedRevealRequest('http://localhost:8552', fetcher)({ method: 'eth_chainId' })).rejects.toThrow(); expect(cancelled).toBe(true);
});
it('af2 A bounds an endless RPC body by deadline', async () => {
  vi.useFakeTimers(); let cancelled = false;
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } })));
  const result = boundedRevealRequest('http://localhost:8552', fetcher)({ method: 'eth_chainId' }).catch(() => 'refused');
  await vi.advanceTimersByTimeAsync(15_001); expect(await result).toBe('refused'); expect(cancelled).toBe(true);
});

it('af2 A hidden heads and draw fields use exact blocks and bigint counts', async () => {
  const f = fixture();
  expect(await f.adapter.hidden.snapshot('finalized')).toMatchObject({ requested: 2n, block: { number: 100n, hash: digest(100) } });
  expect(await f.adapter.hidden.draw(1n, { number: 100n, hash: digest(100) })).toMatchObject({ id: 1n, itemId: 3n, status: 'settled', drawerCode: '0x6000' });
  for (const call of f.calls.filter(c => ['eth_call', 'eth_getCode'].includes(c.method))) expect((call.params as unknown[])[1]).toEqual({ blockHash: digest(100), requireCanonical: true });
});

it('af3 idle session polls use two RPC requests and cache immutable identity until finality loses ancestry', async () => {
  vi.useFakeTimers(); const f = fixture();
  const options: RevealSessionOptions = { chainId: f.f.identity.chainId, box: f.box, account: f.f.identity.creator, rpc: f.rpc,
    wallet: { signer: null, onAccountsChanged: () => () => {}, onChainChanged: () => () => {} },
    file: new Blob([JSON.stringify(f.f.file)]), signal: f.f.controller.signal };
  installRevealTestSeam(options, { session: { adapter: f.adapter, store: f.f.ports.store, lock: f.f.ports.lock,
    clock: f.f.ports.clock, press: () => false } });
  const s = createRevealSession(options);
  try {
    await s.ready; expect(s.getState().source).toBe('ready');
    expect(f.calls.filter(c => c.method === 'eth_chainId')).toHaveLength(1);
    for (let poll = 0; poll < 3; poll++) {
      f.calls.length = 0; await vi.advanceTimersByTimeAsync(5_000);
      expect(f.calls.map(c => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getBlockByNumber']);
      expect(f.calls.map(c => (c.params as unknown[])[0]).sort()).toEqual(['finalized', 'latest']);
    }
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
      { attempt: 'other-tab', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '100', status: 'submitted', hash: digest(1) });
    f.calls.length = 0; await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls.map(c => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getBlockByNumber']);
    expect(s.getState().unresolved[0]?.hash).toBe(digest(1));
    f.calls.length = 0; f.advance(); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls.some(c => c.method === 'eth_chainId' || c.method === 'eth_getCode')).toBe(false);
    // A different hash at the same finalized height invalidates the identity anchor.
    f.calls.length = 0; f.block.hash = digest(999); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls.filter(c => c.method === 'eth_chainId')).toHaveLength(1);
    expect(f.calls.some(c => c.method === 'eth_getCode')).toBe(true);
  } finally { s.dispose(); }
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

it.each(['open', 'hidden'] as const)('af4 R4-M1 %s preparation refuses a switched RPC and invalidates its prior approval', async mode => {
  const { f, s, prepare, wallet } = await switchedEndpointSession(mode);
  try {
    const prior = await prepare();
    f.chainId = 1; f.advance(); f.calls.length = 0;
    // The old finalized block remains canonical on both endpoints. Only the chain ID changes.
    expect(await f.adapter.canonical({ number: 100n, hash: digest(100) })).toBe(true);
    await expect(prepare()).rejects.toThrow('read-chain-changed');
    expect(s.getState()).toMatchObject({ reason: 'read-chain-changed' });
    expect(s.getState().plan).toBeUndefined(); expect(s.getState().opening).toBeUndefined();
    expect(wallet).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.method === 'eth_chainId')).toHaveLength(1);
    f.chainId = f.f.identity.chainId;
    await expect(mode === 'open' ? s.start(prior as Awaited<ReturnType<typeof s.prepare>>) : s.open(prior as Awaited<ReturnType<typeof s.prepareOpening>>)).rejects.toThrow('invalid-plan');
    expect(wallet).not.toHaveBeenCalled();
  } finally { s.dispose(); }
});

it.each(['open', 'hidden'] as const)('af4 R4-M1 %s send preflight refuses a switched RPC with the same canonical ancestor', async mode => {
  const { f, s, prepare, wallet } = await switchedEndpointSession(mode);
  try {
    f.calls.length = 0; const approval = await prepare();
    const prepareChainRequests = f.calls.filter(c => c.method === 'eth_chainId').length;
    expect(f.calls.some(c => c.method === 'eth_getCode' && (c.params as unknown[])[0] !== f.f.identity.creator)).toBe(false);
    f.chainId = 1; f.advance(); f.calls.length = 0;
    const result = mode === 'open' ? await s.start(approval as Awaited<ReturnType<typeof s.prepare>>) : await s.open(approval as Awaited<ReturnType<typeof s.prepareOpening>>);
    expect(wallet.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(0);
    expect(result.reason).toBe('read-chain-changed');
    expect(prepareChainRequests).toBe(1);
    expect(s.getState().plan).toBeUndefined(); expect(s.getState().opening).toBeUndefined();
    expect(f.calls.filter(c => c.method === 'eth_chainId')).toHaveLength(1);
    f.chainId = f.f.identity.chainId;
    await expect(mode === 'open' ? s.start(approval as Awaited<ReturnType<typeof s.prepare>>) : s.open(approval as Awaited<ReturnType<typeof s.prepareOpening>>)).rejects.toThrow('invalid-plan');
    const next = await prepare(); f.calls.length = 0; wallet.mockClear();
    if (mode === 'open') await s.start(next as Awaited<ReturnType<typeof s.prepare>>);
    else await s.open(next as Awaited<ReturnType<typeof s.prepareOpening>>);
    expect(wallet.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'eth_chainId')).toHaveLength(2);
    expect(f.calls.some(c => c.method === 'eth_getCode' && (c.params as unknown[])[0] !== f.f.identity.creator)).toBe(false);
  } finally { s.dispose(); }
});

async function switchedEndpointSession(mode: 'open' | 'hidden') {
  const f = fixture(mode === 'hidden'); f.revealed = false; f.balance = 10n ** 30n;
  const wallet = vi.fn<Eip1193Request>(async request => {
    if (request.method === 'eth_chainId') return toHex(f.f.identity.chainId);
    if (request.method === 'eth_accounts') return [f.f.identity.creator];
    throw Object.assign(new Error('rejected'), { code: 4001 });
  });
  const options: RevealSessionOptions = { chainId: f.f.identity.chainId, box: f.box, account: f.f.identity.creator, rpc: f.rpc,
    wallet: { signer: { request: wallet, walletName: 'test' }, onAccountsChanged: () => () => {}, onChainChanged: () => () => {} },
    file: new Blob([JSON.stringify(mode === 'hidden' ? { ...f.f.file.revealList, revealRoot: f.f.snapshot.root } : f.f.file)]), signal: f.f.controller.signal };
  installRevealTestSeam(options, { session: { adapter: f.adapter, store: f.f.ports.store, lock: f.f.ports.lock,
    clock: f.f.ports.clock, press: () => true, poll: false } });
  const s = createRevealSession(options); await s.ready; expect(s.getState().source).toBe('ready');
  return { f, s, wallet, prepare: () => mode === 'open' ? s.prepare() : s.prepareOpening(1n) };
}


it.each([
  ['open', 'fee'], ['open', 'estimate'], ['open', 'simulation'], ['open', 'nonce'], ['open', 'balance'],
  ['hidden', 'fee'], ['hidden', 'simulation'], ['hidden', 'balance'], ['hidden', 'last-draw'],
] as const)('af5 M1 %s refuses a persistent switch during %s before intent or wallet send', async (mode, boundary) => {
  const { f, s, prepare, wallet } = await switchedEndpointSession(mode);
  try {
    const approval = await prepare(); let draws = 0, switched = false;
    f.intercept = async r => {
      const tx = (r.params as { data?: Hex; gas?: Hex }[] | undefined)?.[0];
      const draw = r.method === 'eth_call' && tx?.data?.startsWith('0x')
        && tx.data.slice(0, 10) === '0x' + keccak256(new TextEncoder().encode('drawTicket(uint256)')).slice(2, 10);
      if (draw) draws++;
      if (boundary === 'fee' && r.method === 'eth_feeHistory'
        || boundary === 'estimate' && r.method === 'eth_estimateGas'
        || boundary === 'simulation' && r.method === 'eth_call' && tx?.gas
        || boundary === 'nonce' && r.method === 'eth_getTransactionCount'
        || boundary === 'balance' && r.method === 'eth_getBalance'
        || boundary === 'last-draw' && draw && draws === 4) { f.chainId = 1; switched = true; }
    };
    const result = mode === 'open' ? await s.start(approval as Awaited<ReturnType<typeof s.prepare>>)
      : await s.open(approval as Awaited<ReturnType<typeof s.prepareOpening>>);
    expect(switched).toBe(true);
    expect(wallet.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(0);
    expect(result.reason).toBe('read-chain-changed');
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    expect((await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash)).intents).toEqual([]);
    expect(s.getState().plan).toBeUndefined(); expect(s.getState().opening).toBeUndefined();
    f.chainId = f.f.identity.chainId;
    await expect(mode === 'open' ? s.start(approval as Awaited<ReturnType<typeof s.prepare>>)
      : s.open(approval as Awaited<ReturnType<typeof s.prepareOpening>>)).rejects.toThrow('invalid-plan');
  } finally { s.dispose(); }
});

it.each(['open', 'hidden'] as const)('af5 M1 %s every wallet send immediately follows the read chain answer', async mode => {
  const { f, s, prepare, wallet } = await switchedEndpointSession(mode);
  const predecessors: unknown[] = [];
  wallet.mockImplementation(async request => {
    if (request.method === 'eth_sendTransaction') {
      predecessors.push(f.answers.at(-1));
      expect(await s.exportJournal()).toContain('"status":"intent"');
    }
    f.answers.push({ owner: 'wallet', method: request.method });
    if (request.method === 'eth_chainId') return toHex(f.f.identity.chainId);
    if (request.method === 'eth_accounts') return [f.f.identity.creator];
    throw Object.assign(new Error('rejected'), { code: 4001 });
  });
  try {
    const approval = await prepare();
    if (mode === 'open') await s.start(approval as Awaited<ReturnType<typeof s.prepare>>);
    else await s.open(approval as Awaited<ReturnType<typeof s.prepareOpening>>);
    expect(predecessors).toEqual([{ owner: 'read', method: 'eth_chainId', value: toHex(f.f.identity.chainId) }]);
  } finally { s.dispose(); }
});

it('af5 L2 ten minutes of failing 10000-item refresh uses 6565 requests and bounded retries', async () => {
  vi.useFakeTimers(); const f = fixture(false, 10_000); f.revealed = false;
  const latest = { ...f.block, number: '0x65', hash: digest(101) };
  f.history.set('latest', latest); f.history.set('0x65', latest);
  const options: RevealSessionOptions = { chainId: f.f.identity.chainId, box: f.box, account: f.f.identity.creator, rpc: f.rpc,
    wallet: { signer: null, onAccountsChanged: () => () => {}, onChainChanged: () => () => {} },
    file: new Blob([JSON.stringify(f.f.file)]), signal: f.f.controller.signal };
  installRevealTestSeam(options, { session: { adapter: f.adapter, store: { ...f.f.ports.store }, lock: f.f.ports.lock,
    clock: f.f.ports.clock, press: () => false } });
  const s = createRevealSession(options);
  try {
    await s.ready;
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
      { attempt: 'revision', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '0', status: 'refused' });
    // Force reconciliation without invalidating the warm deployment anchor.
    const next = { ...latest, number: '0x66', hash: digest(102) };
    f.history.set('latest', next); f.history.set('0x66', next);
    const attempts: number[] = []; const start = Date.now(); let chunks = 0;
    f.intercept = async r => {
      if (r.method !== 'eth_call') return;
      const [tx, at] = r.params as [{ to: string; data: Hex }, { blockHash: Hex }];
      if (!tx.to.toLowerCase().startsWith('0xca11') || at.blockHash !== digest(100)) return;
      if (++chunks % 250 === 1) attempts.push(Date.now() - start);
      if (chunks % 250 === 0) throw new Error('permanent-finalized-chunk-250');
    };
    f.calls.length = 0;
    // Stop at the first old-cadence retry on HEAD rather than repeating 120 expensive scans.
    for (const duration of [5_000, 5_000, 10_000, 20_000, 40_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(duration);
      expect(attempts).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 140_000].slice(0, attempts.length));
    }
    await vi.advanceTimersByTimeAsync(460_000);
    expect(attempts).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 140_000, 200_000, 260_000, 320_000, 380_000, 440_000, 500_000, 560_000]);
    expect(f.calls).toHaveLength(6_565);
    expect(s.getState().reason).toBe('read-failed');
  } finally { s.dispose(); }
}, shLimit(300_000));
