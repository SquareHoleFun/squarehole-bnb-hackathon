/**
 * The executor against a fake EIP-1193 node and wallet, with every emitted event fed through the domain `txReducer`
 * (so each transition the executor reports is one the state machine accepts): simulation (fee, revert decoding),
 * submission (4001 reject, wallet errors, wrong chain or account at signing, the sendable-call gate) and tracking
 * (inclusion → finality, reorgs, replacement by nonce, timeout and re-check by hash, unknown after read failures,
 * reverted receipts with a decoded reason, receipt verification).
 */
import { TX_IDLE, txReducer, type TxEvent, type TxHash, type TxState } from '@squarehole/domain';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { squareHoleLauncherAbi as launcherAbi } from '../abi/squareHoleLauncher';
import { localChain, SEPOLIA_WRITE_CHAIN, type WriteChain } from './chains';
import { claimCall, createLaunchCall, NotSendableError, type WriteCall } from './calls';
import type { WriteDeployment } from './deployment';
import {
  InsufficientGasFundsError, MIN_PRIORITY_FEE_WEI, TxTracker, tipCapOf, WalletContextChangedError, WalletRejectedError, WalletRequestError, readSendFees,
  sendCostCap, sendFeesOf, simulateWrite, submitWrite, type ReplacementInfo, type TrackerEnd,
} from './executor';
import type { WriteVerifier } from './prepared';
import { RpcRequestError, createChainReader } from './rpc';
import { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeRpcError, FakeWallet, revertData } from './test-support/fake-chain';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS, testFeeReader } from './test-support/index';

const LAUNCHER = '0x00000000000000000000000000000000000001a0' as const;
const LEDGER = '0x00000000000000000000000000000000000001e0' as const;
const DEPLOYMENT: WriteDeployment = Object.freeze({
  schema: 'squarehole.deployment/v1',
  chainId: 31337,
  registry: '0x00000000000000000000000000000000000001b0',
  launcher: LAUNCHER,
  converter: '0x00000000000000000000000000000000000001c0',
  hook: '0x0000000000000000000000000000000000002a60',
  poolManager: '0x00000000000000000000000000000000000001d0',
  treasury: '0x00000000000000000000000000000000000000f0',
  registryAdmin: '0x00000000000000000000000000000000000000f0',
  templates: [],
  testnetMockQuotes: [],
  startBlock: 0n,
  endBlock: 0n,
});
const CHAIN: WriteChain = Object.freeze({ ...localChain({ confirmations: 2 }), pollIntervalMs: 1_000, receiptTimeoutMs: 10_000 });

const launchCall = (): WriteCall =>
  createLaunchCall(DEPLOYMENT, {
    kind: 1,
    name: 'Test Collection',
    symbol: 'TEST',
    units: 10n,
    fractionsPerNft: 1_000n,
    templateVersion: 1,
    payoutAsset: 0,
    baseURI: '',
    metadataManifestHash: `0x${'11'.repeat(32)}`,
  });

function submittedState(hash: TxHash, chainId = 31337): TxState {
  const ctx = { kind: 'create_launch' as const, chainId, account: ACCOUNT_A, deadline: null };
  let state = txReducer(TX_IDLE, { type: 'prepare', ctx, walletChainId: chainId });
  state = txReducer(state, { type: 'simulate_ok' });
  return txReducer(state, { type: 'sign', hash });
}

interface Tracked {
  end: TrackerEnd | 'stuck';
  events: TxEvent[];
  statuses: string[];
  state: TxState;
  replacement: ReplacementInfo | null;
  result: unknown;
  tracker: TxTracker;
}

