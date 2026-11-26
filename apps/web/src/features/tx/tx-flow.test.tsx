import { DEMO_CHAIN_ID, DEMO_NOW, TX_STATUSES, parseIsoTimestamp, type TxContext, type TxState } from '@squarehole/domain';
import { DEMO_PERSONAS, MOCK_TX_SCRIPT_NAMES, createMockTxExecutor, mockTxHash, type MockTxScriptName } from '@squarehole/providers';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletProvider, createDemoWalletAdapter, useWallet, type WalletContextValue } from '../wallet';
import { DEMO_SCENARIO_LABELS, TxFlowConfigProvider, TxStatusPanel, setDemoTxScenario, useTxFlow, type TxFlow, type TxFlowOptions } from '.';

const STEP = 100;
const HOLDER = DEMO_PERSONAS[0]?.address ?? '0x00000000000000000000000000000000de000001';
const DEADLINE = '2026-09-25T12:20:00Z';
let clockMs = parseIsoTimestamp(DEMO_NOW);

// Latest hook values, published after each commit (tests read them between acts).
const live = {} as { wallet: WalletContextValue; flow: TxFlow };

function Harness({ options, success }: { options: TxFlowOptions; success?: ReactNode }) {
  const wallet = useWallet();
  const flow = useTxFlow(options);
  useEffect(() => {
    live.wallet = wallet;
    live.flow = flow;
  });
  return (
    <>
      <button type="button" onClick={flow.start}>
        Start request
      </button>
      <TxStatusPanel state={flow.state} successContent={success} />
    </>
  );
}

async function setup(options: Partial<TxFlowOptions> = {}, { connect = true, wrongNetwork = false } = {}) {
  const full: TxFlowOptions = { kind: 'claim', label: 'Claim ORCHARD fee share', requiredChainId: DEMO_CHAIN_ID, ...options };
  render(
    <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <TxFlowConfigProvider value={{ stepMs: STEP, now: () => clockMs }}>
        <Harness options={full} success={<p>Claim settled (demo).</p>} />
      </TxFlowConfigProvider>
    </WalletProvider>,
  );
  if (connect) await act(() => live.wallet.connect('current_holder', { chainId: wrongNetwork ? 1 : DEMO_CHAIN_ID }));
}

const panel = () => document.querySelector<HTMLElement>('[data-tx-status]') as HTMLElement;
const status = () => panel().dataset.txStatus;
const statusText = () => within(panel()).getByRole('status').textContent ?? '';
const step = (ms = STEP) => act(async () => void vi.advanceTimersByTime(ms));
const click = (name: string | RegExp) => act(async () => void fireEvent.click(screen.getByRole('button', { name })));
const start = () => click('Start request');

