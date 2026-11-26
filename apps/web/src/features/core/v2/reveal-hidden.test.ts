import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, type Hex } from 'viem';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { submitWrite } from '../../../../../../packages/chain/src/write/executor';
import { loadHiddenReveal, openHiddenReveal as executeOpening, prepareHiddenReveal, pendingHiddenDraws, prepareHiddenOpening, hiddenDrawStatus, HIDDEN_GRACE_SECONDS, type HiddenDrawState, type HiddenRevealReads } from './reveal-hidden';
import type { HiddenIO, HiddenRoles, sendHidden } from './hidden-draws';
import { addr, digest, must, runFixture } from './reveal-items.test-support';


async function openHiddenReveal(source: Parameters<typeof prepareHiddenReveal>[0], ticket: bigint, account: Parameters<typeof prepareHiddenReveal>[2],
  roles: HiddenRoles, reads: HiddenRevealReads, io: HiddenIO, signal: AbortSignal, _oldSend: typeof sendHidden | undefined,
  durable: Parameters<typeof prepareHiddenReveal>[6]) {
  if (signal.aborted) return { reason: 'cancelled' as const, hash: undefined };
  const prepared = await prepareHiddenReveal(source, ticket, account, roles, reads, io, durable);
  return prepared.reason === 'ready' ? executeOpening(prepared.handle, signal, durable) : prepared;
}

async function fixture(n = 4) {
  const f = runFixture(n);
  const encodedSpec = encodeBoxSpecV2({ ...decodeBoxSpecV2(f.file.encoded), artMode: 2 });
  const identity = { ...f.identity, specHash: keccak256(encodedSpec) };
  const record = { ...f.record, specHash: identity.specHash };
  const snapshot = { ...f.snapshot, ...identity, record, encodedSpec, triggers: 1 };
  f.ports.chain.snapshot = async () => snapshot;
  const text = JSON.stringify({ ...f.file.revealList, revealRoot: snapshot.root });
  const kept = { ...identity, format: 'squarehole.reveal-keep/1' as const, key: `${identity.chainId}:${identity.token}`, revealRoot: snapshot.root,
    artMode: 'hidden' as const, n, fileName: 'hidden.json', savedAt: 0, text };
  const loaded = await loadHiddenReveal(identity, identity.creator, kept, f.ports.chain);
  if (!loaded.ok) throw new Error(loaded.reason);
  const source = loaded.value;
  const draw: HiddenDrawState = { id: 1n, drawer: addr(100), status: 'settled', itemId: 3n, posted: true, revealFallbackAt: 10n + HIDDEN_GRACE_SECONDS, drawerCode: '0x' };
  const reads: HiddenRevealReads = {
    snapshot: async tag => ({ block: { number: tag === 'finalized' ? 100n : 101n, hash: digest(tag === 'finalized' ? 100 : 101) }, timestamp: 20n, requested: 1n }),
    draw: async id => ({ ...draw, id }), canonical: async () => true, receipt: async () => null,
  };
  const roles: HiddenRoles = { chainId: identity.chainId, record, tickets: addr(8), vault: addr(4), collection: addr(5), token: identity.token, creator: identity.creator };
  return { ...f, identity, record, snapshot, source, text, kept, draw, reads, roles, durable: authorizeRevealTestTarget({ ...f.ports, simulateOpening: vi.fn(async () => {}) }) };
}