/** Runs a tracker; `steps[i]` mutates the chain during the i-th wait (the default is a no-op). */
function track(
  chain: FakeChain,
  hash: TxHash,
  steps: ((i: number) => void)[],
  options: { verify?: WriteVerifier; writeChain?: WriteChain; maxSleeps?: number; nonceHint?: bigint; call?: WriteCall } = {},
): Promise<Tracked> {
  let state = submittedState(hash, chain.chainId);
  const statuses = [state.status as string];
  const events: TxEvent[] = [];
  let clock = 0;
  let sleeps = 0;
  let replacement: ReplacementInfo | null = null;
  let result: unknown = null;
  const writeChain = options.writeChain ?? CHAIN;
  return new Promise((resolve) => {
    const done = (end: TrackerEnd | 'stuck') => resolve({ end, events, statuses, state, replacement, result, tracker });
    const tracker: TxTracker = new TxTracker({
      reader: createChainReader(chain.request),
      chain: writeChain,
      hash,
      from: ACCOUNT_A,
      startBlock: chain.head.number,
      verify: options.verify ?? null,
      nonceHint: options.nonceHint ?? null,
      call: options.call ?? null,
      emit: (event) => {
        events.push(event);
        const next = txReducer(state, event);
        if (next === state) throw new Error(`illegal event ${event.type} in ${state.status}`);
        state = next;
        statuses.push(state.status);
      },
      onReplacement: (info) => {
        replacement = info;
      },
      onResult: (value) => {
        result = value;
      },
      onEnd: (end) => {
        if (end !== 'stopped') done(end);
      },
      now: () => clock,
      sleep: async () => {
        clock += writeChain.pollIntervalMs;
        steps[sleeps]?.(sleeps);
        sleeps += 1;
        if (sleeps > (options.maxSleeps ?? 200)) {
          tracker.stop();
          done('stuck');
        }
      },
    });
    tracker.start();
  });
}

/** Sends `call` from ACCOUNT_A through the fake wallet; returns the hash. */
async function send(chain: FakeChain, wallet = new FakeWallet(chain, [ACCOUNT_A]), call = launchCall()): Promise<TxHash> {
  return submitWrite({ feeReader: createChainReader(chain.request), wallet: wallet.request, deployment: DEPLOYMENT, call, expectedLedger: null, from: ACCOUNT_A, gasLimit: 120_000n });
}

