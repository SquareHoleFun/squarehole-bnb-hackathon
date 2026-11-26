/**
 * SH-V21-FE14 (step 8 request 3): a coin pile whose buyers' fees The Alchemist converts, on its box page. The site
 * parses the module sides (`money.modules`) and the conversion totals (`alchemist`) from decimal strings into bigint,
 * shows the P its conversions spent, the P still waiting, the pile coin they delivered and the redeemable balance each
 * apart (two coins are never added up), and names the side The Alchemist, with its route, only once its module checks
 * out on chain as this release's Alchemist for these coins (`useBoxAlchemist`). Navigation asks no wallet.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { pictureLoaded } from './test-support/picture-loaded';
import { MemoryRouter } from 'react-router';
import { getAddress, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlchemistModuleV21 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { CoinPileV2, moduleWaitingP } from './CoinPileV2';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { feeText, V2BoxPage } from './V2BoxPage';
import { DUST_P, MODULE, MODULE_HASH, publishedAlchemistPile, type AlchemistOptions } from './test-support/alchemist-published';
import { ETH } from './test-support/m3-published';
import { required } from './test-support/required';
import { shownText, tucked } from '../../../test-support/shown-text';
import { NO_RESCUE_LINE } from './v2-words';

const PAXG = getAddress('0x00000000000000000000000000000000000000e3') as Address;
const WETH = getAddress('0x00000000000000000000000000000000000000e2') as Address;
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('../../create/v2/indexer-listings', async (original) => ({ ...await original<object>(),
  loadListingsV2: async () => [{ id: 6, token: PAXG, decimals: 18, class: 5, kind: 1, raise: 4_152_900_000_000_000_000n, symbol: 'PAXG', name: 'PAXG', powers: [] }] }));
const checked = vi.hoisted(() => ({ module: null as unknown }));
vi.mock('../../create/v2/alchemist', async (original) => ({ ...await original<object>(), useBoxAlchemist: () => checked.module }));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-255: these pages now wait for the picture's lazy chunk, long enough for the chart to start: the chart's drawing as
// every page test that waits has it (jsdom has no canvas or matchMedia; the real library threw after teardown).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); checked.module = null; wallet.signer.request.mockReset(); });

/**
 * The trigger fixed in the module (`conversionTrigger()`; anvil's account 4, the local chain's keeper account), its
 * per-step cap, 0.001 ETH, and its dust size, 1 gwei. F153: any address can be the trigger, and the page names it by its
 * short address alone; Sepolia's row 4 has the founder's deployer (`DEPLOYER`), not the platform keeper.
 */
