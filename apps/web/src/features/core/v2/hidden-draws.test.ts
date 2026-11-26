/**
 * TA-50: hidden draws' reads, rows and sends. Every send goes through the shared builders and `submitWrite` (the real
 * guard) to a recording wallet: the exact target, the finite approval, the draw's exact bounty, the open's proof.
 */
import { drawLimitFor, drawValueFor } from '@squarehole/chain';
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { submitWrite } from '@squarehole/chain/write';
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, erc20Abi, getAddress, http, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_V2 } from '../../../../../../packages/chain/src/core/roles';
import { vaultV2Abi, type BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2';
import { buildSpec, revealFile } from '../../create/create-model';
import { formOf, inputOf } from '../../create/test-support/fixtures';
import { DRAW, PHASE } from '../box0/box0-model';
import { createHiddenOpeningSession, drawOpen, drawRows, hiddenIO, hiddenRolesOf, prepareDrawV2, readHiddenDraws, RECENT_DRAWS, sendHidden, type HiddenDraw, type HiddenIO, type HiddenReads, type HiddenRoles } from './hidden-draws';
import { parseRevealFile, type RevealFile } from './reveal-file';
import { rpcFetch } from './test-support/rpc-fetch';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2/record-v2';
import { digest, runFixture } from './reveal-items.test-support';
import { installRevealTestSeam } from './reveal-test-seam.test-support';
import type { createRevealRPC } from './reveal-rpc';
import type { HiddenDrawState } from './reveal-hidden';
import type { RevealSessionOptions } from './reveal-session';

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

/**
 * SH-203: a hidden box's reveal session (the page's opener) on the reveal tests' synthetic chain: the real session,
 * engine and executor; only the RPC adapter, the store, the lock, the clock and the press are the session's test seam,
 * and the wallet records every send. `press()` grants the next action, as one trusted click does.
 */
async function openingSession(start: Pick<HiddenDrawState, 'status' | 'itemId'>) {
  const f = runFixture(4);
  const encodedSpec = encodeBoxSpecV2({ ...decodeBoxSpecV2(f.file.encoded), artMode: 2 });
  Object.assign(f.identity, { specHash: keccak256(encodedSpec) });
  Object.assign(f.record, { specHash: f.identity.specHash });
  Object.assign(f.snapshot, { specHash: f.identity.specHash, encodedSpec, triggers: 1 });
  const text = JSON.stringify({ ...f.file.revealList, revealRoot: f.snapshot.root });
  const draw: { -readonly [K in keyof HiddenDrawState]: HiddenDrawState[K] } = { id: 1n, drawer: f.identity.creator, posted: true, drawerCode: '0x', revealFallbackAt: 0n, ...start };
  const sent: { to?: string; data?: string; value?: string }[] = [];
  const signer = { walletName: 'test', request: (async (request: { method: string; params?: unknown }) => {
    if (request.method === 'eth_accounts') return [f.identity.creator];
    if (request.method === 'eth_chainId') return toHex(f.identity.chainId);
    if (request.method === 'eth_sendTransaction') { sent.push((request.params as Record<string, string>[])[0] ?? {}); return digest(77); }
    throw new Error(`unexpected ${request.method}`);
  }) as never };
  const options = { chainId: f.identity.chainId, account: f.identity.creator, signal: f.controller.signal, rpc: {},
    wallet: { signer, onAccountsChanged: () => () => undefined, onChainChanged: () => () => undefined },
    box: { record: f.record, spec: decodeBoxSpecV2(encodedSpec), release: {} }, file: new Blob([text]) } as unknown as RevealSessionOptions;
  const adapter = { identity: f.identity, roles: rolesOfV2(f.record).contracts, chain: f.ports.chain, feeReader: f.ports.feeReader,
    estimate: async () => 100_000n, simulate: async () => '0x', canonical: f.ports.chain.canonical, transaction: async () => null,
    assetRead: async () => ({ block: f.snapshot.block, items: new Map() }),
    hidden: { snapshot: async () => ({ block: f.snapshot.block, requested: 2n, timestamp: 100n }), draw: async (id: bigint) => ({ ...draw, id }),
      canonical: async () => true, receipt: async () => null },
  } as unknown as ReturnType<typeof createRevealRPC>;
  let credit = false;
  installRevealTestSeam(options, { session: { adapter, store: f.ports.store, lock: f.ports.lock, clock: f.ports.clock, poll: false,
    press: () => { const granted = credit; credit = false; return granted; } } });
  const revealOf = (id: bigint) => parseRevealFile(text, f.snapshot.root, 4n).revealOf(id);
  return { session: createHiddenOpeningSession(options), sent, draw, revealOf, press: () => { credit = true; },
    creator: f.identity.creator, tickets: rolesOfV2(f.record).contracts.tickets as string };
}

afterEach(() => { vi.unstubAllGlobals(); });

const a = (n: bigint) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;
const CHAIN = 11155111;
const me = a(100n);
const creator = a(50n);
const other = a(101n);
// Synthetic wiring, never a recorded/deployed address fixture.
const record: BoxRecordV2 = {
  boxId: 1n, templateId: zeroHash, specHash: zeroHash, creator, pricingListingId: 0, q: zeroAddress,
  raise: 1n, poolManager: a(51n), poolId: zeroHash, creationBlock: 7n, openAt: 1n, randomness: a(52n),
  contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))), codeHashes: Array.from({ length: 24 }, () => zeroHash),
};
const at = (role: keyof typeof ROLE_V2) => record.contracts[ROLE_V2[role]] as Address;
const roles: HiddenRoles = (() => {
  const found = hiddenRolesOf(CHAIN, record, { tickets: at('tickets'), vault: at('vault'), collection: at('collection'), token: at('token') }, 2);
  if (!found) throw new Error('fixture');
  return found;
})();
const SOURCE = a(60n);