describe('simulateWrite', () => {
  it('returns the gas estimate, a buffered limit and a network fee estimate', async () => {
    const chain = new FakeChain();
    chain.onCall(LAUNCHER, launcherAbi, 'createLaunch', () => [`0x${'22'.repeat(32)}`, ACCOUNT_B]);
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.simulation.gasEstimate).toBe(100_000n);
    expect(result.simulation.gasLimit).toBe(120_000n);
    expect(result.simulation.fee).toEqual({
      baseFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      maxFeePerGas: 2_100_000_000n,
      expectedFeeWei: 100_000n * 1_100_000_000n,
      maxFeeWei: 120_000n * 2_100_000_000n,
    });
    expect(chain.log).toEqual(expect.arrayContaining(['eth_call', 'eth_estimateGas']));
  });

  it('reports the fee as unavailable (null, never zero) when the fee reads fail', async () => {
    const chain = new FakeChain();
    chain.onCall(LAUNCHER, launcherAbi, 'createLaunch', () => [`0x${'22'.repeat(32)}`, ACCOUNT_B]);
    chain.failing.set('eth_maxPriorityFeePerGas', new FakeRpcError(-32601, 'method not found'));
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(result.ok && result.simulation.fee).toBeNull();
  });

  it.each([
    ['CollectionTooLarge', [20_000n, 10_000n], /at most 10000 \(ADR-0011 §4\)/, 'CollectionTooLarge(20000, 10000)'],
    ['InsufficientOutput', [5n, 9n], /below the signed minimum of 9 raw T/, 'InsufficientOutput(5, 9)'],
    ['Expired', [1_790_000_000n], /quote deadline has passed/, 'Expired(1790000000)'],
    ['TemplateInactive', [3], /template 3 is retired/, 'TemplateInactive(3)'],
    ['NothingToClaim', [], /nothing to claim/, 'NothingToClaim()'],
  ])('decodes a %s revert into an explanation and keeps the original error', async (name, args, explanation, original) => {
    const chain = new FakeChain();
    chain.reverts.set(LAUNCHER.toLowerCase(), revertData(name, args));
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(explanation);
    expect(result.reason).toContain(`[${original}]`);
    expect(result.revert?.name).toBe(name);
  });

  it('unwraps an ERC-7751 WrappedError from the hook down to PoolOutflowAtFeeEvent', async () => {
    const chain = new FakeChain();
    const inner = revertData('PoolOutflowAtFeeEvent', [7n]);
    const wrapped = revertData('WrappedError', [DEPLOYMENT.hook, '0xb47b2fb1', inner, revertData('HookCallFailed')]);
    chain.reverts.set(LAUNCHER.toLowerCase(), wrapped);
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.revert?.name).toBe('WrappedError');
    expect(result.revert?.inner?.name).toBe('PoolOutflowAtFeeEvent');
    expect(result.reason).toMatch(/flash-outflow guard/);
    expect(result.reason).toContain('[PoolOutflowAtFeeEvent(7)]');
  });

  it('decodes require strings and panics; unknown selectors fall back to the node message', async () => {
    const chain = new FakeChain();
    const reader = createChainReader(chain.request);
    chain.reverts.set(LAUNCHER.toLowerCase(), '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b63616c6c206661696c6564000000000000000000000000000000000000000000');
    let result = await simulateWrite(reader, CHAIN, launchCall(), ACCOUNT_A);
    expect(!result.ok && result.reason).toMatch(/Reverted: call failed/);
    chain.reverts.set(LAUNCHER.toLowerCase(), '0x4e487b710000000000000000000000000000000000000000000000000000000000000011');
    result = await simulateWrite(reader, CHAIN, launchCall(), ACCOUNT_A);
    expect(!result.ok && result.reason).toMatch(/arithmetic overflow/);
    chain.reverts.set(LAUNCHER.toLowerCase(), '0xdeadbeef');
    result = await simulateWrite(reader, CHAIN, launchCall(), ACCOUNT_A);
    expect(!result.ok && result.reason).toMatch(/without a known reason/);
  });

  it('an unreachable RPC is a failed simulation that says so (never a success)', async () => {
    const chain = new FakeChain();
    chain.failing.set('eth_call', new Error('fetch failed'));
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/could not be read from the chain.*nothing was sent/);
  });

  it('refuses a transaction above the EIP-7825 per-transaction gas cap', async () => {
    const chain = new FakeChain();
    chain.onCall(LAUNCHER, launcherAbi, 'createLaunch', () => [`0x${'22'.repeat(32)}`, ACCOUNT_B]);
    chain.gasEstimate = 16_777_217n;
    const result = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    expect(!result.ok && result.reason).toMatch(/EIP-7825/);
  });
});

