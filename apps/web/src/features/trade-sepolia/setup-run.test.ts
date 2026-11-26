/**
 * F166 (SH-ALPHA-ONBOARDING): "Set me up" over doubles of our server, Privy's bridge, the wallet context and the chain.
 * The claim's signature is a real EIP-191 one (viem), recovered here to the made wallet's address; the coin calls'
 * reads, plan and guarded send are doubled at their module (TestCoinPage.test.tsx runs the real ones), and the site's
 * RPC answers the blocks, nonces, balances and receipts the run reads itself. The run's clock is the test's.
 */
import { recoverMessageAddress, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinOptions, CoinSubmitOptions } from '@squarehole/chain/trade-sepolia';
import { WalletRequestError, type Eip1193Request } from '@squarehole/chain/write';
import { DRY_RUN_REASON, type AlphaApi, type AlphaMe, type AlphaResult, type ClaimChallenge, type ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, JOIN_WORDS, SETUP_WORDS, claimLine, refusalLine } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { readSetupHint, writeSetupHint } from '../alpha-sepolia/setup-hint';
import { welcomeOffer } from '../alpha-sepolia/welcome-gate';
import type { CoinTargetRead } from './coin-target';
import { DRIP } from './faucet-due';
import { closeSetup, resetSetupForTests, runSetup, setupState, subscribeSetup, type SetupDeps, type SetupState, type SetupWallet } from './setup-run';
import { beginInFlight, clearInFlight, inFlightOf, sendKey } from './trade-inflight';
import { tradeLine } from './trade-words';

// Anvil's well-known default account #1 (a public test key): the made wallet's signature is a real one.
const MADE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = '0x00000000000000000000000000000000000000Aa' as const;
const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const ADMIT = `0x${'a1'.repeat(32)}` as const;
const SEND = `0x${'b2'.repeat(32)}` as const;
const DRIP_TX = `0x${'c3'.repeat(32)}` as const;
const TETH = '0x0000000000000000000000000000000000000011' as const;
const CHAIN = 11_155_111;
const NOW = 1_790_000_000n;
const textFor = (address: string) => `Square Hole alpha claim\n\nI link my X account @tester (X ID 123) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${ID}\nTime: 2026-11-01T08:00:00.000Z\nSite: https://test-app.squarehole.fun`;

/** The chain as the site's RPC and the coin calls' doubles see it. */
const chain = vi.hoisted(() => ({
  block: 0x20n, sepEth: 0n, teth: 0n, admitted: false, open: false, nextDripAt: 0n, dailyRemaining: 400n * 10n ** 18n,
  /** The account's mined nonce, and how many of its sends the node holds pending on top. */
  nonce: 0n, pending: 0n, down: false, receipts: new Map<string, unknown>(), txs: new Map<string, unknown>(),
  /** The chain's gas price (1 gwei), and what the wallet throws at the drip instead of sending it, if anything. */
  gasPrice: 10n ** 9n, submitError: null as Error | null,
  submitted: [] as unknown[], prepared: [] as string[], reads: [] as string[],
  /** What the chain shows once a receipt was looked for (a send the page did not make, mined meanwhile). */
  onReceipt: null as (() => void) | null,
}));
vi.mock('@squarehole/chain/trade-sepolia', async (original) => {
  const real = await original<typeof import('@squarehole/chain/trade-sepolia')>();
  const block = () => ({ blockNumber: chain.block, blockHash: `0x${'ab'.repeat(32)}` as Hex, blockTimestamp: NOW });
  return {
    ...real,
    readCoinStateSepolia: async (options: CoinOptions & { blockNumber: bigint }) => {
      chain.reads.push(options.from);
      if (chain.down) throw new Error('the node did not answer');
      return { ...block(), blockNumber: options.blockNumber, faucet: { open: chain.open, admitted: chain.admitted, nextDripAt: chain.nextDripAt, dailyRemaining: chain.dailyRemaining },
        balances: [{ coin: TETH, balance: chain.teth }] };
    },
    prepareFaucetSepolia: async (options: CoinOptions) => {
      chain.prepared.push(options.from);
      if (!chain.admitted && !chain.open) return { ok: false, reason: 'not_admitted' };
      if (chain.nextDripAt > NOW) return { ok: false, reason: 'cooldown_active', nextDripAt: chain.nextDripAt };
      return { ok: true, plan: { kind: 'faucet', chainId: CHAIN, from: options.from, ...block(), deadline: NOW + 120n, deployment: {}, call: { to: TETH, data: '0x9f678cca', value: 0n },
        approvals: [], revoke: null, gasLimit: 480_000n, reason: null, expectedInput: null, expectedOutput: 10n ** 18n, expectedSqrtPriceX96: null, warning: null } };
    },
    // The guarded send: the wallet "signs" (recorded), and the next block mines the drip.
    submitCoinWriteSepolia: async (options: CoinSubmitOptions) => {
      if (chain.submitError) throw chain.submitError;
      chain.submitted.push(options);
      chain.nonce += 1n;
      chain.block += 1n;
      chain.teth += 10n ** 18n;
      chain.nextDripAt = NOW + 86_400n;
      chain.receipts.set(DRIP_TX, { transactionHash: DRIP_TX, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: toHex(chain.block), status: '0x1', from: options.from, to: TETH, gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] });
      return DRIP_TX;
    },
  };
});