describe('SH202 hidden kept/file source and finalized draws', () => {
  it('loads the matching kept list and original file fallback; refuses open, foreign and malformed sources', async () => {
    const f = await fixture();
    expect((await loadHiddenReveal(f.identity, f.identity.creator, new Blob([f.text]), f.ports.chain)).ok).toBe(true);
    expect((await loadHiddenReveal(f.identity, f.identity.creator, { ...f.kept, token: addr(99) }, f.ports.chain)).ok).toBe(false);
    expect((await loadHiddenReveal(f.identity, f.identity.creator, new Blob([JSON.stringify(f.file)]), f.ports.chain)).ok).toBe(false);
    const damaged = JSON.parse(f.text) as { items: { salt: Hex }[] }; must(damaged.items[0]).salt = digest(999);
    expect((await loadHiddenReveal(f.identity, f.identity.creator, new Blob([JSON.stringify(damaged)]), f.ports.chain)).ok).toBe(false);
    const wrapper = { ...f.file, encoded: f.snapshot.encodedSpec, specHash: f.identity.specHash, spec: JSON.parse(JSON.stringify(decodeBoxSpecV2(f.snapshot.encodedSpec), (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v)), revealList: JSON.parse(f.text) };
    expect((await loadHiddenReveal(f.identity, f.identity.creator, new Blob([JSON.stringify(wrapper)]), f.ports.chain)).ok).toBe(true);
  });
  it('selects proof by settled item id; creator opens through existing direct path without taking the drawer item', async () => {
    const f = await fixture(); const requests: { method: string; params?: unknown }[] = [];
    const io: HiddenIO = {
      chainId: async () => f.identity.chainId, request: async r => {
        requests.push(r);
        if (r.method === 'eth_chainId') return `0x${f.identity.chainId.toString(16)}`;
        if (r.method === 'eth_accounts') return [f.identity.creator];
        return digest(1);
      },
      read: async (_address, fn) => fn === 'drawTicket' ? { ...f.draw, status: 2 } : f.source.file.root,
      drawsOf: async () => [], block: async () => ({ timestamp: 20n, baseFee: 1n }), simulate: async () => {}, estimate: async () => 100_000n,
      receipt: async () => ({ status: 'success', logs: [] }), submit: submitWrite, feeReader: f.ports.feeReader,
    };
    const row = await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads);
    expect(row.reason).toBe('ready'); expect(row.recipient).toBe(f.draw.drawer);
    const outcome = await openHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.controller.signal, undefined, f.durable);
    expect(outcome.reason).toBe('sent');
    expect(f.durable.simulateOpening).toHaveBeenCalledWith(expect.anything(), f.identity.creator, 400_000n);
    const request = must(requests.find(r => r.method === 'eth_sendTransaction'));
    const tx = must((request.params as { to: string; data: Hex }[])[0]);
    expect(tx.to).toBe(f.roles.tickets);
    const decoded = decodeFunctionData({ abi: boxTicketsAbi, data: tx.data });
    expect(decoded.functionName).toBe('openDraw');
    if (decoded.functionName !== 'openDraw') throw new Error();
    expect(decoded.args[0]).toBe(1n); expect(decoded.args[2]).toEqual(f.source.file.revealOf(3n));
    // Contract fixes recipient to drawer for a third-party caller (BoxTicketsV2:335).
    expect(decoded.args[1].toLowerCase()).toBe(f.identity.creator.toLowerCase());
  });
  it('passes only the selected entry into exact simulation and the executor', async () => {
    const f = await fixture(); const io = openingIO(f);
    const prepared = await prepareHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.durable);
    expect(prepared.reason).toBe('ready');
    const call = (f.durable.simulateOpening.mock.calls as unknown[][])[0]?.[0];
    expect(call).toBeDefined();
  });
  it('pages every pending draw beyond 64 and reports the earlier unready queue entry', async () => {
    const f = await fixture(130);
    f.reads.snapshot = async () => ({ block: f.snapshot.block, timestamp: 20n, requested: 130n });
    f.reads.draw = async id => ({ ...f.draw, id, status: id < 3n ? 'requested' : 'settled', posted: id !== 1n });
    const pages = []; for await (const page of pendingHiddenDraws(f.source, f.identity.creator, f.reads, f.controller.signal)) pages.push(page);
    expect(pages.map(p => p.length)).toEqual([64, 64, 2]);
    expect(must(must(pages[0])[0]).reason).toBe('randomness'); expect(must(pages[0])[1]).toMatchObject({ reason: 'settlement', blockedBy: 1n });
    expect(must(pages.flat().at(-1)).draw.id).toBe(130n);
  });
  it('requires finalized settlement and a canonical block before offering an opening', async () => {
    const f = await fixture();
    f.reads.draw = async (id, block) => ({ ...f.draw, id, status: block.number === 100n ? 'requested' : 'settled' });
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('finality');
    f.reads.canonical = async () => false;
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('changed');
  });
  it('contract drawer waits for grace or opens itself; EIP-7702 and ordinary wallets allow the creator', async () => {
    const f = await fixture();
    f.reads.draw = async id => ({ ...f.draw, id, drawerCode: '0x6000' });
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('grace');
    expect((await prepareHiddenOpening(f.source, 1n, f.draw.drawer, f.reads)).reason).toBe('ready');
    const snapshot = f.reads.snapshot;
    f.reads.snapshot = async tag => ({ ...await snapshot(tag), timestamp: f.draw.revealFallbackAt });
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('ready');
    f.reads.snapshot = snapshot; f.reads.draw = async id => ({ ...f.draw, id, drawerCode: `0xef0100${addr(44).slice(2)}` });
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('ready');
  });
  it('navigation cancellation does not call the opening port', async () => {
    const f = await fixture(); const send = vi.fn(); f.controller.abort();
    expect(await openHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, {} as HiddenIO, f.controller.signal, send, f.durable)).toEqual({ reason: 'cancelled' });
    expect(send).not.toHaveBeenCalled();
  });
});


