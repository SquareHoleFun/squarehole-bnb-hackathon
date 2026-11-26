/**
 * Pair detail reward card × claims (integration of SH-012 with SH-014/SH-015): with a demo wallet connected, the card
 * runs the same claim flow as /rewards for that pair (same ClaimCard, useTxFlow, TxStatusPanel and demo settlement
 * ledger); without one it links to Rewards and offers only an explicit button (UI-09).
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  claimButton,
  click,
  connectAs,
  disconnect,
  driveClaim,
  expectNoAmountInputs,
  figure,
  flush,
  location,
  main,
  renderM3,
  txPanel,
  txStatus,
} from '../../test-support/m3';
import { setDemoTxScenario } from '../tx';

const ORCHARD = '/pair/31337/0x0000000000000000000000000000000000000066';
const FRAMES = '/pair/31337/0x000000000000000000000000000000000000006a';
const SIGNED = ['preparing', 'awaiting_signature', 'submitted', 'pending'];

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

/**
 * Renders the detail page. Its detail read loads a lazy JSON chunk (SH-012), which needs real time, so the page is
 * opened on real timers and the scripted demo steps then run on fake ones.
 */
async function openPair(path: string, name: string) {
  vi.useRealTimers();
  const app = renderM3(path, { legacy: true });
  await screen.findByRole('region', { name: 'Holder fee share' }, { timeout: 4000 });
  expect(screen.getByRole('heading', { level: 1, name })).toBeTruthy();
  vi.useFakeTimers();
  await flush();
  return app;
}

const rewardsCard = () => screen.getByRole('region', { name: 'Holder fee share' });
function pairClaim(): HTMLElement {
  const card = rewardsCard().querySelector<HTMLElement>('article[data-claim-variant="pair"]');
  if (!card) throw new Error('no embedded claim card');
  return card;
}

describe('disconnected (UI-09)', () => {
  it('keeps the Rewards link and offers only an explicit Connect wallet button', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    const card = rewardsCard();
    expect(within(card).getByRole('link', { name: 'Claim on the Claims page' }).getAttribute('href')).toBe(
      '/rewards?pair=31337%3A0x0000000000000000000000000000000000000066',
    );
    const button = within(card).getByRole('button', { name: 'Connect wallet' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card.querySelector('article')).toBeNull();
    expect(within(card).queryByTestId('claim-button')).toBeNull();
    await click(button);
    expect(screen.getByRole('dialog', { name: 'Sample wallet' })).toBeTruthy();
  });
});

