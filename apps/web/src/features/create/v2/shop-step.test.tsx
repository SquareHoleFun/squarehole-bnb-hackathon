/**
 * SH-V21-FE13 on the page: Contents offers Shop beside Token and New collection; its step takes the seed, the give tiers,
 * the pick multiple, both weekly limits, the wait for new entries, the curator and the starting collections; the Shop
 * template fills it; the Overview shows every setting and the seed's steps after Create; the Demo plays them. Navigation
 * never asks a wallet. The chain's ERC-721 answer for each collection is read through the source's RPC (shop-checks.ts).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests, updateDraft } from '../draft';
import { DEMO_LISTINGS } from './listings';
import { collectionCheckV2, ERC721_INTERFACE } from './shop-checks';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { seedV2 } from './test-support/v2-fixtures';
import { resetV2ForTests, updateV2 } from './v2-draft';
import { required } from '../../core/v2/test-support/required';
import { checkStartersV2, starterOwnerV2 } from './shop-checks';
import { starterKey } from './shop';

const NFT_A = '0x00000000000000000000000000000000000000a1';
const SAFE = '0x0000000000000000000000000000000000005afe';

function renderFlow(path: string, adapter = createDemoWalletAdapter({ latencyMs: 0 }), stepMs = 0) {
  render(
    <AppProviders walletAdapter={adapter}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={stepMs} v2Listings={DEMO_LISTINGS} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  return adapter;
}
const field = (name: string | RegExp) => screen.getByRole('textbox', { name });
const type = async (name: string | RegExp, text: string) => act(async () => { fireEvent.change(field(name), { target: { value: text } }); });
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });
const next = async () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
const dd = (term: string) => required(Array.from(document.querySelectorAll('.sh-newbox-row')).find((r) => r.querySelector('dt')?.textContent === term)?.querySelector('dd')).textContent;

beforeEach(() => { resetDraftForTests(); resetV2ForTests(); });
afterEach(cleanup);

describe('SH-V21-FE13 Contents: Shop', () => {
  it('offers Shop beside Token and New collection; choosing it shows its settings with the defaults and hides the coin pile', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'rug-rugs')));
    const adapter = renderFlow('/create/v2-contents'); const connect = vi.spyOn(adapter, 'connect');
    expect(screen.getAllByRole('radio').slice(0, 3).map((r) => r.closest('label')?.textContent)).toEqual(['TokenNo NFTs', 'New collectionYour NFTs', 'ShopMany collections']);
    expect(screen.getByRole('group', { name: /^Coin pile/ })).toBeTruthy();
    await act(async () => fireEvent.click(radio(/^Shop/)));
    expect(radio(/^Shop/)).toHaveProperty('checked', true);
    expect(screen.queryByRole('group', { name: /^Coin pile/ })).toBeNull();
    for (const name of ['Seed · RUGS', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Collection 1']) expect(field(name)).toBeTruthy();
    // Each group is named by its legend's words alone, not its (i) button's.
    expect(screen.getByRole('group', { name: 'Give tiers · RUGS' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Collections · 1/64' })).toBeTruthy();
    // The defaults: picks at 2x, 10% a week, 2.5% per collection, 7 days, you as curator.
    expect(within(screen.getByRole('group', { name: /^Pick/ })).getByRole('radio', { name: '2x' })).toHaveProperty('checked', true);
    expect(within(screen.getByRole('group', { name: /^Gives a week/ })).getByRole('radio', { name: '10%' })).toHaveProperty('checked', true);
    expect(within(screen.getByRole('group', { name: /^Per collection a week/ })).getByRole('radio', { name: '2.5%' })).toHaveProperty('checked', true);
    expect(within(screen.getByRole('group', { name: /^New entries wait/ })).getByRole('radio', { name: /^7/ })).toHaveProperty('checked', true);
    expect(within(screen.getByRole('group', { name: /^Curator/ })).getByRole('radio', { name: /^You/ })).toHaveProperty('checked', true);
    // Only the presets the factory accepts.
    expect(within(screen.getByRole('group', { name: /^Pick/ })).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['1.25x', '1.5x', '2x', '3x']);
    expect(within(screen.getByRole('group', { name: /^Gives a week/ })).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['5%', '10%']);
    expect(within(screen.getByRole('group', { name: /^Per collection a week/ })).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['1%', '2.5%', '5%']);
    expect(within(screen.getByRole('group', { name: /^New entries wait/ })).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['7 days', '14 days', '30 days']);
    // Back to Token: the shop's settings go, the coin pile comes back.
    await act(async () => fireEvent.click(radio(/^Token/)));
    expect(screen.queryByRole('textbox', { name: /^Seed · RUGS/ })).toBeNull();
    expect(screen.getByRole('group', { name: /^Coin pile/ })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });

  it('numbers first: the seed names its minimum once the tiers are typed, each collection’s tier chips name their give', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'rug-rugs')));
    renderFlow('/create/v2-contents');
    await act(async () => fireEvent.click(radio(/^Shop/)));
    expect(screen.getByText('From your first buy')).toBeTruthy();
    for (const [i, price] of ['1', '2', '4', '8'].entries()) await type(`Tier ${i + 1}`, price);
    expect(screen.getByText('At least 2 RUGS · from your first buy')).toBeTruthy();
    const tiers = screen.getByRole('group', { name: /^Tier of collection 1/ });
    expect(within(tiers).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['11 RUGS', '22 RUGS', '34 RUGS', '48 RUGS']);
    await act(async () => fireEvent.click(within(tiers).getByRole('radio', { name: /^3/ })));
    expect(screen.getByText('At least 8 RUGS · from your first buy')).toBeTruthy();
  });

  it('Next names what to fix at Contents: the seed, the tiers, the collections', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'rug-rugs')));
    renderFlow('/create/v2-contents');
    await act(async () => fireEvent.click(radio(/^Shop/)));
    await type('Tier 1', '1'); await type('Tier 2', '1'); await type('Tier 3', '4'); await type('Tier 4', '8');
    await type('Seed · RUGS', '1');
    await type('Collection 1', NFT_A);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add collection' })));
    await type('Collection 2', NFT_A.toUpperCase().replace('0X', '0x'));
    await next();
    const summary = screen.getByRole('alert');
    expect(within(summary).getAllByRole('link').map((a) => a.textContent)).toEqual(['Tier 2: Above tier 1', 'Seed: At least 2 RUGS: twice the cheapest listed give', 'Collection 2: Listed twice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Contents');
    // Remove the second row, fix the tiers and the seed: Next goes on to Fees.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove collection 2' })));
    await type('Tier 2', '2'); await type('Seed · RUGS', '1000');
    await next();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Fees');
  });

  it('another curator, a Safe say: its address field, checked as an address', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    renderFlow('/create/v2-contents');
    await act(async () => fireEvent.click(within(screen.getByRole('group', { name: /^Curator/ })).getByRole('radio', { name: /^Another address/ })));
    await type('Curator address', 'safe.eth');
    await next();
    expect(within(screen.getByRole('alert')).getByRole('link').textContent).toBe('Curator address: Use an address like 0x12…, 42 characters');
    await type('Curator address', SAFE);
    await next();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Fees');
  });
});

describe('SH-V21-FE13 Overview and Create: Shop', () => {
  it('shows every setting, the pick price per tier and the seed’s steps; without a wallet it asks for one (you are the curator)', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    renderFlow('/create/v2-overview');
    expect(dd('Contents')).toBe('Shop');
    expect(dd('Seed')).toBe('1000 CURIO');
    expect(dd('Give tiers')).toBe('1 · 2 · 4 · 8 CURIO');
    expect(dd('Pick')).toBe('2x · 2 · 4 · 8 · 16 CURIO');
    expect(dd('Gives a week')).toBe('10% · 2.5% per collection');
    expect(dd('New entries wait')).toBe('7 days');
    expect(dd('Curator')).toBe('You · connect a wallet');
    expect(dd('Collections')).toBe('2');
    const plan = Array.from(document.querySelectorAll('.sh-v2-plan li'), (li) => li.textContent ?? '');
    expect(plan.slice(-3)).toEqual(['approve seed · 1000 CURIO', 'fundSeed · 1000 CURIO', 'complete · opens the box']);
    expect(plan[0]).toMatch(/^approve · .* PAXG$/); expect(plan[1]).toMatch(/^createBox · gas limit/);
    // Create waits for a wallet; the Overview names the curator's.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dd('Curator')).toMatch(/^You · 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  });

  it('Create in the Demo: the box waits for its seed, then opens', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    renderFlow('/create/v2-overview', createDemoWalletAdapter({ latencyMs: 0 }), 10);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
      const status = () => document.querySelector('[data-create-status]')?.textContent ?? '';
      await act(async () => vi.advanceTimersByTime(20));
      expect(status()).toMatch(/^Waiting for its seed · 0\/3$/);
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(status()).toBe('Open');
    } finally { vi.useRealTimers(); }
  });

  it('a shop priced in a coin without a first buy is held at Opening', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, firstIn: '' } }));
    updateV2((choices) => choices);
    renderFlow('/create/v2-opening');
    await next();
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((a) => a.textContent)).toContain('A shop needs your PAXG at start: the seed comes from it.');
  });
});

describe('SH-V21-FE13 the chain’s answer about a collection (shop-checks.ts)', () => {
  const ERC165 = parseAbi(['function supportsInterface(bytes4 id) view returns (bool)']);
  const reader = (code: boolean, reply: Hex | null) => ({ hasCode: vi.fn<(address: Address) => Promise<boolean>>(async () => code), call: vi.fn<(to: Address, data: Hex) => Promise<Hex | null>>(async () => reply) });
  it('asks supportsInterface(0x80ac58cd) of a contract only', async () => {
    const yes = reader(true, encodeFunctionResult({ abi: ERC165, functionName: 'supportsInterface', result: true }));
    await expect(collectionCheckV2(yes, NFT_A as Address)).resolves.toBe('erc721');
    expect(yes.call.mock.calls[0]?.[1]).toMatch(new RegExp(`^0x01ffc9a7${ERC721_INTERFACE.slice(2)}`));
    await expect(collectionCheckV2(reader(true, encodeFunctionResult({ abi: ERC165, functionName: 'supportsInterface', result: false })), NFT_A as Address)).resolves.toBe('not-erc721');
    await expect(collectionCheckV2(reader(true, null), NFT_A as Address)).resolves.toBe('not-erc721');
    await expect(collectionCheckV2(reader(true, '0x1234'), NFT_A as Address)).resolves.toBe('not-erc721');
    const none = reader(false, null);
    await expect(collectionCheckV2(none, NFT_A as Address)).resolves.toBe('no-code');
    expect(none.call).not.toHaveBeenCalled();
  });
});

describe('SH-SHOP-CREATE on the page: starter items and no curator', () => {
  const curatorGroup = () => screen.getByRole('group', { name: /^Curator/ });
  const ids = (n: number) => screen.getByRole('textbox', { name: `Starter ids ${n}` });
  const typeInto = async (box: HTMLElement, text: string) => act(async () => { fireEvent.change(box, { target: { value: text } }); });

  it('offers No curator beside You and Another address: no address to type, the Overview says None', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    renderFlow('/create/v2-contents');
    expect(within(curatorGroup()).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['YouYour wallet', 'Another addressA Safe works', 'No curatorFixed list']);
    await act(async () => fireEvent.click(within(curatorGroup()).getByRole('radio', { name: /^No curator/ })));
    expect(within(curatorGroup()).getByRole('radio', { name: /^No curator/ })).toHaveProperty('checked', true);
    expect(screen.queryByRole('textbox', { name: 'Curator address' })).toBeNull();
    await next();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Fees');
    cleanup();
    renderFlow('/create/v2-overview');
    expect(dd('Curator')).toBe('None');
    expect(dd('Starter items')).toBe('None');
  });

  it('starter ids per collection: the count rule and unreadable ids hold Contents; the Overview counts them and the plan approves and loads each', async () => {
    seedV2(required(CONFIGURATIONS.find((c) => c.id === 'curio-corner')));
    renderFlow('/create/v2-contents');
    expect(ids(1)).toHaveProperty('placeholder', '1, 2, 5-9');
    await typeInto(ids(1), '1-5'); await typeInto(ids(2), '6, 7, 8, nine');
    await next();
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Starter ids 2: Use ids like 1, 2, 5-9']);
    await typeInto(ids(2), '6, 7, 8, 9');
    await next();
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Collections: At least 10 starter items, or none']);
    await typeInto(ids(2), '6-10');
    await next();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Fees');
    cleanup();
    renderFlow('/create/v2-overview');
    // The row names what still holds the items: here, no wallet yet (the Demo asks no chain about them).
    expect(dd('Starter items')).toBe('10 · Connect the wallet that holds the starter items.');
    const plan = Array.from(document.querySelectorAll('.sh-v2-plan li'), (li) => li.textContent ?? '');
    expect(plan.slice(2, 13)).toEqual([...Array.from({ length: 10 }, (_, i) => `approve starter · ${i + 1}`), 'load starters · page 1']);
    expect(plan.slice(-3)).toEqual(['approve seed · 1000 CURIO', 'fundSeed · 1000 CURIO', 'complete · opens the box']);
    expect(dd('Curator')).toBe('You · connect a wallet');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dd('Starter items')).toBe('10');
  });

  it('asks each item’s owner of its collection (ownerOf): the creator’s, someone else’s, or none at all', async () => {
    const OWNER_OF = parseAbi(['function ownerOf(uint256 id) view returns (address)']);
    const holder = (owner: Address | null) => ({ hasCode: vi.fn(async () => true), call: vi.fn<(to: Address, data: Hex) => Promise<Hex | null>>(async () => (owner ? encodeFunctionResult({ abi: OWNER_OF, functionName: 'ownerOf', result: owner }) : null)) });
    const item = { collection: NFT_A as Address, id: 7n };
    const mine = holder(SAFE as Address);
    await expect(starterOwnerV2(mine, item, SAFE.toUpperCase().replace('0X', '0x') as Address)).resolves.toBe('yours');
    expect(mine.call.mock.calls[0]).toEqual([NFT_A, '0x6352211e0000000000000000000000000000000000000000000000000000000000000007']);
    await expect(starterOwnerV2(holder(NFT_A as Address), item, SAFE as Address)).resolves.toBe('not-yours');
    await expect(starterOwnerV2(holder(null), item, SAFE as Address)).resolves.toBe('not-yours');
    // A read the chain could not make is not an answer: 'unknown', and Create stays held ("Checking the starter items").
    const down = { hasCode: vi.fn(async () => true), call: vi.fn(async () => { throw new Error('RPC down'); }) };
    const items = Array.from({ length: 20 }, (_, i) => ({ collection: NFT_A as Address, id: BigInt(i + 1), tier: 0 as const }));
    const answers = await checkStartersV2(down, items, SAFE as Address);
    expect(answers.size).toBe(20);
    expect([...answers.values()].every((answer) => answer === 'unknown')).toBe(true);
    expect((await checkStartersV2(mine, items, SAFE as Address)).get(starterKey(required(items[19])))).toBe('yours');
  });
});
