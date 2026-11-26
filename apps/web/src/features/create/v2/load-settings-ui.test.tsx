/**
 * TA-27 on the page: Load settings on Basics takes the page's own BoxSpec file and then the item pictures; afterwards
 * the fields outside the five show read-only with the loaded setup's line and Start over, the price coin, name, ticker,
 * opening and fees stay editable, the links (not in the file) and the collection page's link (in it) load empty and
 * stay the creator's own, and a hidden-art setup still asks for its reveal file before Create.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePng } from '../../../../../../packages/artwork/src/test-support/images';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { readArt, toBase64, type ArtEnvironment } from '../art-files';
import { commitArt, revealList, type ArtState, type CoverState } from '../create-model';
import { clearDraft, currentDraft, resetDraftForTests, updateDraft } from '../draft';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { formOf, inputOf } from '../test-support/fixtures';
import { DEMO_LISTINGS, NATIVE_TOKEN } from './listings';
import { LOADED_EDITABLE, LOADED_LINE, LoadSettings } from './LoadSettings';
import { DEFAULT_V2, boxSpecFile, buildSpecV2, recipeCtx, type BuildV2Input } from './model';
import { committedModels, committedPictures } from './pictures';
import { glbOf } from '../test-support/models';
import { INSIDE, pickFor } from './recipes';
import type { CollectionCheck } from './shop';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { clearV2, currentV2Loaded, resetV2ForTests, setV2Loaded } from './v2-draft';

const png = (width: number, height = width) => makePng({ width, height, decodable: true });
const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const items = () => TEN.map((id) => new File([png(40 + id).slice().buffer], `${id}.png`, { type: 'image/png' }));
const env: ArtEnvironment = { digest, thumbnail: async () => null, encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }), salt: () => sha256Hex(crypto.getRandomValues(new Uint8Array(32))) };
const link = DEMO_LISTINGS.find((listing) => listing.symbol === 'LINK');
/** The creator's own links, typed after loading (Website, X, Telegram: site metadata, never in the file). */
const MINE = { website: 'https://mine.example', x: '@mine', telegram: 'https://t.me/mine_box' };
const LINK_BOXES = [['Website', MINE.website], ['X', MINE.x], ['Telegram', MINE.telegram]] as const;

/** A hidden collection's settings file, as this page downloads it: its collection page links to the example's site. */
async function hiddenFile(): Promise<string> {
  const kept = new Map<string, Blob>();
  const art = await readArt(items(), { env, onItemFile: (sha256, file) => kept.set(sha256, file) });
  keepItemFiles(kept);
  const picture = (bytes: Uint8Array) => ({ sha256: sha256Hex(bytes), url: null, bytes: bytes.byteLength, data: toBase64(bytes) });
  const input: BuildV2Input = {
    ...inputOf({ form: formOf({ name: 'Paper Moons', ticker: 'MOON', description: 'Moons, folded.', artMode: 'hidden', rights: true, pageLink: 'https://moons.example', pageLinkEdited: true }), art, cover: picture(png(300)), collectionCover: picture(png(301)) }),
    v2: { ...DEFAULT_V2, pricing: link?.token ?? DEFAULT_V2.pricing, buyers: pickFor('items', INSIDE.keep), sellers: pickFor('burn'), pickFeeBps: 100, deadlineDays: 90 },
    listings: DEMO_LISTINGS,
  };
  const spec = buildSpecV2(input);
  const { pictures } = await committedPictures(spec, { cover: input.cover, collectionCover: input.collectionCover ?? null, page: input.page, art }, digest);
  forgetItemFiles();
  return boxSpecFile(spec, recipeCtx(input), { pictures }).parts.join('');
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}
function renderFlow(art: ArtEnvironment = env) {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-basics']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} env={art} />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>,
  );
}
const choose = async (input: HTMLElement, files: File[]) => act(async () => { fireEvent.change(input, { target: { files } }); });
const next = async () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
/** Read-only: inside a disabled fieldset (a control's own `disabled` property does not say so). */
const locked = (element: Element) => element.closest('fieldset[disabled]') !== null;

beforeEach(() => { resetDraftForTests(); resetV2ForTests(); forgetItemFiles(); });
afterEach(cleanup);

/** R74-ART: ten numbered models, one per item. */
const models = () => TEN.map((id) => new File([glbOf(id).slice().buffer], `${id}.glb`, { type: 'model/gltf-binary' }));