describe('submitWrite', () => {
  it('sends exactly one eth_sendTransaction with the call, zero value and the gas limit', async () => {
    const chain = new FakeChain();
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    const hash = await send(chain, wallet);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wallet.sent).toEqual([{ from: ACCOUNT_A, to: LAUNCHER, data: launchCall().data, value: '0x0', gas: '0x1d4c0', ...TEST_SEND_FEE_FIELDS, chainId: '0x7a69' }]);
    expect(wallet.requests).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  });

  it('names the chain in the transaction, so a wallet switched after the check refuses instead of signing elsewhere', async () => {
    const chain = new FakeChain();
    const wallet = new FakeWallet(chain, [ACCOUNT_A], { knownChains: [31_337, 11_155_111] });
    const request = wallet.request;
    // The wallet answers the chain check on 31337, then switches to Sepolia before the send arrives.
    wallet.request = async (args) => {
      const answer = await request(args);
      if (args.method === 'eth_accounts') wallet.setChain(11_155_111);
      return answer;
    };
    await expect(send(chain, wallet)).rejects.toThrow(/chainId/);
    expect(chain.mempool).toEqual([]);
  });

  it('4001 is a rejection; other wallet errors and non-hash answers are wallet errors', async () => {
    const chain = new FakeChain();
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    wallet.sendBehaviour = 'reject';
    await expect(send(chain, wallet)).rejects.toBeInstanceOf(WalletRejectedError);
    wallet.sendBehaviour = 'error';
    await expect(send(chain, wallet)).rejects.toThrow(/Internal JSON-RPC error/);
    wallet.sendBehaviour = 'garbage';
    await expect(send(chain, wallet)).rejects.toBeInstanceOf(WalletRequestError);
  });

  it('refuses to send when the wallet moved to another chain or account before signing', async () => {
    const chain = new FakeChain();
    const onSepolia = new FakeWallet(chain, [ACCOUNT_A], { chainId: 11_155_111 });
    await expect(send(chain, onSepolia)).rejects.toMatchObject({ change: 'chain', walletChainId: 11_155_111 });
    const otherAccount = new FakeWallet(chain, [ACCOUNT_B]);
    await expect(send(chain, otherAccount)).rejects.toBeInstanceOf(WalletContextChangedError);
    expect(onSepolia.sent).toEqual([]);
    expect(otherAccount.sent).toEqual([]);
  });

  it('never sends a call outside the allowlist (wrong target, other selector, value)', async () => {
    const chain = new FakeChain();
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    const call = launchCall();
    await expect(send(chain, wallet, { ...call, to: ACCOUNT_B })).rejects.toBeInstanceOf(NotSendableError);
    await expect(send(chain, wallet, { ...call, data: `0xa9059cbb${call.data.slice(10)}` as Hex })).rejects.toBeInstanceOf(NotSendableError);
    await expect(send(chain, wallet, { ...call, value: 1n as 0n })).rejects.toBeInstanceOf(NotSendableError);
    const claim = claimCall(LEDGER, ACCOUNT_A);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, wallet: wallet.request, deployment: DEPLOYMENT, call: claim, expectedLedger: ACCOUNT_B, from: ACCOUNT_A, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet.sent).toEqual([]);
  });
});

