/**
 * SH-218 rail 2 (design section 6, `every-authoring-path-obeys-switches`): every authoring place shows a switched-off
 * option, refuses it and says so once (line A): the template tiles, the Contents tiles and the royalty, the price and
 * pile coins, the coin pile, and each side's fee choices with their payout coin. A choice the draft already holds stays
 * chosen and visible (never replaced). A settings file that needs one, or meets a list that cannot be read (line B), is
 * not loaded and the draft is kept; its own decoded spec is checked first, its installed form again.
 */
import { sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePng } from '../../../../../../packages/artwork/src/test-support/images';
import { toBase64, type ArtEnvironment } from '../art-files';
import { ContentsStep } from '../ContentsStep';
import { formOf } from '../test-support/fixtures';
import { CoinPicker } from './CoinPicker';
import { OffLine } from './CreateOptionsLines';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS, NATIVE_TOKEN, listingFor, offeredListings } from './listings';
import { LoadSettings, type LoadOptionsCheck } from './LoadSettings';
import { boxSpecFile, buildSpecV2, recipeCtx } from './model';
import { PileStep } from './PileStep';
import { choiceOf, pickFor, type FeeChoice, type FeeSide } from './recipes';
import { TemplateRow } from './TemplateRow';
import { TEMPLATES } from './templates';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import type { BoxSpecV2 } from './spec-types';

afterEach(() => cleanup());
const offLines = () => screen.queryAllByText(CREATE_OFF);