const input = inputOf({ form: formOf({ artMode: 'hidden' }) });
const commitment = input.commitment as NonNullable<typeof input.commitment>;
const file = parseRevealFile(revealFile(buildSpec(input), input.art as NonNullable<typeof input.art>, commitment).text, commitment.revealRoot, BigInt(commitment.n));

/**
 * Fix round 1 (F2): what the real viem client throws for `quoteTake`: the vault's own refusal (the node's revert with
 * its NoHiddenItem data, as a node answers), or a node it cannot reach.
 */
function quoteTakeVia(answer: 'revert' | 'offline'): Promise<unknown> {
  const fetchFn = answer === 'offline'
    ? ((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)
    : rpcFetch(async () => { throw Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: vaultV2Abi, errorName: 'NoHiddenItem', args: [1n, 0n] }) }); });
  const client = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0, fetchFn }) });
  return client.readContract({ address: roles.vault, abi: vaultV2Abi, functionName: 'quoteTake', args: [1n] });
}

interface Chain {
  phase: number; quote: readonly [bigint, bigint] | null; allowance: bigint; balance: bigint; baseFee: bigint;
  draws: Map<bigint, { drawer: Address; status: number; itemId: bigint }>; rounds: Map<bigint, bigint>; posted: Set<bigint>;
  revealed: Map<bigint, Hex>; logs: boolean;
  /** Fix round 1 (F2): how `quoteTake` answers instead of `quote` (the real client's errors). */
  quoteRead?: () => Promise<unknown>;
}
function chainOf(patch: Partial<Chain> = {}): Chain {
  return { phase: PHASE.Drawing, quote: [1_000n * 10n ** 18n, 10n * 10n ** 18n], allowance: 0n, balance: 2_000n * 10n ** 18n, baseFee: 2_000_000_000n,
    draws: new Map(), rounds: new Map(), posted: new Set(), revealed: new Map(), logs: true, ...patch };
}

