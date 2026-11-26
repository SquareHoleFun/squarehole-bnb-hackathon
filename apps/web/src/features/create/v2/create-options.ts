/**
 * SH-218 rail 2: one switch per Create option. The selected release's list of switched-off options
 * (`/v2/create-options/<chain>/<factory>.json`, served by the indexer, packages/indexer/src/core/create-options.ts) is
 * read here, with no cache, a five-second limit and no redirect, and checked with the chain package's own parser
 * (`parseCreateOptions`, pinned to the release). A read is good for 60 seconds from its start on a monotonic clock; a
 * failed, slow, stale, invalid or other release's read blocks new creation, and no older answer is ever used instead.
 *
 * What a box needs is a pure function of its exact spec (the chain package's `requiredCreateOptions`); ANY throw of it
 * means blocked. The last check (`checkBeforeWallet`) reads the list afresh for the run's own spec, plan identity and
 * the release's module directory, right before the wallet is asked for the payment approval or createBox (the
 * executor's `createOptionsCheck`). Existing boxes never come here: box pages and their actions import none of this.
 *
 * Framework-free: the page's hook is useCreateOptions.ts.
 */
import { decodeAbiParameters, type Address } from 'viem';
import { CREATE_OPTIONS_MAX_BYTES, parseCreateOptions, type CreateOptionsDocument, type CreateOptionsRelease } from '../../../../../../packages/chain/src/create-options/schema';
import { requiredCreateOptions, switchedOff } from '../../../../../../packages/chain/src/create-options/keys';
import type { CreateSendPlanV2 } from '../../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../../core/v2/indexer-v2';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import { CreateRefusal } from './create-send';
import type { FeeChoice, FeeSide } from './recipes';
import { Dest, type BoxSpecV2 } from './spec-types';
import { TESTNET } from '../../data-source/testnet';
import { createReleaseOf } from '../../core/v2/releases';

export type { CreateOptionsDocument } from '../../../../../../packages/chain/src/create-options/schema';

/** The whole read, connection to last byte, must finish within this. */
export const CREATE_OPTIONS_TIMEOUT_MS = 5_000;
/** A good read permits creation for this long, counted from the moment it was asked. */
export const CREATE_OPTIONS_FRESH_MS = 60_000;

export type CreateOptionsFetch = (input: string, init: RequestInit) => Promise<Response>;

const browserFetch: CreateOptionsFetch = (input, init) => fetch(input, init);
let fetcher: CreateOptionsFetch = browserFetch;
/** Tests only: answer the list's requests in memory (null puts the browser's fetch back). The checks stay the same. */
export function createOptionsFetchForTests(next: CreateOptionsFetch | null): void {
  fetcher = next ?? browserFetch;
}
/** The fetch every read uses (the browser's). */
export const createOptionsFetch = (): CreateOptionsFetch => fetcher;

/** The monotonic clock reads are timed on (a changed wall clock or a sleeping tab cannot extend a read). */
export const monotonicNow = (): number => performance.now();

/** Where the selected release's list is, and the pins it must carry. */
export interface CreateOptionsTarget {
  readonly url: string;
  readonly release: CreateOptionsRelease;
}

/** Create's release (the first, SH-300), its list's address and pins (lowercase); null without a release (then blocked). */
export function createOptionsTargetOf(source: Pick<V2Source, 'origin' | 'manifest'>): CreateOptionsTarget | null {
  const release = createReleaseOf(source.manifest);
  if (!release) return null;
  const pins: CreateOptionsRelease = {
    chainId: source.manifest.chainId,
    factory: release.factory.address.toLowerCase(),
    registry: release.registry.address.toLowerCase(),
    versionCodeHash: release.versionCodeHash.toLowerCase(),
  };
  return { url: `${source.origin}/v2/create-options/${pins.chainId}/${pins.factory}.json`, release: pins };
}

export type CreateOptionsRead =
  | { readonly ok: true; readonly document: CreateOptionsDocument; readonly startedAt: number }
  | { readonly ok: false; readonly startedAt: number };

/**
 * One read of the list: no cache, no redirect, no credentials, at most `CREATE_OPTIONS_TIMEOUT_MS` for the whole answer,
 * a 200 with at most 32 KiB of valid UTF-8 that parses as this release's document. Anything else is `{ ok: false }`.
 * `cancel` ends it early (then it is `{ ok: false }` too).
 */