const TRIGGER = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65') as Address;
const DEPLOYER = getAddress('0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE') as Address;
/** No word may call the trigger a keeper or say how it sends (SH-APP8-TRIGGER-WORDS). */
const KEEPER_WORDS = /keeper|private/i;
const VERIFIED: AlchemistModuleV21 = {
  module: MODULE, codeHash: MODULE_HASH, priceCoin: '0x0000000000000000000000000000000000000000', pileCoin: PAXG, executor: '0x0000000000000000000000000000000000000052', executorCodeHash: MODULE_HASH,
  route: [{ kind: 4, tokenIn: '0x0000000000000000000000000000000000000000', tokenOut: WETH, pool: '0x000000000000000000000000000000000000009f', fee: 3000, tickSpacing: 60 }, { kind: 3, tokenIn: WETH, tokenOut: PAXG, pool: '0x00000000000000000000000000000000000000a1', fee: 3000, tickSpacing: 60 }],
  inputCap: ETH / 1000n, dustMax: 10n ** 9n, conversionTrigger: TRIGGER,
};
async function view(options: AlchemistOptions = {}) {
  const published = await publishedAlchemistPile(options);
  return { ...published, view: parseSnapshotV2(published.body, published.source) };
}
const panel = () => screen.getByRole('region', { name: 'Coin pile' });
const figure = (label: string) => within(panel()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
/** SH-ALCHEMIST-LESS-TEXT: Pile details is a Details button, closed until pressed; pressed, its panel (returned) shows. */
const pileDetails = (): HTMLElement => {
  const button = within(panel()).getByRole('button', { name: 'Pile details' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const details = required(document.getElementById(required(button.getAttribute('aria-controls'))));
  expect(details.hidden).toBe(true);
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(details.hidden).toBe(false);
  return details;
};

describe('SH-V21-FE14 parsing a pile’s module sides and conversions', () => {
  it('reads the module snapshot, the P waiting and the conversion totals as bigint, from decimal strings only', async () => {
    const { view: parsed, body, source } = await view();
    expect(parsed.choices.buyers).toBe('module');
    expect(parsed.modules?.buyers).toEqual({ module: getAddress(MODULE), codeHash: MODULE_HASH, pendingP: 3n * ETH / 10n });
    expect(parsed.alchemist).toEqual({ inputP: ETH, receivedAsset: ETH / 2n, dustToDepthP: DUST_P });
    expect(moduleWaitingP(parsed)).toBe(3n * ETH / 10n);
    for (const bad of [{ inputP: 1 }, { receivedAsset: '0.5' }, { dustToDepthP: 10 }, { dustToDepthP: '1e1' }]) {
      expect(() => parseSnapshotV2({ ...body, alchemist: { ...(body.alchemist as Record<string, unknown>), ...bad } }, source)).toThrow(/decimal/i);
    }
    const modules = required(body.money.modules) as { buyers: Record<string, unknown> };
    expect(() => parseSnapshotV2({ ...body, money: { ...body.money, modules: { ...modules, buyers: { ...modules.buyers, pendingP: '3e17' } } } }, source)).toThrow(/decimal/i);
    // Unpublished parts are unavailable, never zero.
    const missing = await view({ pendingP: null, totals: null });
    expect(missing.view.modules).toBeNull();
    expect(missing.view.alchemist).toBeNull();
    expect(moduleWaitingP(missing.view)).toBeNull();
    // A publication from before the dust total: dust unavailable, never zero; the other totals still read.
    const older = await view({ totals: { inputP: ETH, receivedAsset: ETH / 2n } });
    expect(older.view.alchemist).toEqual({ inputP: ETH, receivedAsset: ETH / 2n, dustToDepthP: null });
    // RC5-B: a pre-RC5 FIT Safe dust figure is never read as depth: it stays unavailable, never reinterpreted.
    const legacy = await view({ totals: { inputP: ETH, receivedAsset: ETH / 2n, dustP: DUST_P } });
    expect(legacy.view.alchemist).toEqual({ inputP: ETH, receivedAsset: ETH / 2n, dustToDepthP: null });
  });
});

describe('SH-V21-FE14 the pile panel of an Alchemist box', () => {
  const rig = async (options: AlchemistOptions = {}, module: AlchemistModuleV21 | null = VERIFIED) => {
    const published = await view(options);
    render(<AppProviders><MemoryRouter><CoinPileV2 view={published.view} source={published.source} ticker="LEAD" symbol="ETH" alchemist={module} disabled={false} /></MemoryRouter></AppProviders>);
    await screen.findByText('2.5 PAXG', { selector: '.sh-v2-value' });
    return published;
  };

  it('P spent, P waiting, the pile coin delivered and the redeemable balance, each apart; the route once checked', async () => {
    expect(VERIFIED.route.every(hop => hop.fee >= 3000), 'G1-A3 verified fixture fee floor').toBe(true);
    await rig();
    expect(figure('Redeemable')).toBe('2.5 PAXG');
    expect(figure('ETH converted')).toBe('1 ETH');
    expect(figure('ETH waiting')).toBe('0.3 ETH');
    expect(figure('Added by conversion')).toBe('0.5 PAXG');
    // RC5-B: the P of steps too small to convert, kept for the box's own pool depth, is a figure of its own in the price coin.
    expect(figure('ETH added to pool depth')).toBe('0.00000000000000001 ETH');
    expect(within(panel()).queryByText('ETH to the FIT Safe')).toBeNull();
    expect(figure('Leave behind')).toBe('5%');
    const details = pileDetails();
    expect(details.textContent).toContain('fees chosen for The Alchemist wait in ETH until graduation, then convert into PAXG.');
    expect(details.textContent).toContain('ETH and PAXG are never added up');
    expect(details.textContent).not.toContain('no fee choice adds to it');
    // G1: capped steps whose last two split the rest, a too-small step up to the module's dust size kept for the box's own
    // pool depth (RC5-B), the fixed trigger by its short address and its 7 days.
    for (const words of ['Each step converts at most 0.001 ETH; the rest waits for the next one.', 'A step goes along the fixed route, each pool within 49 ticks',
      'When more than one but less than two full steps are left, two steps split the rest.',
      'A step of at most 0.000000001 ETH that a pool would pay nothing for stays in this box instead, as ETH for its own pool’s next deepening, shown apart and never added to the pile; a larger one refuses and waits.',
      'Only 0x15d3…6A65 starts a step, until a side has waited 7 days without one',
      'anyone else’s try is refused and nothing moves', 'Graduation and every step that goes through start the 7 days again; a refused try does not.', 'It knows no fair price', 'a trader can move a pool’s price just before it',
      'It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.']) expect(details.textContent, words).toContain(words);
    // F153: the trigger is any address; nothing calls it a keeper or says it sends privately, and it shows in short only.
    expect(details.textContent).not.toMatch(KEEPER_WORDS);
    expect(details.textContent).not.toContain(TRIGGER);
    // SH-APP8: the short address in its own span in tabular figures (the design's .sh-numeric), as the create flow's rows
    // draw it; the route list too, for a coin named by its address.
    expect(Array.from(details.querySelectorAll('p > .sh-numeric')).map((span) => span.textContent)).toEqual(['0x15d3…6A65']);
    expect(within(details).getByRole('list', { name: 'Conversion route' }).classList.contains('sh-numeric')).toBe(true);
    // A refused try does not restart the fallback's 7 days (ReceiverPendingV21.run restores pending before startWait).
    expect(details.textContent).not.toContain('every step starts the 7 days again');
    // G1-INT: no promise that the last steps always drain; RC5-B: no too-small step goes to the FIT Safe.
    expect(details.textContent).not.toMatch(/no remainder stays behind|When less than two full steps|FIT Safe/);
    // No promise of a whole queue in one try, or of a conversion at all.
    expect(details.textContent).not.toMatch(/whole waiting|in one try|always converts|guarantee/i);
    expect(within(details).getByRole('list', { name: 'Conversion route' }).textContent).toBe('ETH → 0x0000…00E2 · Uniswap v4 · 0.3%0x0000…00E2 → PAXG · Uniswap v3 · 0.3%');
    expect(appCopyFraming(renderedCopy(panel()))).toEqual([]);
    expect(panel().textContent).not.toMatch(/profit|earn|yield|returns?\b/i);
    expect(wallet.signer.request).not.toHaveBeenCalled();
  });

  it('F153: a trigger that is not the platform keeper (Sepolia’s row 4: the founder’s deployer) is named by its own short address; nothing else changes', async () => {
    await rig({}, { ...VERIFIED, conversionTrigger: DEPLOYER });
    const details = pileDetails();
    const lines = Array.from(details.querySelectorAll('p')).map((p) => p.textContent ?? '');
    expect(lines).toContain('Only 0x1F14…4eeE starts a step, until a side has waited 7 days without one; before that, anyone else’s try is refused and nothing moves. After 7 days anyone may start the next step. Graduation and every step that goes through start the 7 days again; a refused try does not.');
    expect(lines).toContain('It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.');
    expect(details.textContent).not.toMatch(KEEPER_WORDS);
    expect(details.textContent).not.toContain('0x15d3');
    // SH-APP8: the sentence's words stay as above; only the address is its own span (tabular figures, one line).
    const address = required(details.querySelector('p > .sh-numeric'));
    expect(address.textContent).toBe('0x1F14…4eeE');
    expect(address.parentElement?.textContent).toMatch(/^Only 0x1F14…4eeE starts a step, /);
    // The cap, the dust size, the route and the figures are as for any trigger.
    expect(details.textContent).toContain('Each step converts at most 0.001 ETH; the rest waits for the next one.');
    expect(details.textContent).toContain('A step of at most 0.000000001 ETH that a pool would pay nothing for stays in this box instead');
    expect(within(details).getByRole('list', { name: 'Conversion route' }).textContent).toBe('ETH → 0x0000…00E2 · Uniswap v4 · 0.3%0x0000…00E2 → PAXG · Uniswap v3 · 0.3%');
    expect(figure('ETH converted')).toBe('1 ETH');
    expect(figure('ETH waiting')).toBe('0.3 ETH');
    expect(appCopyFraming(renderedCopy(panel()))).toEqual([]);
    expect(wallet.signer.request).not.toHaveBeenCalled();
  });

  it('a module that does not check out as The Alchemist keeps its figures, without the name, a route, a cap or a trigger', async () => {
    await rig({}, null);
    expect(figure('ETH converted')).toBe('1 ETH');
    const details = pileDetails();
    expect(details.textContent).toContain('fees chosen for its fee module wait in ETH');
    expect(within(details).queryByRole('list', { name: 'Conversion route' })).toBeNull();
    expect(details.textContent).toContain('A conversion spends waiting ETH along its fixed route');
    expect(details.textContent).not.toMatch(/at most|Keeper|7 days|whole waiting|starts a step|0x15d3/);
  });

  it('unpublished reads are Unavailable, never zero', async () => {
    await rig({ pendingP: null, totals: null });
    for (const label of ['ETH converted', 'ETH waiting', 'Added by conversion', 'ETH added to pool depth']) expect(figure(label), label).toBe('Unavailable');
    cleanup();
    await rig({ totals: { inputP: ETH, receivedAsset: ETH / 2n } });
    expect(figure('ETH added to pool depth')).toBe('Unavailable');
    expect(figure('ETH converted')).toBe('1 ETH');
  });
});

describe('SH-ALCHEMIST-LESS-TEXT the pile panel: the pile, what a coin gets, the no-rescue line and the redeem box; the rest behind a closed Pile details', () => {
  const rig = async (module: AlchemistModuleV21 | null = VERIFIED) => {
    const published = await view();
    render(<AppProviders><MemoryRouter><CoinPileV2 view={published.view} source={published.source} ticker="LEAD" symbol="ETH" alchemist={module} disabled={false} /></MemoryRouter></AppProviders>);
    await screen.findByText('2.5 PAXG', { selector: '.sh-v2-value' });
  };
  const MOVED = [['Seed', '0 PAXG'], ['LEAD out', '1000000 LEAD'], ['Leave behind', '5%'], ['Redeemable', '2.5 PAXG'], ['ETH converted', '1 ETH'], ['ETH waiting', '0.3 ETH'],
    ['Added by conversion', '0.5 PAXG'], ['ETH added to pool depth', '0.00000000000000001 ETH']] as const;

  it('the default view, word for word; one sentence, the one that guards against a loss nobody can undo', async () => {
    await rig();
    expect(shownText(panel())).toEqual(['Coin pile', '2.5 PAXG', 'Redeem open', 'Per LEAD', '0.000002375 PAXG', NO_RESCUE_LINE, 'LEAD to redeem', 'Approve coins', 'Redeem', 'Pile details']);
    expect(NO_RESCUE_LINE).toBe('Coins sent to the pile by mistake cannot be recovered.');
    const button = within(panel()).getByRole('button', { name: 'Pile details' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const details = required(document.getElementById(required(button.getAttribute('aria-controls'))));
    expect(details.hidden).toBe(true);
    // The actions are never in the panel: it opens below them.
    for (const action of ['Approve coins', 'Redeem']) expect(details.contains(within(panel()).getByRole('button', { name: action }))).toBe(false);
    expect(button.compareDocumentPosition(within(panel()).getByRole('group', { name: 'Redeem' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    for (const [label] of MOVED) expect(tucked(within(panel()).getByText(label, { selector: 'dt' })), label).toBe(true);
  });

  it('pressed, Pile details shows every moved figure first, in its old order, then every paragraph, the route and the addresses', async () => {
    await rig();
    const details = pileDetails();
    expect(Array.from(details.querySelectorAll('[data-pile-figures] dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])).toEqual(MOVED);
    const shown = shownText(details);
    for (const words of ['The creator seeds the pile once, after Create; fees chosen for The Alchemist wait in ETH until graduation, then convert into PAXG. A zero seed needs no loading.',
      'ETH → 0x0000…00E2 · Uniswap v4 · 0.3%', '0x0000…00E2 → PAXG · Uniswap v3 · 0.3%', '0x15d3…6A65',
      'It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.',
      'Leave behind 5%: each hand-in pays 95% of its share and the rest stays in the pile for those still holding. Handing in every LEAD still out takes the whole pile.',
      'If the box fails, only the recorded seed goes back to the creator, in a separate call anyone can make and retry. Nothing else in the pile has a way out.',
      'Redeeming calls approve(pile, coins) on LEAD, then redeem(coins, minimum, your wallet) on the pile.']) expect(shown, words).toContain(words);
    expect(shown.some((line) => line.startsWith('Seeder 0x'))).toBe(true);
    // The figures come before the paragraphs, as the design says.
    expect(shown.indexOf('Seed')).toBeLessThan(shown.indexOf('ETH → 0x0000…00E2 · Uniswap v4 · 0.3%'));
  });

  it('a module that does not check out as The Alchemist: the same short view, its figures behind Pile details too', async () => {
    await rig(null);
    expect(shownText(panel())).toEqual(['Coin pile', '2.5 PAXG', 'Redeem open', 'Per LEAD', '0.000002375 PAXG', NO_RESCUE_LINE, 'LEAD to redeem', 'Approve coins', 'Redeem', 'Pile details']);
    expect(tucked(within(panel()).getByText('ETH converted', { selector: 'dt' }))).toBe(true);
  });
});

describe('SH-V21-FE14 the box page names the side', () => {
  it('The Alchemist once checked on chain, else Fee module', async () => {
    const { view: parsed, source } = await view();
    expect(feeText(parsed, 'buyers', 'ETH', 'LEAD', true)).toBe('The Alchemist');
    expect(feeText(parsed, 'buyers', 'ETH', 'LEAD')).toBe('Fee module');
    checked.module = VERIFIED;
    render(<AppProviders><MemoryRouter><V2BoxPage record={recordV2(parsed, source)} /></MemoryRouter></AppProviders>);
    // SH-255: the side's name is the picture's Where the fees go line (the Fees card's row before it).
    await pictureLoaded();
    expect(await screen.findByText('The Alchemist', { selector: '.sh-bpic-ledger-place' })).toBeTruthy();
    expect(wallet.signer.request).not.toHaveBeenCalled();
  });
});