/** The site's RPC: blocks, balances, nonces, receipts and transactions. */
const rpc: Eip1193Request = async ({ method, params = [] }) => {
  const list = params as readonly unknown[];
  if (chain.down) throw new Error('the node did not answer');
  if (method === 'eth_blockNumber') return toHex(chain.block);
  if (method === 'eth_gasPrice') return toHex(chain.gasPrice);
  if (method === 'eth_getBalance') return toHex(chain.sepEth);
  if (method === 'eth_getTransactionCount') return toHex(list[1] === 'pending' ? chain.nonce + chain.pending : chain.nonce);
  if (method === 'eth_getTransactionReceipt') {
    chain.onReceipt?.();
    return chain.receipts.get(String(list[0])) ?? null;
  }
  if (method === 'eth_getTransactionByHash') return chain.txs.get(String(list[0])) ?? null;
  throw new Error(`unexpected ${method}`);
};
const target: CoinTargetRead = { ok: true, target: { chainId: CHAIN, rpc, teth: { address: TETH, symbol: 'tETH', decimals: 18 }, pairs: [], explorer: () => null } };

/** The sender sends: the wallet admitted and its starter SepETH, both transactions on the chain. */
function senderSends(to: string = MADE.address) {
  chain.admitted = to === MADE.address;
  chain.sepEth = to === MADE.address ? 5n * 10n ** 16n : 0n;
  chain.txs.set(SEND, { hash: SEND, from: OTHER, to, nonce: '0x7', input: '0x', value: toHex(5n * 10n ** 16n), gas: '0x5208', blockNumber: '0x1f', blockHash: `0x${'ef'.repeat(32)}` });
}

const receipt = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: ID, status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-11-01T08:05:00Z', ...over });
const SENT = receipt('sent', { admitTx: ADMIT, sendTx: SEND });

/** Our server: `me`, the claim text, the claim, and the claim's states in turn (the last one repeats). */
function server(options: { me?: AlphaResult<AlphaMe>; claim?: ClaimState | null; states?: ClaimState[]; message?: AlphaResult<ClaimChallenge>[] } = {}) {
  const calls: string[] = [];
  const states = [...(options.states ?? [SENT])];
  const messages = [...(options.message ?? [])];
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async (): Promise<AlphaResult<AlphaMe>> => { calls.push('me'); return options.me ?? { ok: true, value: { status: 'approved', handle: 'tester', claim: options.claim ?? null } }; }),
    session: vi.fn(), signOut: vi.fn(), signups: vi.fn(), decide: vi.fn(),
    claimMessage: vi.fn(async (address: string): Promise<AlphaResult<ClaimChallenge>> => {
      calls.push(`message:${address}`);
      return messages.shift() ?? { ok: true, value: { id: ID, address: address as `0x${string}`, message: textFor(address), requestedAt: '2026-11-01T08:00:00.000Z' } };
    }),
    claim: vi.fn(async (input: { address: string; message: string; signature: string }): Promise<AlphaResult<ClaimState>> => { calls.push(`claim:${input.address}`); return { ok: true, value: receipt('queued') }; }),
    claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('state'); return { ok: true, value: (states.length > 1 ? states.shift() : states[0]) ?? SENT }; }),
  };
  return { api, calls };
}

/** Privy's bridge: the made wallet (signing with the test key), or a failure; `notReady`: its record never loaded. */
function privyDouble(options: { signedIn?: boolean; fails?: number; notReady?: boolean } = {}) {
  let failures = options.fails ?? 0;
  const made: MadeWallet = { address: MADE.address, provider: { request: vi.fn() } };
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => options.signedIn ?? true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => {
      if (options.notReady) throw new Error('Privy’s record did not load');
      return options.signedIn === false ? null : made;
    }),
    exportWallet: vi.fn(),
    makeWallet: vi.fn(async () => {
      if (failures > 0) { failures -= 1; throw new Error('Privy’s wallet frame did not load'); }
      return made;
    }),
  };
  return { bridge, made };
}