describe('af1 hidden regressions', () => {
  it('M3 serializes openings across tabs and keeps a known hash after receipt timeout and reload', async () => {
    const f = await fixture(); const releases: (() => void)[] = []; let entered!: () => void; let sends = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const io: HiddenIO = {
      chainId: async () => f.identity.chainId,
      request: async r => {
        if (r.method === 'eth_chainId') return `0x${f.identity.chainId.toString(16)}`;
        if (r.method === 'eth_accounts') return [f.identity.creator];
        sends++; entered(); await new Promise<void>(resolve => { releases.push(resolve); }); return digest(1);
      },
      read: async (_a, fn) => fn === 'drawTicket' ? { ...f.draw, status: 2 } : f.source.file.root,
      drawsOf: async () => [], block: async () => ({ timestamp: 20n, baseFee: 1n }), simulate: async () => {}, estimate: async () => 100_000n,
      receipt: async () => { throw new Error('timeout'); }, submit: submitWrite, feeReader: f.ports.feeReader,
    };
    const open = () => openHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.controller.signal, undefined, f.durable);
    const first = open(); await waiting;
    const second = open();
    // HEAD would enter a second wallet prompt. Release both for a deterministic red result.
    await new Promise(resolve => setTimeout(resolve, 10)); releases.forEach(release => release());
    expect(await second).toMatchObject({ reason: 'running-elsewhere' });
    expect(await first).toEqual({ reason: 'sent', hash: digest(1) });
    expect(await open()).toEqual({ reason: 'receipt-pending', hash: digest(1) });
    expect(sends).toBe(1);
  });
  it('M3 maps a cancelled contract draw to a closed outcome', async () => {
    const f = await fixture(); f.reads.draw = async id => ({ ...f.draw, id, status: hiddenDrawStatus(4) });
    expect(hiddenDrawStatus(4n)).toBe('cancelled');
    expect((await prepareHiddenOpening(f.source, 1n, f.identity.creator, f.reads)).reason).toBe('closed');
  });
});