/** A fake chain behind the IO, a recording wallet, and the real shared sender. */
function ioOf(chain: Chain, account: Address = me) {
  const sent: { to: Address; data: Hex; value: bigint }[] = [];
  const reads: string[] = [];
  const request = (async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    if (method === 'eth_chainId') return `0x${CHAIN.toString(16)}`;
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_sendTransaction') {
      const tx = (params as [{ to: Address; data: Hex; value: Hex }])[0];
      sent.push({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
      return `0x${String(sent.length).padStart(64, '0')}`;
    }
    throw new Error(method);
  }) as HiddenIO['request'];
  const io: HiddenIO = {
    feeReader: TEST_FEE_READER, chainId: async () => CHAIN,
    request,
    read: async (to, fn, args = []) => {
      reads.push(`${fn}:${String(args[0] ?? '')}`);
      switch (fn) {
        case 'phase': return chain.phase;
        case 'status': return { drawsRequested: BigInt(chain.draws.size) };
        case 'source': return SOURCE;
        case 'collectionSize': return BigInt(commitment.n);
        case 'firstId': return 1n;
        case 'revealRoot': return commitment.revealRoot;
        // No quote: the vault refuses (a revert), as a node answers.
        case 'quoteTake': if (chain.quoteRead) return chain.quoteRead(); if (!chain.quote) return quoteTakeVia('revert'); return chain.quote;
        case 'allowance': return chain.allowance;
        case 'balanceOf': return chain.balance;
        case 'drawTicket': { const d = chain.draws.get(args[0] as bigint); return d ?? { drawer: zeroAddress, status: 0, itemId: 0n }; }
        case 'requestOf': return [1n, chain.rounds.get(args[1] as bigint) ?? 0n];
        case 'beaconOf': return [zeroHash, chain.posted.has(args[0] as bigint) ? 99n : 0n];
        case 'traitsOf': { const hash = chain.revealed.get(args[0] as bigint); return [hash !== undefined, 1n, hash ?? zeroHash, zeroHash]; }
      }
      throw new Error(`unread ${fn} ${to}`);
    },
    drawsOf: async (_tickets, drawer) => {
      if (!chain.logs) throw new Error('range too large');
      return [...chain.draws].filter(([, d]) => d.drawer === drawer).map(([id]) => id);
    },
    block: async () => ({ timestamp: 1_800_000_000n, baseFee: chain.baseFee }),
    simulate: async () => undefined,
    estimate: async () => 200_000n,
    receipt: async (hash) => {
      const last = sent.at(-1);
      if (last && decodeFunctionData({ abi: boxTicketsAbi, data: last.data }).functionName === 'draw') {
        const ticketId = BigInt(chain.draws.size + 1);
        chain.draws.set(ticketId, { drawer: account, status: DRAW.Requested, itemId: 0n });
        const topics = encodeEventTopics({ abi: boxTicketsAbi, eventName: 'DrawRequested', args: { ticketId, drawer: account } });
        return { status: 'success', logs: [{ address: roles.tickets, topics: topics as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 1n, 5n, 0n]) }], hash };
      }
      return { status: 'success', logs: [] };
    },
    submit: submitWrite,
  };
  return { io, sent, reads };
}

const draw = (patch: Partial<HiddenDraw>): HiddenDraw => ({ id: 1n, drawer: me, status: DRAW.Requested, round: 5n, posted: false, itemId: 0n, imageHash: null, ...patch });
const readsOf = (draws: readonly HiddenDraw[]): HiddenReads => ({ phase: PHASE.Drawing, quote: 1n, revealRoot: commitment.revealRoot, collectionSize: BigInt(commitment.n), firstId: 1n, draws });

describe('TA-50 hidden draws: which boxes and when', () => {
  it('only a hidden-art box with tickets has draws; a draw is offered while drawing with a quote', () => {
    expect(hiddenRolesOf(CHAIN, record, { tickets: at('tickets'), vault: at('vault'), collection: at('collection'), token: at('token') }, 1)).toBeNull();
    expect(hiddenRolesOf(CHAIN, record, { tickets: null, vault: at('vault'), collection: at('collection'), token: at('token') }, 2)).toBeNull();
    expect(drawOpen({ phase: PHASE.Drawing, quote: 5n })).toBe(true);
    expect(drawOpen({ phase: PHASE.AwaitingWord, quote: 5n })).toBe(true);
    for (const phase of [PHASE.BeforeOpen, PHASE.Curve, PHASE.Terminal]) expect(drawOpen({ phase, quote: 5n })).toBe(false);
    expect(drawOpen({ phase: PHASE.Drawing, quote: null })).toBe(false);
  });

  it('rows: waiting for the round, settling, open with the file, waiting for the reveal, revealed', () => {
    const rows = (d: HiddenDraw, f: RevealFile | null = file, who: Address | null = me) => drawRows(readsOf([d]), who, f).map((row) => row.kind);
    expect(rows(draw({}))).toEqual(['waiting-round']);
    expect(rows(draw({ posted: true }))).toEqual(['settling']);
    expect(rows(draw({ status: DRAW.Settled, itemId: 3n, round: null }))).toEqual(['open']);
    expect(rows(draw({ status: DRAW.Settled, itemId: 3n, round: null }), null)).toEqual(['waiting-reveal']);
    // Another drawer's settled draw: the creator opens it with the file; without it, it is not this viewer's row.
    expect(rows(draw({ drawer: other, status: DRAW.Settled, itemId: 3n }), file, creator)).toEqual(['open']);
    expect(rows(draw({ drawer: other, status: DRAW.Settled, itemId: 3n }), null, creator)).toEqual([]);
    expect(rows(draw({ status: DRAW.Opened, itemId: 3n, imageHash: `0x${'ab'.repeat(32)}` }))).toEqual(['revealed']);
    expect(rows(draw({ status: DRAW.Opened, itemId: 3n }))).toEqual(['unrevealed']);
    expect(rows(draw({ status: DRAW.Cancelled }))).toEqual([]);
  });
});