describe('every-authoring-path-obeys-switches', () => {
  it('template tiles: a switched-off tile stays, is aria-disabled and refuses a press; the row says so once', () => {
    const onPick = vi.fn();
    render(<TemplateRow current="holders" onPick={onPick} off={(template) => template.id === 'holders'} />);
    const holders = document.querySelector('[data-template="holders"]') as HTMLButtonElement;
    expect(holders.getAttribute('aria-disabled')).toBe('true');
    expect(holders.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById(holders.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CREATE_OFF);
    fireEvent.click(holders);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-template="burn"]') as HTMLButtonElement);
    expect(onPick).toHaveBeenCalledWith(TEMPLATES.find((template) => template.id === 'burn'));
    expect(offLines()).toHaveLength(1);
    cleanup();
    render(<TemplateRow current={null} onPick={onPick} />);
    expect(offLines()).toHaveLength(0);
    expect(screen.getAllByRole('button').every((button) => button.getAttribute('aria-disabled') === null)).toBe(true);
  });

  it('fee choices: an off choice is refused; To holders takes the other coin when only one is off; a held choice stays chosen', () => {
    const ctx = recipeCtx(inputV2Of(CONFIGURATIONS.find((entry) => entry.id === 'gas-guzzlers')));
    const set = vi.fn();
    const offs = new Set(['buyers:holders', 'buyers:burn', 'sellers:holders', 'sellers:holders-t']);
    const off = (side: FeeSide, choice: FeeChoice) => offs.has(`${side}:${choice}`);
    render(<FeesStep buyers={pickFor('holders')} sellers={pickFor('grow')} ctx={ctx} collection={false} errorFor={() => null} set={set} off={off} />);
    const buyers = screen.getByRole('group', { name: /^Buyers’ fees/ });
    const sellers = screen.getByRole('group', { name: /^Sellers’ fees/ });
    // Buyers: the held To holders (in P, off) stays pressed and marked; its P chip is off; Burn is refused.
    expect(within(buyers).getByRole('button', { name: 'To holders' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(buyers).getByRole('button', { name: /Claimed in ETH/ }).getAttribute('aria-disabled')).toBe('true');
    const burn = within(buyers).getAllByRole('button').find((button) => button.dataset.feeChoice === 'burn');
    expect(burn?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(burn as HTMLElement);
    fireEvent.click(within(buyers).getByRole('button', { name: /Claimed in ETH/ }));
    expect(set).not.toHaveBeenCalled();
    // Sellers: To holders is off in both coins, so the button is refused; in the buyers' card it takes T instead.
    const sellersHolders = within(sellers).getByRole('button', { name: 'To holders' });
    expect(sellersHolders.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(sellersHolders);
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(within(buyers).getByRole('button', { name: 'To holders' }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(choiceOf((set.mock.calls[0]?.[0] as { buyers: Parameters<typeof choiceOf>[0] }).buyers)).toBe('holders-t');
    // Each card says so once.
    expect(within(buyers).getAllByText(CREATE_OFF)).toHaveLength(1);
    expect(within(sellers).getAllByText(CREATE_OFF)).toHaveLength(1);
  });

  it('coins: a switched-off coin stays in its group, refuses a pick, and a held one stays chosen', () => {
    const offered = offeredListings(DEMO_LISTINGS);
    const link = offered.find((listing) => listing.symbol === 'LINK');
    const onChange = vi.fn();
    render(<CoinPicker id="coins" legend="Priced in" listings={offered} value={link?.token ?? null} onChange={onChange} off={(token) => token === link?.token} />);
    const radio = screen.getByRole('radio', { name: /^LINK/ }) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    expect(radio.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(radio);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /^ETH/ }));
    expect(onChange).toHaveBeenCalledWith(NATIVE_TOKEN);
    expect(offLines()).toHaveLength(1);
  });

  it('the coin pile and its seed coin', () => {
    const onChange = vi.fn();
    const pricing = listingFor(NATIVE_TOKEN, DEMO_LISTINGS);
    render(<PileStep pile={null} pricing={pricing} listings={DEMO_LISTINGS} onChange={onChange} errorFor={() => null} touch={() => undefined} off={{ pile: true, coin: () => false }} />);
    const pile = screen.getByRole('radio', { name: /^Coin pile/ });
    expect(pile.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pile);
    expect(onChange).not.toHaveBeenCalled();
    expect(offLines()).toHaveLength(1);
  });

  it('Contents tiles and the royalty (the shared step, v2 marks only)', () => {
    const set = vi.fn();
    const onChoose = vi.fn();
    const props = {
      form: formOf({ contents: 'collection', royaltyBps: 0 }), set, errorFor: () => null, touch: () => undefined, art: null, commitment: null, collectionCover: null,
      page: { banner: null, teasers: [] }, pictures: { collection: { busy: false, problem: null }, banner: { busy: false, problem: null }, teaser: { busy: false, problem: null } },
      progress: null, onArt: vi.fn(), onCollectionCover: vi.fn(), onBanner: vi.fn(), onTeasers: vi.fn(), onPage: vi.fn(), inbox: true,
      shop: { chosen: false, onChoose },
      off: { contents: (value: 'token' | 'collection' | 'shop') => value === 'shop', royalty: true, line: (id: string) => <OffLine id={id} /> },
    } as unknown as Parameters<typeof ContentsStep>[0];
    render(<ContentsStep {...props} />);
    const shop = screen.getByRole('radio', { name: /^Shop/ });
    expect(shop.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(shop);
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /^Token/ }));
    expect(onChoose).toHaveBeenCalledWith('token');
    const royalty = screen.getByRole('group', { name: /Royalty/ });
    const rates = within(royalty).getAllByRole('radio');
    expect(rates.filter((rate) => rate.getAttribute('aria-disabled') === 'true')).toHaveLength(rates.length - 1);
    fireEvent.click(rates[1] as HTMLElement);
    expect(set).not.toHaveBeenCalled();
    expect(offLines()).toHaveLength(2);
  });
});

describe('af1 request 9 and N6: hidden art, special series and the collection page have controls, marked like the others', () => {
  it('the Hidden art chip, Add series and the collection page each say so; a held hidden art stays chosen', () => {
    const set = vi.fn();
    const props = {
      form: formOf({ contents: 'collection', royaltyBps: 0, artMode: 'hidden' }), set, errorFor: () => null, touch: () => undefined, art: null, commitment: null, collectionCover: null,
      page: { banner: null, teasers: [] }, pictures: { collection: { busy: false, problem: null }, banner: { busy: false, problem: null }, teaser: { busy: false, problem: null } },
      progress: null, onArt: vi.fn(), onCollectionCover: vi.fn(), onBanner: vi.fn(), onTeasers: vi.fn(), onPage: vi.fn(), inbox: true,
      off: { contents: () => false, royalty: false, hidden: true, specials: true, page: true, line: (id: string) => <OffLine id={id} /> },
    } as unknown as Parameters<typeof ContentsStep>[0];
    render(<ContentsStep {...props} />);
    const hidden = screen.getByRole('radio', { name: /^Hidden until drawn/ }) as HTMLInputElement;
    expect(hidden.checked).toBe(true);
    expect(hidden.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /^Open/ }));
    expect(set).toHaveBeenCalledTimes(1);
    set.mockClear();
    const add = screen.getByRole('button', { name: 'Add series' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(set).not.toHaveBeenCalled();
    expect(document.getElementById(hidden.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CREATE_OFF);
    expect(document.getElementById(add.getAttribute('aria-describedby') ?? '')?.textContent).toBe(CREATE_OFF);
    // One line each: the art mode, the special series, the collection page.
    expect(offLines()).toHaveLength(3);
  });
});

describe('af2 (review C5): the collection page group refuses new input while add-on 6 is off', () => {
  const props = (off: boolean, set = vi.fn(), onBanner = vi.fn(), onTeasers = vi.fn(), onPage = vi.fn()) => ({
    form: formOf({ contents: 'collection', royaltyBps: 0, pageLink: 'https://example.org/page', pageLinkEdited: true }), set, errorFor: () => null, touch: () => undefined,
    art: null, commitment: null, collectionCover: null, page: { banner: { sha256: `0x${'ab'.repeat(32)}`, url: null, bytes: 10, data: '' }, teasers: [] },
    pictures: { collection: { busy: false, problem: null }, banner: { busy: false, problem: null }, teaser: { busy: false, problem: null } },
    progress: null, onArt: vi.fn(), onCollectionCover: vi.fn(), onBanner, onTeasers, onPage, inbox: true,
    ...(off ? { off: { contents: () => false, royalty: false, page: true, line: (id: string) => <OffLine id={id} /> } } : {}),
  }) as unknown as Parameters<typeof ContentsStep>[0];
  const png = () => new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
  const field = (id: string) => document.getElementById(id) as HTMLInputElement;

  it('off: banner, teasers and link stay, aria-disabled and tied to line A; no new picture or text; clearing the link and Remove still work', () => {
    const set = vi.fn(); const onBanner = vi.fn(); const onTeasers = vi.fn(); const onPage = vi.fn();
    render(<ContentsStep {...props(true, set, onBanner, onTeasers, onPage)} />);
    for (const id of ['create-banner', 'create-teasers', 'create-page-link']) {
      const input = field(id);
      expect(input, id).toBeTruthy();
      expect(input.getAttribute('aria-disabled'), id).toBe('true');
      const line = (input.getAttribute('aria-describedby') ?? '').split(' ').map((ref) => document.getElementById(ref)?.textContent);
      expect(line, id).toContain(CREATE_OFF);
    }
    fireEvent.change(field('create-banner'), { target: { files: [png()] } });
    fireEvent.change(field('create-teasers'), { target: { files: [png()] } });
    expect(onBanner).not.toHaveBeenCalled();
    expect(onTeasers).not.toHaveBeenCalled();
    expect(field('create-page-link').value).toBe('https://example.org/page');
    fireEvent.change(field('create-page-link'), { target: { value: 'https://example.org/other' } });
    expect(set).not.toHaveBeenCalled();
    fireEvent.change(field('create-page-link'), { target: { value: '' } });
    expect(set).toHaveBeenCalledWith({ pageLink: '', pageLinkEdited: true });
    fireEvent.click(screen.getByRole('button', { name: 'Remove banner' }));
    expect(onPage).toHaveBeenCalledWith({ banner: null, teasers: [] });
    expect(offLines()).toHaveLength(1);
  });

  it('not off (and v1, which passes no off): exactly as before', () => {
    const set = vi.fn(); const onBanner = vi.fn(); const onTeasers = vi.fn();
    render(<ContentsStep {...props(false, set, onBanner, onTeasers)} />);
    for (const id of ['create-banner', 'create-teasers', 'create-page-link']) expect(field(id).getAttribute('aria-disabled'), id).toBeNull();
    fireEvent.change(field('create-banner'), { target: { files: [png()] } });
    fireEvent.change(field('create-teasers'), { target: { files: [png()] } });
    fireEvent.change(field('create-page-link'), { target: { value: 'https://example.org/other' } });
    expect(onBanner).toHaveBeenCalledTimes(1);
    expect(onTeasers).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ pageLink: 'https://example.org/other', pageLinkEdited: true });
    expect(offLines()).toHaveLength(0);
  });
});

describe('every-authoring-path-obeys-switches: a settings file', () => {
  const env: ArtEnvironment = { digest: async (bytes) => sha256Hex(bytes), thumbnail: async () => null, encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }), salt: () => `0x${'11'.repeat(32)}` };
  const config = CONFIGURATIONS.find((entry) => entry.id === 'rug-rugs');
  if (!config) throw new Error('rug-rugs');
  const logo = makePng({ width: 300, height: 300, decodable: true });
  const input = { ...inputV2Of(config, { pricing: NATIVE_TOKEN, buyers: pickFor('holders') }), cover: { sha256: sha256Hex(logo), url: null, bytes: logo.byteLength, data: toBase64(logo) } };
  const spec = buildSpecV2(input);
  const body = JSON.parse(boxSpecFile(spec, recipeCtx(input), { pictures: [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }] }).parts.join('')) as Record<string, unknown>;
  delete body.demo; delete body.note;
  const file = () => new File([JSON.stringify(body)], 'rugs-boxspec-v2.json', { type: 'application/json' });
  const load = async (check: LoadOptionsCheck | null) => {
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo={false} checkCollections={null} onLoaded={onLoaded} optionsCheck={check} />);
    await act(async () => { fireEvent.change(document.getElementById('create-load-settings') as HTMLInputElement, { target: { files: [file()] } }); });
    return onLoaded;
  };

  it('a file that needs a switched-off option is not loaded (line A); the file’s own spec is what is checked', async () => {
    const check = vi.fn<LoadOptionsCheck>(async () => 'off');
    const onLoaded = await load(check);
    expect((await screen.findByRole('alert')).textContent).toContain(CREATE_OFF);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect((check.mock.calls[0]?.[0] as BoxSpecV2).buyers).toEqual(spec.buyers);
  });

  it('a list that cannot be read: not loaded (line B)', async () => {
    const onLoaded = await load(vi.fn<LoadOptionsCheck>(async () => 'unavailable'));
    expect((await screen.findByRole('alert')).textContent).toContain(CREATE_UNAVAILABLE);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('checked twice: the decoded file, then the setup as it would replace the draft; a change between them refuses it', async () => {
    const check = vi.fn<LoadOptionsCheck>(async () => 'ok');
    let onLoaded = await load(check);
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(check).toHaveBeenCalledTimes(2);
    cleanup();
    const second = vi.fn<LoadOptionsCheck>().mockResolvedValueOnce('ok').mockResolvedValueOnce('off');
    onLoaded = await load(second);
    await waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('alert')).textContent).toContain(CREATE_OFF);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('an off coin in the file is never traded for the page’s coin: the decoded file is checked before it is repriced', async () => {
    const link = DEMO_LISTINGS.find((listing) => listing.symbol === 'LINK');
    if (!link) throw new Error('LINK');
    const priced = { ...inputV2Of(config, { pricing: link.token, buyers: pickFor('burn') }), cover: input.cover };
    const linkBody = JSON.parse(boxSpecFile(buildSpecV2(priced), recipeCtx(priced), { pictures: [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }] }).parts.join('')) as Record<string, unknown>;
    delete linkBody.demo; delete linkBody.note;
    // LINK is switched off and not listed on this page: loading would reprice the file to ETH, which is not off.
    const check = vi.fn<LoadOptionsCheck>(async (given) => (given.pricing.token.toLowerCase() === link.token.toLowerCase() ? 'off' : 'ok'));
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS.filter((listing) => listing.token !== link.token)} pricing={NATIVE_TOKEN} demo={false} checkCollections={null} onLoaded={onLoaded} optionsCheck={check} />);
    await act(async () => { fireEvent.change(document.getElementById('create-load-settings') as HTMLInputElement, { target: { files: [new File([JSON.stringify(linkBody)], 'link-boxspec-v2.json', { type: 'application/json' })] } }); });
    expect((await screen.findByRole('alert')).textContent).toContain(CREATE_OFF);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('no list in this build (the Demo): loads as before', async () => {
    const onLoaded = await load(null);
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
  });
});