export async function readCreateOptions(target: CreateOptionsTarget, fetchFn: CreateOptionsFetch = fetcher, now: () => number = monotonicNow, cancel?: AbortSignal): Promise<CreateOptionsRead> {
  const startedAt = now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CREATE_OPTIONS_TIMEOUT_MS);
  // A newer read replaces this one (the page's Retry, a tab shown again): its answer is dropped and the request ends.
  if (cancel?.aborted) abort.abort();
  cancel?.addEventListener('abort', () => abort.abort(), { once: true });
  try {
    const reply = await fetchFn(target.url, { cache: 'no-store', redirect: 'error', credentials: 'omit', signal: abort.signal });
    if (reply.status !== 200) return { ok: false, startedAt };
    const bytes = new Uint8Array(await reply.arrayBuffer());
    if (bytes.byteLength > CREATE_OPTIONS_MAX_BYTES) return { ok: false, startedAt };
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = parseCreateOptions(text, target.release);
    return parsed.ok ? { ok: true, document: parsed.document, startedAt } : { ok: false, startedAt };
  } catch {
    return { ok: false, startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a read still permits creation at `now` (a good read, asked less than 60 seconds ago). */
export const isFresh = (read: CreateOptionsRead | null, now: number): read is Extract<CreateOptionsRead, { ok: true }> =>
  read !== null && read.ok && now >= read.startedAt && now - read.startedAt < CREATE_OPTIONS_FRESH_MS;

/** Whether a spec names a module row (The Alchemist), whose key needs the release's module directory. */
export const needsModuleDirectory = (spec: Pick<BoxSpecV2, 'buyers' | 'sellers'>): boolean =>
  spec.buyers.a.dest === Dest.Module || spec.sellers.a.dest === Dest.Module;

export type CreateSpecCheck =
  | { readonly state: 'ok' }
  /** Options the list switches off, in the order the spec needs them. */
  | { readonly state: 'off'; readonly keys: readonly string[] }
  /** `requiredCreateOptions` threw: nothing it says can be trusted, so the spec is blocked. */
  | { readonly state: 'blocked' };

/** A spec against a document: every option it needs, and which of them are off. Any throw is blocked. */
export function checkSpec(document: CreateOptionsDocument, spec: BoxSpecV2, moduleDirectory?: Address): CreateSpecCheck {
  let keys;
  try {
    keys = requiredCreateOptions(spec, moduleDirectory);
  } catch {
    return { state: 'blocked' };
  }
  // SH-258: the network's own switch counts as the list's (an imported hidden-art spec on BNB Chain testnet is off).
  const off = [...new Set([...switchedOff(document, keys), ...(TESTNET.switches.draws ? [] : keys.filter((key) => HIDDEN_KEYS.includes(key)))])];
  return off.length > 0 ? { state: 'off', keys: off } : { state: 'ok' };
}

/** The keys a document switches off (for marking the page's controls). */
/**
 * The switched-off option keys: the release's list, and SH-258's network switch: where the build's test network offers
 * no hidden draws (BNB Chain testnet, `switches.draws`), "Hidden until drawn" is off like an option the list switches off.
 */
export const offKeysOf = (document: CreateOptionsDocument | null): ReadonlySet<string> =>
  new Set([...(document?.off.map((entry) => entry.key) ?? []), ...(TESTNET.switches.draws ? [] : HIDDEN_KEYS)]);

// --- The page's controls, each option by the keys choosing it needs (create-options.test.ts holds these equal to
// --- `requiredCreateOptions` for the specs they build).

/** A template tile. Its key is never a send requirement: only the tile is off. */
export const templateKey = (id: string): string => `template.${id}`;
/** The Contents step's tiles: a token (a coin pile when one is set), a new collection, a shop (always add-ons 7 and 8). */
export function contentsKeys(value: 'token' | 'collection' | 'shop', pile: boolean): readonly string[] {
  if (value === 'collection') return ['kind.collection'];
  if (value === 'shop') return ['kind.shop', 'addon.7', 'addon.8'];
  return [pile ? 'kind.pile' : 'kind.token'];
}
/** Adding a coin pile to a token. */
export const PILE_KEYS: readonly string[] = Object.freeze(['kind.pile']);
/** A price coin, by its listed address (native is the zero address). */
export const priceKey = (token: string): string => `price.${token.toLowerCase()}`;
/** A pile's coin, by its listed address. */
export const pileCoinKey = (token: string): string => `pile.coin.${token.toLowerCase()}`;
/** A royalty other than Off (add-on 4). */
export const ROYALTY_KEYS: readonly string[] = Object.freeze(['addon.4']);
/** Hidden art (add-on 1, its placeholders). */
export const HIDDEN_KEYS: readonly string[] = Object.freeze(['addon.1']);
/** A special series (add-on 3). */
export const SPECIALS_KEYS: readonly string[] = Object.freeze(['addon.3']);
/** The collection page: a banner, teasers or a link (add-on 6). */
export const PAGE_KEYS: readonly string[] = Object.freeze(['addon.6']);
const FEE_SUFFIX: Readonly<Record<FeeChoice, string>> = {
  keep: 'keep', burn: 'burn', grow: 'grow', holders: 'holders-p', items: 'items-p', eat: 'eat', 'holders-t': 'holders-t',
  'items-t': 'items-t', pile: 'pile', shop: 'shop', alchemist: 'alchemist',
};
/**
 * A fee choice on one side; Into the shop also needs the sellers' holders in P (its overflow); The Alchemist also its
 * row's key once the release's directory is known (unknown: the row is checked at the sending step).
 */
export function feeKeys(side: FeeSide, choice: FeeChoice, module: { readonly directory: Address; readonly row: number } | null = null): readonly string[] {
  const keys = [`fee.${side}.${FEE_SUFFIX[choice]}`];
  if (choice === 'shop') keys.push('fee.sellers.holders-p');
  if (choice === 'alchemist' && module) keys.push(`module.${module.directory.toLowerCase()}.${module.row}`);
  return keys;
}

// --- The sending step.

/** The Overview's rows a switched-off option can sit in (OverviewV2 names them). */
export type OverviewRow = 'price' | 'contents' | 'seed' | 'buyers' | 'sellers';

/**
 * Which of the Overview's rows hold the switched-off keys a draft needs: the price coin's row, the contents row (the box
 * kind and every add-on: a shop's list and starter set, hidden art, special series, royalty, collection page), the pile's
 * seed row (its coin), and each fee side (Into the shop's holders dependency is the sellers'; a module row is the side
 * that names it). A template key never blocks a draft, so it has no row.
 */
export function overviewRowsOf(keys: readonly string[], spec: Pick<BoxSpecV2, 'buyers' | 'sellers'>): ReadonlySet<OverviewRow> {
  const rows = new Set<OverviewRow>();
  const moduleRow = (side: 'buyers' | 'sellers'): string | null => {
    if (spec[side].a.dest !== Dest.Module) return null;
    try { return String(decodeAbiParameters([{ type: 'uint32' }], spec[side].a.destParams)[0]); } catch { return null; }
  };
  for (const key of keys) {
    if (key.startsWith('price.')) rows.add('price');
    else if (key.startsWith('pile.coin.')) rows.add('seed');
    else if (key.startsWith('kind.') || key.startsWith('addon.')) rows.add('contents');
    else if (key.startsWith('fee.buyers.')) rows.add('buyers');
    else if (key.startsWith('fee.sellers.')) rows.add('sellers');
    else if (key.startsWith('module.')) {
      const row = key.slice(key.lastIndexOf('.') + 1);
      for (const side of ['buyers', 'sellers'] as const) if (moduleRow(side) === row) rows.add(side);
    }
  }
  return rows;
}

/**
 * The line under the Overview's Create, for a press that prepares the draft (`shown`: a real build's Create, not a
 * resume): B when the list (or the module directory) cannot be read; A when the draft needs a switched-off option, or
 * cannot be checked while the page names nothing else to fix (an incomplete draft has its own issues, which say what to
 * do; then no line A); none otherwise.
 */
export function createOptionsLine(verdict: 'none' | 'reading' | 'unavailable' | 'ok' | 'off' | 'blocked', issues: number, shown: boolean): 'off' | 'unavailable' | null {
  if (!shown) return null;
  if (verdict === 'unavailable') return 'unavailable';
  if (verdict === 'off' || (verdict === 'blocked' && issues === 0)) return 'off';
  return null;
}

// --- The last check, right before the wallet.

export interface CreateGate {
  /** The selected release's list; null when the source has no single release (then nothing is created). */
  readonly target: CreateOptionsTarget | null;
  /** The release's checked module directory, read when the spec names a module row. */
  readonly moduleDirectory: () => Promise<Address>;
  readonly fetch?: CreateOptionsFetch;
  readonly now?: () => number;
}

/**
 * The executor's `createOptionsCheck`: read the list afresh and check the run's own plan (its chain, factory and exact
 * spec, never the page's draft). Resolves only when nothing it needs is off; throws a CreateRefusal with line A (an
 * option is off, or the spec cannot be checked) or line B (the list or the module directory cannot be read now).
 */
export async function checkBeforeWallet(gate: CreateGate, plan: Pick<CreateSendPlanV2, 'chainId' | 'factory' | 'spec'>): Promise<void> {
  const unavailable = () => new CreateRefusal('refused', CREATE_UNAVAILABLE);
  const target = gate.target;
  if (!target || plan.chainId !== target.release.chainId || plan.factory.toLowerCase() !== target.release.factory) throw unavailable();
  const now = gate.now ?? monotonicNow;
  const read = await readCreateOptions(target, gate.fetch ?? fetcher, now);
  if (!isFresh(read, now())) throw unavailable();
  let directory: Address | undefined;
  if (needsModuleDirectory(plan.spec)) {
    try {
      directory = await gate.moduleDirectory();
    } catch {
      throw unavailable();
    }
  }
  if (checkSpec(read.document, plan.spec, directory).state !== 'ok') throw new CreateRefusal('refused', CREATE_OFF);
}