describe('TA-50 hidden draws: reads', () => {
  it('follows this wallet’s draws by its events, each with its round and whether it is posted; no picture before a reveal', async () => {
    const chain = chainOf();
    chain.draws.set(1n, { drawer: other, status: DRAW.Requested, itemId: 0n });
    chain.draws.set(2n, { drawer: me, status: DRAW.Requested, itemId: 0n });
    chain.draws.set(3n, { drawer: me, status: DRAW.Settled, itemId: 4n });
    chain.draws.set(4n, { drawer: me, status: DRAW.Opened, itemId: 6n });
    chain.rounds.set(2n, 77n); chain.posted.add(77n);
    chain.revealed.set(6n, `0x${'cd'.repeat(32)}`);
    const { io, reads } = ioOf(chain);
    const out = await readHiddenDraws(roles, me, [], io);
    expect(out.quote).toBe(1_010n * 10n ** 18n);
    expect(out.draws.map((d) => [d.id, d.status, d.round, d.posted, d.itemId, d.imageHash])).toEqual([
      [2n, DRAW.Requested, 77n, true, 0n, null],
      [3n, DRAW.Settled, null, false, 4n, null],
      [4n, DRAW.Opened, null, false, 6n, `0x${'cd'.repeat(32)}`],
    ]);
    // Another drawer's draw is never read for a viewer who is not the creator.
    expect(reads).not.toContain('drawTicket:1');
  });

  it('the creator also follows the latest settled draws; a refused log range falls back to the latest draws', async () => {
    const chain = chainOf({ logs: false });
    chain.draws.set(1n, { drawer: other, status: DRAW.Settled, itemId: 2n });
    chain.draws.set(2n, { drawer: other, status: DRAW.Requested, itemId: 0n });
    chain.draws.set(3n, { drawer: me, status: DRAW.Requested, itemId: 0n });
    expect((await readHiddenDraws(roles, creator, [], ioOf(chain, creator).io)).draws.map((d) => d.id)).toEqual([1n]);
    expect((await readHiddenDraws(roles, me, [], ioOf(chain).io)).draws.map((d) => d.id)).toEqual([3n]);
    expect(RECENT_DRAWS).toBe(64n);
    // Not drawing: no quote, no draw offered.
    expect((await readHiddenDraws(roles, null, [], ioOf(chainOf({ quote: null })).io)).quote).toBeNull();
  });
});