describe('TxTracker', () => {
  it('submitted → pending → included (1 confirmation) → finalized after N confirmations on anvil', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const run = await track(chain, hash, [() => undefined, () => chain.mine(), () => chain.mineEmpty(), () => chain.mineEmpty()]);
    expect(run.end).toBe('finalized');
    expect(run.statuses).toEqual(['submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(run.state).toMatchObject({ status: 'finalized', block: '1', hash });
  });

  it('never reports finality from a hash or a single confirmation', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const run = await track(chain, hash, [() => chain.mine()], { maxSleeps: 8 });
    expect(run.end).toBe('stuck');
    expect(run.state.status).toBe('confirmed_unfinalized');
  });

  it('Sepolia policy: finalized only once the `finalized` tag reaches the receipt block', async () => {
    const chain = new FakeChain(11_155_111);
    chain.finalizedDepth = 3n;
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    const hash = await submitWrite({ feeReader: TEST_FEE_READER, wallet: wallet.request, deployment: { ...DEPLOYMENT, chainId: 11_155_111 }, call: launchCall(), expectedLedger: null, from: ACCOUNT_A, gasLimit: 1n });
    const sepolia = { ...SEPOLIA_WRITE_CHAIN, pollIntervalMs: 1_000 };
    const run = await track(chain, hash, [() => chain.mine(), () => chain.mineEmpty(), () => chain.mineEmpty(), () => chain.mineEmpty()], { writeChain: sepolia });
    expect(run.end).toBe('finalized');
    expect(run.events.filter((e) => e.type === 'finalized')).toHaveLength(1);
    expect(chain.log).toContain('eth_getBlockByNumber');
  });

  it('reorg: a receipt that disappears returns to pending, then re-inclusion finalizes', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const run = await track(chain, hash, [
      () => chain.mine(),
      () => chain.reorg(1),
      () => chain.mineEmpty(),
      () => chain.mine(),
      () => chain.mineEmpty(),
      () => chain.mineEmpty(),
    ]);
    expect(run.end).toBe('finalized');
    expect(run.statuses).toEqual(['submitted', 'pending', 'confirmed_unfinalized', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(run.state).toMatchObject({ status: 'finalized', block: '2' });
  });

  it('reorg: a receipt that moves to another block hash is a reorg too', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const run = await track(chain, hash, [
      () => chain.mine(),
      () => {
        chain.reorg(1);
        chain.mine();
      },
      () => chain.mineEmpty(),
      () => chain.mineEmpty(),
      () => chain.mineEmpty(),
    ]);
    expect(run.end).toBe('finalized');
    expect(run.events.map((e) => e.type)).toContain('reorged');
    expect(run.statuses.filter((s) => s === 'confirmed_unfinalized')).toHaveLength(2);
  });

  it('replacement (speed-up): the same call at the same nonce with another hash → replaced, kind repriced', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const original = chain.mempool[0];
    if (!original) throw new Error('not in mempool');
    const run = await track(chain, hash, [
      () => {
        chain.mempool = [];
        chain.submit({ from: ACCOUNT_A, to: original.to, input: original.input, value: 0n, gas: original.gas, nonce: original.nonce });
        chain.mine();
      },
    ]);
    expect(run.end).toBe('replaced');
    expect(run.state.status).toBe('replaced');
    expect(run.replacement?.kind).toBe('repriced');
    expect(run.state).toMatchObject({ newHash: run.replacement?.hash });
  });

  it('replacement (cancel): an empty self-transfer at the same nonce → replaced, kind cancelled', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const nonce = chain.mempool[0]?.nonce ?? 0n;
    const run = await track(chain, hash, [
      () => {
        chain.mempool = [];
        chain.submit({ from: ACCOUNT_A, to: ACCOUNT_A, input: '0x', value: 0n, gas: 21_000n, nonce });
        chain.mine();
      },
    ]);
    expect(run.end).toBe('replaced');
    expect(run.replacement?.kind).toBe('cancelled');
  });

  it('a speed-up before the RPC ever saw our tx: only a same-call tx at the hinted nonce counts as its replacement', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const original = chain.mempool[0];
    if (!original) throw new Error('not in mempool');
    chain.mempool = [];
    chain.submit({ from: ACCOUNT_A, to: original.to, input: original.input, value: 0n, gas: original.gas, nonce: original.nonce });
    chain.mine();
    const sameCall = await track(chain, hash, [], { nonceHint: original.nonce, call: launchCall() });
    expect(sameCall.end).toBe('replaced');
    expect(sameCall.replacement?.kind).toBe('repriced');

    const chain2 = new FakeChain();
    const hash2 = await send(chain2);
    const nonce = chain2.mempool[0]?.nonce ?? 0n;
    chain2.mempool = [];
    chain2.submit({ from: ACCOUNT_A, to: ACCOUNT_B, input: '0x', value: 5n, gas: 21_000n, nonce });
    chain2.mine();
    const other = await track(chain2, hash2, [], { nonceHint: nonce, call: launchCall() });
    expect(other.end).toBe('timed_out'); // an unrelated tx at the hinted nonce proves nothing about ours
  });

  it('timeout without a receipt → timed_out; "re-check by hash" later tracks the late inclusion to finality', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    chain.mempool = []; // the node never sees it (dropped from this RPC's view)
    const first = await track(chain, hash, []);
    expect(first.end).toBe('timed_out');
    expect(first.state.status).toBe('timed_out');
    // The transaction lands after all (e.g. re-broadcast by the wallet); re-check by hash resumes tracking.
    chain.submit({ from: ACCOUNT_A, to: LAUNCHER, input: launchCall().data, value: 0n, gas: 1n, hash });
    chain.mine();
    chain.mineEmpty(2);
    let state = first.state;
    const statuses: string[] = [];
    await new Promise<void>((resolve) => {
      const tracker = new TxTracker({
        reader: createChainReader(chain.request),
        chain: CHAIN,
        hash,
        from: ACCOUNT_A,
        startBlock: 0n,
        verify: null,
        emit: (event) => {
          const next = txReducer(state, event);
          if (next !== state) statuses.push(next.status);
          state = next;
        },
        onEnd: (end) => {
          if (end === 'timed_out') tracker.recheck();
          else resolve();
        },
        now: () => 0,
        sleep: async () => undefined,
      });
      // Simulate the earlier timeout on this instance, then the person's "Re-check".
      tracker['end'] = 'timed_out';
      tracker.recheck();
    });
    expect(statuses).toEqual(['confirmed_unfinalized', 'finalized']);
  });

  it('repeated read failures before a receipt → unknown with the RPC error; a hash is never success', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    chain.failing.set('eth_getTransactionReceipt', new FakeRpcError(-32005, 'rate limited'));
    const run = await track(chain, hash, []);
    expect(run.end).toBe('unknown');
    expect(run.state).toMatchObject({ status: 'unknown' });
    expect(run.state.status === 'unknown' && run.state.reason).toMatch(/rate limited/);
  });

  it('a reverted receipt → reverted with the reason recovered by replaying the call', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    chain.statusFor.set(LAUNCHER.toLowerCase(), 'reverted');
    const run = await track(chain, hash, [
      () => {
        chain.mine();
        chain.reverts.set(LAUNCHER.toLowerCase(), revertData('CollectionTooLarge', [20_000n, 10_000n]));
      },
    ]);
    expect(run.end).toBe('reverted');
    expect(run.state.status === 'reverted' && run.state.reason).toMatch(/at most 10000/);
  });

  it('a receipt that fails the writer’s check is unknown at inclusion, and at finality it is never finalized', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const rejectAll: WriteVerifier = async () => ({ ok: false, reason: 'PairCreated does not match the request: quote' });
    const atInclusion = await track(chain, hash, [() => chain.mine()], { verify: rejectAll });
    expect(atInclusion.end).toBe('unknown');
    expect(atInclusion.state.status === 'unknown' && atInclusion.state.reason).toMatch(/could not be verified: PairCreated does not match the request: quote/);

    const chain2 = new FakeChain();
    const hash2 = await send(chain2);
    const onlyAtFinality: WriteVerifier = async (_r, _reader, stage) => (stage === 'included' ? { ok: true, result: 'ok' } : { ok: false, reason: 'registry record differs' });
    const atFinality = await track(chain2, hash2, [() => chain2.mine(), () => chain2.mineEmpty(), () => chain2.mineEmpty()], { verify: onlyAtFinality });
    expect(atFinality.end).toBe('unknown');
    expect(atFinality.statuses).toEqual(['submitted', 'pending', 'confirmed_unfinalized', 'pending', 'unknown']);
    expect(atFinality.events.some((e) => e.type === 'finalized')).toBe(false);
  });

  it('hands the verified result over only at finality', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const verify: WriteVerifier = async (_r, _reader, stage) => ({ ok: true, result: { stage } });
    const run = await track(chain, hash, [() => chain.mine(), () => chain.mineEmpty(), () => chain.mineEmpty()], { verify });
    expect(run.end).toBe('finalized');
    expect(run.result).toEqual({ stage: 'finalized' });
  });

  it('stop() ends tracking silently (no further events)', async () => {
    const chain = new FakeChain();
    const hash = await send(chain);
    const events: TxEvent[] = [];
    const tracker = new TxTracker({
      reader: createChainReader(chain.request),
      chain: CHAIN,
      hash,
      from: ACCOUNT_A,
      startBlock: 0n,
      verify: null,
      emit: (e) => events.push(e),
      sleep: async () => {
        tracker.stop();
        chain.mine();
      },
    });
    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracker.ended).toBe('stopped');
    expect(events.map((e) => e.type)).not.toContain('included');
  });
});

