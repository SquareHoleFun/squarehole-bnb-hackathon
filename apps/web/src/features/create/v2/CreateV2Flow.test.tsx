import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as wallet from '../../wallet';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests, updateDraft } from '../draft';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { DEMO_LISTINGS, type SiteListing } from './listings';
import { Dest, Leg } from './spec-types';
import { resetV2ForTests, updateV2 } from './v2-draft';
import { INSIDE, choiceOf, insideOf } from './recipes';
import type { V2Choices } from './model';
import { seedV2 } from './test-support/v2-fixtures';
import { sha256Hex } from '@squarehole/artwork';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { FILE_FAILED, MODELS_AGAIN, PICTURES_AGAIN, picturesMissingText, picturesNote } from './CreateV2Flow';
import { required } from '../../core/v2/test-support/required';
import { COVER, PAGE, artOf, itemFilesOf } from '../test-support/fixtures';
import { glbOf } from '../test-support/models';
import { decodeMetadataTable } from '../../boxes/spec-record';

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

function renderFlow(path: string, adapter = createDemoWalletAdapter({ latencyMs: 0 }), stepMs = 0, listings: readonly SiteListing[] = DEMO_LISTINGS) {
  const tree = (offered: readonly SiteListing[]) => (
    <AppProviders walletAdapter={adapter}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={stepMs} v2Listings={offered} />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>
  );
  const view = render(tree(listings));
  /** The same page, kept as it is, with the feed's listings changed (wave 2: M1-52's feed). */
  return { relist: (offered: readonly SiteListing[]) => view.rerender(tree(offered)) };
}

const where = () => screen.getByTestId('where').textContent;
const heading = () => screen.getByRole('heading', { level: 1 });
const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

async function connectDemoWallet() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
  const dialog = await screen.findByRole('dialog');
  await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function next() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  });
}

const statusLine = () => document.querySelector('[data-create-status]')?.textContent ?? null;
const createButton = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;

beforeEach(() => {
  resetDraftForTests();
  resetV2ForTests();
});
afterEach(cleanup);

describe('Download BoxSpec validates the current form', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:boxspec');

  beforeEach(() => {
    // Exercise the chain-source action with a connected owner; listings remain labelled Demo fixtures.
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() {
      return { ...useSource(), isDemo: false };
    });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useConnectedWallet() {
      return { ...useCurrentWallet(), status: 'connected', account: wallet.DEMO_WALLET_A };
    });
    createObjectURL.mockClear();
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    seedV2(config('depth-reward'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function downloadFromStepper(path: string) {
    renderFlow(path);
    const steps = within(screen.getByRole('navigation', { name: 'Steps' }));
    await act(async () => fireEvent.click(steps.getByRole('link', { name: 'Overview' })));
    expect(where()).toBe('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
  }

  it.each([
    ['1e3', 'Use a number like 0.05'],
    ['100.1234567', 'Use a number like 0.05'],
    ['15986.524323', 'Below the raise: less than 15986.524323 USDC'],
    ['20000', 'Below the raise: less than 15986.524323 USDC'],
  ])('refuses amount %s and links the focused summary to Opening', async (firstIn, message) => {
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, firstIn } }));
    await downloadFromStepper('/create/v2-opening');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    const summary = screen.getByRole('alert');
    expect(document.activeElement).toBe(summary);
    // SH-254: each link is named by its field, as the field is labelled on Opening.
    await act(async () => fireEvent.click(within(summary).getByRole('link', { name: `Your USDC at start: ${message}` })));
    expect(where()).toBe('/create/v2-opening');
  });

  it.each(['buyers', 'sellers'] as const)('refuses an invalid %s recipe and links to Fees', async (side) => {
    updateV2((choices) => ({ ...choices, [side]: { ...choices[side], a: { leg: Leg.RESERVED_4, dest: Dest.Creator, to: null } } }));
    await downloadFromStepper('/create/v2-fees');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    const summary = screen.getByRole('alert');
    expect(document.activeElement).toBe(summary);
    const issue = within(summary).getByRole('link', { name: `${side === 'buyers' ? 'Buyers’' : 'Sellers’'} fees: Choose a fee destination.` });
    expect(issue.getAttribute('href')).toBe(`#create-v2-${side}`);
    await act(async () => fireEvent.click(issue));
    expect(where()).toBe('/create/v2-fees');
  });

  it.each([
    ['100.5', '100500000'],
    ['15986.524322', '15986524322'],
  ])('exports valid amount %s as exact raw units', async (firstIn, creatorBuy) => {
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, firstIn } }));
    await downloadFromStepper('/create/v2-opening');
    expect(screen.queryByRole('alert')).toBeNull();
    // The file's pictures are read and checked first (F-1), so the download follows a moment later.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!blob) throw new Error('BoxSpec was not downloaded');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toMatchObject({
      format: 'squarehole.boxspec/2',
      demo: true,
      spec: { creatorBuy, creatorFeeRecipient: '0x0000000000000000000000000000000000000000', raise: '15986524323' },
    });
  });
});