/** An open 3D collection's settings file, as this page downloads it: every picture, every model and the reveal list. */
async function modelFile(): Promise<string> {
  const kept = new Map<string, Blob>();
  const art = await readArt([...items(), ...models()], { env, onItemFile: (sha256, file) => kept.set(sha256, file) });
  keepItemFiles(kept);
  const picture = (bytes: Uint8Array) => ({ sha256: sha256Hex(bytes), url: null, bytes: bytes.byteLength, data: toBase64(bytes) });
  const commitment = commitArt(art, 'open');
  const input: BuildV2Input = {
    ...inputOf({ form: formOf({ name: 'Glass Houses', ticker: 'HOUSE', description: 'Houses, modelled.', rights: true }), art, commitment, cover: picture(png(300)), collectionCover: picture(png(301)) }),
    v2: { ...DEFAULT_V2, pricing: NATIVE_TOKEN, buyers: pickFor('items', INSIDE.keep), sellers: pickFor('burn'), pickFeeBps: 100 },
    listings: DEMO_LISTINGS,
  };
  const spec = buildSpecV2(input);
  const { pictures } = await committedPictures(spec, { cover: input.cover, collectionCover: input.collectionCover ?? null, page: input.page, art }, digest);
  const { models: glbs } = await committedModels(spec, { art });
  forgetItemFiles();
  return boxSpecFile(spec, recipeCtx(input), { pictures, models: glbs, revealList: revealList(art, commitment?.packed ?? []) }).parts.join('');
}

describe('Load settings on Create: a setup with 3D models (SH-CREATE-ITEM-MODELS)', () => {
  it('asks for the pictures and models, refuses the pictures alone, then loads them: the line says 3D and the draft keeps every model', async () => {
    const text = await modelFile();
    renderFlow();
    await choose(field('create-load-settings'), [new File([text], 'house-boxspec-v2.json', { type: 'application/json' })]);
    await screen.findByText('Item pictures + models · 10');
    expect(field('create-load-items').accept).toContain('.glb');
    expect(screen.getByLabelText('Item pictures + models · 10 Images + models + traits')).toBe(field('create-load-items'));
    // The pictures without their models: refused, said plainly; nothing is loaded.
    await choose(field('create-load-items'), items());
    expect((await screen.findByRole('alert')).textContent).toContain('This setup has 3D models: add 1.glb … N.glb with the pictures.');
    expect(currentV2Loaded()).toBeNull();
    // Models that are not the setup's (1.glb and 2.glb swapped): the line names the models too.
    const swapped = [2, 1, ...TEN.slice(2)].map((id, i) => new File([glbOf(id).slice().buffer], `${i + 1}.glb`, { type: 'model/gltf-binary' }));
    await choose(field('create-load-items'), [...items(), ...swapped]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('These item pictures, models or traits are not the setup’s.'));
    expect(currentV2Loaded()).toBeNull();
    await choose(field('create-load-items'), [...items(), ...models()]);
    await screen.findByText(LOADED_LINE);
    expect(screen.getByText('10 items, 3D')).toBeTruthy();
    expect(currentV2Loaded()).toMatchObject({ items: 10, hidden: false, models: true });
    expect(currentDraft().art?.items.map((item) => item.modelSha256)).toEqual(TEN.map((id) => sha256Hex(glbOf(id))));
    // Contents: the art's line says the models were read.
    await next();
    expect(screen.getAllByRole('status').map((line) => line.textContent)).toContain('10 items · 0 traits · 3D');
  });
});