describe('SH-SEND-FEES: every send carries the app\'s EIP-1559 fee', () => {
  // Sepolia on 2026-11-02: base fee about 0.0005 gwei, eth_maxPriorityFeePerGas 0.000472652 gwei.
  const SEPOLIA_BASE = 500_000n;
  const SEPOLIA_TIP = 472_652n;
  const SEPOLIA = 11_155_111;

  it('sendFeesOf: twice the base fee plus the tip; a tip under 0.01 gwei (zero included) is raised to it', () => {
    expect(MIN_PRIORITY_FEE_WEI).toBe(10_000_000n);
    expect(sendFeesOf(SEPOLIA_BASE, SEPOLIA_TIP, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 11_000_000n });
    expect(sendFeesOf(1_000_000_000n, 0n, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 2_010_000_000n });
    expect(sendFeesOf(1_000_000_000n, 2_000_000_000n, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 4_000_000_000n });
    expect(sendCostCap(10n, sendFeesOf(1n, 0n, SEPOLIA), 5n)).toBe(10n * 10_000_002n + 5n);
  });

  it('the RPC\'s tip is capped: on Sepolia at 2 gwei and at twice the base fee, never below the floor; elsewhere at 5 gwei', () => {
    // A spike on a quiet Sepolia (base fee 16 wei): the cap is the floor.
    expect(tipCapOf(SEPOLIA, 16n)).toBe(MIN_PRIORITY_FEE_WEI);
    expect(sendFeesOf(16n, 3_000_000_000n, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 10_000_032n });
    // A busy Sepolia: twice the base fee, up to 2 gwei.
    expect(sendFeesOf(500_000_000n, 3_000_000_000n, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n });
    expect(sendFeesOf(5_000_000_000n, 3_000_000_000n, SEPOLIA)).toEqual({ maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 12_000_000_000n });
    expect(sendFeesOf(5_000_000_000n, 9_000_000_000n, 1)).toEqual({ maxPriorityFeePerGas: 5_000_000_000n, maxFeePerGas: 15_000_000_000n });
    expect(tipCapOf(1, 100_000_000n)).toBe(200_000_000n);
  });

  it('sends maxFeePerGas and maxPriorityFeePerGas as hex quantities read from the app RPC, never a gasPrice', async () => {
    const chain = new FakeChain();
    chain.baseFee = SEPOLIA_BASE;
    chain.tip = SEPOLIA_TIP;
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    await send(chain, wallet);
    expect(wallet.sent).toEqual([{ from: ACCOUNT_A, to: LAUNCHER, data: launchCall().data, value: '0x0', gas: '0x1d4c0', maxFeePerGas: '0xa7d8c0', maxPriorityFeePerGas: '0x989680', chainId: '0x7a69' }]);
    expect(wallet.sent[0]).not.toHaveProperty('gasPrice');
    // The fee and balance reads went to the app's RPC; the wallet was asked its chain, its account and the send only.
    expect(wallet.requests).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
    expect(chain.log).toEqual(expect.arrayContaining(['eth_getBlockByNumber', 'eth_maxPriorityFeePerGas', 'eth_getBalance']));
  });

  // The executor sends a given fee as it is; runChainWrite gives it the higher of the shown and a fresh read (run.test.ts).
  it('a given fee (the one shown with the simulation) is sent as it is', async () => {
    const chain = new FakeChain();
    chain.baseFee = SEPOLIA_BASE;
    chain.tip = 0n;
    chain.onCall(LAUNCHER, launcherAbi, 'createLaunch', () => [`0x${'22'.repeat(32)}`, ACCOUNT_B]);
    const simulated = await simulateWrite(createChainReader(chain.request), CHAIN, launchCall(), ACCOUNT_A);
    if (!simulated.ok || simulated.simulation.fee === null) throw new Error('no simulation fee');
    const { fee, gasLimit, gasEstimate } = simulated.simulation;
    expect(fee).toEqual({ baseFeePerGas: SEPOLIA_BASE, maxPriorityFeePerGas: MIN_PRIORITY_FEE_WEI, maxFeePerGas: 11_000_000n,
      expectedFeeWei: gasEstimate * (SEPOLIA_BASE + MIN_PRIORITY_FEE_WEI), maxFeeWei: gasLimit * 11_000_000n });
    chain.baseFee = 7n * SEPOLIA_BASE;
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    await submitWrite({ feeReader: createChainReader(chain.request), fee, wallet: wallet.request, deployment: DEPLOYMENT, call: launchCall(), expectedLedger: null, from: ACCOUNT_A, gasLimit });
    const sent = wallet.sent as { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; gas: Hex }[];
    expect(sent.map((tx) => [BigInt(tx.maxFeePerGas), BigInt(tx.maxPriorityFeePerGas), BigInt(tx.gas)])).toEqual([[fee.maxFeePerGas, fee.maxPriorityFeePerGas, gasLimit]]);
    expect(sent.map((tx) => BigInt(tx.gas) * BigInt(tx.maxFeePerGas))).toEqual([fee.maxFeeWei]);
  });

  it('an account that cannot hold gasLimit × maxFeePerGas (+ value, sendCostCap) is told so before the wallet is asked', async () => {
    const chain = new FakeChain();
    const wallet = new FakeWallet(chain, [ACCOUNT_A]);
    const need = sendCostCap(120_000n, await readSendFees(createChainReader(chain.request), 31337), 0n);
    chain.balances.set(ACCOUNT_A.toLowerCase(), need - 1n);
    const refused = send(chain, wallet);
    await expect(refused).rejects.toBeInstanceOf(InsufficientGasFundsError);
    await expect(refused).rejects.toBeInstanceOf(WalletRequestError);
    await expect(refused).rejects.toMatchObject({ need, balance: need - 1n, chainId: 31337, message: expect.stringMatching(/insufficient funds/i) });
    expect(wallet.requests).toEqual([]);
    expect(chain.mempool).toEqual([]);
    chain.balances.set(ACCOUNT_A.toLowerCase(), need);
    await expect(send(chain, wallet)).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    expect(wallet.requests).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  });

  it('a fee or balance the app RPC cannot answer, or a chain without a base fee, stops the send', async () => {
    for (const method of ['eth_maxPriorityFeePerGas', 'eth_getBalance', 'eth_getBlockByNumber']) {
      const chain = new FakeChain();
      chain.failing.set(method, new FakeRpcError(-32603, 'the node is down'));
      const wallet = new FakeWallet(chain, [ACCOUNT_A]);
      await expect(send(chain, wallet)).rejects.toBeInstanceOf(RpcRequestError);
      expect(wallet.requests).toEqual([]);
    }
    const noBaseFee = { ...testFeeReader(), getBlock: async () => ({ number: 1n, hash: `0x${'11'.repeat(32)}` as TxHash, timestamp: 0n, baseFeePerGas: null, transactions: [] }) };
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A]);
    await expect(submitWrite({ feeReader: noBaseFee, wallet: wallet.request, deployment: DEPLOYMENT, call: launchCall(), expectedLedger: null, from: ACCOUNT_A, gasLimit: 1n })).rejects.toBeInstanceOf(RpcRequestError);
    expect(wallet.requests).toEqual([]);
  });

  it('a given fee that is not a valid EIP-1559 fee is refused', async () => {
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A]);
    for (const fee of [{ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }, { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }]) {
      await expect(submitWrite({ feeReader: TEST_FEE_READER, fee, wallet: wallet.request, deployment: DEPLOYMENT, call: launchCall(), expectedLedger: null, from: ACCOUNT_A, gasLimit: 1n })).rejects.toBeInstanceOf(WalletRequestError);
    }
    expect(wallet.requests).toEqual([]);
  });
});
