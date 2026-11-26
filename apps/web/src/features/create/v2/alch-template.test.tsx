/**
 * ALCH-TEMPLATE (founder 2026-10-23): "Alchemist coin pile" (fix round 1; first "Growing coin pile"), a generic recipe
 * for boxes like his example (a box token priced in one coin with a pile of another, fed by The Alchemist). Its spec,
 * its visibility (only while a row resolves for a listed pile coin), and the Fees step's inbox lines (the inbox's money is booked as buyers' fees,
 * ReceiverBooksV21, so only a buyers'-side Alchemist receives it).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { keccak256, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { alchemistSideV21, type AlchemistRowV21 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import { required } from '../../core/v2/test-support/required';
import { useAlchemistOffer, type AlchemistAnswer } from './alchemist';
import { ALCHEMIST_NO_INBOX, FeesStep, INBOX_HOLDERS_LINE, INBOX_SIDE_LINE, inboxSideLine } from './FeesStep';
import { DEMO_LISTINGS, NATIVE_TOKEN } from './listings';
import { buildSpecV2, pileInOther, recipeCtx, v2Issues } from './model';
import { CHOICES, alchemistPick, pickFor, type SidePick } from './recipes';
import { BoxTypeV2 } from './spec-types';
import { TemplateRow } from './TemplateRow';
import { TEMPLATES, offeredTemplates, templateDraft } from './templates';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const PAXG = coin('PAXG');
const alchemistPile = required(TEMPLATES.find((t) => t.id === 'alchemist-pile'));
const ROW: AlchemistRowV21 = {
  id: 7, readyAt: 86_400n, module: '0x0000000000000000000000000000000000000051', codeHash: keccak256('0x01'), priceCoin: NATIVE_TOKEN, pileCoin: PAXG.token,
  executor: '0x0000000000000000000000000000000000000052', executorCodeHash: keccak256('0x02'),
  route: [{ kind: 2, tokenIn: NATIVE_TOKEN, tokenOut: PAXG.token, pool: '0x00000000000000000000000000000000000000a2', fee: 3000, tickSpacing: 0 }],
  inputCap: 10n ** 15n, dustMax: 10n ** 9n, conversionTrigger: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address,
};
const READY: AlchemistAnswer = { state: 'ready', rows: [ROW] };

describe('ALCH-TEMPLATE the spec it fills', () => {
  it('a pile in the offered coin, the row on the buyers’ side, Burn on the sellers’: a valid spec the Fees step accepts', () => {
    const base = inputV2Of(required(CONFIGURATIONS.find((c) => c.id === 'rug-rugs')), { pricing: NATIVE_TOKEN }, { ticker: 'LEAD' });
    const { form, v2 } = templateDraft(alchemistPile, { pricing: NATIVE_TOKEN, pile: null, alchemist: { coin: PAXG.token, row: ROW.id } });
    const input = { ...base, form: { ...base.form, ...form }, v2: { ...base.v2, ...v2, pile: v2.pile && { ...v2.pile, seed: '1' } }, alchemist: READY };
    expect(pileInOther(input)?.symbol).toBe('PAXG');
    const spec = buildSpecV2(input);
    expect(spec.boxType).toBe(BoxTypeV2.PILE);
    expect(spec.buyers).toEqual(alchemistSideV21(ROW.id));
    expect(spec.sellers).toEqual(buildSpecV2({ ...input, v2: { ...input.v2, buyers: pickFor('burn') } }).sellers);
    expect(validateBoxSpecV2(spec, { listing: recipeCtx(input).pricing })).toEqual({ reason: 0, field: 0 });
    expect(v2Issues(input).filter((issue) => issue.step === 'v2-fees')).toEqual([]);
  });
});

describe('ALCH-TEMPLATE visibility', () => {
  it('the tile is hidden without an offer and shown with one; pressing it hands the template over', () => {
    const onPick = vi.fn();
    const { rerender } = render(<TemplateRow current={null} onPick={onPick} templates={offeredTemplates(null)} />);
    expect(screen.queryByRole('button', { name: /^Alchemist coin pile/ })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(TEMPLATES.length - 1);
    rerender(<TemplateRow current={null} onPick={onPick} templates={offeredTemplates({ coin: PAXG.token, row: ROW.id })} />);
    const tile = screen.getByRole('button', { name: /^Alchemist coin pile/ });
    expect(tile.textContent).toContain('Coin pile · The Alchemist');
    expect(tile.hasAttribute('disabled')).toBe(false);
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith(alchemistPile);
  });
  it('the Demo has no directory: no offer, so no tile, and no chain is asked', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useAlchemistOffer(NATIVE_TOKEN, DEMO_LISTINGS.map((l) => l.token)), { wrapper: ({ children }) => <AppProviders>{children}</AppProviders> });
    expect(result.current).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

describe('ALCH-TEMPLATE the Fees step’s inbox lines', () => {
  const fees = (buyers: SidePick, sellers: SidePick) => {
    const input = inputV2Of(required(CONFIGURATIONS.find((c) => c.id === 'dragons-hoard')), { pricing: NATIVE_TOKEN });
    return render(<MemoryRouter><FeesStep buyers={buyers} sellers={sellers} ctx={recipeCtx(input)} collection={false} alchemist={{ pile: PAXG, answer: READY }} errorFor={() => null} set={() => undefined} /></MemoryRouter>);
  };
  it('always says inbox money follows the buyers’ side', () => {
    fees(pickFor('burn'), pickFor('burn'));
    // SH-ALCHEMIST-LESS-TEXT: in Fee details (closed), right after the inbox paragraph it sums up; not in the default view.
    const line = screen.getByText(INBOX_SIDE_LINE);
    expect(line.closest('details')?.querySelector('summary')?.textContent).toBe('Fee details');
    expect(line.closest('details')?.open).toBe(false);
    expect(line.previousElementSibling?.textContent).toMatch(/^Every box also has an inbox for royalties and gifts in other coins\./);
    expect(screen.queryByText(ALCHEMIST_NO_INBOX)).toBeNull();
  });
  it('SH-245: with To holders on the buyers’ side the line says inbox money skips holders; every other choice keeps the general line', () => {
    // Every wired choice, rendered on the buyers' side (Into the shop and To items too, though Create offers the first on
    // the sellers' side only and the second only with a collection: a pick the box cannot take stays shown).
    for (const choice of CHOICES) {
      fees(pickFor(choice), pickFor('burn'));
      const line = document.querySelector('[data-inbox-side]')?.textContent;
      expect(line, choice).toBe(choice === 'holders' || choice === 'holders-t' ? INBOX_HOLDERS_LINE : INBOX_SIDE_LINE);
      cleanup();
    }
    fees(alchemistPick(ROW.id), pickFor('holders'));
    expect(document.querySelector('[data-inbox-side]')?.textContent).toBe(INBOX_SIDE_LINE);
    expect([null, 'items', 'items-t', 'pile', 'alchemist', 'eat', 'keep', 'grow', 'burn'].map((c) => inboxSideLine(c as Parameters<typeof inboxSideLine>[0]))).toEqual(Array(9).fill(INBOX_SIDE_LINE));
    expect(INBOX_HOLDERS_LINE).toBe('In this version of the boxes, inbox money skips holders, because holders are paid from trades and inbox money has no trade behind it. Its 10/15 goes into the pool, or into the closing claim if the box fails.');
  });
  it('SH-245: the contracts book inbox money on the buyers’ side with no batch, and fund holders only from a trade batch', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const sol = (path: string) => readFileSync(join(root, 'packages/contracts/src/box-v2', path), 'utf8');
    const books = sol('libraries/ReceiverBooksV21.sol');
    // Royalties (the inbox's flush calls fundRoyalty) and any P not from a trade batch: the buyers' side, batch id 0.
    expect(books).toMatch(/function bookRoyalty\([^)]*\) public \{\s*split\(st, pm, amount, false\);/);
    expect(books).toContain('function split(State storage st, IPoolManager pm, uint256 amount, bool sellers) public { _splitSource(st, pm, amount, sellers, 0); }');
    expect(books).toContain('split(st, pm, surplus, false);');
    // Holders (4, P; 7, T) are funded only from a trade batch (id != 0); otherwise the 10/15 falls through to Grow.
    expect(books).toContain('if ((choice == 4 || choice == 7) && id != 0) funding = 10 * unit;');
    expect(books).toContain('else st._p[choice == 1 ? CREATOR : choice == 2 ? BUY_BACK : GROW] += 10 * unit;');
    // A box that fails first: the held royalties and Grow (where a holders choice put the 10/15) go to the closing claim.
    expect(books).toContain('_routePot(st, pm, ROYALTY, HeldKind.ROYALTIES);');
    expect(books).toContain('_routePot(st, pm, GROW, HeldKind.DEPTH_BRANCH);');
    expect(books).toMatch(/function _routePot\([^)]*\) private \{\s*uint256 amount = _release\(st, pm, ledger, A\.addressAt\(A\.COORDINATOR\)\);/);
    // Royalties after failure go straight to the pot; before graduation they are held, from graduation booked.
    expect(sol('BoxReceiverV2.sol')).toMatch(/if \(_failureSettled\) _toPot\(\);\s*else if \(_graduationSettled\) _bookRoyalty\(amount\);\s*else _p\[ROYALTY\] \+= amount;/);
    expect(sol('interfaces/RecipeTypes.sol')).toContain('enum FeeChoice { None, Keep, Burn, Grow, Holders, Items, EatPriceCoin, HoldersT, ItemsT, Pile, Module, ShopT }');
  });
  it('a sellers’-only Alchemist gets the note; with The Alchemist on the buyers’ side there is none', () => {
    fees(pickFor('burn'), alchemistPick(ROW.id));
    // SH-ALCHEMIST-LESS-TEXT: in the sellers' Alchemist Details, hidden until pressed.
    const note = screen.getByText(ALCHEMIST_NO_INBOX);
    expect(note.closest('[hidden]')).not.toBeNull();
    const sellers = screen.getByRole('group', { name: /^Sellers’ fees/ });
    expect(sellers.contains(note)).toBe(true);
    fireEvent.click(within(sellers).getByRole('button', { name: 'Details: Alchemist, sellers’ fees' }));
    expect(note.closest('[hidden]')).toBeNull();
    cleanup();
    fees(alchemistPick(ROW.id), alchemistPick(ROW.id));
    expect(screen.queryByText(ALCHEMIST_NO_INBOX)).toBeNull();
    cleanup();
    fees(alchemistPick(ROW.id), pickFor('burn'));
    expect(screen.queryByText(ALCHEMIST_NO_INBOX)).toBeNull();
    expect(INBOX_SIDE_LINE).toBe('Inbox money follows the buyers’ side.');
    expect(ALCHEMIST_NO_INBOX).toBe('The inbox will not feed the sellers’ Alchemist.');
  });
});