describe('Load settings on Create', () => {
  it('loads a hidden setup and its pictures; only the five and the links stay editable, the links empty; the reveal file is still asked for; Start over clears it', async () => {
    const text = await hiddenFile();
    renderFlow();
    expect(screen.getByRole('heading', { name: 'Start from a template' })).toBeTruthy();
    await choose(field('create-load-settings'), [new File([text], 'moon-boxspec-v2.json', { type: 'application/json' })]);
    await screen.findByText('Item pictures · 10');
    expect(screen.getByLabelText('Item pictures · 10 Images + traits')).toBe(field('create-load-items'));
    await choose(field('create-load-items'), items());
    await screen.findByText(LOADED_LINE);
    expect(screen.getByText(LOADED_EDITABLE)).toBeTruthy();
    expect(currentV2Loaded()).toMatchObject({ items: 10, hidden: true });
    // The example's collection page link is not kept: the new box's starts empty.
    expect(currentDraft().form).toMatchObject({ pageLink: '', pageLinkEdited: false });
    // Basics: name and ticker editable, the price coin too; the logo and About read-only; no templates, no second load.
    expect(screen.queryByRole('heading', { name: 'Start from a template' })).toBeNull();
    expect(document.getElementById('create-load-settings')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Paper Moons');
    expect(locked(screen.getByRole('textbox', { name: 'Name' }))).toBe(false);
    expect(locked(screen.getByRole('textbox', { name: 'Ticker' }))).toBe(false);
    expect(locked(screen.getByRole('radio', { name: /^USDC/ }))).toBe(false);
    expect(locked(screen.getByRole('textbox', { name: 'About' }))).toBe(true);
    expect(locked(field('create-logo'))).toBe(true);
    // The links: empty (the file has none) and editable; what is typed is kept, as without a loaded setup.
    for (const [name, value] of LINK_BOXES) {
      const box = screen.getByRole('textbox', { name }) as HTMLInputElement;
      expect(box.value, name).toBe('');
      expect(locked(box), name).toBe(false);
      await act(async () => { fireEvent.change(box, { target: { value } }); });
      expect(box.value, name).toBe(value);
    }
    expect(currentDraft().form.links).toEqual(MINE);
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'My Moons' } }); });
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'About' }), { target: { value: 'Changed' } }); });
    expect(currentDraft().form).toMatchObject({ name: 'My Moons', description: 'Moons, folded.', links: MINE });
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /^USDC/ })); });
    expect((screen.getByRole('radio', { name: /^USDC/ }) as HTMLInputElement).checked).toBe(true);
    await next();
    // Contents: every field read-only but the pick fee (a fee) and the collection page's link (the creator's own).
    await screen.findByText(LOADED_LINE);
    const contents = document.querySelector('fieldset[data-locked]') as HTMLFieldSetElement;
    expect(contents.disabled).toBe(true);
    expect(locked(within(contents).getByRole('radio', { name: /^Hidden until drawn/ }))).toBe(true);
    const pick = screen.getByRole('group', { name: /^Pick fee/ });
    expect(locked(pick)).toBe(false);
    await act(async () => { fireEvent.click(within(pick).getByRole('radio', { name: '5%' })); });
    expect(document.querySelectorAll('#create-page-link')).toHaveLength(1);
    const pageLink = field('create-page-link');
    expect(locked(pageLink)).toBe(false);
    expect(pageLink.value).toBe(MINE.website);
    await act(async () => { fireEvent.change(pageLink, { target: { value: 'https://mine.example/moons' } }); });
    expect(pageLink.value).toBe('https://mine.example/moons');
    await next();
    await next();
    // Raise: the deadline is the setup's.
    expect(locked(screen.getByRole('radio', { name: /^90/ }))).toBe(true);
    expect((screen.getByRole('radio', { name: /^90/ }) as HTMLInputElement).checked).toBe(true);
    await next();
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' })); });
    await next();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/create/v2-overview'));
    // Create's draft carries the creator's links (the page keeps links there) and page link; kept fields are the file's.
    expect(currentDraft().form).toMatchObject({ name: 'My Moons', description: 'Moons, folded.', links: MINE, pageLink: 'https://mine.example/moons', pageLinkEdited: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // New salts for the new box: its reveal file must be saved before Create.
    expect(screen.getByRole('button', { name: 'Save reveal file' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole('link', { name: /Basics/ })[0] as HTMLElement); });
    await screen.findByText(LOADED_LINE);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start over' })); });
    expect(screen.queryByText(LOADED_LINE)).toBeNull();
    expect(currentV2Loaded()).toBeNull();
    expect(locked(screen.getByRole('textbox', { name: 'About' }))).toBe(false);
    expect(field('create-load-settings')).toBeTruthy();
  });

  it('says plainly why a file cannot load', async () => {
    renderFlow();
    await choose(field('create-load-settings'), [new File(['{"format":"other"}'], 'x.json', { type: 'application/json' })]);
    expect((await screen.findByRole('alert')).textContent).toContain('Not a settings file');
    expect(currentV2Loaded()).toBeNull();
  });

  it('a logo read still running when a setup loads never replaces the loaded logo', async () => {
    let held = false;
    let release = (): void => undefined;
    const slow: ArtEnvironment = { ...env, encodeCover: async (file) => {
      held = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return { bytes: new Uint8Array(await file.arrayBuffer()) };
    } };
    const text = await hiddenFile();
    renderFlow(slow);
    await choose(field('create-logo'), [new File([png(310).slice().buffer], 'logo.png', { type: 'image/png' })]);
    await waitFor(() => expect(held).toBe(true));
    await choose(field('create-load-settings'), [new File([text], 'moon-boxspec-v2.json', { type: 'application/json' })]);
    await screen.findByText('Item pictures · 10');
    await choose(field('create-load-items'), items());
    await screen.findByText(LOADED_LINE);
    expect(currentDraft().cover?.sha256).toBe(sha256Hex(png(300)));
    // The old upload finishes after the load: it is not this draft's, and the lock refuses it anyway.
    await act(async () => { release(); });
    await waitFor(() => expect(field('create-logo').closest('label')?.hasAttribute('data-busy')).toBe(false));
    expect(currentDraft().cover?.sha256).toBe(sha256Hex(png(300)));
  });

  it('while a setup is loaded the draft keeps its art, logo, collection cover, page and kept fields, whoever writes it', () => {
    clearDraft();
    const picture = (side: number): CoverState => ({ sha256: sha256Hex(png(side)), url: null, bytes: png(side).byteLength, data: toBase64(png(side)) });
    const art: ArtState = { items: [], salts: [], thumbs: [], totalBytes: 0, problems: [] };
    updateDraft((d) => ({ ...d, cover: picture(300), collectionCover: picture(301), page: { banner: picture(302), teasers: [] }, form: { ...d.form, description: 'Moons, folded.' } }));
    const before = currentDraft();
    setV2Loaded({ pileFollowsPrice: false, items: 0, hidden: false, note: null });
    updateDraft((d) => ({ ...d, art, cover: picture(310), collectionCover: picture(311), page: { banner: null, teasers: [picture(312)] }, form: { ...d.form, description: 'Changed', name: 'Mine' } }));
    expect(currentDraft()).toMatchObject({ art: before.art, cover: before.cover, collectionCover: before.collectionCover, page: before.page });
    expect(currentDraft().form).toMatchObject({ description: 'Moons, folded.', name: 'Mine' });
    clearV2();
    updateDraft((d) => ({ ...d, cover: picture(310) }));
    expect(currentDraft().cover?.sha256).toBe(sha256Hex(png(310)));
  });

  it('a shop file is checked on the chain before it loads: a starting collection with no contract refuses it', async () => {
    const config = CONFIGURATIONS.find((entry) => entry.id === 'curio-corner');
    if (!config) throw new Error('curio-corner');
    const logo = png(300);
    const input = { ...inputV2Of(config, { pricing: NATIVE_TOKEN }), cover: { sha256: sha256Hex(logo), url: null, bytes: logo.byteLength, data: toBase64(logo) } };
    const text = boxSpecFile(buildSpecV2(input), recipeCtx(input), { pictures: [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }] }).parts.join('');
    const asked: string[][] = [];
    const checkCollections = async (collections: readonly string[]) => {
      asked.push(collections.map((address) => address.toLowerCase()));
      return new Map(collections.map((address): [string, CollectionCheck] => [address.toLowerCase(), address.toLowerCase().endsWith('a1') ? 'no-code' : 'erc721']));
    };
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo checkCollections={checkCollections} onLoaded={onLoaded} optionsCheck={null} />);
    await choose(field('create-load-settings'), [new File([text], 'curio-boxspec-v2.json', { type: 'application/json' })]);
    expect((await screen.findByRole('alert')).textContent).toContain('No contract at this address');
    expect(asked).toEqual([['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2']]);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('a shop file on a page with no chain to ask is refused, outside the Demo, before it loads', async () => {
    const config = CONFIGURATIONS.find((entry) => entry.id === 'curio-corner');
    if (!config) throw new Error('curio-corner');
    const logo = png(300);
    const input = { ...inputV2Of(config, { pricing: NATIVE_TOKEN }), cover: { sha256: sha256Hex(logo), url: null, bytes: logo.byteLength, data: toBase64(logo) } };
    // A real build's file (not built from sample listings), its starting collections the test addresses 0x...a1, 0x...b2.
    const body = JSON.parse(boxSpecFile(buildSpecV2(input), recipeCtx(input), { pictures: [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }] }).parts.join('')) as Record<string, unknown>;
    delete body.demo; delete body.note;
    const file = () => new File([JSON.stringify(body)], 'curio-boxspec-v2.json', { type: 'application/json' });
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo={false} checkCollections={null} onLoaded={onLoaded} optionsCheck={null} />);
    await choose(field('create-load-settings'), [file()]);
    expect((await screen.findByRole('alert')).textContent).toContain('This shop’s collections could not be checked. Try again.');
    expect(onLoaded).not.toHaveBeenCalled();
    cleanup();
    // The Demo has no chain: there the shop loads unchecked, as on the Demo's own page, its curator the creator.
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo checkCollections={null} onLoaded={onLoaded} optionsCheck={null} />);
    await choose(field('create-load-settings'), [file()]);
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ v2: { shop: { curator: 'creator', curatorAddress: '' } } });
  });
});