describe('F-1: the BoxSpec file carries the pictures its spec commits', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:boxspec');
  const text = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  beforeEach(() => {
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() { return { ...useSource(), isDemo: false }; });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useConnectedWallet() { return { ...useCurrentWallet(), status: 'connected', account: wallet.DEMO_WALLET_A }; });
    createObjectURL.mockClear();
    vi.stubGlobal('URL', class extends URL { static override createObjectURL = createObjectURL; static override revokeObjectURL = vi.fn(); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('the logo, the collection cover and each item picture, each the bytes of its committed sha256; open art’s reveal list too', async () => {
    const input = seedV2(config('bag-holders'));
    renderFlow('/create/v2-overview');
    expect(screen.getByText(picturesNote('open'))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const body = JSON.parse(await text(required(createObjectURL.mock.calls[0]?.[0]))) as { spec: { coverSha256: string; collectionCoverSha256: string }; pictures: { role: string; sha256: string; base64: string }[]; revealList: { items: { imageSha256: string }[] } | null };
    const roles = body.pictures.map((picture) => picture.role);
    expect(roles.slice(0, 2)).toEqual(['logo', 'collection cover']);
    expect(roles.filter((role) => role === 'item')).toHaveLength(new Set(required(input.art).items.map((item) => item.imageSha256)).size);
    expect(body.pictures[0]?.sha256).toBe(body.spec.coverSha256); expect(body.pictures[1]?.sha256).toBe(body.spec.collectionCoverSha256);
    for (const picture of body.pictures) expect(sha256Hex(Uint8Array.from(atob(picture.base64), (c) => c.charCodeAt(0)))).toBe(picture.sha256);
    // Items in sha256 order, never by id; open art's public reveal list names each item's picture.
    const items = body.pictures.filter((picture) => picture.role === 'item').map((picture) => picture.sha256);
    expect(items).toEqual([...items].sort());
    expect(new Set(required(body.revealList).items.map((item) => item.imageSha256))).toEqual(new Set(items));
  });

  it('after a reload (the art’s hashes kept, its files not), refuses and asks for the item pictures again; a token needs only its logo', async () => {
    seedV2(config('bag-holders')); forgetItemFiles();
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(PICTURES_AGAIN)).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    cleanup();
    seedV2(config('rug-rugs'));
    renderFlow('/create/v2-overview');
    expect(screen.getByText(picturesNote('token'))).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const body = JSON.parse(await text(required(createObjectURL.mock.calls[0]?.[0]))) as { pictures: { role: string }[]; revealList: unknown };
    expect(body.pictures.map((picture) => picture.role)).toEqual(['logo']);
    expect(body.revealList).toBeNull();
  });

  // SH-AI-PLAN fix round 1: hidden art's table is sorted, so it says nothing about which id holds what; open art's is not.
  it('hidden art’s file commits a sorted trait table; open art’s keeps the order of first appearance', async () => {
    const cases = [['ultrasound-owls', ['Gold', 'Red', 'Teal'], ['Circle', 'Square']], ['bag-holders', ['Red', 'Teal', 'Gold'], ['Square', 'Circle']]] as const;
    for (const [id, colours, shapes] of cases) {
      cleanup();
      createObjectURL.mockClear();
      seedV2(config(id));
      renderFlow('/create/v2-overview');
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
      const body = JSON.parse(await text(required(createObjectURL.mock.calls[0]?.[0]))) as { spec: { artMode: number; metadataTable: `0x${string}` } };
      expect(body.spec.artMode, id).toBe(id === 'ultrasound-owls' ? 2 : 1);
      expect(decodeMetadataTable(body.spec.metadataTable)?.traitTypes, id).toEqual([{ name: 'Colour', values: colours }, { name: 'Shape', values: shapes }]);
    }
  });

  // FE12 review H-1: the collection page's banner and teasers are the browser's re-encodings too (add-on 6).
  it('the collection page’s banner and teasers ride along, each the bytes of its committed sha256; hidden art says when items publish', async () => {
    seedV2(config('bag-holders'));
    updateDraft((draft) => ({ ...draft, page: PAGE }));
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const body = JSON.parse(await text(required(createObjectURL.mock.calls[0]?.[0]))) as { pictures: { role: string; sha256: string; base64: string }[] };
    expect(body.pictures.map((picture) => picture.role).slice(0, 6)).toEqual(['logo', 'collection cover', 'banner', 'teaser', 'teaser', 'teaser']);
    expect(body.pictures.slice(2, 6).map((picture) => picture.sha256)).toEqual([required(PAGE.banner).sha256, ...PAGE.teasers.map((teaser) => teaser.sha256)]);
    for (const picture of body.pictures) expect(sha256Hex(Uint8Array.from(atob(picture.base64), (c) => c.charCodeAt(0)))).toBe(picture.sha256);
    // A banner whose kept bytes no longer hash to the committed sha256 is named, and nothing is saved.
    createObjectURL.mockClear();
    updateDraft((draft) => ({ ...draft, page: { ...PAGE, banner: { ...required(PAGE.banner), data: btoa('other bytes') } } }));
    cleanup();
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(picturesMissingText([{ role: 'banner', sha256: required(PAGE.banner).sha256 }]))).toBeTruthy();
    expect(screen.getByText('Add the banner again: its bytes do not match this spec.')).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    cleanup();
    seedV2(config('ultrasound-owls'));
    renderFlow('/create/v2-overview');
    expect(screen.getByText(picturesNote('hidden'))).toBeTruthy();
    expect(picturesNote('hidden')).toMatch(/item pictures at the reveal\./);
  });

  // SH-NO-PICTURE-GATE (founder 2026-10-24): a box is listed at once; its pictures follow when published.
  it('the pictures note says the box shows up as soon as it is created, never that it waits for its pictures', () => {
    for (const contents of ['token', 'open', 'hidden'] as const) {
      expect(picturesNote(contents)).toMatch(/^Your box shows up as soon as it is created\. /);
      expect(picturesNote(contents)).not.toMatch(/only once|until|not (?:listed|shown)/i);
    }
  });

  // R74-ART (SH-CREATE-ITEM-MODELS): a collection with a 3D model per item carries every model in its file.
  it('a 3D collection’s file carries each model after its pictures, typed and checked; after a reload it asks for the pictures and models again', async () => {
    seedV2(config('bag-holders'));
    const art = { ...artOf(), items: artOf().items.map((item) => ({ ...item, modelSha256: sha256Hex(glbOf(item.id)), modelBytes: glbOf(item.id).byteLength })) };
    updateDraft((draft) => ({ ...draft, art }));
    keepItemFiles(new Map([...itemFilesOf(), ...art.items.map((item) => [required(item.modelSha256), new Blob([glbOf(item.id).slice().buffer])] as const)]));
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const body = JSON.parse(await text(required(createObjectURL.mock.calls[0]?.[0]))) as { pictures: { role: string }[]; models: { type: string; sha256: string; base64: string }[]; revealList: { items: { modelSha256: string }[] } };
    expect(Object.keys(body).slice(-3)).toEqual(['pictures', 'models', 'revealList']);
    expect(body.pictures.filter((picture) => picture.role === 'item')).toHaveLength(12);
    expect(body.models.map((model) => model.sha256)).toEqual(art.items.map((item) => required(item.modelSha256)).sort());
    for (const model of body.models) {
      expect(model.type).toBe('model/gltf-binary');
      expect(sha256Hex(Uint8Array.from(atob(model.base64), (c) => c.charCodeAt(0)))).toBe(model.sha256);
    }
    expect(body.revealList.items.map((entry) => entry.modelSha256)).toEqual(art.items.map((item) => item.modelSha256));
    // After a reload the draft keeps the hashes only: nothing is saved, and the line asks for both kinds of file.
    cleanup(); createObjectURL.mockClear(); forgetItemFiles();
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(MODELS_AGAIN)).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    // The pictures alone (the models' files gone) are not enough either.
    cleanup(); keepItemFiles(itemFilesOf());
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(MODELS_AGAIN)).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  // FE12 review M-3: a file that cannot be read any more, or a file the browser cannot save, ends with a message.
  it('an item file that can no longer be read asks for the pictures again; a file that cannot be saved says so', async () => {
    const input = seedV2(config('bag-holders'));
    const files = new Map(itemFilesOf(required(input.art).items.length));
    const [first] = [...files.keys()].sort();
    files.set(required(first), { arrayBuffer: () => Promise.reject(new DOMException('The file was moved', 'NotReadableError')) } as unknown as Blob);
    keepItemFiles(files);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(PICTURES_AGAIN)).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    cleanup();
    seedV2(config('rug-rugs'));
    createObjectURL.mockImplementationOnce(() => { throw new RangeError('Out of room'); });
    renderFlow('/create/v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download BoxSpec' })));
    expect(await screen.findByText(FILE_FAILED)).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});