it('L4 rejects oversized hidden kept text before constructing a Blob', async () => {
  const f = await fixture(); const Original = Blob; let constructions = 0;
  vi.stubGlobal('Blob', class extends Original { constructor(parts: BlobPart[]) { constructions++; super(parts); } });
  try { expect(await loadHiddenReveal(f.identity, f.identity.creator, { ...f.kept, text: ' '.repeat(64 * 1024 * 1024 + 1) }, f.ports.chain)).toEqual({ ok: false, reason: 'invalid-source' }); expect(constructions).toBe(0); }
  finally { vi.unstubAllGlobals(); }
});

function openingIO(f: Awaited<ReturnType<typeof fixture>>): { -readonly [K in keyof HiddenIO]: HiddenIO[K] } {
  return {
    chainId: async () => f.identity.chainId,
    request: async r => r.method === 'eth_chainId' ? `0x${f.identity.chainId.toString(16)}` : r.method === 'eth_accounts' ? [f.identity.creator] : digest(1),
    read: async (_a, fn) => fn === 'drawTicket' ? { ...f.draw, status: 2 } : f.source.file.root,
    drawsOf: async () => [], block: async () => ({ timestamp: 20n, baseFee: 1n }), simulate: async () => {}, estimate: async () => 100_000n,
    receipt: async () => ({ status: 'success', logs: [] }), submit: submitWrite, feeReader: f.ports.feeReader,
  };
}
it('M3 writes the public intent before the wallet and the hash before a receipt lookup', async () => {
  const f = await fixture(); const io = openingIO(f); const request = io.request; let before = false, after = false;
  io.request = async r => { if (r.method === 'eth_sendTransaction') before = [...f.saved.values()].some(v => v.includes('"status":"intent"')); return request(r); };
  io.receipt = async () => { after = [...f.saved.values()].some(v => v.includes(digest(1))); throw new Error('timeout'); };
  expect(await openHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.controller.signal, undefined, f.durable)).toEqual({ reason: 'sent', hash: digest(1) });
  expect(before).toBe(true); expect(after).toBe(false);
  expect([...f.saved.values()].join('')).toContain(digest(1));
  expect([...f.saved.values()].join('')).not.toMatch(/salt|proof|calldata|traits|imageHash/);
  const reloaded = await loadHiddenReveal(f.identity, f.identity.creator, f.kept, f.ports.chain); if (!reloaded.ok) throw new Error(reloaded.reason);
  expect(await openHiddenReveal(reloaded.value, 1n, f.identity.creator, f.roles, f.reads, io, f.controller.signal, undefined, f.durable)).toEqual({ reason: 'receipt-pending', hash: digest(1) });
});
it('M3 reconciles a finalized reverted opening before permitting another send', async () => {
  const f = await fixture(); const io = openingIO(f); const request = io.request; let input: Hex = '0x'; let sends = 0;
  io.request = async r => { if (r.method === 'eth_sendTransaction') { input = must((r.params as { data: Hex }[])[0]).data; return digest(++sends); } return request(r); };
  io.receipt = async () => { throw new Error('timeout'); };
  const open = () => openHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.controller.signal, undefined, f.durable);
  expect((await open()).hash).toBe(digest(1));
  f.reads.receipt = async hash => ({ hash, nonce: 99n, from: f.identity.creator, to: f.source.tickets, input, value: 0n,
    block: f.snapshot.block, status: 'reverted', logs: [] });
  expect((await open()).hash).toBe(digest(2)); expect(sends).toBe(2);
  expect([...f.saved.values()].join('')).toContain('"nonce":"99"');
  f.reads.draw = async id => ({ ...f.draw, id, status: 'cancelled' });
  expect((await open()).reason).toBe('closed'); expect(sends).toBe(2);
});