/** The wallet context as the run reads it, and its ticket (current while nothing else connected). */
function walletDouble() {
  const asked: { method: string; params?: unknown }[] = [];
  const view: { -readonly [K in keyof SetupWallet]: SetupWallet[K] } = { status: 'disconnected', account: null, chainId: null, signer: null, switchChain: vi.fn(async () => undefined) };
  const signer = {
    walletName: 'Wallet Privy made', confirmsInPage: true as const,
    request: async (args: { method: string; params?: unknown }) => {
      asked.push(args);
      if (args.method !== 'personal_sign') throw new Error(`unexpected ${args.method}`);
      return MADE.signMessage({ message: { raw: (args.params as [`0x${string}`])[0] } });
    },
  };
  const connects: unknown[] = [];
  const ticket = {
    current: () => view.status === 'disconnected',
    connect: vi.fn(async (wallet: unknown) => {
      if (view.status !== 'disconnected') return false;
      connects.push(wallet);
      Object.assign(view, { status: 'connected', account: MADE.address, chainId: CHAIN, signer });
      return true;
    }),
  };
  return { view, ticket, asked, connects, signer };
}

/** A browser wallet of the person's own, as the wallet context shows it once connected. */
const BROWSER = { status: 'connected' as const, account: OTHER, chainId: CHAIN, signer: { walletName: 'Browser wallet', confirmsInPage: false as const, request: vi.fn() } };

/** This device's setup made the claim our server holds (its hint names it): the run goes on from it. */
const ours = (claimId: string = ID) => writeSetupHint({ handle: 'tester', state: 'started', claimId });

/** The run's clock: each wait moves it on at once. */
const clock = { now: 0 };
const timing = { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; await Promise.resolve(); } };

function deps(over: Omit<Partial<SetupDeps>, 'wallet' | 'privy'> & { wallet: ReturnType<typeof walletDouble>; privy?: ReturnType<typeof privyDouble> | null; api: AlphaApi }): SetupDeps {
  return { api: over.api, privy: over.privy === null ? null : Promise.resolve((over.privy ?? privyDouble()).bridge), ticket: over.wallet.ticket, target: over.target ?? target, wallet: () => over.wallet.view, timing };
}

/** Every state the run published, as the pages' subscription sees them. */
let seen: SetupState[] = [];
const watch = () => { subscribeSetup(() => { seen.push(setupState()); }); };
/** The press, and where the run ended. */
async function press(input: SetupDeps): Promise<SetupState> {
  await runSetup(input);
  return setupState();
}