describe('connected demo wallet', () => {
  it('shows this account’s claim on the pair, read-only, with the Rewards link kept as fallback', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder');
    const card = rewardsCard();
    const section = within(card).getByRole('region', { name: 'Your claims on ORCHARD' });
    expect(within(section).getByTestId('account-bar').textContent).toContain('Past holder');
    const claim = pairClaim();
    expect(claim.getAttribute('aria-labelledby')).toBe(within(section).getByRole('heading', { level: 3 }).id);
    expect(within(claim).getByText(/You hold no ORCH now/)).toBeTruthy();
    expect(figure(claim, 'claimable')).toBe('9.705953 AAPLx-DEMO');
    expect(figure(claim, 'claimed')).toBe('0 AAPLx-DEMO');
    expect(claimButton(claim).textContent).toBe('Claim 9.705953 AAPLx-DEMO');
    // No link back to the page it is on; the Rewards page stays one click away.
    expect(within(claim).queryByRole('link', { name: /Pair detail/ })).toBeNull();
    expect(within(section).getByRole('link', { name: 'Open in Claims' }).getAttribute('href')).toBe(
      '/rewards?pair=31337%3A0x0000000000000000000000000000000000000066',
    );
    // The tester picker is fenced off from the product card, as on /rewards.
    const demo = within(section).getByRole('group', { name: 'Scenarios' });
    expect(within(demo).getByRole('combobox', { name: 'Scenario' })).toBeTruthy();
    expect(claim.contains(demo)).toBe(false);
    expectNoAmountInputs(main());
  });

  it('connecting from the card moves focus to the claim it reveals', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await click(within(rewardsCard()).getByRole('button', { name: 'Connect wallet' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Past holder' }));
    await click(within(dialog).getByRole('button', { name: 'Connect sample wallet' }));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Your claims on ORCHARD' }));
  });

  it('a claim finalized on the detail page is consumed once, and /rewards shows the same settlement (ECO-05)', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder');
    await click(claimButton(pairClaim()));
    expect(txStatus(pairClaim())).toBe('preparing');
    expect(await driveClaim(pairClaim())).toEqual([...SIGNED, 'confirmed_unfinalized', 'finalized']);
    await flush();
    const after = pairClaim();
    expect(figure(after, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(figure(after, 'claimed')).toBe('9.705953 AAPLx-DEMO');
    expect(claimButton(after).disabled).toBe(true);
    expect(within(txPanel(after) as HTMLElement).getByText(/Settled 9.705953 AAPLx-DEMO of credited fees/)).toBeTruthy();

    await click(within(rewardsCard()).getByRole('link', { name: 'Open in Claims' }));
    await flush();
    expect(location()).toBe('/rewards?pair=31337%3A0x0000000000000000000000000000000000000066');
    const listed = screen.getByRole('heading', { level: 3, name: /^ORCHARD/ }).closest('article') as HTMLElement;
    expect(figure(listed, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(figure(listed, 'claimed')).toBe('9.705953 AAPLx-DEMO');
    expect(claimButton(listed).textContent).toBe('Nothing claimable yet');
  });

  it('R=T: the read-only estimate, computed minimum and deadline; no amount or slippage field', async () => {
    await openPair(FRAMES, 'TINY FRAMES');
    await connectAs('Past holder');
    const claim = pairClaim();
    const estimate = within(claim).getByTestId('conversion-estimate');
    expect(estimate.textContent).toContain('≈ 163.149767 FRAME');
    expect(estimate.textContent).toContain('161.518269 FRAME');
    expect(estimate.textContent).toContain('25 Sep 2026, 12:20 UTC');
    expect(estimate.textContent).toContain('a fixed tolerance, not a setting');
    expect(estimate.textContent).not.toMatch(/demo (tolerance|quote)/i);
    expect(claimButton(claim).textContent).toBe('Claim as FRAME');
    expectNoAmountInputs(main());
  });

  it('?scenario=conversion_fails (account data) shows the labelled emergency settlement on the detail page too', async () => {
    await openPair(`${FRAMES}?scenario=conversion_fails`, 'TINY FRAMES');
    await connectAs('Past holder');
    const claim = pairClaim();
    expect(within(claim).getByTestId('emergency-settlement').textContent).toContain('Emergency settlement: WETH-DEMO paid directly');
    expect(within(claim).queryByTestId('conversion-estimate')).toBeNull();
    expect(claimButton(claim).textContent).toBe('Claim 0.081574 WETH-DEMO directly');
  });

  it('a signed claim keeps being tracked after the wallet disconnects', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder');
    await click(claimButton(pairClaim()));
    const seen = await driveClaim(pairClaim(), 3);
    expect(seen).toContain('submitted');
    await disconnect();
    await flush();
    const section = within(rewardsCard()).getByRole('region', { name: 'Your ORCH claim, still being tracked' });
    expect(section.textContent).toContain('Wallet disconnected.');
    expect(within(section).queryByRole('combobox', { name: 'Scenario' })).toBeNull();
    expect(claimButton(pairClaim()).disabled).toBe(true);
    const rest = await driveClaim(pairClaim());
    expect(rest.at(-1)).toBe('finalized');
  });

  it('wrong network: the notice is shown and the claim asks for an explicit switch first', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder', { wrongNetwork: true });
    expect(within(rewardsCard()).getByTestId('wrong-network-notice').textContent).toContain('Ethereum (1)');
    await click(claimButton(pairClaim()));
    expect(txStatus(pairClaim())).toBe('wrong_chain');
    await click(within(pairClaim()).getByRole('button', { name: 'Switch to Local chain (31337)' }));
    await flush();
    expect(within(rewardsCard()).queryByTestId('wrong-network-notice')).toBeNull();
    expect(await driveClaim(pairClaim())).toEqual(['preparing', 'awaiting_signature', 'submitted', 'pending', 'confirmed_unfinalized', 'finalized']);
  });

  it('R=T quote deadline on the demo clock: the detail card re-reads at the deadline and stops showing the quote (ADR-0008 §4)', async () => {
    const { clock } = await openPair(FRAMES, 'TINY FRAMES');
    await connectAs('Past holder');
    expect(within(pairClaim()).getByTestId('conversion-estimate')).toBeTruthy();
    expect(pairClaim().dataset.claimAction).toBe('claim_t');
    clock.ms += 21 * 60 * 1000;
    await advance(21 * 60 * 1000);
    const claim = pairClaim();
    expect(claim.dataset.claimAction).toBe('needs_quote');
    expect(within(claim).queryByTestId('conversion-estimate')).toBeNull();
    expect(within(claim).getByTestId('needs-quote').textContent).toContain('No current quote.');
    expect(claimButton(claim).textContent).toBe('Waiting for a current quote');
    expect(claimButton(claim).disabled).toBe(true);
  });

  it('deadline_expiry demo scenario: the detail card shows "No current quote" until refreshed, and one retry control', async () => {
    await openPair(FRAMES, 'TINY FRAMES');
    await connectAs('Past holder');
    const picker = within(rewardsCard()).getByRole('combobox', { name: 'Scenario' });
    await act(async () => void fireEvent.change(picker, { target: { value: 'deadline_expiry' } }));
    await click(claimButton(pairClaim()));
    expect(await driveClaim(pairClaim(), 4)).toEqual(['preparing', 'awaiting_signature', 'invalidated']);
    const claim = pairClaim();
    expect(within(claim).queryByTestId('conversion-estimate')).toBeNull();
    expect(within(claim).getByTestId('needs-quote').dataset.quoteCause).toBe('lapsed');
    expect(claimButton(claim).disabled).toBe(true);
    expect(within(txPanel(claim) as HTMLElement).queryByRole('button', { name: 'Start again' })).toBeNull();
    await click(within(claim).getByRole('button', { name: 'Refresh the estimate' }));
    await flush();
    expect(txStatus(pairClaim())).toBe('idle');
    expect(within(pairClaim()).getByTestId('conversion-estimate')).toBeTruthy();
    expect(claimButton(pairClaim()).disabled).toBe(false);
  });

  it('persona switch after signing: the previous account’s claim stays on the card, tracked, beside the new account’s', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder');
    await click(claimButton(pairClaim()));
    expect(await driveClaim(pairClaim(), 3)).toContain('submitted');
    await connectAs('Current holder');
    const mine = within(rewardsCard()).getByRole('region', { name: 'Your claims on ORCHARD' });
    expect(figure(mine.querySelector('article') as HTMLElement, 'claimable')).toBe('0.000811 AAPLx-DEMO');
    const other = within(rewardsCard()).getByRole('region', { name: 'ORCH claim from another account, still being tracked' });
    expect(within(other).getByTestId('account-bar').textContent).toContain('Past holder');
    const tracked = other.querySelector('article') as HTMLElement;
    expect(['submitted', 'pending']).toContain(txStatus(tracked));
    expect(claimButton(tracked).disabled).toBe(true);
    expect(await driveClaim(tracked)).toContain('finalized');
    await flush();
    await connectAs('Past holder');
    expect(within(rewardsCard()).queryByRole('region', { name: /still being tracked/ })).toBeNull();
    expect(txStatus(pairClaim())).toBe('finalized');
    expect(figure(pairClaim(), 'claimable')).toBe('0 AAPLx-DEMO');
    expect(claimButton(pairClaim()).disabled).toBe(true);
  });

  it('a request signed on the detail page is the same request on /rewards (no second claim offered while it runs)', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Past holder');
    await click(claimButton(pairClaim()));
    expect(await driveClaim(pairClaim(), 3)).toContain('submitted');
    await click(within(rewardsCard()).getByRole('link', { name: 'Open in Claims' }));
    await flush();
    const listed = screen.getByRole('heading', { level: 3, name: /^ORCHARD/ }).closest('article') as HTMLElement;
    expect(['submitted', 'pending']).toContain(txStatus(listed));
    expect(claimButton(listed).textContent).toBe('Claim in progress…');
    expect((await driveClaim(listed)).at(-1)).toBe('finalized');
    await flush();
    expect(figure(screen.getByRole('heading', { level: 3, name: /^ORCHARD/ }).closest('article') as HTMLElement, 'claimable')).toBe('0 AAPLx-DEMO');
  });

  it('a never-held account sees a disabled claim, not a zero shown as success', async () => {
    await openPair(ORCHARD, 'ORCHARD');
    await connectAs('Never held');
    const claim = pairClaim();
    expect(figure(claim, 'claimable')).toBe('0 AAPLx-DEMO');
    expect(claimButton(claim).textContent).toBe('Nothing claimable yet');
    expect(claimButton(claim).disabled).toBe(true);
  });
});