/** Advances step by step, signing whenever the demo wallet asks; returns the distinct statuses rendered. */
async function drive(maxSteps = 12): Promise<string[]> {
  const seen = [status() ?? ''];
  for (let i = 0; i < maxSteps; i += 1) {
    const sign = screen.queryByRole('button', { name: 'Sign' });
    if (sign) await act(async () => void fireEvent.click(sign));
    else await step();
    const current = status() ?? '';
    if (current !== seen[seen.length - 1]) seen.push(current);
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  clockMs = parseIsoTimestamp(DEMO_NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setDemoTxScenario('success');
  window.sessionStorage.clear();
});

const SIGNED = ['preparing', 'awaiting_signature', 'submitted', 'pending'];

describe('useTxFlow + TxStatusPanel: every mock script as rendered', () => {
  const cases: [MockTxScriptName, string[]][] = [
    ['success', [...SIGNED, 'confirmed_unfinalized', 'finalized']],
    ['reject', ['preparing', 'awaiting_signature', 'rejected']],
    ['simulation_fail', ['preparing', 'simulation_failed']],
    ['revert', [...SIGNED, 'reverted']],
    ['min_out_revert', [...SIGNED, 'reverted']],
    ['replace', [...SIGNED, 'replaced']],
    ['wrong_chain', ['wrong_chain']],
    ['timeout', [...SIGNED, 'timed_out']],
    ['status_unknown', [...SIGNED, 'unknown']],
    ['reorg', [...SIGNED, 'confirmed_unfinalized', 'pending', 'confirmed_unfinalized', 'finalized']],
    ['deadline_expiry', ['preparing', 'awaiting_signature', 'invalidated']],
    ['account_change', ['preparing', 'awaiting_signature', 'invalidated']],
  ];

  it.each(cases)('%s', async (script, expected) => {
    await setup({ script, deadline: DEADLINE });
    await start();
    expect(await drive()).toEqual(expected);
  });

  it('wrong_chain_then_switch: the switch button re-simulates, then the request can be signed to finality', async () => {
    await setup({ script: 'wrong_chain_then_switch' });
    await start();
    expect(status()).toBe('wrong_chain');
    expect(statusText()).toContain('The wallet is on Ethereum (1), but this request is for Local chain (31337)');
    await click('Switch to Local chain (31337)');
    expect(screen.getByRole('button', { name: 'Switching…' })).toHaveProperty('disabled', true);
    expect(live.flow.isBusy).toBe(true);
    expect(await drive()).toEqual(['wrong_chain', 'preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('wrong_chain: a declined switch is explained, and the request can be cancelled', async () => {
    await setup({ script: 'wrong_chain' });
    await start();
    await click('Switch to Local chain (31337)');
    expect(screen.getByRole('alert').textContent).toContain('declined the network switch');
    expect(status()).toBe('wrong_chain');
    await click('Cancel request');
    expect(status()).toBe('idle');
    expect(live.flow.isBusy).toBe(false);
  });

  it('simulation_failed / reverted: honest reasons and "Start again"', async () => {
    await setup({ script: 'min_out_revert' });
    await start();
    await drive();
    expect(status()).toBe('reverted');
    expect(statusText()).toContain('Your claim is still intact');
    expect(panel().textContent).toContain('The payout would have been below the signed minimum. (min_payout_not_met)');
    expect(panel().textContent).not.toContain('Claim settled');
    await click('Start again');
    expect(status()).toBe('preparing');
  });
});

describe('honest copy (UI-08)', () => {
  it('a hash is never success; only finalized shows the success content', async () => {
    await setup({ script: 'success' });
    expect(live.flow.isSuccess).toBe(false);
    await start();
    await step();
    expect(status()).toBe('awaiting_signature');
    const request = screen.getByRole('group', { name: 'Wallet request' });
    expect(request.textContent).toContain('Signs nothing: signing here only moves the scenario forward.');
    expect(request.textContent).toContain('Claim ORCHARD fee share · from 0x0000…0001 on Local chain (31337)');
    await click('Sign');
    expect(status()).toBe('submitted');
    expect(statusText()).toContain('A hash is not a confirmation');
    expect(panel().textContent).toContain(mockTxHash(1));
    for (const next of ['pending', 'confirmed_unfinalized']) {
      expect(live.flow.isSuccess).toBe(false);
      expect(live.flow.isBusy).toBe(true);
      expect(panel().textContent).not.toContain('Claim settled');
      expect(panel().dataset.tone).toBe('waiting');
      await step();
      expect(status()).toBe(next);
    }
    expect(statusText()).toContain('could still be reorganised out');
    await step();
    expect(status()).toBe('finalized');
    expect(live.flow.isSuccess).toBe(true);
    expect(live.flow.isBusy).toBe(false);
    expect(panel().dataset.tone).toBe('success');
    expect(panel().textContent).toContain('Claim settled (demo).');
    expect(panel().textContent).toContain('Block39601');
  });

  it('renders every status of the state machine with its own copy; success tone only when finalized', () => {
    const ctx: TxContext = { kind: 'claim', chainId: DEMO_CHAIN_ID, account: HOLDER, deadline: DEADLINE };
    const states = new Map<string, TxState>();
    for (const script of MOCK_TX_SCRIPT_NAMES) {
      for (const state of createMockTxExecutor({ script }).run(ctx).states) states.set(state.status, state);
    }
    states.set('idle', { status: 'idle' });
    expect([...states.keys()].sort()).toEqual([...TX_STATUSES].sort());
    const titles = new Set<string>();
    for (const state of states.values()) {
      const { container, unmount } = render(<TxStatusPanel state={state} successContent={<p>SUCCESS-CONTENT</p>} />);
      const root = container.querySelector<HTMLElement>('[data-tx-status]') as HTMLElement;
      expect(root.dataset.txStatus).toBe(state.status);
      // F130: the sample transaction's own words, no Demo or mock word (the package's MOCK_TX_LABEL is not shown).
      expect(root.textContent).toContain('Nothing is signed or sent.');
      expect(root.textContent).toContain('Transaction');
      expect(root.textContent?.match(/.{0,40}(?<![a-z])(?:demo|mock)(?![a-z]).{0,40}/i)?.[0] ?? null, state.status).toBeNull();
      expect(root.dataset.tone === 'success').toBe(state.status === 'finalized');
      expect(root.textContent?.includes('SUCCESS-CONTENT')).toBe(state.status === 'finalized');
      if ('hash' in state) expect(root.textContent).toContain(state.hash);
      const said = within(root).getByRole('status').textContent ?? '';
      if (state.status !== 'finalized') expect(said).not.toMatch(/\bsuccess(ful)?\b|\bcompleted?\b|\bconfirmed\b(?! yet)/i);
      titles.add(within(root).getByRole('status').querySelector('.sh-tx__title')?.textContent ?? '');
      unmount();
    }
    expect(titles.size).toBe(TX_STATUSES.length);
  });
});

describe('wallet changes and deadlines', () => {
  it('an account change in the wallet before signing invalidates the request', async () => {
    await setup({ script: 'success' });
    await start();
    await step();
    expect(status()).toBe('awaiting_signature');
    await act(() => live.wallet.connect('past_holder'));
    expect(status()).toBe('invalidated');
    expect(statusText()).toContain('The wallet account changed before signing');
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
  });

  it('a chain change in the wallet before signing invalidates the request', async () => {
    await setup({ script: 'success' });
    await start();
    expect(status()).toBe('preparing');
    await act(() => live.wallet.connect('current_holder', { chainId: 11155111 }));
    expect(status()).toBe('invalidated');
    expect(statusText()).toContain('The wallet changed networks before signing');
    await step(STEP * 3);
    expect(status()).toBe('invalidated'); // the pending simulation step was cancelled
  });

  it('after signing, wallet changes no longer touch the tracked transaction', async () => {
    await setup({ script: 'success' });
    await start();
    await step();
    await click('Sign');
    await act(() => live.wallet.connect('past_holder', { chainId: 1 }));
    act(() => live.wallet.disconnect());
    expect(await drive()).toEqual(['submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('a wallet that disconnects before signing drops the request (nothing was signed)', async () => {
    await setup({ script: 'success' });
    await start();
    await step();
    act(() => live.wallet.disconnect());
    expect(status()).toBe('idle');
    await step(STEP * 5);
    expect(status()).toBe('idle');
  });

  it('a real wrong network: the switch goes through the wallet, which then reports the right chain', async () => {
    await setup({ script: 'success' }, { wrongNetwork: true });
    await start();
    expect(status()).toBe('wrong_chain');
    await click('Switch to Local chain (31337)');
    expect(live.wallet.chainId).toBe(DEMO_CHAIN_ID);
    expect(status()).toBe('preparing');
    expect(await drive()).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('switching the wallet to the right chain by itself also resumes a wrong-chain request', async () => {
    await setup({ script: 'success' }, { wrongNetwork: true });
    await start();
    await act(() => live.wallet.switchChain(DEMO_CHAIN_ID));
    expect(status()).toBe('preparing');
  });

  it('the quote deadline passing while waiting for a signature invalidates the request', async () => {
    await setup({ script: 'success', deadline: DEADLINE });
    await start();
    await step();
    expect(status()).toBe('awaiting_signature');
    clockMs = parseIsoTimestamp(DEADLINE) - 1;
    await step(parseIsoTimestamp(DEADLINE) - parseIsoTimestamp(DEMO_NOW) - STEP - 1);
    expect(status()).toBe('awaiting_signature'); // one millisecond before the deadline
    clockMs = parseIsoTimestamp(DEADLINE);
    await step(1);
    expect(status()).toBe('invalidated');
    expect(statusText()).toContain('Quote expired');
  });

  it('an already expired quote is invalidated right away', async () => {
    clockMs = parseIsoTimestamp(DEADLINE) + 1_000;
    await setup({ script: 'success', deadline: DEADLINE });
    await start();
    await step(0);
    expect(status()).toBe('invalidated');
  });

  it('after signing, the deadline is the contract’s job: the flow keeps tracking', async () => {
    await setup({ script: 'success', deadline: DEADLINE });
    await start();
    await step();
    await click('Sign');
    clockMs = parseIsoTimestamp(DEADLINE) + 60_000;
    expect(await drive()).toEqual(['submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });
});

describe('controls', () => {
  it('start needs a connected wallet', async () => {
    await setup({}, { connect: false });
    await start();
    expect(status()).toBe('idle');
  });

  it('start is ignored while a request is open; reset cancels scripted steps', async () => {
    await setup({ script: 'success' });
    await start();
    await step();
    const waiting = live.flow.state;
    act(() => live.flow.start());
    expect(live.flow.state).toBe(waiting);
    act(() => live.flow.reject());
    expect(status()).toBe('rejected');
    act(() => live.flow.reset());
    expect(status()).toBe('idle');
    act(() => live.flow.start());
    act(() => live.flow.reset());
    await step(STEP * 5);
    expect(status()).toBe('idle');
  });

  it('create flows use the create_launch kind and their own copy', async () => {
    await setup({ kind: 'create', label: 'Create ORCHARD', script: 'revert' });
    await start();
    await drive();
    expect(live.flow.state.status === 'reverted' && live.flow.state.ctx.kind).toBe('create_launch');
    expect(statusText()).toContain('nothing was created');
  });

  it('deadline_expiry on a request without a deadline stays a normal, signable request', async () => {
    await setup({ kind: 'create', label: 'Create ORCHARD', script: 'deadline_expiry' });
    await start();
    expect(await drive()).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('the Demo scenario picker chooses the next request’s script and is hidden for fixed scripts', async () => {
    await setup();
    const picker = screen.getByRole('combobox', { name: 'Scenario' }) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual([...MOCK_TX_SCRIPT_NAMES]);
    expect([...picker.options].map((option) => option.textContent)).toEqual(MOCK_TX_SCRIPT_NAMES.map((name) => DEMO_SCENARIO_LABELS[name]));
    expect(picker.value).toBe('success');
    fireEvent.change(picker, { target: { value: 'simulation_fail' } });
    expect(window.sessionStorage.getItem('sh.sample-tx-scenario')).toBe('simulation_fail');
    await start();
    await step();
    expect(status()).toBe('simulation_failed');
    expect(panel().textContent).toContain('mock: simulation reverted');
    cleanup();
    await setup({ script: 'success' });
    expect(screen.queryByRole('combobox', { name: 'Scenario' })).toBeNull();
  });
});