beforeEach(() => {
  resetSetupForTests();
  clearInFlight();
  clock.now = 0;
  Object.assign(chain, { block: 0x20n, sepEth: 0n, teth: 0n, admitted: false, open: false, nextDripAt: 0n, dailyRemaining: 400n * 10n ** 18n, nonce: 0n, pending: 0n, down: false, onReceipt: null,
    gasPrice: 10n ** 9n, submitError: null });
  chain.receipts.clear(); chain.txs.clear(); chain.submitted.length = 0; chain.prepared.length = 0; chain.reads.length = 0;
  try { window.localStorage.clear(); } catch { /* none */ }
  seen = [];
  watch();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('“Set me up”: one press, each step skipped when done (F166, SH-ALPHA-ONBOARDING)', () => {
  it('makes the wallet, connects it, signs this claim, waits for the coins and takes the first tETH, in that order; done shows SepETH and tETH', async () => {
    const wallet = walletDouble();
    const privy = privyDouble();
    // The sender answers on the second look: queued, then sent (and the chain shows both its transactions).
    const { api, calls } = server({ states: [receipt('queued'), SENT] });
    vi.mocked(api.claimState).mockImplementation(async () => {
      calls.push('state');
      if (calls.filter((call) => call === 'state').length < 2) return { ok: true, value: receipt('queued') };
      senderSends();
      return { ok: true, value: SENT };
    });
    const end = await press(deps({ api, wallet, privy }));

    expect(end.phase).toBe('done');
    expect(end.done).toEqual(['wallet', 'claim', 'coins', 'teth']);
    expect(end.line).toBe(SETUP_WORDS.done);
    expect(end.figures).toEqual({ sepEth: 5n * 10n ** 16n, teth: DRIP });
    expect(end.drip).toBe(DRIP_TX);
    expect(end.address).toBe(MADE.address);
    // Our server: who this is, the text for the made wallet, the claim, then its state until the sender's receipt.
    expect(calls).toEqual(['me', `message:${MADE.address}`, `claim:${MADE.address}`, 'state', 'state']);
    // Privy made the wallet on the press, and the ticket taken on the press connected it as the app's wallet.
    expect(privy.bridge.makeWallet).toHaveBeenCalledTimes(1);
    expect(wallet.connects).toEqual([{ id: 'privy', name: 'Wallet Privy made', provider: privy.made.provider }]);
    // One signature of exactly the server's text, by the made wallet, sent as it was signed.
    expect(wallet.asked.map(({ method }) => method)).toEqual(['personal_sign']);
    const [claimed] = vi.mocked(api.claim).mock.calls[0] ?? [];
    expect(claimed?.message).toBe(textFor(MADE.address));
    expect(await recoverMessageAddress({ message: textFor(MADE.address), signature: claimed?.signature as Hex })).toBe(MADE.address);
    // One drip, from the made wallet, through the guarded coin sender, with its own signer; the slot is free again.
    expect(chain.submitted).toHaveLength(1);
    expect(chain.submitted[0]).toMatchObject({ from: MADE.address, chainId: CHAIN, gasLimit: 480_000n, wallet: wallet.signer.request });
    expect(inFlightOf(sendKey(CHAIN, MADE.address))).toBeNull();
    // The ticks moved in order, and the device's hint followed: started, then done.
    const steps = [...new Set(seen.filter((state) => state.phase === 'running' && state.step !== null).map((state) => state.step))];
    expect(steps).toEqual(['wallet', 'claim', 'coins', 'teth']);
    expect(readSetupHint('tester')).toEqual({ state: 'done', claimId: ID });
  });

  it('skips what is done: the made wallet in use, a claim the sender sent, a drip’s worth of tETH held; nothing is signed, claimed or sent', async () => {
    const wallet = walletDouble();
    Object.assign(wallet.view, { status: 'connected', account: MADE.address, chainId: CHAIN, signer: wallet.signer });
    senderSends();
    chain.teth = DRIP;
    ours();
    const { api, calls } = server({ claim: SENT });
    const end = await press(deps({ api, wallet }));
    expect(end.phase).toBe('done');
    expect(end.done).toEqual(['wallet', 'claim', 'coins', 'teth']);
    expect(calls).toEqual(['me']);
    expect(wallet.ticket.connect).not.toHaveBeenCalled();
    expect(wallet.asked).toEqual([]);
    expect(chain.prepared).toEqual([]);
    expect(chain.submitted).toEqual([]);
    expect(end.figures).toEqual({ sepEth: 5n * 10n ** 16n, teth: DRIP });
  });

  it('only the FIRST drip: a wallet that dripped before (its tETH spent, the cooldown over) is done here; a later drip needs its own press', async () => {
    for (const nextDripAt of [NOW + 3_600n, NOW - 60n]) {
      resetSetupForTests();
      chain.submitted.length = 0;
      chain.prepared.length = 0;
      senderSends();
      chain.teth = 0n;
      chain.nextDripAt = nextDripAt;
      ours();
      const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
      expect(end.phase, String(nextDripAt)).toBe('done');
      expect(end.figures).toEqual({ sepEth: 5n * 10n ** 16n, teth: 0n });
      expect(chain.prepared).toEqual([]);
      expect(chain.submitted).toEqual([]);
    }
  });

  it('the sender’s dry run ends the run in test mode; the claim is free again, and the next visit offers “Finish setup”', async () => {
    const wallet = walletDouble();
    const dry = receipt('skipped', { reason: DRY_RUN_REASON });
    const { api, calls } = server({ states: [dry] });
    const end = await press(deps({ api, wallet }));
    expect(end).toMatchObject({ phase: 'test', step: 'coins', line: SETUP_WORDS.testMode, retry: false, done: ['wallet', 'claim'] });
    expect(calls).toEqual(['me', `message:${MADE.address}`, `claim:${MADE.address}`, 'state']);
    // The chain was read for the coins meanwhile (af2); nothing was prepared or sent.
    expect(chain.prepared).toEqual([]);
    expect(chain.submitted).toEqual([]);
    expect(readSetupHint('tester')).toEqual({ state: 'started', claimId: ID });
    expect(welcomeOffer({ status: 'approved', handle: 'tester', claim: dry }, readSetupHint('tester'), false)).toBe('finish');
  });

  it('af2: the coins from the chain, before the sender’s receipt: on the list first, the SepETH minutes later; the drip goes as soon as both show', async () => {
    const wallet = walletDouble();
    const { api, calls } = server({ states: [receipt('queued')] });
    // The sender's admission lands on the second look, its SepETH on the fifth; its receipt still says queued.
    let looks = 0;
    vi.mocked(api.claimState).mockImplementation(async () => {
      calls.push('state');
      looks += 1;
      if (looks === 2) chain.admitted = true;
      if (looks === 5) chain.sepEth = 5n * 10n ** 16n;
      return { ok: true, value: receipt('queued') };
    });
    const end = await press(deps({ api, wallet }));
    expect(end.phase).toBe('done');
    expect(end.done).toEqual(['wallet', 'claim', 'coins', 'teth']);
    expect(end.claim?.status).toBe('queued');
    expect(calls.filter((call) => call === 'state')).toHaveLength(5);
    // While on the list without SepETH, the line said so, and no drip was prepared or sent before the SepETH came.
    expect(seen.some((state) => state.line === claimLine(receipt('queued')))).toBe(true);
    expect(chain.submitted).toHaveLength(1);
    expect(end.figures).toEqual({ sepEth: 5n * 10n ** 16n, teth: DRIP });
    expect(readSetupHint('tester')).toEqual({ state: 'done', claimId: ID });
  });

  it('af2: in either order and in the same block: SepETH first, then the list; or both at once', async () => {
    for (const order of ['sepEth first', 'same block'] as const) {
      resetSetupForTests();
      window.localStorage.clear();
      chain.submitted.length = 0;
      Object.assign(chain, { admitted: false, sepEth: 0n, teth: 0n, nextDripAt: 0n, block: 0x20n });
      const { api } = server();
      let looks = 0;
      vi.mocked(api.claimState).mockImplementation(async () => {
        looks += 1;
        if (order === 'same block' && looks === 1) Object.assign(chain, { admitted: true, sepEth: 5n * 10n ** 16n });
        if (order === 'sepEth first' && looks === 1) chain.sepEth = 5n * 10n ** 16n;
        if (order === 'sepEth first' && looks === 3) chain.admitted = true;
        return { ok: true, value: receipt('queued') };
      });
      const end = await press(deps({ api, wallet: walletDouble() }));
      expect(end.phase, order).toBe('done');
      expect(chain.submitted, order).toHaveLength(1);
      expect(looks, order).toBe(order === 'same block' ? 1 : 3);
    }
  });

  it('af2: on the list but no SepETH for the drip’s gas (none, or dust): no drip is prepared or sent; it waits, saying the SepETH is on its way', async () => {
    for (const sepEth of [0n, 1_000n]) {
      resetSetupForTests();
      seen = [];
      watch();
      window.localStorage.clear();
      clock.now = 0;
      chain.prepared.length = 0;
      chain.submitted.length = 0;
      Object.assign(chain, { admitted: true, sepEth });
      const { api } = server({ states: [receipt('queued')] });
      const end = await press(deps({ api, wallet: walletDouble() }));
      expect(end, String(sepEth)).toMatchObject({ phase: 'stopped', step: 'coins', line: SETUP_WORDS.stillQueued, retry: true, done: ['wallet', 'claim'] });
      expect(seen.some((state) => state.line === claimLine(receipt('queued')))).toBe(true);
      expect(chain.prepared).toEqual([]);
      expect(chain.submitted).toEqual([]);
    }
  });

  it('af2: a wallet that dripped before needs no gas money for setup to finish (its first drip is behind it)', async () => {
    Object.assign(chain, { admitted: true, sepEth: 0n, teth: 0n, nextDripAt: NOW - 60n });
    ours();
    const end = await press(deps({ api: server({ claim: receipt('queued') }).api, wallet: walletDouble() }));
    expect(end.phase).toBe('done');
    expect(chain.prepared).toEqual([]);
    expect(chain.submitted).toEqual([]);
  });

  it('af2: a drip the wallet refuses for its cost says the plain line, not the wallet’s error; nothing is followed', async () => {
    senderSends();
    ours();
    chain.submitError = new WalletRequestError('The wallet returned an error: insufficient funds for gas * price + value: balance 0');
    const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'teth', line: tradeLine('gas_funds'), retry: true });
    expect(tradeLine('gas_funds')).toBe('Needs a little SepETH for gas.');
    expect(inFlightOf(sendKey(CHAIN, MADE.address))).toBeNull();
  });

  it.each(['queued', 'waiting', 'sending'] as const)('%s keeps the same claim during refill and finishes after the sender resumes', async status => {
    ours();
    const waiting = receipt('waiting', { reason: 'insufficient float for starter and gas' });
    const { api } = server({ claim: { ...waiting, status } });
    let polls = 0;
    vi.mocked(api.claimState).mockImplementation(async () => {
      if (++polls < 3) return { ok: true, value: waiting };
      senderSends(); return { ok: true, value: SENT };
    });
    const wallet = walletDouble();
    const end = await press(deps({ api, wallet }));
    expect(end.phase).toBe('done');
    expect(seen.some(state => state.line === claimLine(waiting))).toBe(true);
    expect(vi.mocked(api.claimState).mock.calls).toEqual([[waiting.id], [waiting.id], [waiting.id]]);
    expect(api.claim).not.toHaveBeenCalled();
    expect(api.claimMessage).not.toHaveBeenCalled();
    expect(wallet.asked.filter(request => request.method === 'personal_sign')).toEqual([]);
  });

  it('a claim the sender refused or that failed stops at the coins with its line, and no Try again', async () => {
    for (const status of ['refused', 'failed'] as const) {
      resetSetupForTests();
      ours();
      const end = await press(deps({ api: server({ claim: receipt(status) }).api, wallet: walletDouble() }));
      expect(end).toMatchObject({ phase: 'stopped', step: 'coins', line: claimLine(receipt(status)), retry: false });
      expect(readSetupHint('tester')?.state).toBe('ended');
    }
  });

  it('a claim this device’s setup did not make (by hand, or on another device) is never taken for its own: stopped before Privy is asked', async () => {
    for (const hint of [null, { state: 'manual' as const }, { state: 'started' as const, claimId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }]) {
      resetSetupForTests();
      window.localStorage.clear();
      if (hint) writeSetupHint({ handle: 'tester', ...hint });
      const privy = privyDouble();
      const wallet = walletDouble();
      const end = await press(deps({ api: server({ claim: receipt('queued') }).api, wallet, privy }));
      expect(end, JSON.stringify(hint)).toMatchObject({ phase: 'stopped', step: 'claim', line: SETUP_WORDS.claimedAlready, retry: false });
      expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
      expect(wallet.connects).toEqual([]);
    }
  });

  it('Privy that cannot make the wallet stops the run at the wallet with Try again (never “no wallet”); the next press goes on from there', async () => {
    const wallet = walletDouble();
    const privy = privyDouble({ fails: 1 });
    const { api } = server();
    vi.mocked(api.claimState).mockImplementation(async () => { senderSends(); return { ok: true, value: SENT }; });
    const stopped = await press(deps({ api, wallet, privy }));
    expect(stopped).toMatchObject({ phase: 'stopped', step: 'wallet', line: CLAIM_WORDS.madeWalletFailed, retry: true, signIn: null });
    expect(wallet.connects).toEqual([]);
    expect(api.claimMessage).not.toHaveBeenCalled();
    expect(readSetupHint('tester')).toEqual({ state: 'started', claimId: null });
    const end = await press(deps({ api, wallet, privy }));
    expect(end.phase).toBe('done');
    expect(privy.bridge.makeWallet).toHaveBeenCalledTimes(2);
  });

  it('Privy’s sign-in lapsed in this browser: stops at the wallet and asks for X again; nothing is made', async () => {
    const privy = privyDouble({ signedIn: false });
    const end = await press(deps({ api: server().api, wallet: walletDouble(), privy }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'wallet', line: CLAIM_WORDS.signInAgain, signIn: 'privy', retry: true });
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
  });

  it('Privy never got ready (its record did not load): its own line and Try again, not “sign in with X again”', async () => {
    const privy = privyDouble({ signedIn: false, notReady: true });
    const end = await press(deps({ api: server().api, wallet: walletDouble(), privy }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'wallet', line: SETUP_WORDS.privyNotReady, signIn: null, retry: true });
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
  });

  it('XR-ALPHA-SITE af3: a browser wallet’s window still open at the press is waited for; it connects, and Privy is never asked', async () => {
    const wallet = walletDouble();
    const privy = privyDouble();
    Object.assign(wallet.view, { status: 'connecting' });
    // The person answers the browser wallet's window a second later.
    let waited = 0;
    const timed = { ...timing, sleep: async (ms: number) => { waited += ms; if (waited >= 1_000) Object.assign(wallet.view, BROWSER); await timing.sleep(ms); } };
    const end = await press({ ...deps({ api: server().api, wallet, privy }), timing: timed });
    expect(end).toMatchObject({ phase: 'stopped', step: 'wallet', line: SETUP_WORDS.walletTaken, retry: true });
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    expect(wallet.ticket.connect).not.toHaveBeenCalled();
  });

  it('a browser wallet still asking after the wait: its own line, and Privy is never asked', async () => {
    const wallet = walletDouble();
    const privy = privyDouble();
    Object.assign(wallet.view, { status: 'connecting' });
    const end = await press(deps({ api: server().api, wallet, privy }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'wallet', line: SETUP_WORDS.walletAsking, retry: true });
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
  });

  it('the made wallet’s own reconnect on load, under way at the press, is ours: the run waits for it and goes on (af1 F7)', async () => {
    const wallet = walletDouble();
    senderSends();
    ours();
    Object.assign(wallet.view, { status: 'connecting' });
    // made-wallet.ts brings the made wallet back a moment later; the ticket taken on the press is no longer current.
    vi.mocked(wallet.ticket.connect).mockResolvedValue(false);
    let waited = 0;
    const timed = { ...timing, sleep: async (ms: number) => {
      waited += ms;
      if (waited >= 200 && wallet.view.status === 'connecting') Object.assign(wallet.view, { status: 'connected', account: MADE.address, chainId: CHAIN, signer: wallet.signer });
      await timing.sleep(ms);
    } };
    const end = await press({ ...deps({ api: server({ claim: SENT }).api, wallet }), timing: timed });
    expect(end.phase).toBe('done');
    expect(seen.some((state) => state.line === SETUP_WORDS.walletTaken)).toBe(false);
  });

  it('a press while nothing is connected, the made wallet’s own reconnect landing mid-run: the ticket ended by it, the run waits for it and goes on (af1 F7, the wait after the connect)', async () => {
    const wallet = walletDouble();
    senderSends();
    ours();
    // made-wallet.ts's reconnect, still waiting for Privy at the press (nothing connected yet), connects first: the
    // run's ticket is no longer current, and the made wallet arrives a moment later, while the run waits for it.
    vi.mocked(wallet.ticket.connect).mockImplementation(async () => {
      setTimeout(() => Object.assign(wallet.view, { status: 'connected', account: MADE.address, chainId: CHAIN, signer: wallet.signer }), 0);
      return false;
    });
    const timed = { ...timing, sleep: async (ms: number) => { clock.now += ms; await new Promise((resolve) => setTimeout(resolve, 0)); } };
    const end = await press({ ...deps({ api: server({ claim: SENT }).api, wallet }), timing: timed });
    expect(end.phase).toBe('done');
    expect(wallet.ticket.connect).toHaveBeenCalledTimes(1);
    expect(seen.some((state) => state.line === SETUP_WORDS.walletNone || state.line === SETUP_WORDS.walletTaken)).toBe(false);
  });

  it('a wallet of the person’s own, connected meanwhile, stays: the run stops at the wallet and signs nothing', async () => {
    const wallet = walletDouble();
    vi.mocked(wallet.ticket.connect).mockImplementationOnce(async () => { Object.assign(wallet.view, BROWSER); return false; });
    const { api } = server();
    const end = await press(deps({ api, wallet }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'wallet', line: SETUP_WORDS.walletTaken, retry: true });
    expect(api.claimMessage).not.toHaveBeenCalled();
    expect(wallet.asked).toEqual([]);
  });

  it('no wallet connected when one is needed: “No wallet is connected now”, never “Another wallet is in use”', async () => {
    const wallet = walletDouble();
    vi.mocked(wallet.ticket.connect).mockResolvedValueOnce(false);
    const stopped = await press(deps({ api: server().api, wallet }));
    expect(stopped).toMatchObject({ phase: 'stopped', step: 'wallet', line: SETUP_WORDS.walletNone, retry: true });
    // Let go between the wallet and the claim: the same line at the claim.
    const { api } = server();
    vi.mocked(api.claimMessage).mockImplementationOnce(async (address: string) => {
      Object.assign(wallet.view, { status: 'disconnected', account: null, chainId: null, signer: null });
      return { ok: true, value: { id: ID, address: address as `0x${string}`, message: textFor(address), requestedAt: '2026-11-01T08:00:00.000Z' } };
    });
    const later = await press(deps({ api, wallet }));
    expect(later).toMatchObject({ phase: 'stopped', step: 'claim', line: SETUP_WORDS.walletNone });
    expect(api.claim).not.toHaveBeenCalled();
  });

  it('our server refuses the claim text: stops at the claim with its line; Try again asks again and goes on', async () => {
    const wallet = walletDouble();
    const refusal = { ok: false as const, status: 503, error: 'service unavailable' };
    const { api } = server({ message: [refusal] });
    vi.mocked(api.claimState).mockImplementation(async () => { senderSends(); return { ok: true, value: SENT }; });
    const stopped = await press(deps({ api, wallet }));
    expect(stopped).toMatchObject({ phase: 'stopped', step: 'claim', line: refusalLine(refusal), retry: true, done: ['wallet'] });
    expect(wallet.asked).toEqual([]);
    const end = await press(deps({ api, wallet }));
    expect(end.phase).toBe('done');
    expect(api.claimMessage).toHaveBeenCalledTimes(2);
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it('a sign-out or a removal during the claim wait ends the run at once with its own line; a lapsed sign-in leads with the sign-in', async () => {
    const signedOut = { ok: false as const, status: 401, error: 'sign in required' };
    const removed = { ok: false as const, status: 403, error: 'approval required' };
    for (const [answer, now, line] of [
      [signedOut, null, refusalLine(signedOut)],
      [removed, 'removed', JOIN_WORDS.removed],
      [removed, 'pending', CLAIM_WORDS.notApproved],
    ] as const) {
      resetSetupForTests();
      window.localStorage.clear();
      clock.now = 0;
      const { api } = server();
      vi.mocked(api.claimState).mockResolvedValue(answer);
      if (now !== null) vi.mocked(api.me).mockResolvedValueOnce({ ok: true, value: { status: 'approved', handle: 'tester', claim: null } }).mockResolvedValueOnce({ ok: true, value: { status: now, handle: 'tester', claim: null } });
      const end = await press(deps({ api, wallet: walletDouble() }));
      expect(end, `${answer.status} ${now}`).toMatchObject({ phase: 'stopped', step: 'coins', line, signIn: answer.status === 401 ? 'ours' : null, retry: answer.status === 401 });
      expect(clock.now).toBeLessThan(60_000);
      expect(api.claimState).toHaveBeenCalledTimes(1);
      // Not this device's end: a later approval offers the setup again.
      expect(readSetupHint('tester')?.state).toBe('started');
    }
  });

  it('a claim still queued after a quarter of an hour stops with “Still queued” and Try again; the next press signs nothing again', async () => {
    const wallet = walletDouble();
    const { api } = server({ states: [receipt('queued')] });
    const stopped = await press(deps({ api, wallet }));
    expect(stopped).toMatchObject({ phase: 'stopped', step: 'coins', line: SETUP_WORDS.stillQueued, retry: true });
    expect(clock.now).toBeGreaterThanOrEqual(15 * 60_000);
    // The next visit's press: our server holds the queued claim, so nothing is signed or claimed again.
    vi.mocked(api.me).mockResolvedValue({ ok: true, value: { status: 'approved', handle: 'tester', claim: receipt('queued') } });
    vi.mocked(api.claimState).mockImplementation(async () => { senderSends(); return { ok: true, value: SENT }; });
    const end = await press(deps({ api, wallet }));
    expect(end.phase).toBe('done');
    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(wallet.asked.filter(({ method }) => method === 'personal_sign')).toHaveLength(1);
  });

  it('a claim the sender sent to another wallet brings no coins here: stopped at the coins, no Try again', async () => {
    senderSends(OTHER);
    ours();
    const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'coins', line: SETUP_WORDS.otherWallet, retry: false });
    expect(chain.submitted).toEqual([]);
  });

  it('the chain cannot be read: stopped at the coins with the chain’s line and Try again (a failed read is never zero)', async () => {
    chain.down = true;
    ours();
    const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'coins', line: tradeLine('rpc_failed'), retry: true, figures: null });
  });

  it('coins the chain does not show in time: stopped at the coins, Try again', async () => {
    // Sent, by the receipt, to this wallet; but the node read shows neither the admission nor the SepETH yet.
    chain.txs.set(SEND, { hash: SEND, from: OTHER, to: MADE.address, nonce: '0x7', input: '0x', value: '0x1', gas: '0x5208', blockNumber: null, blockHash: null });
    ours();
    const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(end).toMatchObject({ phase: 'stopped', step: 'coins', line: SETUP_WORDS.coinsLate, retry: true });
  });

  it('a drip the faucet card has under way for the account is followed to its end, never sent a second time', async () => {
    senderSends();
    const slot = sendKey(CHAIN, MADE.address);
    beginInFlight(slot, { sent: { step: 'trade', plan: {} as never, call: { to: TETH, data: '0x9f678cca', value: 0n }, gasLimit: 480_000n }, asking: false,
      track: { nonceBefore: 0n, hash: DRIP_TX, quietReads: 0, quietSince: null } });
    // The card's drip: mined by the time the run looks for its receipt, and its tETH with it.
    chain.receipts.set(DRIP_TX, { transactionHash: DRIP_TX, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x21', status: '0x1', from: MADE.address, to: TETH, gasUsed: '0x5208', logs: [] });
    chain.onReceipt = () => { chain.teth = DRIP; chain.nextDripAt = NOW + 86_400n; chain.block = 0x21n; };
    ours();
    const end = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(end.phase).toBe('done');
    expect(end.figures).toEqual({ sepEth: 5n * 10n ** 16n, teth: DRIP });
    expect(chain.prepared).toEqual([]);
    expect(chain.submitted).toEqual([]);
    expect(inFlightOf(slot)).toBeNull();
  });

  it('a send of the account still pending at the node (another tab’s drip, or one from before a reload) is never sent behind; once it lands it counts', async () => {
    senderSends();
    ours();
    chain.pending = 1n;
    // The other tab's drip lands a few looks later: the chain shows its tETH and the faucet's next drip.
    let looks = 0;
    const timed = { ...timing, sleep: async (ms: number) => {
      if (ms === 1_500 && (looks += 1) === 3) Object.assign(chain, { pending: 0n, nonce: 1n, teth: DRIP, nextDripAt: NOW + 86_400n, block: 0x22n });
      await timing.sleep(ms);
    } };
    const end = await press({ ...deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }), timing: timed });
    expect(end.phase).toBe('done');
    expect(chain.submitted).toEqual([]);
    expect(inFlightOf(sendKey(CHAIN, MADE.address))).toBeNull();
    // Still pending after the receipt wait: the hold's own line, and nothing sent.
    resetSetupForTests();
    Object.assign(chain, { pending: 1n, nonce: 0n, teth: 0n, nextDripAt: 0n });
    const held = await press(deps({ api: server({ claim: SENT }).api, wallet: walletDouble() }));
    expect(held).toMatchObject({ phase: 'stopped', step: 'teth', line: tradeLine('earlier_send'), retry: true });
    expect(chain.submitted).toEqual([]);
  });

  it('one run at a time: a second press while one runs joins it', async () => {
    const { api } = server({ claim: SENT });
    senderSends();
    chain.teth = DRIP;
    ours();
    const input = deps({ api, wallet: walletDouble() });
    const first = runSetup(input);
    const second = runSetup(input);
    expect(second).toBe(first);
    await first;
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('Close puts an end away; the next press counts as a new run', async () => {
    senderSends();
    chain.teth = DRIP;
    ours();
    const input = deps({ api: server({ claim: SENT }).api, wallet: walletDouble() });
    expect((await press(input)).phase).toBe('done');
    closeSetup();
    expect(setupState()).toMatchObject({ phase: 'idle', run: 1, claim: null, figures: null });
    expect((await press(input)).run).toBe(2);
  });
});
