/**
 * /rewards (SH-014, SH-015 part 2) through the whole app: the three demo personas and every M3 gate: a past holder
 * with zero balance claims prior earnings (ECO-05), a failed conversion keeps the claim intact with a retry (ECO-07),
 * a lost connection mid-flow, the wrong chain, a min-out revert, quote deadline expiry and a reorg back to pending.
 */
import { DEMO_PERSONAS, type MockTxScriptName } from '@squarehole/providers';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCopyFraming, renderedCopy, unnegatedReturnFraming } from '../features/legal/wording';
import { setDemoTxScenario } from '../features/tx';
import {
  claimButton,
  claimCard,
  click,
  connectAs,
  disconnect,
  driveClaim,
  expectNoAmountInputs,
  figure,
  flush,
  goTo,
  location,
  main,
  advance,
  renderM3,
  txPanel,
  txStatus,
} from '../test-support/m3';

const ORCHARD_ID = '31337:0x0000000000000000000000000000000000000066';
const ROUND_ID = '31337:0x0000000000000000000000000000000000000067';
const SIGNED = ['preparing', 'awaiting_signature', 'submitted', 'pending'];
const STEP = 100;
const PAST_ADDRESS = (DEMO_PERSONAS.find((persona) => persona.id === 'past_holder')?.address ?? '0x00000000000000000000000000000000de000002') as `0x${string}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDemoTxScenario('success');
  window.sessionStorage.clear();
  window.localStorage.clear();
});

async function open(path = '/rewards') {
  const app = renderM3(path, { legacy: true });
  await flush();
  return app;
}

async function chooseScenario(script: MockTxScriptName) {
  const select = within(main()).getByRole('combobox', { name: 'Scenario' }) as HTMLSelectElement;
  await act(async () => void fireEvent.change(select, { target: { value: script } }));
}

describe('disconnected (UI-09)', () => {
  it('explains what the page needs and offers an explicit Connect wallet button; nothing connects on its own', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Claims' })).toBeTruthy();
    const prompt = screen.getByRole('heading', { level: 2, name: 'Connect a wallet to see your claims' });
    expect(prompt).toBeTruthy();
    const button = within(main()).getByRole('button', { name: 'Connect wallet' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(main().querySelector('article')).toBeNull();
    await click(button);
    expect(screen.getByRole('dialog', { name: 'Sample wallet' })).toBeTruthy();
  });

  it('connecting from the page shows the rewards and moves focus to them', async () => {
    await open();
    await click(within(main()).getByRole('button', { name: 'Connect wallet' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Past holder' }));
    await click(within(dialog).getByRole('button', { name: 'Connect sample wallet' }));
    await flush();
    const heading = screen.getByRole('heading', { level: 2, name: 'Your claims' });
    expect(document.activeElement).toBe(heading);
  });
});

describe('the three personas', () => {
  it('past holder (zero balance): sees earlier earnings on both pairs, separately per asset (ECO-05)', async () => {
    await open();
    await connectAs('Past holder');
    expect(screen.getByTestId('account-bar').textContent).toContain('Past holder');
    expect(screen.getByTestId('account-bar').textContent).toContain('Read at block 39,600');
    const orchard = claimCard('ORCHARD');
    expect(within(orchard).getByText(/You hold no ORCH now/)).toBeTruthy();
    expect(figure(orchard, 'claimable')).toBe('9.705953 AAPLx-DEMO');
    expect(figure(orchard, 'claimed')).toBe('0 AAPLx-DEMO');
    expect(figure(orchard, 'earned')).toBe('9.705953 AAPLx-DEMO');
    expect(figure(orchard, 'pending')).toBe('0 AAPLx-DEMO');
    expect(claimButton(orchard).textContent).toBe('Claim 9.705953 AAPLx-DEMO');
    expect(claimButton(orchard).disabled).toBe(false);

    const frames = claimCard('TINY FRAMES');
    expect(figure(frames, 'claimable')).toBe('0.081574 WETH-DEMO');
    expect(figure(frames, 'claimed')).toBe('0.25 WETH-DEMO');
    const estimate = within(frames).getByTestId('conversion-estimate');
    expect(estimate.textContent).toContain('≈ 163.149767 FRAME');
    expect(estimate.textContent).toContain('161.518269 FRAME');
    expect(estimate.textContent).toContain('1% below the estimate: a fixed tolerance, not a setting');
    expect(estimate.textContent).not.toMatch(/demo (tolerance|quote)/i);
    expect(estimate.textContent).toContain('2,000 FRAME per WETH-DEMO');
    expect(estimate.textContent).toContain('quoted at block 39,600');
    expect(estimate.textContent).toContain('25 Sep 2026, 12:20 UTC');
    expect(within(frames).queryByTestId('emergency-settlement')).toBeNull();
    expect(claimButton(frames).textContent).toBe('Claim as FRAME');
    // History: one settled conversion and one min-out revert that consumed nothing.
    const history = within(frames).getByText(/Claim history/).closest('details') as HTMLElement;
    expect(history.textContent).toContain('Settled 0.25 WETH-DEMO, paid 500 FRAME');
    expect(history.textContent).toContain('Reverted: nothing was consumed or paid (The payout would have been below the signed minimum. (min_payout_not_met))');
    expect(main().textContent).toContain('2 pairs with amounts to claim');
    expectNoAmountInputs(main());
  });

  it('current holder: holdings, claimable, one earlier claim and pending harvest shown as not claimable', async () => {
    await open();
    await connectAs('Current holder');
    const orchard = claimCard('ORCHARD');
    expect(within(orchard).getByText(/You hold/).textContent).toBe('You hold 3.25 ORCH now.');
    expect(figure(orchard, 'claimable')).toBe('0.000811 AAPLx-DEMO');
    expect(figure(orchard, 'claimed')).toBe('0.013588 AAPLx-DEMO');
    expect(figure(orchard, 'earned')).toBe('0.0144 AAPLx-DEMO');
    expect(figure(orchard, 'pending')).toBe('0.00001 AAPLx-DEMO');
    expect(orchard.querySelector('[data-figure="pending"] dt')?.textContent).toContain('not claimable');
    // ROUND TRIP has no reward activity for this account, so it is not listed.
    expect(screen.queryByRole('heading', { level: 3, name: /^ROUND TRIP/ })).toBeNull();
    expect(main().textContent).toContain('2 with pending harvest (not claimable yet)');
  });

  it('never held: an honest empty state, no claim buttons', async () => {
    await open();
    await connectAs('Never held');
    expect(screen.getByTestId('rewards-empty').textContent).toContain('No claims on this account');
    expect(within(main()).queryAllByTestId('claim-button')).toEqual([]);
    // SEC staff FAQ Q2.5 wording rule (features/legal/wording.ts): the empty state explains fee credits as mechanics.
    // F23 safe wording: the whole page (named Claims) passes the app-copy check, too.
    expect(unnegatedReturnFraming(renderedCopy(screen.getByTestId('rewards-empty')))).toEqual([]);
    expect(screen.getByTestId('rewards-empty').textContent).toContain('A contract credits part of a pair’s fees to the addresses that hold it');
    expect(appCopyFraming(renderedCopy(main()))).toEqual([]);
  });

  it('?pair= preselects a pair; a pair without rewards shows "Nothing claimable yet" (disabled)', async () => {
    await open(`/rewards?pair=${ROUND_ID}`);
    await connectAs('Current holder');
    await flush();
    const cards = main().querySelectorAll('article');
    expect(cards[0]?.getAttribute('data-pair-id')).toBe(ROUND_ID);
    const round = claimCard('ROUND TRIP');
    expect(round.hasAttribute('data-selected')).toBe(true);
    expect(within(round).getByText('Selected from your link')).toBeTruthy();
    expect(claimButton(round).textContent).toBe('Nothing claimable yet');
    expect(claimButton(round).disabled).toBe(true);
    expect(within(round).getByText(/You hold/).textContent).toBe('You hold 1,500 ROUND now.');
  });

  it('?pair= puts a listed pair first; a malformed pair id is reported, not repaired', async () => {
    await open(`/rewards?pair=${ORCHARD_ID}`);
    await connectAs('Past holder');
    expect(main().querySelector('article')?.getAttribute('data-pair-id')).toBe(ORCHARD_ID);
    cleanup();
    await open('/rewards?pair=31337:0x1234');
    await connectAs('Past holder');
    expect(main().textContent).toContain('The pair in this link is not a valid pair id');
  });
});

describe('M3 gates', () => {
  it('past holder with zero balance claims prior earnings; only finalized counts, then it is consumed once (ECO-05, ECO-07)', async () => {
    await open();
    await connectAs('Past holder');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    expect(txStatus(card)).toBe('preparing');
    expect(claimButton(card).disabled).toBe(true);
    const seen = await driveClaim(card);
    expect(seen).toEqual([...SIGNED, 'confirmed_unfinalized', 'finalized']);
    await flush();
    const after = claimCard('ORCHARD');
    expect(figure(after, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(figure(after, 'claimed')).toBe('9.705953 AAPLx-DEMO');
    expect(figure(after, 'earned')).toBe('9.705953 AAPLx-DEMO');
    expect(claimButton(after).textContent).toBe('Nothing claimable yet');
    expect(claimButton(after).disabled).toBe(true);
    expect(within(txPanel(after) as HTMLElement).getByText(/Settled 9.705953 AAPLx-DEMO of credited fees, paid as 9.705953 AAPLx-DEMO/)).toBeTruthy();
    expect(after.textContent).toContain('Settled 9.705953 AAPLx-DEMO, paid 9.705953 AAPLx-DEMO');
    expect(screen.getByTestId('account-bar').textContent).toContain('Read at block 39,601');
  });

  it('R=T claim as T: the paid T lands in the portfolio as whole NFTs plus a fraction', async () => {
    await open();
    await connectAs('Past holder');
    const card = claimCard('TINY FRAMES');
    await click(claimButton(card));
    await advance(100);
    expect(within(card).getByText(/quote deadline 25 Sep 2026, 12:20 UTC/)).toBeTruthy();
    expect(await driveClaim(card)).toEqual(['awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
    await flush();
    expect(figure(claimCard('TINY FRAMES'), 'claimable')).toBe('0 WETH-DEMO');
    expect(within(claimCard('TINY FRAMES')).queryByTestId('conversion-estimate')).toBeNull();
    await goTo('/portfolio');
    await flush();
    const position = screen.getByRole('heading', { level: 3, name: /^TINY FRAMES/ }).closest('article') as HTMLElement;
    expect(position.querySelector('[data-figure="balance"] dd')?.textContent).toBe('163.149767 FRAME');
    expect(position.querySelector('[data-figure="representation"] dd')?.textContent).toContain('163 whole NFTs + 0.149767 FRAME, not yet a whole NFT');
  });

  it('min-out revert: the failed conversion keeps the claim intact, and the claim button (the one retry control) retries it', async () => {
    await open();
    await connectAs('Past holder');
    await chooseScenario('min_out_revert');
    const card = claimCard('TINY FRAMES');
    await click(claimButton(card));
    expect(await driveClaim(card)).toEqual([...SIGNED, 'reverted']);
    const panel = txPanel(card) as HTMLElement;
    expect(panel.textContent).toContain('Your claim is still intact.');
    expect(panel.textContent).toContain('The payout would have been below the signed minimum. (min_payout_not_met)');
    expect(figure(claimCard('TINY FRAMES'), 'claimable')).toBe('0.081574 WETH-DEMO');
    expect(claimButton(claimCard('TINY FRAMES')).disabled).toBe(false);
    // One retry control: the claim button. The panel does not offer a second "Start again".
    expect(within(panel).queryByRole('button', { name: 'Start again' })).toBeNull();
    await chooseScenario('success');
    await click(claimButton(claimCard('TINY FRAMES')));
    expect(await driveClaim(claimCard('TINY FRAMES'))).toEqual([...SIGNED, 'confirmed_unfinalized', 'finalized']);
    await flush();
    expect(figure(claimCard('TINY FRAMES'), 'claimable')).toBe('0 WETH-DEMO');
  });

  it('conversion unavailable: the labelled emergency settlement appears only then, and pays WETH-DEMO directly', async () => {
    await open('/rewards?scenario=conversion_fails');
    await connectAs('Past holder');
    const card = claimCard('TINY FRAMES');
    const fallback = within(card).getByTestId('emergency-settlement');
    expect(fallback.textContent).toContain('Emergency settlement: WETH-DEMO paid directly');
    expect(fallback.textContent).toContain('This is not the normal payout: you receive WETH-DEMO, not FRAME');
    expect(within(card).queryByTestId('conversion-estimate')).toBeNull();
    expect(claimButton(card).textContent).toBe('Claim 0.081574 WETH-DEMO directly');
    // R=Q pairs never show it.
    expect(within(claimCard('ORCHARD')).queryByTestId('emergency-settlement')).toBeNull();
    await click(claimButton(card));
    expect(within(card).getByRole('heading', { level: 4 }).textContent).toBe('Emergency claim: TINY FRAMES fee share in WETH-DEMO');
    expect(await driveClaim(card)).toEqual([...SIGNED, 'confirmed_unfinalized', 'finalized']);
    await flush();
    expect(claimCard('TINY FRAMES').textContent).toContain('Settled 0.081574 WETH-DEMO, paid 0.081574 WETH-DEMO');
    expect(within(claimCard('TINY FRAMES')).queryByTestId('emergency-settlement')).toBeNull();
    // Switching back to normal data shows the same settled ledger.
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'default' } }));
    await flush();
    expect(location()).toBe('/rewards');
    expect(figure(claimCard('TINY FRAMES'), 'claimable')).toBe('0 WETH-DEMO');
  });

  it('wrong chain: the wallet on Ethereum (1) reads rewards, and the claim offers an explicit switch first', async () => {
    await open();
    await connectAs('Past holder', { wrongNetwork: true });
    expect(screen.getByTestId('wrong-network-notice').textContent).toContain('Your wallet is on Ethereum (1)');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    expect(txStatus(card)).toBe('wrong_chain');
    expect(within(card).getByRole('status').textContent).toContain('The wallet is on Ethereum (1), but this request is for Local chain (31337)');
    await click(within(card).getByRole('button', { name: 'Switch to Local chain (31337)' }));
    await flush();
    expect(screen.queryByTestId('wrong-network-notice')).toBeNull();
    expect(await driveClaim(claimCard('ORCHARD'))).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('quote deadline expiry on the demo clock: an unsigned request is cancelled and the stale estimate disappears', async () => {
    const { clock } = await open();
    await connectAs('Past holder');
    const card = claimCard('TINY FRAMES');
    await click(claimButton(card));
    await advance(100);
    expect(txStatus(card)).toBe('awaiting_signature');
    // 20 minutes of demo time pass without a signature.
    clock.ms += 20 * 60 * 1000;
    await advance(20 * 60 * 1000);
    const panel = txPanel(claimCard('TINY FRAMES')) as HTMLElement;
    expect(panel.dataset.txStatus).toBe('invalidated');
    expect(panel.textContent).toContain('Quote expired');
    expect(panel.textContent).toContain('so nothing was signed. Refresh the estimate above, then claim again.');
    const after = claimCard('TINY FRAMES');
    expect(within(after).queryByTestId('conversion-estimate')).toBeNull();
    expect(within(after).getByTestId('needs-quote').textContent).toContain('No current quote.');
    expect(claimButton(after).textContent).toBe('Waiting for a current quote');
    expect(claimButton(after).disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: 'Start again' })).toBeNull();
    expect(figure(after, 'claimable')).toBe('0.081574 WETH-DEMO');
    // The control the panel points at exists; refreshing clears the lapsed request, and there is still no quote.
    await click(within(after).getByRole('button', { name: 'Refresh the estimate' }));
    await flush();
    expect(txStatus(claimCard('TINY FRAMES'))).toBe('idle');
    expect(within(claimCard('TINY FRAMES')).getByTestId('needs-quote').dataset.quoteCause).toBe('expired');
    expect(claimButton(claimCard('TINY FRAMES')).disabled).toBe(true);
  });

  it('quote deadline without a request: the card re-reads at the deadline and never shows the expired quote as current', async () => {
    const { clock } = await open();
    await connectAs('Past holder');
    expect(within(claimCard('TINY FRAMES')).getByTestId('conversion-estimate')).toBeTruthy();
    clock.ms += 20 * 60 * 1000 + 1;
    await advance(20 * 60 * 1000 + 2);
    const card = claimCard('TINY FRAMES');
    expect(card.dataset.claimAction).toBe('needs_quote');
    expect(within(card).queryByTestId('conversion-estimate')).toBeNull();
    expect(card.textContent).not.toContain('Minimum you sign');
    expect(claimButton(card).disabled).toBe(true);
  });

  it('deadline_expiry scenario: the card shows the same "No current quote" state as a real expiry until the estimate is refreshed', async () => {
    await open();
    await connectAs('Past holder');
    await chooseScenario('deadline_expiry');
    const card = claimCard('TINY FRAMES');
    await click(claimButton(card));
    expect(await driveClaim(card, 4)).toEqual(['preparing', 'awaiting_signature', 'invalidated']);
    const panel = txPanel(card) as HTMLElement;
    expect(panel.textContent).toContain('Refresh the estimate above, then claim again.');
    // The page does not contradict itself: no estimate, minimum or deadline shown as current, no second retry.
    const stale = claimCard('TINY FRAMES');
    expect(stale.dataset.claimAction).toBe('needs_quote');
    expect(within(stale).queryByTestId('conversion-estimate')).toBeNull();
    expect(within(stale).getByTestId('needs-quote').dataset.quoteCause).toBe('lapsed');
    expect(stale.textContent).not.toContain('Minimum you sign');
    expect(claimButton(stale).textContent).toBe('Waiting for a current quote');
    expect(claimButton(stale).disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: 'Start again' })).toBeNull();
    expect(figure(stale, 'claimable')).toBe('0.081574 WETH-DEMO');
    // Refreshing re-reads the quote (still current on the demo clock) and clears the lapsed request.
    await click(within(stale).getByRole('button', { name: 'Refresh the estimate' }));
    await flush();
    const fresh = claimCard('TINY FRAMES');
    expect(txStatus(fresh)).toBe('idle');
    expect(within(fresh).getByTestId('conversion-estimate')).toBeTruthy();
    expect(claimButton(fresh).textContent).toBe('Claim as FRAME');
    expect(claimButton(fresh).disabled).toBe(false);
  });

  it('reorg: included, back to pending, included again, then finalized; nothing before finalized is success', async () => {
    await open();
    await connectAs('Past holder');
    await chooseScenario('reorg');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    const seen: string[] = [];
    const blocks: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const sign = within(card).queryByRole('button', { name: 'Sign' });
      if (sign) await click(sign);
      else await advance(100);
      const status = txStatus(card);
      if (status !== seen.at(-1)) {
        seen.push(status);
        if (status === 'confirmed_unfinalized') blocks.push((txPanel(card) as HTMLElement).textContent?.match(/Included in block (\d+)/)?.[1] ?? '');
        if (status !== 'finalized') expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('9.705953 AAPLx-DEMO');
      }
    }
    expect(seen).toEqual(['awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'pending', 'confirmed_unfinalized', 'finalized']);
    expect(blocks).toEqual(['39601', '39602']);
    await flush();
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('0 AAPLx-DEMO');
    expect(claimCard('ORCHARD').textContent).toContain('block 39,602');
  });

  it('lost connection before signing: the request is dropped, nothing was sent, and the claim is intact on reconnect', async () => {
    await open();
    await connectAs('Past holder');
    await click(claimButton(claimCard('ORCHARD')));
    await advance(100);
    expect(txStatus(claimCard('ORCHARD'))).toBe('awaiting_signature');
    await disconnect();
    await flush();
    expect(screen.getByRole('heading', { level: 2, name: 'Connect a wallet to see your claims' })).toBeTruthy();
    expect(main().querySelector('article')).toBeNull();
    await connectAs('Past holder');
    expect(txStatus(claimCard('ORCHARD'))).toBe('idle');
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('9.705953 AAPLx-DEMO');
  });

  it('lost connection after signing: the sent claim stays tracked to its result, and nothing new can start', async () => {
    await open();
    await connectAs('Past holder');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    await advance(100);
    await click(within(card).getByRole('button', { name: 'Sign' }));
    expect(txStatus(card)).toBe('submitted');
    await disconnect();
    await flush();
    expect(screen.getByRole('heading', { level: 2, name: 'Wallet disconnected' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Claims still being tracked' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 3, name: /^TINY FRAMES/ })).toBeNull();
    const tracked = claimCard('ORCHARD');
    expect(claimButton(tracked).disabled).toBe(true);
    await advance(100);
    await advance(100);
    await advance(100);
    expect(txStatus(claimCard('ORCHARD'))).toBe('finalized');
    await flush();
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('0 AAPLx-DEMO');
    await connectAs('Past holder');
    expect(screen.getByRole('heading', { level: 3, name: /^TINY FRAMES/ })).toBeTruthy();
    expect(txStatus(claimCard('ORCHARD'))).toBe('finalized');
  });

  it('lost connection to the chain after sending: timeout and unknown status say to check the hash, keep the claim, and need a re-read before claiming again', async () => {
    await open();
    await connectAs('Past holder');
    for (const [script, status, text] of [
      ['timeout', 'timed_out', 'check its hash before trying again'],
      ['status_unknown', 'unknown', 'check its hash before trying again'],
    ] as const) {
      await chooseScenario(script);
      const card = claimCard('ORCHARD');
      await click(claimButton(card));
      expect((await driveClaim(card, 8)).at(-1)).toBe(status);
      expect((txPanel(card) as HTMLElement).textContent).toContain(text);
      expect(within(txPanel(card) as HTMLElement).queryByRole('button', { name: 'Start again' })).toBeNull();
      expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('9.705953 AAPLx-DEMO');
      // The earlier request may still be included: nothing new starts until the rewards are re-read.
      expect(claimButton(claimCard('ORCHARD')).disabled).toBe(true);
      await click(claimButton(claimCard('ORCHARD')));
      expect(txStatus(claimCard('ORCHARD'))).toBe(status);
      await click(within(claimCard('ORCHARD')).getByRole('button', { name: 'Re-read my claims' }));
      await flush();
      expect(within(claimCard('ORCHARD')).queryByTestId('needs-reread')).toBeNull();
      expect(claimButton(claimCard('ORCHARD')).disabled).toBe(false);
      expect(txStatus(claimCard('ORCHARD'))).toBe(status);
    }
  });

  it('account data unavailable: an explicit failure with a retry, never a zero', async () => {
    await open('/rewards?scenario=unavailable');
    await connectAs('Past holder');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Claims unavailable');
    expect(alert.textContent).toContain('a failed read is never shown as zero');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(main().querySelector('[data-figure]')).toBeNull();
  });

  it('switching persona while a request waits for a signature cancels it (nothing signed) and shows the new account', async () => {
    await open();
    await connectAs('Past holder');
    await click(claimButton(claimCard('ORCHARD')));
    await advance(100);
    await connectAs('Current holder');
    expect(screen.getByTestId('account-bar').textContent).toContain('Current holder');
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('0.000811 AAPLx-DEMO');
    expect(txStatus(claimCard('ORCHARD'))).toBe('idle');
  });
});

describe('a signed claim outlives its card (06-ARCHITECTURE; ADR-0008 §4; UI-08)', () => {
  const tracked = () => screen.getByTestId('tracked-claims');
  const trackedCard = (name: string) => {
    const heading = within(tracked()).getByRole('heading', { level: 3, name: new RegExp(`^${name}\\b`) });
    return heading.closest('article') as HTMLElement;
  };
  const listCard = (name: string) => {
    const list = screen.getByRole('region', { name: 'Your claims' });
    return within(list).getByRole('heading', { level: 3, name: new RegExp(`^${name}\\b`) }).closest('article') as HTMLElement;
  };

  async function signOrchardAsPastHolder() {
    await open();
    await connectAs('Past holder');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    await advance(STEP);
    await click(within(card).getByRole('button', { name: 'Sign' }));
    expect(txStatus(card)).toBe('submitted');
  }

  it('persona switch: the previous account’s sent claim stays tracked in its own section, and is not offered again', async () => {
    const { sources } = await signOrchardAsPastHolderWithSources();
    await connectAs('Current holder');
    // The new account's own list, with its own ORCHARD claim, idle.
    expect(within(screen.getByRole('region', { name: 'Your claims' })).getByTestId('account-bar').textContent).toContain('Current holder');
    expect(figure(listCard('ORCHARD'), 'claimable')).toBe('0.000811 AAPLx-DEMO');
    expect(txStatus(listCard('ORCHARD'))).toBe('idle');
    // The Past holder's signed claim: same request, still tracked, nothing new can start from it.
    expect(within(tracked()).getByRole('heading', { level: 2, name: 'Claims still being tracked' })).toBeTruthy();
    expect(within(tracked()).getByTestId('account-bar').textContent).toContain('Past holder');
    expect(within(tracked()).getByTestId('account-bar').textContent).toContain('(not the connected account)');
    expect(['submitted', 'pending']).toContain(txStatus(trackedCard('ORCHARD')));
    expect(claimButton(trackedCard('ORCHARD')).disabled).toBe(true);
    expect(trackedCard('ORCHARD').textContent).toContain('Switch back to this account to claim on it.');
    for (let i = 0; i < 4; i += 1) await advance(STEP);
    expect(txStatus(trackedCard('ORCHARD'))).toBe('finalized');
    expect(figure(trackedCard('ORCHARD'), 'claimable')).toBe('0 AAPLx-DEMO');
    expect(sources.settlements?.forOwner(PAST_ADDRESS)).toHaveLength(1);

    // Back to the Past holder: the same finalized request, consumed once, and not startable again.
    await connectAs('Past holder');
    expect(screen.queryByTestId('tracked-claims')).toBeNull();
    const back = claimCard('ORCHARD');
    expect(txStatus(back)).toBe('finalized');
    expect(figure(back, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(figure(back, 'claimed')).toBe('9.705953 AAPLx-DEMO');
    expect(claimButton(back).textContent).toBe('Nothing claimable yet');
    expect(claimButton(back).disabled).toBe(true);
    expect(sources.settlements?.forOwner(PAST_ADDRESS)).toHaveLength(1);
  });

  it('persona switch while pending, then back before it finishes: the card re-attaches to the running request', async () => {
    await signOrchardAsPastHolder();
    await connectAs('Current holder');
    await connectAs('Past holder');
    const card = claimCard('ORCHARD');
    expect(['submitted', 'pending']).toContain(txStatus(card));
    expect(claimButton(card).textContent).toBe('Claim in progress…');
    expect(figure(card, 'claimable')).toBe('9.705953 AAPLx-DEMO');
    expect((await driveClaim(card)).at(-1)).toBe('finalized');
    await flush();
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('0 AAPLx-DEMO');
  });

  it('a finished tracked claim can be hidden; the page then shows only the connected account', async () => {
    await signOrchardAsPastHolder();
    await connectAs('Current holder');
    expect(within(tracked()).queryByRole('button', { name: /^Hide the ORCHARD claim/ })).toBeNull();
    for (let i = 0; i < 4; i += 1) await advance(STEP);
    expect(txStatus(trackedCard('ORCHARD'))).toBe('finalized');
    await click(within(tracked()).getByRole('button', { name: 'Hide the ORCHARD claim from this list' }));
    expect(screen.queryByTestId('tracked-claims')).toBeNull();
    expect(claimCard('ORCHARD').textContent).toContain('0.000811 AAPLx-DEMO');
  });

  it('account-data scenario change: the list stays mounted (being re-read) and the sent claim keeps its status', async () => {
    await signOrchardAsPastHolder();
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'conversion_fails' } }));
    const card = claimCard('ORCHARD');
    expect(['submitted', 'pending']).toContain(txStatus(card));
    await flush();
    expect(location()).toBe('/rewards?scenario=conversion_fails');
    expect((await driveClaim(claimCard('ORCHARD'))).at(-1)).toBe('finalized');
    await flush();
    expect(figure(claimCard('ORCHARD'), 'claimable')).toBe('0 AAPLx-DEMO');
  });

  it('account data that never finishes loading: the previous cards stay (nothing can start), with the loading state beside them', async () => {
    await signOrchardAsPastHolder();
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'loading' } }));
    await flush();
    const list = screen.getByRole('region', { name: 'Your claims' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.textContent).toContain('Reading your claims… The figures below are the previous read.');
    expect(['submitted', 'pending']).toContain(txStatus(claimCard('ORCHARD')));
    const frames = claimCard('TINY FRAMES');
    expect(claimButton(frames).disabled).toBe(true);
    expect(frames.textContent).toContain('Wait for the new data to finish loading.');
  });

  it('account data unavailable after signing: the sent claim is listed on its own, and its result is kept when data returns', async () => {
    await signOrchardAsPastHolder();
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'unavailable' } }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Claims unavailable');
    const own = tracked();
    expect(own.dataset.trackedReason).toBe('unreadable');
    const panel = own.querySelector<HTMLElement>('[data-tx-status]');
    expect(['submitted', 'pending']).toContain(panel?.dataset.txStatus);
    for (let i = 0; i < 4; i += 1) await advance(STEP);
    expect(tracked().querySelector<HTMLElement>('[data-tx-status]')?.dataset.txStatus).toBe('finalized');
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'default' } }));
    await flush();
    const card = claimCard('ORCHARD');
    expect(txStatus(card)).toBe('finalized');
    expect(figure(card, 'claimable')).toBe('0 AAPLx-DEMO');
  });

  it('navigating away after signing: the request keeps running and settles; coming back shows its result', async () => {
    const { sources } = await signOrchardAsPastHolderWithSources();
    await goTo('/portfolio');
    expect(location()).toBe('/portfolio');
    for (let i = 0; i < 4; i += 1) await advance(STEP);
    expect(sources.settlements?.forOwner(PAST_ADDRESS)).toHaveLength(1);
    await goTo('/rewards');
    const card = claimCard('ORCHARD');
    expect(txStatus(card)).toBe('finalized');
    expect(figure(card, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(claimButton(card).disabled).toBe(true);
  });

  it('navigating away before signing drops the unsigned request (nothing was signed)', async () => {
    await open();
    await connectAs('Past holder');
    await click(claimButton(claimCard('ORCHARD')));
    await advance(STEP);
    expect(txStatus(claimCard('ORCHARD'))).toBe('awaiting_signature');
    await goTo('/portfolio');
    await goTo('/rewards');
    expect(txStatus(claimCard('ORCHARD'))).toBe('idle');
    expect(claimButton(claimCard('ORCHARD')).disabled).toBe(false);
  });

  async function signOrchardAsPastHolderWithSources() {
    const app = await open();
    await connectAs('Past holder');
    const card = claimCard('ORCHARD');
    await click(claimButton(card));
    await advance(STEP);
    await click(within(card).getByRole('button', { name: 'Sign' }));
    expect(txStatus(card)).toBe('submitted');
    return app;
  }
});

describe('claim button focus (WCAG 2.4.3)', () => {
  it('pressing Claim keeps the focused button focusable (aria-disabled, not disabled) while the request is open', async () => {
    await open();
    await connectAs('Past holder');
    const button = claimButton(claimCard('ORCHARD'));
    await act(async () => button.focus());
    await click(button);
    const busy = claimButton(claimCard('ORCHARD'));
    expect(txStatus(claimCard('ORCHARD'))).toBe('preparing');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.disabled).toBe(false);
    expect(document.activeElement).toBe(busy);
    // A second press is ignored.
    await click(busy);
    expect(txStatus(claimCard('ORCHARD'))).toBe('preparing');
    // Once focus moves on, the button is disabled as usual.
    await act(async () => busy.blur());
    expect(claimButton(claimCard('ORCHARD')).disabled).toBe(true);
  });
});

describe('scenario controls (the sample data)', () => {
  it('offer the account data scenario (kept in ?scenario=) and one scenario picker for all claims, with no Demo word (F130)', async () => {
    await open();
    await connectAs('Past holder');
    expect(within(main()).getByRole('region', { name: 'Scenarios' })).toBeTruthy();
    expect(main().textContent).not.toMatch(/demo controls|for testers|mock account/i);
    expect(within(main()).getAllByRole('combobox', { name: 'Scenario' })).toHaveLength(1);
    await click(claimButton(claimCard('ORCHARD')));
    // The status panels do not repeat the picker.
    expect(within(main()).getAllByRole('combobox', { name: 'Scenario' })).toHaveLength(1);
    await act(async () => void fireEvent.change(within(main()).getByRole('combobox', { name: 'Account data' }), { target: { value: 'unavailable' } }));
    await flush();
    expect(location()).toBe('/rewards?scenario=unavailable');
  });

  it('personas map to the fixture accounts', () => {
    expect(DEMO_PERSONAS.map((persona) => persona.id)).toEqual(['current_holder', 'past_holder', 'never_held']);
  });
});
