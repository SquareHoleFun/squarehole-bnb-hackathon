/**
 * Chain transaction flow (Stage C) as rendered: `useTxFlow({ chain })` + `TxStatusPanel` over the real executor, a fake
 * EIP-1193 node and a fake browser wallet. Every state comes from the domain reducer; only `finalized` shows success.
 */
import { createLaunchInputFromDraft, createChainReader, localChain, type CreateLaunchInput } from '@squarehole/chain/write';
import { ACCOUNT_A, ACCOUNT_B, FAKE, FakeChain, FakeSquareHole, FakeWallet } from '@squarehole/chain/write/test-support';
import type { LaunchDraft } from '@squarehole/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shAsyncUtilTimeout } from '../../../../../vitest.timeouts.mjs';
import { BROWSER_WALLET_ID, WalletProvider, createDemoWalletAdapter, createInjectedWalletAdapter, useWallet, type WalletContextValue } from '../wallet';
import { TxFlowConfigProvider, TxStatusPanel, chainClaimAsTSpec, chainCreateLaunchSpec, useTxFlow, type ChainTxSpec, type TxFlow } from '.';

const draft: LaunchDraft = {
  schemaVersion: '1.0',
  mode: 'live',
  chainId: 31337,
  assetType: 'nft_collection',
  name: 'Flow Test',
  symbol: 'FLOW',
  quoteAddress: FAKE.weth,
  rewardSide: 'Q',
  feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
  feePolicyStatus: 'draft',
  headlineFeeTargetBps: 300,
  qProtocolShareNumerator: 1,
  qProtocolShareDenominator: 3,
  nftUnitRaw: '1000000000000000000000',
  collectionSize: '100',
  metadataManifestHash: `0x${'77'.repeat(32)}`,
  rootTokenAddress: null,
  rootNFTAddress: null,
  externalRouteState: 'unverified',
  productionAuthorized: false,
};

const live = {} as { wallet: WalletContextValue; flow: TxFlow };

function Harness({ spec, onFallback }: { spec: ChainTxSpec; onFallback?: () => void }) {
  const wallet = useWallet();
  const flow = useTxFlow({ kind: spec.deadlineSeconds === null ? 'create' : 'claim', label: 'Test request', requiredChainId: 31337, chain: spec });
  useEffect(() => {
    live.wallet = wallet;
    live.flow = flow;
  });
  return (
    <>
      <button type="button" onClick={flow.start}>
        Start request
      </button>
      <TxStatusPanel state={flow.state} successContent={<p>Verified on chain.</p>} onRequestQFallback={onFallback} />
    </>
  );
}

interface Setup {
  chain: FakeChain;
  sh: FakeSquareHole;
  wallet: FakeWallet;
}

async function setup(makeSpec: (env: Setup) => ChainTxSpec, options: { walletChainId?: number; demo?: boolean; onFallback?: () => void } = {}): Promise<Setup> {
  const chain = new FakeChain();
  const sh = new FakeSquareHole(chain);
  const wallet = new FakeWallet(chain, [ACCOUNT_A], { chainId: options.walletChainId ?? 31337 });
  const target = Object.assign(new EventTarget(), { ethereum: wallet });
  const env = { chain, sh, wallet };
  render(
    <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} injectedAdapter={createInjectedWalletAdapter({ target: target as unknown as Window, storage: null })} defaultDialog="browser" targetChainId={31337}>
      <TxFlowConfigProvider value={{ stepMs: 0, now: Date.now }}>
        <Harness spec={makeSpec(env)} onFallback={options.onFallback} />
      </TxFlowConfigProvider>
    </WalletProvider>,
  );
  if (options.demo) await act(() => live.wallet.connect('current_holder'));
  else await act(() => live.wallet.connectBrowserWallet(BROWSER_WALLET_ID));
  wallet.requests = [];
  return env;
}

const target = (env: Setup, overrides: Partial<ReturnType<typeof localChain>> = {}) => ({
  writeChain: { ...localChain({ confirmations: 2 }), pollIntervalMs: 5, receiptTimeoutMs: 300, ...overrides },
  deployment: env.sh.deployment,
  reader: createChainReader(env.chain.request),
});
const launchSpec = (env: Setup, input: CreateLaunchInput = createLaunchInputFromDraft(draft), overrides: Partial<ReturnType<typeof localChain>> = {}) =>
  chainCreateLaunchSpec(target(env, overrides), input);