describe('TA-50 hidden draws: sends through the shared guard', () => {
  it('a draw: the exact finite approval to the tickets, then the draw with its exact limit and bounty', async () => {
    const chain = chainOf();
    const { io, sent } = ioOf(chain);
    const plan = await prepareDrawV2(roles, me, io);
    const quote = 1_010n * 10n ** 18n;
    expect(plan).toEqual({ quote, limit: drawLimitFor(quote), needsApproval: true, short: false, value: drawValueFor(chain.baseFee) });
    await sendHidden(roles, me, { kind: 'approve', amount: plan.limit }, io);
    expect(sent[0]?.to).toBe(roles.token);
    expect(sent[0]?.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: sent[0]?.data as Hex })).toEqual({ functionName: 'approve', args: [roles.tickets, plan.limit] });
    // Without the approval mined, the draw is refused before the wallet.
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, io)).rejects.toThrow('Approve the coins first');
    chain.allowance = plan.limit;
    const result = await sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, io);
    expect(result.ticketId).toBe(1n);
    expect(sent[1]?.to).toBe(roles.tickets);
    expect(sent[1]?.value).toBe(drawValueFor(chain.baseFee));
    expect(decodeFunctionData({ abi: boxTicketsAbi, data: sent[1]?.data as Hex })).toEqual({ functionName: 'draw', args: [plan.limit, 1_800_000_000n + 1_800n] });
    // A price above the limit, or too few coins, refuses before the wallet.
    chain.quote = [2_000n * 10n ** 18n, 20n * 10n ** 18n];
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, io)).rejects.toThrow('The price moved; check the new price');
    chain.quote = [1_000n * 10n ** 18n, 10n * 10n ** 18n]; chain.balance = 1n;
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, io)).rejects.toThrow('Not enough coins');
    chain.phase = PHASE.Terminal;
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, io)).rejects.toThrow('The box is not drawing now');
    expect(sent).toHaveLength(2);
  });

  // Fix round 1, F1 (XR-SH-TA-50): prepared at 2 gwei (0.003 ETH shown), the draw once sent 0.0246 ETH at 20 gwei.
  it('F1: the draw carries exactly the bounty the drawer confirmed; a fee that needs more stops before the wallet', async () => {
    const chain = chainOf({ allowance: 10n ** 30n });
    const { io, sent } = ioOf(chain);
    const targets: unknown[] = [];
    const recording: HiddenIO = { ...io, submit: ((options: Parameters<typeof submitWrite>[0]) => { targets.push((options as { target?: { drawValue?: bigint } }).target?.drawValue); return submitWrite(options); }) as typeof submitWrite };
    const plan = await prepareDrawV2(roles, me, recording);
    expect(plan.value).toBe(3_000_000_000_000_000n); // 600,000 × (2 × 2 gwei + 1 gwei): the 0.003 ETH the page shows
    chain.baseFee = 20_000_000_000n; // 0.0246 ETH now: never sent on the 0.003 ETH confirmation
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, recording)).rejects.toThrow('The network fee rose. Check the new amount and confirm again.');
    expect(sent).toEqual([]);
    // Less needed now: still exactly the confirmed bounty, in the call and in the guard's target (the rest comes back).
    chain.baseFee = 1_000_000_000n;
    await sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, recording);
    expect(sent.map((tx) => tx.value)).toEqual([plan.value]);
    expect(targets).toEqual([plan.value]);
  });

  // SH-203 (SH-202 af2 H): the direct opener is retired; every opening goes through the reveal session (prepareOpening,
  // then open, on two presses). The old test's properties (no item yet refuses, the settled draw's item with its reveal and
  // proof from the file to the caller, an item the file lacks refuses before the wallet) are pinned on that path below.
  it('an open: the retired direct opener refuses before any read or send, whatever the draw', async () => {
    const chain = chainOf();
    const { io, sent } = ioOf(chain);
    for (const draw of [{ drawer: me, status: DRAW.Requested, itemId: 0n }, { drawer: me, status: DRAW.Settled, itemId: 5n }]) {
      chain.draws.set(1n, draw);
      await expect(sendHidden(roles, me, { kind: 'open', ticket: 1n, file }, io)).rejects.toThrow('opening-session-required');
    }
    expect(sent).toEqual([]);
  });

  it('an open on the session path: no item yet waits; the settled draw’s item with its reveal and proof from the file, to the caller; an item the file lacks refuses before the wallet', async () => {
    const h = await openingSession({ status: 'requested', itemId: 0n });
    try {
      await h.session.ready;
      h.press(); await expect(h.session.prepareOpening(1n)).rejects.toThrow('settlement');
      expect(h.sent).toEqual([]);
      h.draw.status = 'settled'; h.draw.itemId = 3n;
      h.press(); const handle = await h.session.prepareOpening(1n);
      expect(handle).toMatchObject({ ticket: 1n, itemId: 3n, spentWei: 0n });
      expect(handle.ceilingWei).toBe(handle.spentWei + handle.capWei);
      expect(h.sent).toEqual([]);
      // The second press opens exactly the shown handle; one send, to the tickets contract, no value.
      h.press(); expect((await h.session.open(handle)).reason).toBe('sent');
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.to?.toLowerCase()).toBe(h.tickets.toLowerCase());
      expect(BigInt(h.sent[0]?.value ?? '0x0')).toBe(0n);
      const decoded = decodeFunctionData({ abi: boxTicketsAbi, data: h.sent[0]?.data as Hex });
      expect(decoded.functionName).toBe('openDraw');
      expect(decoded.args).toEqual([1n, h.creator, h.revealOf(3n)]);
      // An item the file does not hold refuses before the wallet.
      h.draw.id = 2n; h.draw.itemId = 99n;
      h.press(); await expect(h.session.prepareOpening(2n)).rejects.toThrow('missing-proof');
      expect(h.sent).toHaveLength(1);
    } finally { h.session.dispose(); }
  });

  it('a wallet on another account or network sends nothing', async () => {
    const { io, sent } = ioOf(chainOf(), other);
    await expect(sendHidden(roles, me, { kind: 'approve', amount: 5n }, io)).rejects.toThrow('Wallet changed; confirm again');
    expect(sent).toEqual([]);
  });
});

