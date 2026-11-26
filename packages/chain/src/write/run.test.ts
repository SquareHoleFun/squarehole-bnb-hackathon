/**
 * runChainWrite: nothing reaches the wallet before the person confirms; refusals, simulation failures, rejection,
 * wallet errors (retry), wrong chain at signing and a hash that arrives after cancellation.
 */
import { TX_IDLE, txReducer, type TxEvent, type TxHash, type TxState } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { localChain } from './chains';
import { prepareClaim, prepareClaimAsT } from './claims';
import { PrepareRefusal } from './prepared';
import { createChainReader } from './rpc';
import { runChainWrite, type WalletErrorReason } from './run';
import type { Simulation } from './executor';
import { ACCOUNT_A, FakeChain, FakeWallet } from './test-support/fake-chain';
import { FakeSquareHole } from './test-support/fake-square-hole';

const CHAIN = Object.freeze({ ...localChain({ confirmations: 2 }), pollIntervalMs: 1, receiptTimeoutMs: 1_000 });

function harness() {
  const chain = new FakeChain();
  const sh = new FakeSquareHole(chain);
  const wallet = new FakeWallet(chain, [ACCOUNT_A]);
  const reader = createChainReader(chain.request);
  const pair = sh.addPair('Q');
  sh.setClaimable(pair, ACCOUNT_A, 50n);
  let state: TxState = txReducer(TX_IDLE, { type: 'prepare', ctx: { kind: 'claim', chainId: 31337, account: ACCOUNT_A, deadline: null }, walletChainId: 31337 });
  const events: TxEvent[] = [];
  const emit = (event: TxEvent) => {
    events.push(event);
    state = txReducer(state, event);
  };
  return { chain, sh, wallet, reader, pair, emit, events, state: () => state };
}