describe('the v2 flow’s steps', () => {
  it('/create/v2 opens Basics, step 1 of 6, with no source chip or Demo word for the sample data (F130)', async () => {
    renderFlow('/create/v2');
    await waitFor(() => expect(where()).toBe('/create/v2-basics'));
    expect(heading().textContent).toBe('Launch a box, step 1 of 6: Basics');
    expect(screen.queryAllByText('Demo')).toHaveLength(0);
    expect(document.querySelector('.sh-newbox__source')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bdemo\b/i);
    const steps = within(screen.getByRole('navigation', { name: 'Steps' }));
    expect(steps.getAllByRole('listitem').map((item) => item.textContent?.replace(' · Fix', ''))).toEqual(['Basics', 'Contents', 'Fees', 'Raise', 'Opening', 'Overview']);
  });

  it('walks Basics to Overview with Next and never asks a wallet', async () => {
    const adapter = createDemoWalletAdapter({ latencyMs: 0 });
    const connect = vi.spyOn(adapter, 'connect');
    seedV2(config('depth-reward'));
    renderFlow('/create/v2-basics', adapter);
    for (const [path, label] of [
      ['/create/v2-contents', 'Contents'],
      ['/create/v2-fees', 'Fees'],
      ['/create/v2-raise', 'Raise'],
      ['/create/v2-opening', 'Opening'],
      ['/create/v2-overview', 'Overview'],
    ] as const) {
      await next();
      await waitFor(() => expect(where()).toBe(path));
      expect(heading().textContent).toContain(label);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('v1’s flow at /create/basics is untouched', () => {
    renderFlow('/create/basics');
    expect(within(screen.getByRole('navigation', { name: 'Steps' })).getByText('Box kind')).toBeTruthy();
  });
});

describe('F128 Start from a template', () => {
  // A template no longer writes a name or ticker, so a draft an earlier test left in this tab must not show through.
  beforeEach(() => {
    window.sessionStorage.clear();
    resetDraftForTests();
    resetV2ForTests();
  });
  const tiles = () => within(screen.getByRole('region', { name: 'Start from a template' }));
  const tile = (name: RegExp) => tiles().getByRole('button', { name });
  const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

  it('Basics starts with one tile per generic recipe and Blank, each with its icon, name and one line; none pressed yet', () => {
    renderFlow('/create/v2-basics');
    const buttons = tiles().getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Liquidity tokenToken · Grow the pool', 'BurnToken · Buy back and burn', 'To the creatorToken · Keep', 'To holdersToken · To holders',
      'CollectionNFTs · To items · Keep', 'Collection that burnsNFTs · To items · Buy back and burn', 'Coin pileToken · Coin pile', 'ShopShop · To holders', 'BlankNo recipe',
    ]);
    // No named example box (they are test data now); Shop is generic (SH-V21-FE13: the flow has its step now).
    expect(tiles().queryByRole('button', { name: /Gold Rush|Link Marines|Dragon|Junkyard/ })).toBeNull();
    for (const b of buttons) { expect(b.getAttribute('aria-pressed')).toBe('false'); expect(b.querySelector('svg[data-icon][aria-hidden="true"]')).toBeTruthy(); }
  });

  // The logo is the one Basics field no template sets.
  const withLogo = () => updateDraft((d) => ({ ...d, cover: COVER }));

  it('a template fills only its recipe: contents and both fee choices; the price coin, name and ticker stay; no wallet is asked', async () => {
    const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
    withLogo(); renderFlow('/create/v2-basics', adapter);
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: /^USDC/ })));
    await act(async () => fireEvent.change(field('Name'), { target: { value: 'Night Owls' } }));
    await act(async () => fireEvent.click(tile(/^Collection that burns/)));
    expect(tile(/^Collection that burns/).getAttribute('aria-pressed')).toBe('true');
    // Nothing named or coin-specific is filled: the creator's name stays, the ticker stays empty, the coin stays USDC.
    expect(field('Name').value).toBe('Night Owls'); expect(field('Ticker').value).toBe('');
    expect((screen.getByRole('radio', { name: /^USDC/ }) as HTMLInputElement).checked).toBe(true);
    await act(async () => fireEvent.change(field('Ticker'), { target: { value: 'OWLS' } }));
    expect(tile(/^Collection that burns/).getAttribute('aria-pressed')).toBe('true');
    await next(); await waitFor(() => expect(where()).toBe('/create/v2-contents'));
    expect((screen.getByRole('radio', { name: /^New collection/ }) as HTMLInputElement).checked).toBe(true);
    // Items on both sides, and the items still in the vault burn (the Misfits' way); the price coin is still USDC.
    let choices: V2Choices | null = null;
    updateV2((current) => { choices = current; return current; });
    const picked = choices as V2Choices | null;
    expect(picked && [choiceOf(picked.buyers), choiceOf(picked.sellers), insideOf(picked.buyers), insideOf(picked.sellers)]).toEqual(['items', 'items', INSIDE.burn, INSIDE.burn]);
    expect(picked?.pricing).toBe(DEMO_LISTINGS.find((listing) => listing.symbol === 'USDC')?.token);
    expect(connect).not.toHaveBeenCalled();
  });

  it('a token recipe sets Token and its fees; Coin pile adds a pile in the price coin; Blank puts the recipe back', async () => {
    withLogo(); renderFlow('/create/v2-basics');
    await act(async () => fireEvent.click(tile(/^To the creator/)));
    expect(field('Name').value).toBe(''); expect(field('Ticker').value).toBe('');
    // The creator names the box: no template does.
    await act(async () => { fireEvent.change(field('Name'), { target: { value: 'Paper Moons' } }); fireEvent.change(field('Ticker'), { target: { value: 'MOON' } }); });
    await next(); await waitFor(() => expect(where()).toBe('/create/v2-contents'));
    expect((screen.getByRole('radio', { name: /^Token/ }) as HTMLInputElement).checked).toBe(true);
    await next(); await waitFor(() => expect(where()).toBe('/create/v2-fees'));
    for (const side of ['Buyers', 'Sellers']) expect(within(screen.getByRole('group', { name: side === 'Buyers' ? 'Buyers’ fees · in ETH' : 'Sellers’ fees · paid in MOON, used as ETH' })).getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    cleanup(); renderFlow('/create/v2-basics');
    expect(tile(/^To the creator/).getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(tile(/^Coin pile/)));
    await next(); await waitFor(() => expect(where()).toBe('/create/v2-contents'));
    expect((screen.getByRole('radio', { name: /^Token/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /^Coin pile/ }) as HTMLInputElement).checked).toBe(true);
    cleanup(); renderFlow('/create/v2-basics');
    await act(async () => fireEvent.click(tile(/^Blank/)));
    // Blank puts back only what a recipe sets: the creator's name and ticker and the price coin stay.
    expect(field('Name').value).toBe('Paper Moons'); expect(field('Ticker').value).toBe('MOON');
    expect((screen.getByRole('radio', { name: /^ETH/ }) as HTMLInputElement).checked).toBe(true);
    expect(tile(/^Blank/).getAttribute('aria-pressed')).toBe('true'); expect(tile(/^Coin pile/).getAttribute('aria-pressed')).toBe('false');
    await next(); await waitFor(() => expect(where()).toBe('/create/v2-contents'));
    expect((screen.getByRole('radio', { name: /^Token/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('radio', { name: /^New collection/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('Basics: the pricing token', () => {
  it('names the issuer’s powers of a stock', async () => {
    renderFlow('/create/v2-basics');
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: /NVDAon/ })));
    expect(screen.getByText('Ondo can pause or block all its tokens at once.')).toBeTruthy();
    expect(screen.getByText('Stock-linked: may not be offered to US persons.')).toBeTruthy();
  });
  it('shows each coin’s raise and the chosen box coin’s parent', async () => {
    renderFlow('/create/v2-basics');
    expect(screen.getByRole('radio', { name: /USDC.*15986.524323 USDC/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: /CHOO/ })));
    expect(screen.getByRole('link', { name: 'Toy Trains' }).getAttribute('href')).toBe('/box/31337/0xde00700000000000000000000000000000000003');
    expect(within(document.querySelector('[data-pricing-card]') as HTMLElement).getByText('9783674.616279069767441859 CHOO')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/at spot|listing is added first/);
  });
});
describe('CQ11-E choices and fixed raise', () => {
  it('offers six choices on BOTH sides of a collection box, in the price coin (v2.1: eating ETH locks it)', async () => {
    seedV2(config('ultrasound-owls')); renderFlow('/create/v2-fees');
    for (const side of ['Buyers', 'Sellers']) {
      const group = screen.getByRole('group', { name: side === 'Buyers' ? 'Buyers’ fees · in ETH' : 'Sellers’ fees · paid in OWL, used as ETH' });
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep', 'Buy back and burn OWL', 'Grow the pool', 'To holders', 'To items', 'Lock ETH']);
      await act(async () => fireEvent.click(within(group).getByRole('button', { name: 'Keep' })));
      expect(within(group).getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    }
    await next(); expect(where()).toBe('/create/v2-raise');
  });
  it('shows the fixed raise and explains that lister edits affect future boxes', async () => {
    seedV2(config('square-pegs')); renderFlow('/create/v2-raise');
    expect(screen.getByText('21034900.425 FIT')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'About the raise' })));
    expect(screen.getByText(/each box keeps its creation raise/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/at spot|lowest prices|pair touched/);
  });
  it('a changed listing raise invalidates the Demo run without changing its identity', async () => {
    seedV2(config('box-token-priced'));
    const view = renderFlow('/create/v2-overview', createDemoWalletAdapter({ latencyMs: 0 }), 0);
    await connectDemoWallet(); await act(async () => fireEvent.click(createButton()));
    await waitFor(() => expect(statusLine()).toBe('Open'));
    const before = document.querySelector('[data-spec-hash]')?.getAttribute('data-spec-hash');
    act(() => view.relist(DEMO_LISTINGS.map((l) => l.symbol === 'CHOO' ? { ...l, raise: l.raise + 1n } : l)));
    expect(statusLine()).toBeNull(); expect(createButton().disabled).toBe(false);
    expect(document.querySelector('[data-spec-hash]')?.getAttribute('data-spec-hash')).not.toBe(before);
  });
  it('a run stays its box’s while the clock moves a preset open time (review round 3)', async () => {
    seedV2(config('gas-guzzlers'));
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, open: { kind: 'preset', id: '5m' } } }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderFlow('/create/v2-overview', createDemoWalletAdapter({ latencyMs: 0 }), 10);
      await connectDemoWallet();
      const hashShown = () => document.querySelector('[data-spec-hash]')?.getAttribute('data-spec-hash');
      const before = hashShown();
      await act(async () => fireEvent.click(createButton()));
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(statusLine()).toBe('Open');
      // Two minutes on, the open time (the next whole minute 5 min from the clock), and so the live hash, have moved.
      await act(async () => vi.advanceTimersByTime(120_000));
      expect(hashShown()).not.toBe(before);
      expect(statusLine()).toBe('Open');
      expect(screen.getByRole('button', { name: 'Start a new box' })).toBeTruthy();
      // SH-254: a new box starts on the default way, Visual.
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start a new box' })));
      expect(where()).toBe('/create/v2-picture');
    } finally {
      vi.useRealTimers();
    }
  });
  it('an edit mid-run makes the run another box’s; a new Create counts its own steps only (review round 3)', async () => {
    seedV2(config('gas-guzzlers'));
    renderFlow('/create/v2-overview', createDemoWalletAdapter({ latencyMs: 0 }), 10);
    await connectDemoWallet();
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(createButton()));
      await act(async () => vi.advanceTimersByTime(10));
      expect(statusLine()).toMatch(/^Waiting for its table · 0\//);
      await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Edit Raise' })));
      await act(async () => fireEvent.click(screen.getByRole('radio', { name: /^60/ })));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Back to overview' })));
      expect(where()).toBe('/create/v2-overview');
      expect(statusLine()).toBeNull();
      expect(document.querySelectorAll('.sh-v2-plan [data-done]')).toHaveLength(0);
      expect(createButton().disabled).toBe(false);
      await act(async () => fireEvent.click(createButton()));
      expect(statusLine()).toMatch(/^Sending · 0\//);
      // The old run's timers are stopped: one step on, the new run has sent its createBox and no chunk.
      await act(async () => vi.advanceTimersByTime(10));
      expect(statusLine()).toMatch(/^Waiting for its table · 0\//);
      expect(document.querySelectorAll('.sh-v2-plan [data-done]')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('an ETH-priced box: the createBox row shows the ETH it sends (bootstrap and creator buy)', () => {
    seedV2(config('gas-guzzlers'));
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, firstIn: '0.1' } }));
    renderFlow('/create/v2-overview');
    expect(screen.getByText(/^createBox · 0\.1015 ETH · gas limit [\d,]+$/)).toBeTruthy();
  });
  it('the Overview shows the plan; Create in the Demo waits for the table, then opens', async () => {
    seedV2(config('gas-guzzlers'));
    renderFlow('/create/v2-overview', createDemoWalletAdapter({ latencyMs: 0 }), 10);
    expect(screen.getByText(/createBox/)).toBeTruthy();
    await connectDemoWallet();
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
      const status = () => document.querySelector('[data-create-status]')?.textContent ?? '';
      expect(status()).toMatch(/^Sending/);
      await act(async () => vi.advanceTimersByTime(10));
      expect(status()).toMatch(/^Waiting for its table · 0\//);
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(status()).toMatch(/^Open/);
    } finally {
      vi.useRealTimers();
    }
  });
});