/**
 * SH-238: the executor's receipt timeout runs in real time. A test whose transaction is to be INCLUDED gives it room
 * (`INCLUDED_MS`): with the fixture's 300 ms, this file's first test ended `timed_out` before its first block was read
 * (full gate ac of 18 November 2026, on a loaded machine). The timeout test keeps its own short limit. `SETTLED` and
 * `TIMED_OUT` are the waits for finality and for the timeout, raised with the slower-machine opt-in like the other waits.
 */
const INCLUDED_MS = 30_000;
const SETTLED = { timeout: Math.max(3_000, shAsyncUtilTimeout() ?? 0), interval: 20 };
const TIMED_OUT = { timeout: Math.max(2_000, shAsyncUtilTimeout() ?? 0) };

const panel = () => document.querySelector<HTMLElement>('[data-tx-status]') as HTMLElement;
const status = () => panel().dataset.txStatus;
const click = (name: string | RegExp) => act(async () => void fireEvent.click(screen.getByRole('button', { name })));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('chain transaction flow (useTxFlow + TxStatusPanel)', () => {
  it('create: simulate → review (details, network fee) → one wallet request on Confirm → … → finalized and verified', async () => {
    const env = await setup((e) => launchSpec(e, undefined, { receiptTimeoutMs: INCLUDED_MS }));
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    const review = within(screen.getByTestId('chain-signature-request'));
    expect(review.getByText('Network fee').nextElementSibling?.textContent).toMatch(/^≈ 0\.00011 ETH \(local test\) \(at most 0\.000252 ETH \(local test\)\)/);
    expect(review.getByText('Collection bound').nextElementSibling?.textContent).toBe('100 of at most 10000 NFTs on this template');
    expect(within(panel()).getByText('Local anvil chain transaction')).toBeTruthy();
    expect(env.wallet.requests).toEqual([]); // nothing reached the wallet before the click
    await click('Confirm in wallet');
    await waitFor(() => expect(env.wallet.sent).toHaveLength(1));
    expect(env.wallet.requests).toHaveLength(3); // chain id and accounts re-checked, then the one transaction request
    const seen = new Set<string>();
    await waitFor(
      () => {
        seen.add(status() ?? '');
        env.chain.mine();
        expect(status()).toBe('finalized');
      },
      SETTLED,
    );
    expect(seen.has('confirmed_unfinalized') || seen.has('pending') || seen.has('submitted')).toBe(true);
    expect(screen.getByText('Verified on chain.')).toBeTruthy();
    expect(live.flow.chain?.result).toMatchObject({ name: 'Flow Test', symbol: 'FLOW', rewardSide: 'Q' });
    expect(within(panel()).queryByRole('link')).toBeNull(); // no explorer for the local chain
  });

  it('the wallet declines (4001) → rejected, nothing tracked', async () => {
    const env = await setup((e) => launchSpec(e));
    env.wallet.sendBehaviour = 'reject';
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    await click('Confirm in wallet');
    await waitFor(() => expect(status()).toBe('rejected'));
  });

  it('a wallet error keeps the request open with the error shown; confirming again sends', async () => {
    const env = await setup((e) => launchSpec(e));
    env.wallet.sendBehaviour = 'error';
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    await click('Confirm in wallet');
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toMatch(/Internal JSON-RPC error/));
    expect(status()).toBe('awaiting_signature');
    env.wallet.sendBehaviour = 'send';
    await click('Confirm in wallet');
    await waitFor(() => expect(env.wallet.sent).toHaveLength(2));
    await waitFor(() => expect(['submitted', 'pending', 'timed_out']).toContain(status()));
    expect(within(panel()).getByText('Transaction hash')).toBeTruthy();
  });

  it('SH-SEND-FEES: a fee that rose since it was shown is shown again first; a wallet short of gas reads the gas line', async () => {
    const env = await setup((e) => launchSpec(e));
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    env.chain.baseFee *= 3n;
    await click('Confirm in wallet');
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toBe('The network fee went up. Check it and confirm again.'));
    expect(env.wallet.sent).toHaveLength(0);
    env.chain.balances.set(env.wallet.accounts[0]?.toLowerCase() ?? '', 1n);
    await click('Confirm in wallet');
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toBe('Needs a little more ETH for gas.'));
    expect(env.wallet.sent).toHaveLength(0);
    expect(status()).toBe('awaiting_signature');
  });

  it('wrong chain: a described switch, then the request is simulated for the right chain', async () => {
    const env = await setup((e) => launchSpec(e), { walletChainId: 11_155_111 });
    await click('Start request');
    expect(status()).toBe('wrong_chain');
    await click('Switch to Local anvil chain (31337)');
    expect(env.wallet.requests).toContain('wallet_switchEthereumChain');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
  });

  it('an account change before signing invalidates the request (nothing is sent)', async () => {
    const env = await setup((e) => launchSpec(e));
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    act(() => env.wallet.setAccounts([ACCOUNT_B]));
    expect(panel()).toMatchObject({ dataset: { txStatus: 'invalidated' } });
    expect(env.wallet.sent).toEqual([]);
  });

  it('the claimAsT deadline passing before signing invalidates the request (quote expired)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await setup((e) => {
      const pair = e.sh.addPair('T');
      e.sh.setClaimable(pair, ACCOUNT_A, 1_000n);
      return chainClaimAsTSpec(target(e), pair.token);
    });
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    expect(within(screen.getByTestId('chain-signature-request')).getByText('Signed minimum').nextElementSibling?.textContent).toMatch(/^1980 raw T/);
    await act(async () => void vi.advanceTimersByTime(20 * 60_000 + 1_000));
    expect(panel()).toMatchObject({ dataset: { txStatus: 'invalidated' } });
    expect(within(panel()).getByRole('status').textContent).toMatch(/Quote expired/);
  });

  it('the sample wallet cannot sign a chain request: a notice, no preparation, no wallet request', async () => {
    await setup((e) => launchSpec(e), { demo: true });
    await click('Start request');
    expect(status()).toBe('idle');
    expect(within(panel()).getByRole('alert').textContent).toMatch(/the sample wallet cannot sign it/);
  });

  it('sold out: conversion refused; the Q fallback is only offered as a separate button the person must click', async () => {
    const onFallback = vi.fn();
    await setup(
      (e) => {
        const pair = e.sh.addPair('T');
        e.sh.setClaimable(pair, ACCOUNT_A, 1_000n);
        e.sh.soldOut.add(pair.token.toLowerCase());
        return chainClaimAsTSpec(target(e), pair.token);
      },
      { onFallback },
    );
    await click('Start request');
    await waitFor(() => expect(status()).toBe('simulation_failed'));
    const offer = screen.getByTestId('q-fallback-offer');
    expect(offer.textContent).toMatch(/A different payout is available/);
    expect(onFallback).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(offer).getByRole('button', { name: 'Request the emergency payout in Q instead' })));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('no receipt before the timeout → timed_out with "Re-check by hash", which tracks a late inclusion to finality', async () => {
    const env = await setup((e) => chainCreateLaunchSpec(target(e, { receiptTimeoutMs: 60 }), createLaunchInputFromDraft(draft)));
    await click('Start request');
    await waitFor(() => expect(status()).toBe('awaiting_signature'));
    await click('Confirm in wallet');
    await waitFor(() => expect(env.wallet.sent).toHaveLength(1));
    const held = env.chain.mempool.splice(0); // the node loses sight of it
    await waitFor(() => expect(status()).toBe('timed_out'), TIMED_OUT);
    expect(within(panel()).getByRole('status').textContent).toMatch(/No confirmation yet/);
    env.chain.mempool.push(...held);
    // SH-238: the late inclusion happens before the re-check. The re-check starts the same short receipt timeout again,
    // and on a slow machine it could run out before the wait below mines its first block.
    env.chain.mine();
    await click('Re-check by hash');
    await waitFor(
      () => {
        env.chain.mine();
        expect(status()).toBe('finalized');
      },
      SETTLED,
    );
  });
});