describe('runChainWrite', () => {
  it('asks the wallet nothing until the person confirms, then sends once and tracks the hash', async () => {
    const h = harness();
    let confirm: (value: 'send' | 'cancel') => void = () => undefined;
    const confirmation = new Promise<'send' | 'cancel'>((resolve) => {
      confirm = resolve;
    });
    let prepared = false;
    const running = runChainWrite({
      reader: h.reader,
      chain: CHAIN,
      deployment: h.sh.deployment,
      wallet: h.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, h.pair.token),
      signal: new AbortController().signal,
      sleep: async () => void h.chain.mine(),
      hooks: { emit: h.emit, awaitConfirmation: () => confirmation, onPrepared: () => (prepared = true) },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(prepared).toBe(true);
    expect(h.state().status).toBe('awaiting_signature');
    expect(h.wallet.requests).toEqual([]);
    confirm('send');
    const tracker = await running;
    expect(tracker).not.toBeNull();
    expect(h.wallet.requests.filter((m) => m === 'eth_sendTransaction')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.state().status).toBe('finalized');
  });

  it('a preparation refusal becomes simulation_failed and is handed to onRefusal (for a labelled alternative)', async () => {
    const h = harness();
    const t = h.sh.addPair('T');
    h.sh.setClaimable(t, ACCOUNT_A, 5n);
    h.sh.soldOut.add(t.token.toLowerCase());
    let refusal: PrepareRefusal | null = null;
    const tracker = await runChainWrite({
      reader: h.reader,
      chain: CHAIN,
      deployment: h.sh.deployment,
      wallet: h.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaimAsT({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, t.token, 2_000_000_000n),
      signal: new AbortController().signal,
      hooks: { emit: h.emit, awaitConfirmation: async () => 'send', onRefusal: (r) => (refusal = r) },
    });
    expect(tracker).toBeNull();
    expect(h.state().status).toBe('simulation_failed');
    expect((refusal as PrepareRefusal | null)?.fallback).toBe('claim_as_q_when_sold_out');
    expect(h.wallet.requests).toEqual([]);
  });

  it('4001 → rejected; a wallet error is shown and the person may confirm again; wrong chain at signing → invalidated', async () => {
    const h = harness();
    h.wallet.sendBehaviour = 'reject';
    await runChainWrite({
      reader: h.reader,
      chain: CHAIN,
      deployment: h.sh.deployment,
      wallet: h.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, h.pair.token),
      signal: new AbortController().signal,
      hooks: { emit: h.emit, awaitConfirmation: async () => 'send' },
    });
    expect(h.state().status).toBe('rejected');

    const h2 = harness();
    h2.wallet.sendBehaviour = 'error';
    const errors: string[] = [];
    let attempts = 0;
    const tracker = await runChainWrite({
      reader: h2.reader,
      chain: CHAIN,
      deployment: h2.sh.deployment,
      wallet: h2.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h2.reader, deployment: h2.sh.deployment, account: ACCOUNT_A }, h2.pair.token),
      signal: new AbortController().signal,
      sleep: async () => void h2.chain.mine(),
      hooks: {
        emit: h2.emit,
        awaitConfirmation: async () => {
          attempts += 1;
          if (attempts === 2) h2.wallet.sendBehaviour = 'send';
          return 'send';
        },
        onWalletError: (message) => errors.push(message),
      },
    });
    expect(errors).toEqual([expect.stringMatching(/Internal JSON-RPC error/)]);
    expect(tracker).not.toBeNull();
    expect(h2.state().status).toBe('submitted');

    const h3 = harness();
    h3.wallet.chainId = 11_155_111;
    await runChainWrite({
      reader: h3.reader,
      chain: CHAIN,
      deployment: h3.sh.deployment,
      wallet: h3.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h3.reader, deployment: h3.sh.deployment, account: ACCOUNT_A }, h3.pair.token),
      signal: new AbortController().signal,
      hooks: { emit: h3.emit, awaitConfirmation: async () => 'send' },
    });
    expect(h3.state()).toMatchObject({ status: 'invalidated', cause: 'chain_changed' });
    expect(h3.wallet.sent).toEqual([]);
  });

  it('a hash that arrives after the request was cancelled is reported, not tracked as this request', async () => {
    const h = harness();
    const controller = new AbortController();
    const late: TxHash[] = [];
    const original = h.wallet.request;
    h.wallet.request = async (args) => {
      if (args.method === 'eth_sendTransaction') controller.abort(); // the account changed while the prompt was open
      return original(args);
    };
    const tracker = await runChainWrite({
      reader: h.reader,
      chain: CHAIN,
      deployment: h.sh.deployment,
      wallet: h.wallet.request,
      account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, h.pair.token),
      signal: controller.signal,
      hooks: { emit: h.emit, awaitConfirmation: async () => 'send', onLateHash: (hash) => late.push(hash) },
    });
    expect(tracker).toBeNull();
    expect(late).toHaveLength(1);
    expect(h.events.map((e) => e.type)).not.toContain('sign');
  });

  it('SH-SEND-FEES: each press reads the fee again; a higher one is shown first, then sent; a lower one sends the shown fee', async () => {
    const h = harness();
    h.chain.baseFee = 1_000_000_000n;
    const presses: ((value: 'send' | 'cancel') => void)[] = [];
    const shown: Simulation[] = [];
    const errors: [string, WalletErrorReason | undefined][] = [];
    const running = runChainWrite({
      reader: h.reader, chain: CHAIN, deployment: h.sh.deployment, wallet: h.wallet.request, account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, h.pair.token),
      signal: new AbortController().signal, sleep: async () => void h.chain.mine(),
      hooks: { emit: h.emit, awaitConfirmation: () => new Promise((resolve) => { presses.push(resolve); }), onPrepared: (_p, simulation) => { shown.push(simulation); },
        onWalletError: (message, reason) => { errors.push([message, reason]); } },
    });
    const pressed = async (count: number) => { while (presses.length < count) await new Promise((r) => setTimeout(r, 2)); };
    await pressed(1);
    expect(shown.map((s) => s.fee?.maxFeePerGas)).toEqual([2_100_000_000n]);
    // The base fee doubled while the person waited: nothing is sent, the higher fee is shown and waits for a press.
    h.chain.baseFee = 2_000_000_000n;
    presses[0]?.('send');
    await pressed(2);
    expect(h.wallet.requests).toEqual([]);
    expect(errors).toEqual([['The network fee went up. Check it and confirm again.', 'fee_rose']]);
    expect(shown.map((s) => s.fee?.maxFeePerGas)).toEqual([2_100_000_000n, 4_100_000_000n]);
    expect(shown[1]?.fee?.maxFeeWei).toBe((shown[1]?.gasLimit ?? 0n) * 4_100_000_000n);
    // Then it fell: the press sends the higher of the shown and the fresh fee, the one shown.
    h.chain.baseFee = 500_000_000n;
    presses[1]?.('send');
    expect(await running).not.toBeNull();
    const sent = h.wallet.sent as { maxFeePerGas: string; maxPriorityFeePerGas: string }[];
    expect(sent.map((tx) => [BigInt(tx.maxFeePerGas), BigInt(tx.maxPriorityFeePerGas)])).toEqual([[4_100_000_000n, 100_000_000n]]);
  });

  it('SH-SEND-FEES: a wallet short of gas is reported with its reason and the chain, and may confirm again', async () => {
    const h = harness();
    h.chain.balances.set(ACCOUNT_A.toLowerCase(), 1n);
    const errors: (WalletErrorReason | undefined)[] = [];
    let presses = 0;
    const tracker = await runChainWrite({
      reader: h.reader, chain: CHAIN, deployment: h.sh.deployment, wallet: h.wallet.request, account: ACCOUNT_A,
      prepare: () => prepareClaim({ reader: h.reader, deployment: h.sh.deployment, account: ACCOUNT_A }, h.pair.token),
      signal: new AbortController().signal,
      hooks: { emit: h.emit, awaitConfirmation: async () => (presses++ === 0 ? 'send' : 'cancel'), onWalletError: (_m, reason) => { errors.push(reason); } },
    });
    expect(tracker).toBeNull();
    expect(errors).toEqual([{ kind: 'gas_funds', chainId: 31337 }]);
    expect(h.wallet.requests).toEqual([]);
  });
});