describe('SH-SHOP-CREATE Load settings: a shop with starter items and no curator', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
  // The kits' files as committed (the one-collection shop's copied unchanged from sh-050-one-collection-shop).
  const kitFile = (path: string, name: string) => new File([readFileSync(join(ROOT, path), 'utf8')], name, { type: 'application/json' });
  const oneShop = () => kitFile('apps/web/src/features/create/v2/test-support/one-collection-shop-boxspec-v2.json', 'one-collection-shop-boxspec-v2.json');
  const junkyard = () => kitFile('examples/boxes/junkyard/settings/junkyard-boxspec-v2.json', 'junkyard-boxspec-v2.json');
  const erc721 = async (collections: readonly string[]) => new Map(collections.map((address): [string, CollectionCheck] => [address.toLowerCase(), 'erc721']));
  const typeIn = async (label: string | RegExp, text: string) => act(async () => { fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: text } }); });
  const load = async () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load' })); });

  it('the one-collection shop’s file asks for its ten starter ids; other ids are refused; its own load it, no curator kept', async () => {
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo={false} checkCollections={erc721} onLoaded={onLoaded} optionsCheck={null} />);
    await choose(field('create-load-settings'), [oneShop()]);
    expect(await screen.findByRole('group', { name: 'Starter items · 10' })).toBeTruthy();
    // One field per collection of the file, named by its address.
    expect(screen.getAllByRole('textbox').map((box) => box.getAttribute('id'))).toEqual(['create-load-starters-0']);
    await typeIn('Collection 1 · 0x0000…0011', '3-11');
    await load();
    expect((await screen.findByRole('alert')).textContent).toContain('These starter ids are not the setup’s.');
    expect(onLoaded).not.toHaveBeenCalled();
    // Editing the ids clears the line.
    await typeIn('Collection 1 · 0x0000…0011', '3-12');
    expect(screen.queryByRole('alert')).toBeNull();
    await load();
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ v2: { shop: { curator: 'none', curatorAddress: '', collections: [{ address: '0x0000000000000000000000000000000000230011', tier: 0, ids: '3-12' }] } } });
  });

  it('the Junkyard’s file loads with ids 1 and 2 typed for each of its five collections; its curator becomes the creator; Cancel starts again', async () => {
    const onLoaded = vi.fn();
    const asked: string[][] = [];
    const checker = async (collections: readonly string[]) => { asked.push([...collections]); return erc721(collections); };
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo={false} checkCollections={checker} onLoaded={onLoaded} optionsCheck={null} />);
    await choose(field('create-load-settings'), [junkyard()]);
    await screen.findByRole('group', { name: 'Starter items · 10' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByRole('group', { name: 'Starter items · 10' })).toBeNull();
    await choose(field('create-load-settings'), [junkyard()]);
    await screen.findByRole('group', { name: 'Starter items · 10' });
    for (let i = 0; i < 5; i += 1) await typeIn(`Collection ${i + 1} · 0x0000…00${11 + i}`, '1, 2');
    await load();
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ v2: { shop: { curator: 'creator', curatorAddress: '' } } });
    expect(onLoaded.mock.calls[0]?.[0].v2.shop.collections.map((row: { ids: string }) => row.ids)).toEqual(Array(5).fill('1, 2'));
    // The chain was asked about the five starting collections once, after the ids matched.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(5);
  });

  it('on the page: the loaded shop shows its starter ids, its collection and No curator read-only on Contents', async () => {
    renderFlow();
    await choose(field('create-load-settings'), [oneShop()]);
    await screen.findByRole('group', { name: 'Starter items · 10' });
    await typeIn('Collection 1 · 0x0000…0011', '3-12');
    await load();
    await screen.findByText(LOADED_LINE);
    await next();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Contents');
    const ids = screen.getByRole('textbox', { name: 'Starter ids 1' }) as HTMLInputElement;
    expect(ids.value).toBe('3-12');
    expect(locked(ids)).toBe(true);
    const none = within(screen.getByRole('group', { name: /^Curator/ })).getByRole('radio', { name: /^No curator/ });
    expect(none).toHaveProperty('checked', true);
    expect(locked(none)).toBe(true);
    expect(locked(screen.getByRole('textbox', { name: 'Collection 1' }))).toBe(true);
  });
});
