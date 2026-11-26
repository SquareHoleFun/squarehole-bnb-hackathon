/**
 * SH-218 rail 2 (design section 6, `policy-read-fails-closed-and-expires` and the key half of
 * `every-authoring-path-obeys-switches`): the list's read refuses everything but this release's valid document, read
 * with no cache and no redirect within five seconds; a good read permits for 60 seconds only; the page's control keys
 * are the chain package's own (`requiredCreateOptions`) for the specs those controls build; and the last check reads
 * afresh for the run's exact spec and identity. The server's fixtures (packages/chain/src/create-options/fixtures).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { requiredCreateOptions } from '../../../../../../packages/chain/src/create-options/keys';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import {
  CREATE_OPTIONS_FRESH_MS, CREATE_OPTIONS_TIMEOUT_MS, HIDDEN_KEYS, PAGE_KEYS, PILE_KEYS, ROYALTY_KEYS, SPECIALS_KEYS, createOptionsLine, overviewRowsOf, checkBeforeWallet, checkSpec, contentsKeys, createOptionsTargetOf, feeKeys, isFresh,
  needsModuleDirectory, pileCoinKey, priceKey, readCreateOptions, templateKey, type CreateOptionsFetch, type CreateOptionsTarget,
} from './create-options';
import { CreateRefusal } from './create-send';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2, v2Issues } from './model';
import { alchemistPick, pickFor, type FeeChoice, type FeeSide, type WiredChoice } from './recipes';
import { newShop } from './shop';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { TEMPLATE_CREATE_OPTIONS } from '../../../../../../packages/chain/src/create-options/keys';
import { TEMPLATES } from './templates';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/chain/src/create-options/fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const SEPOLIA = { chainId: 11155111, factory: '0xfae1e6cff43cadcbe01885bdd0aa6218263de393', registry: '0x5d2866ef084d801ae734d3a2a6e4f7179898737c',
  versionCodeHash: '0x31927f086fff14638c18ca1194dc874c12d6faec88b9356fc939d066f485baaa' } as const;
const TARGET: CreateOptionsTarget = { url: `https://api.test/v2/create-options/${SEPOLIA.chainId}/${SEPOLIA.factory}.json`, release: SEPOLIA };
const reply = (body: string | Uint8Array, status = 200): Response => new Response(body as BodyInit, { status, headers: { 'content-type': 'application/json' } });
const fetchOf = (answer: () => Promise<Response> | Response) => vi.fn<CreateOptionsFetch>(async () => answer());
const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

afterEach(() => { vi.useRealTimers(); });

describe('policy-read-fails-closed-and-expires: one read of the list', () => {
  it('asks once, with no cache, no redirect and no credentials, and takes exactly this release’s document', async () => {
    const fetch = fetchOf(() => reply(fixture('empty.json')));
    const read = await readCreateOptions(TARGET, fetch, () => 7);
    expect(read).toMatchObject({ ok: true, startedAt: 7, document: { revision: 1, off: [] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(TARGET.url);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error', credentials: 'omit' });
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    const two = await readCreateOptions(TARGET, fetchOf(() => reply(fixture('two-off.json'))));
    expect(two.ok && two.document.off.map((entry) => entry.key)).toEqual(['fee.buyers.holders-p', 'template.holders']);
  });
  it.each([
    ['a malformed list (one bad entry poisons it)', () => reply(fixture('malformed.json'))],
    ['an oversized list', () => reply(fixture('oversized.json'))],
    ['another release’s list', () => reply(fixture('other-release.json'))],
    ['a list with a byte-order mark', () => reply(`${String.fromCharCode(0xfeff)}${fixture('empty.json')}`)],
    ['bytes that are not UTF-8', () => reply(new Uint8Array([0x7b, 0xff, 0x7d]))],
    ['a missing list (503)', () => reply('{"error":"create options unavailable"}', 503)],
    ['an unknown release (404)', () => reply('{"error":"no release"}', 404)],
    ['a valid list with another status', () => reply(fixture('empty.json'), 203)],
    ['a refused redirect or a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('refuses %s', async (_name, answer) => {
    expect(await readCreateOptions(TARGET, fetchOf(answer))).toMatchObject({ ok: false });
  });
  it('gives up after five seconds, aborting the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<CreateOptionsFetch>((_url, init) => new Promise((_, reject) => {
      signal = init.signal ?? undefined;
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = readCreateOptions(TARGET, fetch);
    await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
  it('a body that never ends is cut at five seconds too', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<CreateOptionsFetch>(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); },
    }), { status: 200 }));
    const pending = readCreateOptions(TARGET, fetch);
    await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
  it('a good read permits for 60 seconds from its start, never before it, and a failed read never', async () => {
    const good = { ok: true as const, startedAt: 1_000, document: JSON.parse(fixture('empty.json')) };
    expect(isFresh(good, 1_000)).toBe(true);
    expect(isFresh(good, 1_000 + CREATE_OPTIONS_FRESH_MS - 1)).toBe(true);
    expect(isFresh(good, 1_000 + CREATE_OPTIONS_FRESH_MS)).toBe(false);
    expect(isFresh(good, 999)).toBe(false);
    expect(isFresh({ ok: false, startedAt: 1_000 }, 1_000)).toBe(false);
    expect(isFresh(null, 1_000)).toBe(false);
  });
  it('names Create’s release (the first, SH-300) with its pins in lowercase; a second release changes nothing; none without a release', () => {
    const release = { factory: { address: '0xFAE1E6CFF43CADCBE01885BDD0AA6218263DE393' }, registry: { address: '0x5D2866EF084D801AE734D3A2A6E4F7179898737C' }, versionCodeHash: SEPOLIA.versionCodeHash.toUpperCase().replace('0X', '0x') };
    const manifest = { chainId: SEPOLIA.chainId, releases: [release] } as never;
    expect(createOptionsTargetOf({ origin: 'https://api.test', manifest })).toEqual(TARGET);
    expect(createOptionsTargetOf({ origin: 'https://api.test', manifest: { chainId: 1, releases: [release, { ...release, factory: { address: '0x00000000000000000000000000000000000000Ee' } }] } as never })).toEqual(createOptionsTargetOf({ origin: 'https://api.test', manifest: { chainId: 1, releases: [release] } as never }));
    expect(createOptionsTargetOf({ origin: 'https://api.test', manifest: { chainId: 1, releases: [] } as never })).toBeNull();
  });
});

const DIRECTORY = '0x00000000000000000000000000000000000d1e00' as Address;
const docOf = (off: readonly string[]) => ({ schema: 1 as const, ...SEPOLIA, revision: 1, off: off.map((key) => ({ key })) }) as Parameters<typeof checkSpec>[0];

describe('a spec against the list', () => {
  it('finds what a spec needs that is off; a list that switches nothing off passes every example', () => {
    for (const entry of CONFIGURATIONS) {
      const spec = buildSpecV2(inputV2Of(entry));
      expect(checkSpec(docOf([]), spec, DIRECTORY), entry.id).toEqual({ state: 'ok' });
    }
    const spec = buildSpecV2(inputV2Of(config('gas-guzzlers'), { buyers: pickFor('holders') }));
    expect(checkSpec(docOf(['fee.buyers.holders-p', 'template.holders']), spec)).toEqual({ state: 'off', keys: ['fee.buyers.holders-p'] });
    // A template key is never a send requirement.
    expect(checkSpec(docOf(TEMPLATE_CREATE_OPTIONS), spec)).toEqual({ state: 'ok' });
  });
  it('any throw of requiredCreateOptions is blocked: an unsupported wire, or a module row without its directory', () => {
    const spec = buildSpecV2(inputV2Of(config('gas-guzzlers')));
    expect(checkSpec(docOf([]), { ...spec, boxType: 2 })).toEqual({ state: 'blocked' });
    expect(checkSpec(docOf([]), { ...spec, version: 3 })).toEqual({ state: 'blocked' });
    const alchemist = { ...spec, buyers: buildSpecV2(inputV2Of(config('gas-guzzlers'), { buyers: alchemistPick(7) })).buyers };
    expect(needsModuleDirectory(alchemist)).toBe(true);
    expect(needsModuleDirectory(spec)).toBe(false);
    expect(checkSpec(docOf([]), alchemist)).toEqual({ state: 'blocked' });
    expect(checkSpec(docOf([]), alchemist, DIRECTORY)).toEqual({ state: 'ok' });
    expect(checkSpec(docOf([`module.${DIRECTORY}.7`]), alchemist, DIRECTORY)).toEqual({ state: 'off', keys: [`module.${DIRECTORY}.7`] });
  });
});

describe('every-authoring-path-obeys-switches: each control’s keys are the chain package’s own', () => {
  const required = (v2: Parameters<typeof inputV2Of>[1], form: Parameters<typeof inputV2Of>[2] = {}, id = 'gas-guzzlers') => requiredCreateOptions(buildSpecV2(inputV2Of(config(id), v2, form)), DIRECTORY);
  const wired: readonly WiredChoice[] = ['keep', 'burn', 'grow', 'holders', 'holders-t', 'eat', 'pile'];
  it.each((['buyers', 'sellers'] as const).flatMap((side) => wired.map((choice) => [side, choice] as const)))('fees: %s %s', (side: FeeSide, choice: FeeChoice) => {
    const keys = required({ [side]: pickFor(choice as WiredChoice) });
    expect(keys.filter((key) => key.startsWith(`fee.${side}.`))).toEqual(feeKeys(side, choice));
  });
  it('fees: To items in either coin, Into the shop with its holders dependency, The Alchemist with its row', () => {
    for (const side of ['buyers', 'sellers'] as const) for (const choice of ['items', 'items-t'] as const) {
      expect(required({ [side]: pickFor(choice) }, {}, 'bag-holders').filter((key) => key.startsWith(`fee.${side}.`))).toEqual(feeKeys(side, choice));
    }
    const shop = required({ sellers: pickFor('shop', undefined, 4) }, {}, 'scrap-shop');
    expect(feeKeys('sellers', 'shop').every((key) => shop.includes(key as never))).toBe(true);
    expect(feeKeys('sellers', 'shop')).toEqual(['fee.sellers.shop', 'fee.sellers.holders-p']);
    const alchemist = required({ buyers: alchemistPick(9) });
    expect(feeKeys('buyers', 'alchemist', { directory: DIRECTORY, row: 9 }).every((key) => alchemist.includes(key as never))).toBe(true);
  });
  it('contents tiles, the coin pile, a shop’s add-ons, the price coin, the pile coin and a royalty', () => {
    expect(required({}, { contents: 'token' })).toContain(contentsKeys('token', false)[0]);
    expect(required({}, {}, 'gas-guzzlers')).toContain(contentsKeys('collection', false)[0]);
    const pile = required({}, {}, 'dragons-hoard');
    expect(pile).toContain(contentsKeys('token', true)[0]);
    expect(pile).toContain(PILE_KEYS[0]);
    const usdc = DEMO_LISTINGS.find((listing) => listing.symbol === 'USDC');
    expect(pile).toContain(pileCoinKey(usdc?.token ?? ''));
    const shop = required({ shop: newShop() }, { contents: 'token' }, 'curio-corner');
    for (const key of contentsKeys('shop', false)) expect(shop).toContain(key);
    const eth = required({}, {}, 'gas-guzzlers');
    expect(eth).toContain(priceKey('0x0000000000000000000000000000000000000000'));
    expect(required({}, { royaltyBps: 250 })).toContain(ROYALTY_KEYS[0]);
    expect(required({}, { royaltyBps: 0 })).not.toContain(ROYALTY_KEYS[0]);
  });
  it('af1: hidden art, a special series and the collection page (add-ons 1, 3 and 6)', () => {
    expect(required({}, {}, 'ultrasound-owls')).toContain(HIDDEN_KEYS[0]);
    expect(required({}, {}, 'gas-guzzlers')).not.toContain(HIDDEN_KEYS[0]);
    expect(required({}, { specials: [{ label: 'Gold', count: '2' }] })).toContain(SPECIALS_KEYS[0]);
    expect(required({}, { specials: [] })).not.toContain(SPECIALS_KEYS[0]);
    expect(required({}, { pageLink: 'https://example.org/page', pageLinkEdited: true })).toContain(PAGE_KEYS[0]);
  });
  it('every template tile has a key the list may name, and none other', () => {
    expect(TEMPLATES.map((template) => templateKey(template.id)).sort()).toEqual([...TEMPLATE_CREATE_OPTIONS].sort());
  });
});

describe('last-send-check-uses-the-run: the check right before the wallet', () => {
  const spec = buildSpecV2(inputV2Of(config('gas-guzzlers'), { buyers: pickFor('holders') }));
  const plan = { chainId: SEPOLIA.chainId, factory: SEPOLIA.factory as Address, spec };
  const gate = (fetch: CreateOptionsFetch, moduleDirectory = vi.fn(async () => DIRECTORY)) => ({ target: TARGET, fetch, moduleDirectory });
  const refusal = async (pending: Promise<void>) => { const error = await pending.catch((e: unknown) => e); expect(error).toBeInstanceOf(CreateRefusal); return (error as CreateRefusal).message; };
  it('reads afresh every time and passes the run’s exact spec when nothing it needs is off', async () => {
    const fetch = fetchOf(() => reply(fixture('empty.json')));
    await expect(checkBeforeWallet(gate(fetch), plan)).resolves.toBeUndefined();
    await expect(checkBeforeWallet(gate(fetch), plan)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses with line A when the run needs a switched-off option (template keys never refuse)', async () => {
    expect(await refusal(checkBeforeWallet(gate(fetchOf(() => reply(fixture('two-off.json')))), plan))).toBe(CREATE_OFF);
    const without = { ...plan, spec: buildSpecV2(inputV2Of(config('gas-guzzlers'))) };
    await expect(checkBeforeWallet(gate(fetchOf(() => reply(fixture('two-off.json')))), without)).resolves.toBeUndefined();
    expect(await refusal(checkBeforeWallet(gate(fetchOf(() => reply(fixture('empty.json')))), { ...plan, spec: { ...spec, boxType: 2 } }))).toBe(CREATE_OFF);
  });
  it('refuses with line B when the list cannot be read, belongs to another release, or the run is another release’s', async () => {
    for (const answer of [() => reply(fixture('malformed.json')), () => reply('{}', 503), () => reply(fixture('other-release.json')), () => Promise.reject(new TypeError('offline'))]) {
      expect(await refusal(checkBeforeWallet(gate(fetchOf(answer)), plan))).toBe(CREATE_UNAVAILABLE);
    }
    const fetch = fetchOf(() => reply(fixture('empty.json')));
    expect(await refusal(checkBeforeWallet(gate(fetch), { ...plan, factory: '0x1111111111111111111111111111111111111111' }))).toBe(CREATE_UNAVAILABLE);
    expect(await refusal(checkBeforeWallet(gate(fetch), { ...plan, chainId: 1 }))).toBe(CREATE_UNAVAILABLE);
    expect(await refusal(checkBeforeWallet({ target: null, fetch, moduleDirectory: async () => DIRECTORY }, plan))).toBe(CREATE_UNAVAILABLE);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a module row is checked with the release’s directory, read for this check; an unreadable directory is line B', async () => {
    const alchemist = { ...plan, spec: buildSpecV2(inputV2Of(config('gas-guzzlers'), { buyers: alchemistPick(3) })) };
    const directory = vi.fn(async () => DIRECTORY);
    const list = JSON.stringify({ schema: 1, ...SEPOLIA, revision: 2, off: [{ key: `module.${DIRECTORY}.3` }] });
    expect(await refusal(checkBeforeWallet(gate(fetchOf(() => reply(list)), directory), alchemist))).toBe(CREATE_OFF);
    expect(directory).toHaveBeenCalledTimes(1);
    await expect(checkBeforeWallet(gate(fetchOf(() => reply(fixture('empty.json'))), directory), alchemist)).resolves.toBeUndefined();
    expect(await refusal(checkBeforeWallet(gate(fetchOf(() => reply(fixture('empty.json'))), vi.fn(async (): Promise<Address> => { throw new Error('rpc'); })), alchemist))).toBe(CREATE_UNAVAILABLE);
  });
  it('a pile’s seed coin is the pile’s own key (an encoded pile spec)', () => {
    const pile = buildSpecV2(inputV2Of(config('dragons-hoard')));
    const usdc = DEMO_LISTINGS.find((listing) => listing.symbol === 'USDC')?.token ?? '';
    expect(checkSpec(docOf([pileCoinKey(usdc)]), pile)).toEqual({ state: 'off', keys: [pileCoinKey(usdc)] });
  });
});

describe('af1: the sending step', () => {
  it('request 9: each switched-off key the draft needs names its Overview row', () => {
    const spec = buildSpecV2(inputV2Of(config('gas-guzzlers'), { buyers: alchemistPick(7), sellers: pickFor('holders') }));
    const rows = (keys: readonly string[]) => [...overviewRowsOf(keys, spec)].sort();
    expect(rows(['price.0x0000000000000000000000000000000000000000'])).toEqual(['price']);
    expect(rows(['kind.collection', 'addon.1', 'addon.3', 'addon.4', 'addon.6', 'addon.7', 'addon.8'])).toEqual(['contents']);
    // af2 (review C2, change J): an add-on alone marks the Contents row; the keys a spec needs, each on its own.
    const royalty = requiredCreateOptions(buildSpecV2(inputV2Of(config('link-marines'))), DIRECTORY).filter((key) => key.startsWith('addon.'));
    expect(royalty).toContain('addon.4');
    for (const key of royalty) expect(rows([key]), key).toEqual(['contents']);
    expect(rows([`pile.coin.${DIRECTORY}`])).toEqual(['seed']);
    expect(rows(['fee.buyers.alchemist'])).toEqual(['buyers']);
    expect(rows(['fee.sellers.holders-p'])).toEqual(['sellers']);
    expect(rows([`module.${DIRECTORY}.7`])).toEqual(['buyers']);
    expect(rows([`module.${DIRECTORY}.8`])).toEqual([]);
    expect(rows(['template.holders'])).toEqual([]);
  });

  it('N4: a draft that cannot be checked because it is incomplete shows its own issues, never line A', () => {
    // Fee picks the form cannot finish: To items without its in-vault rule, Into the shop without its ceiling.
    const incomplete = [
      inputV2Of(config('bag-holders'), { buyers: { a: { leg: 1, dest: 8, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } } }),
      inputV2Of(config('scrap-shop'), { sellers: { a: { leg: 2, dest: 7, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } } }),
    ];
    for (const input of incomplete) {
      const spec = buildSpecV2(input);
      expect(checkSpec(docOf([]), spec, DIRECTORY)).toEqual({ state: 'blocked' });
      const issues = v2Issues(input);
      expect(issues.length).toBeGreaterThan(0);
      expect(createOptionsLine('blocked', issues.length, true)).toBeNull();
    }
    // Every example the form can finish checks cleanly, so a blocked verdict with no issue is not a form state.
    for (const entry of CONFIGURATIONS) expect(checkSpec(docOf([]), buildSpecV2(inputV2Of(entry)), DIRECTORY).state, entry.id).toBe('ok');
    // The rule itself: B for an unreadable list, A for an option off (or an uncheckable draft with nothing else to fix).
    expect(createOptionsLine('unavailable', 3, true)).toBe('unavailable');
    expect(createOptionsLine('off', 2, true)).toBe('off');
    expect(createOptionsLine('blocked', 0, true)).toBe('off');
    expect(createOptionsLine('reading', 0, true)).toBeNull();
    expect(createOptionsLine('off', 0, false)).toBeNull();
  });
});