describe('TA-50 fix round 1 (XR-SH-TA-50): reads that fail are never "no draw" or "no fee"', () => {
  it('F2: an unreadable price is unavailable, never "no draw"; the vault’s own refusal is "no draw"', async () => {
    const offline = chainOf({ quoteRead: () => quoteTakeVia('offline') });
    const refused = chainOf({ quoteRead: () => quoteTakeVia('revert') });
    expect((await readHiddenDraws(roles, me, [], ioOf(offline).io)).quote).toBe('unavailable');
    expect((await readHiddenDraws(roles, me, [], ioOf(refused).io)).quote).toBeNull();
    // Neither offers a draw; a press with an unreadable price says so, never "not drawing".
    expect(drawOpen({ phase: PHASE.Drawing, quote: 'unavailable' })).toBe(false);
    await expect(prepareDrawV2(roles, me, ioOf(offline).io)).rejects.toThrow('Price unavailable. Try again.');
    await expect(prepareDrawV2(roles, me, ioOf(refused).io)).rejects.toThrow('The box is not drawing now');
  });

  it('F3: a block without a valid base fee prepares and sends no draw; an explicit 0 (a local chain) is a fee', async () => {
    // The real hiddenIO().block() against a node's block JSON, its baseFeePerGas as given (absent when undefined).
    let served: Record<string, unknown> = {};
    const blockJson = (baseFeePerGas?: string | null) => ({
      number: '0x10', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x6b49d200', gasLimit: '0x1c9c380',
      gasUsed: '0x0', miner: zeroAddress, extraData: '0x', transactions: [], ...(baseFeePerGas === undefined ? {} : { baseFeePerGas }),
    });
    vi.stubGlobal('fetch', rpcFetch(async ({ method }) => { if (method === 'eth_getBlockByNumber') return served; throw new Error(method); }));
    const block = hiddenIO('http://127.0.0.1:1', async () => { throw new Error('no wallet'); }).block;
    for (const bad of [undefined, null, '0xzz']) {
      served = blockJson(bad);
      await expect(block()).rejects.toThrow('Network fee unavailable. Try again.');
    }
    served = blockJson('0x0');
    expect((await block()).baseFee).toBe(0n);
    served = blockJson('0x77359400');
    expect((await block()).baseFee).toBe(2_000_000_000n);
    // Through the draw: no plan and no send without a fee read.
    const chain = chainOf({ allowance: 10n ** 30n });
    const { io, sent } = ioOf(chain);
    const plan = await prepareDrawV2(roles, me, io);
    served = blockJson();
    await expect(prepareDrawV2(roles, me, { ...io, block })).rejects.toThrow('Network fee unavailable. Try again.');
    await expect(sendHidden(roles, me, { kind: 'draw', limit: plan.limit, value: plan.value }, { ...io, block })).rejects.toThrow('Network fee unavailable. Try again.');
    expect(sent).toEqual([]);
    // A local chain's base fee of 0 is a fee: the bounty is 600,000 × 1 gwei.
    served = blockJson('0x0');
    expect((await prepareDrawV2(roles, me, { ...io, block })).value).toBe(600_000n * 1_000_000_000n);
  });
});