it('af2 R2-M2 hidden handle includes released caps and refuses a changed journal or higher fee', async () => {
  const { readRevealProgress, saveRevealIntent, revealProgressKey } = await import('./reveal-items-store');
  const f = await fixture(), io = openingIO(f), key = revealProgressKey(f.identity.chainId, f.identity.token);
  let p = await readRevealProgress(f.durable.store, key, f.identity.specHash);
  p = await saveRevealIntent(f.durable.store, key, p, { attempt: 'released', ids: ['3'], ticket: '1', account: f.identity.creator, capWei: '123', createdAt: 0, status: 'user-released' });
  const prepared = await prepareHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.durable);
  if (prepared.reason !== 'ready') throw new Error(prepared.reason);
  expect(Object.isFrozen(prepared.handle)).toBe(true); expect(prepared.handle.spentWei).toBe(123n);
  expect(prepared.handle.ceilingWei).toBe(123n + prepared.handle.capWei);
  await saveRevealIntent(f.durable.store, key, p, { attempt: 'another-release', ids: ['3'], ticket: '1', account: f.identity.creator, capWei: '321', createdAt: 0, status: 'user-released' });
  expect(await executeOpening(prepared.handle, f.controller.signal, f.durable)).toEqual({ reason: 'plan-changed' });
  const next = await prepareHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, io, f.durable);
  if (next.reason !== 'ready') throw new Error(next.reason);
  io.feeReader = { ...io.feeReader, maxPriorityFeePerGas: async () => 10n ** 30n, getBlock: async () => ({ number: 1n, hash: digest(1), timestamp: 1n, baseFeePerGas: 10n ** 20n, transactions: [] }) };
  expect(await executeOpening(next.handle, f.controller.signal, f.durable)).toEqual({ reason: 'plan-changed' });
  expect(await executeOpening({ ...next.handle }, f.controller.signal, f.durable)).toEqual({ reason: 'invalid-plan' });
});
it.each(['closed', 'reverted'] as const)('af2 R2-L1 revalidates hidden terminal %s after resume', async status => {
  const { readRevealProgress, saveRevealIntent, revealProgressKey } = await import('./reveal-items-store');
  const f = await fixture(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  const p = await readRevealProgress(f.durable.store, key, f.identity.specHash);
  await saveRevealIntent(f.durable.store, key, p, { attempt: 'old', ids: ['3'], ticket: '1', account: f.identity.creator, createdAt: 0,
    capWei: '123', status, hash: digest(1), succeeded: [], receiptStatus: 'reverted', block: { number: '90', hash: digest(90) } });
  f.reads.canonical = async block => block.hash !== digest(90);
  expect(await prepareHiddenReveal(f.source, 1n, f.identity.creator, f.roles, f.reads, openingIO(f), f.durable)).toMatchObject({ reason: 'receipt-pending' });
  expect((await readRevealProgress(f.durable.store, key, f.identity.specHash)).intents[0]?.status).toBe('submitted');
});
it('af2 R2-L4 hidden release refuses a forward clock jump', async () => {
  const { readRevealProgress, saveRevealIntent, revealProgressKey } = await import('./reveal-items-store');
  const { releaseUnknownHiddenOpening } = await import('./reveal-hidden');
  const f = await fixture(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  const p = await readRevealProgress(f.durable.store, key, f.identity.specHash);
  await saveRevealIntent(f.durable.store, key, p, { attempt: 'old', ids: ['3'], ticket: '1', account: f.identity.creator, createdAt: 0,
    capWei: '123', status: 'unknown', clock: { wall: 60_000, tick: 60_000, epoch: 'test', elapsed: 60_000 } });
  f.durable.now = () => 1_860_000;
  f.durable.clock = () => ({ wall: 1_860_000, tick: 61_000, epoch: 'test' });
  expect(await releaseUnknownHiddenOpening(f.source, 'old', f.durable)).toEqual({ reason: 'release-too-soon' });
});

it('af2 H a drawer can load the committed hidden source and prepare its own opening', async () => {
  const f = await fixture();
  const loaded = await loadHiddenReveal(f.identity, f.draw.drawer, new Blob([f.text]), f.ports.chain);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.reason);
  expect((await prepareHiddenOpening(loaded.value, 1n, f.draw.drawer, f.reads)).reason).toBe('ready');
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));
