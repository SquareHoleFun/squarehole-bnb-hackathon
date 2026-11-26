/**
 * SH-289: the launches on the two other rails (Flap's Pool Launch, Four.meme's OpenFour), read for the Boxes page the
 * launch page's own way. The reading code is a copy, not an import: the web image's platform stage installs only the
 * platform's packages (hackathon/stack/app.Dockerfile, `pnpm install --filter '@squarehole/web...'`), so bounties/app's
 * modules cannot resolve their own `viem` there. Originals:
 * - the event windows: bounties/app/src/lib/logs.ts (`readEvents`, `WINDOW`, `MIN_WINDOW`);
 * - which launches there are: bounties/app/src/screens/Home.tsx (`sales`, `tokens`);
 * - one launch's line: Home.tsx `SaleLine`, `FourLine`; FlapSale.tsx's "Raised … of …"; FourToken.tsx `fourPhaseWord`;
 * - the deployment entries: bounties/app/src/lib/config.ts, from the file the launch page reads (/launches/addresses.json);
 * - SH-304: the rules pairs' launches (Home.tsx `rulesLogs`) and their rules' line (launch-rules.ts).
 * Reads go through the site's read endpoints with the site's rule for a refused read (`refusedRetryFetch`, SH-276).
 */
import { createPublicClient, erc20Abi, fallback, formatUnits, http, type Abi, type Address, type PublicClient } from 'viem';
import { refusedRetryFetch } from '@squarehole/chain/write/wallet';
import { CURVE_FACTORY_ABI, CURVE_LAUNCHER_ABI, FOUR_CORE_ABI, FOUR_VAULT_ABI, TOKEN_CURVE_FACTORY_ABI, TOKEN_CURVE_LAUNCHER_ABI } from './launch-abis';
import { launchRuleLine, readFourRulesLine, readRulesLine, type FourRulesSource, type RulesSource } from './launch-rules';
import { parsePictureLink, type LaunchPictureRef } from './launch-picture';

/** Where the launch page is served beside the site, and its deployment file. */
export const LAUNCHES_BASE = '/launches/';
export const LAUNCHES_FILE = `${LAUNCHES_BASE}addresses.json`;

// ------------------------------------------------------------------------------------------------ the deployment file

/** SH-304: a rules pair (config.ts `FlapRulesPair`): a launcher factory whose launches' rules its rules vault factory records. */
export interface RulesPair {
  readonly launcherFactory: Address;
  readonly rulesVaultFactory: Address;
  readonly sales?: readonly Address[];
}

export interface LaunchConfig {
  readonly fromBlock: bigint;
  readonly flap: {
    readonly curveLauncherFactory: Address;
    readonly sales: readonly Address[];
    readonly tokenQuote: { readonly launcherFactory: Address; readonly sales: readonly Address[] } | null;
    /** SH-304: the rules pairs per quote (BNB, the test dollar); absent when the file has none. */
    readonly rules?: { readonly native: RulesPair | null; readonly token: RulesPair | null };
  } | null;
  readonly openfour: {
    readonly core: Address;
    readonly presetIds: readonly bigint[];
    readonly tokens: readonly Address[];
    /** SH-304 step 2: what decides a token's kind (config.ts): the two preset ids, the two vault templates, each named token's kind. */
    readonly presetId?: bigint;
    readonly taxPresetId?: bigint;
    readonly taxTemplate?: Address;
    readonly rulesTemplate?: Address;
    readonly kinds?: Readonly<Record<string, string>>;
    readonly tokenUris?: Readonly<Record<string, string>>;
  } | null;
  /** SH-304: our card shop factory (`shops.factory`) and stake factory (`railStake.factory`), for the payees' names. */
  readonly shops?: Address;
  readonly stakes?: Address;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const address = (value: unknown, what: string): Address => {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(`launch file: ${what} is not an address`);
  return value as Address;
};
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`launch file: ${what} is not an object`);
  return value as Record<string, unknown>;
};
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const sales = (value: unknown, what: string) => list(value).map((s, i) => address(record(s, `${what} ${i}`).launcher, `${what} ${i}`));
/**
 * SH-304: an entry the cards can do without (a rules pair, the shop and stake factories). A malformed one is left out,
 * as if the file had none, instead of refusing the file: the other launches' cards still show. Left out, a rules pair's
 * launches have no card (without its rules vault factory their rules cannot be read, and a card must not claim
 * "pile 100" for them); a factory left out names no payee (it reads "paid out").
 */
const optional = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};
const rulesPair = (value: unknown, what: string): RulesPair | null =>
  value === undefined || value === null ? null : optional(() => {
    const e = record(value, what);
    const named = optional(() => sales(e.sales, `${what}.sales`));
    return { launcherFactory: address(e.launcherFactory, `${what}.launcherFactory`), rulesVaultFactory: address(e.rulesVaultFactory, `${what}.rulesVaultFactory`),
      ...(named?.length ? { sales: named } : {}) };
  });
const factoryOf = (value: unknown, what: string): Address | null =>
  value === undefined || value === null ? null : optional(() => address(record(value, what).factory, `${what}.factory`));

/**
 * The few entries the cards need from the launch page's file (config.ts's shape); a malformed required entry refuses
 * the file, a malformed optional one (SH-304: `flap.rules`, `shops`, `railStake`) is left out.
 */
export function parseLaunchConfig(raw: unknown, chainId = 97): LaunchConfig {
  const file = record(raw, 'the file');
  if (Number(file.chainId) !== chainId) throw new Error('launch file: another chain');
  if (typeof file.fromBlock !== 'string' && typeof file.fromBlock !== 'number') throw new Error('launch file: no first block');
  const fromBlock = BigInt(file.fromBlock);
  let flap: LaunchConfig['flap'] = null;
  if (file.flap !== undefined && file.flap !== null) {
    const f = record(file.flap, 'flap');
    const t = f.tokenQuote === undefined || f.tokenQuote === null ? null : record(f.tokenQuote, 'flap.tokenQuote');
    const r = f.rules === undefined || f.rules === null ? null : optional(() => record(f.rules, 'flap.rules'));
    const rules = r ? { native: rulesPair(r.native, 'flap.rules.native'), token: rulesPair(r.token, 'flap.rules.token') } : null;
    flap = { curveLauncherFactory: address(f.curveLauncherFactory, 'flap.curveLauncherFactory'), sales: sales(f.sales, 'flap sale'),
      tokenQuote: t ? { launcherFactory: address(t.launcherFactory, 'flap.tokenQuote.launcherFactory'), sales: sales(t.sales, 'token-quote sale') } : null,
      ...(rules && (rules.native || rules.token) ? { rules } : {}) };
  }
  let openfour: LaunchConfig['openfour'] = null;
  if (file.openfour !== undefined && file.openfour !== null) {
    const o = record(file.openfour, 'openfour');
    const presetIds = [o.presetId, o.taxPresetId].filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map((x) => BigInt(x));
    const kinds: Record<string, string> = {};
    const tokenUris: Record<string, string> = {};
    const tokens = list(o.tokens).map((t, i) => {
      const entry = record(t, `openfour token ${i}`);
      const token = address(entry.token, `openfour token ${i}`);
      const key = token.toLowerCase();
      if (typeof entry.kind === 'string') kinds[key] = entry.kind;
      if (typeof entry.tokenUri === 'string') tokenUris[key] = entry.tokenUri;
      return token;
    });
    const id = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? BigInt(x) : null);
    const [presetId, taxPresetId] = [id(o.presetId), id(o.taxPresetId)];
    // a malformed template is left out: its tokens' kind cannot be proven, so their cards show no rule line
    const template = (x: unknown, what: string) => (x === undefined || x === null ? null : optional(() => address(x, what)));
    const [taxTemplate, rulesTemplate] = [template(o.taxTemplate, 'openfour.taxTemplate'), template(o.rulesTemplate, 'openfour.rulesTemplate')];
    openfour = { core: address(o.core, 'openfour.core'), presetIds, tokens,
      ...(presetId !== null ? { presetId } : {}), ...(taxPresetId !== null ? { taxPresetId } : {}),
      ...(taxTemplate ? { taxTemplate } : {}), ...(rulesTemplate ? { rulesTemplate } : {}), ...(Object.keys(kinds).length ? { kinds } : {}),
      ...(Object.keys(tokenUris).length ? { tokenUris } : {}) };
  }
  const shops = factoryOf(file.shops, 'shops');
  const stakes = factoryOf(file.railStake, 'railStake');
  return { fromBlock, flap, openfour, ...(shops ? { shops } : {}), ...(stakes ? { stakes } : {}) };
}

// ------------------------------------------------------------------------------------------------ the event windows

/** bounties/app/src/lib/logs.ts: windows of at most 40,000 blocks, halved on a refusal down to 5,000. */
export const WINDOW = 40_000n;
export const MIN_WINDOW = 5_000n;

export interface EventQuery {
  readonly address: Address;
  readonly abi: Abi;
  readonly eventName: string;
  readonly fromBlock: bigint;
}

/** The decoded events of `q` from its first block to `head`, in windows (a window that fails at 5,000 fails the read). */
export async function readEvents<T>(c: Pick<PublicClient, 'getContractEvents'>, q: EventQuery, head: bigint): Promise<T[]> {
  const logs: T[] = [];
  let from = q.fromBlock;
  let size = WINDOW;
  while (from <= head) {
    const to = from + size - 1n < head ? from + size - 1n : head;
    let got: T[];
    try {
      got = (await c.getContractEvents({ address: q.address, abi: q.abi, eventName: q.eventName, fromBlock: from, toBlock: to } as never)) as unknown as T[];
    } catch (error) {
      if (size <= MIN_WINDOW) throw error;
      size = size / 2n > MIN_WINDOW ? size / 2n : MIN_WINDOW;
      continue;
    }
    logs.push(...got);
    from = to + 1n;
    if (size < WINDOW) size = size * 2n < WINDOW ? size * 2n : WINDOW;
  }
  return logs;
}

// ------------------------------------------------------------------------------------------------ at most two at a time

/** Runs `jobs` with at most `limit` running at once, in order; the first failure fails the whole. */
export async function inTwos<T>(jobs: readonly (() => Promise<T>)[], limit = 2): Promise<T[]> {
  const out: T[] = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      if (job) out[i] = await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

// ------------------------------------------------------------------------------------------------ the launches

export type LaunchRail = 'flap' | 'four';
export interface LaunchCardData {
  readonly rail: LaunchRail;
  readonly address: Address;
  readonly name: string;
  readonly symbol: string;
  /** Its state in the launch page's own words: "Raised 0.05 of 1 BNB", "Launched", "Missed", "On PancakeSwap", … */
  readonly state: string;
  /** One short line of its rules ("pile 100"), or null. */
  readonly rules: string | null;
  /** Its own page on the launch page. */
  readonly href: string;
  /** SH-294: its picture, from its own link (Flap `meta`, OpenFour `tokenUri`), or null. */
  readonly picture: LaunchPictureRef | null;
}

type ReadClient = Pick<PublicClient, 'getContractEvents' | 'readContract' | 'getBlockNumber' | 'getCode'>;
const unique = (addresses: readonly Address[]): Address[] => [...new Set(addresses.map((a) => a.toLowerCase() as Address))];

/**
 * Home.tsx: the sales the file names plus the factories' creation events (SH-304: the rules pairs' launcher factories
 * too, Home.tsx's `rulesLogs`, after the others as there); the tokens the file names plus Core's, newest first.
 */
export interface FlapLaunch {
  readonly launcher: Address;
  /** A sale priced in a token (TokenCurveLauncher), not in BNB. */
  readonly tokenQuote: boolean;
  /** SH-304: the rules pair whose launcher factory created it, or null (a launch without the creator's rules). */
  readonly rules: RulesPair | null;
}
export async function listLaunches(c: ReadClient, config: LaunchConfig, head: bigint): Promise<{ flap: FlapLaunch[]; four: Address[]; links: ReadonlyMap<string, string> }> {
  type Created = { args: { launcher?: Address; token?: Address; presetId?: bigint; tokenMetaUri?: string } };
  const NONE = async (): Promise<Created[]> => [];
  const f = config.flap; const o = config.openfour;
  const created = (factory: Address | undefined, quote: 'native' | 'token') => (factory
    ? () => readEvents<Created>(c, quote === 'native'
      ? { address: factory, abi: CURVE_FACTORY_ABI, eventName: 'CurveLauncherCreated', fromBlock: config.fromBlock }
      : { address: factory, abi: TOKEN_CURVE_FACTORY_ABI, eventName: 'TokenCurveLauncherCreated', fromBlock: config.fromBlock }, head)
    : NONE);
  // Five lists, two at a time; one that is not configured is empty and reads nothing.
  const [bnbLogs = [], tokenLogs = [], rulesBnbLogs = [], rulesTokenLogs = [], fourLogs = []] = await inTwos([
    created(f?.curveLauncherFactory, 'native'),
    created(f?.tokenQuote?.launcherFactory, 'token'),
    created(f?.rules?.native?.launcherFactory, 'native'),
    created(f?.rules?.token?.launcherFactory, 'token'),
    o && o.presetIds.length ? () => readEvents<Created>(c, { address: o.core, abi: FOUR_CORE_ABI, eventName: 'TokenCreated', fromBlock: config.fromBlock }, head) : NONE,
  ]);
  const launchers = (logs: readonly Created[]) => logs.map((l) => l.args.launcher).filter((a): a is Address => a !== undefined);
  const nativeSales = f?.rules?.native?.sales ?? [];
  const tokenSales = f?.rules?.token?.sales ?? [];
  const priced = new Set(unique([...(f?.tokenQuote?.sales ?? []), ...tokenSales, ...launchers(tokenLogs), ...launchers(rulesTokenLogs)]));
  const ruled = new Map<string, RulesPair>();
  if (f?.rules?.native) for (const l of unique([...nativeSales, ...launchers(rulesBnbLogs)])) ruled.set(l, f.rules.native);
  if (f?.rules?.token) for (const l of unique([...tokenSales, ...launchers(rulesTokenLogs)])) ruled.set(l, f.rules.token);
  const flap = f
    ? unique([...f.sales, ...(f.tokenQuote?.sales ?? []), ...nativeSales, ...tokenSales, ...launchers(bnbLogs), ...launchers(tokenLogs), ...launchers(rulesBnbLogs), ...launchers(rulesTokenLogs)])
      .reverse().map((launcher) => ({ launcher, tokenQuote: priced.has(launcher), rules: ruled.get(launcher) ?? null }))
    : [];
  const four = o ? unique([...o.tokens, ...fourLogs.filter((l) => l.args.presetId !== undefined && o.presetIds.includes(l.args.presetId)).map((l) => l.args.token).filter((a): a is Address => a !== undefined)]).reverse() : [];
  // Core's record holds no link. A creation event takes precedence over the file, including an empty event URI.
  const links = new Map(Object.entries(o?.tokenUris ?? {}));
  for (const { args } of fourLogs) {
    if (!args.token) continue;
    const key = args.token.toLowerCase();
    if (typeof args.tokenMetaUri === 'string') links.set(key, args.tokenMetaUri);
    else links.delete(key);
  }
  return { flap, four, links };
}

/** The launch page's own phases: 0 selling, 1 launched, 2 missed (FlapSale.tsx `PHASE`). */
const FLAP_LAUNCHED = 1; const FLAP_MISSED = 2;
/** OpenFour's vault phases (bounties/app/src/abi/openfour.ts): Trading 1, Migrated 3. */
const FOUR_TRADING = 1; const FOUR_MIGRATED = 3;
/** An amount on a card: at most four decimals, cut (never rounded up), no trailing zeros ("2.35", not "2.350000000000000001"). */
export const amount = (raw: bigint, decimals: number): string => {
  const [whole, fraction = ''] = formatUnits(raw, decimals).split('.');
  const cut = fraction.slice(0, 4).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : (whole ?? '0');
};

/**
 * One Flap sale: name, symbol, "Raised X of Y <quote>" while selling (FlapSale.tsx), "Launched", "Missed". SH-304: a
 * sale with the creator's rules (`ruled`, from its rules pair) shows them as read from the chain, or no rule line when
 * they cannot be read; the card itself still shows.
 */
export async function readFlapCard(c: ReadClient, launcher: Address, tokenQuote: boolean, ruled: RulesSource | null = null): Promise<LaunchCardData> {
  const abi = tokenQuote ? TOKEN_CURVE_LAUNCHER_ABI : CURVE_LAUNCHER_ABI;
  const [cfg, p] = await Promise.all([
    c.readContract({ address: launcher, abi, functionName: 'config' }) as Promise<{ name: string; symbol: string; meta?: string }>,
    c.readContract({ address: launcher, abi, functionName: 'progress' }) as Promise<{ phase: number; curveBalance: bigint; raiseTarget: bigint }>,
  ]);
  let quote = { symbol: 'BNB', decimals: 18 };
  if (tokenQuote && p.phase !== FLAP_LAUNCHED && p.phase !== FLAP_MISSED) {
    const q = (await c.readContract({ address: launcher, abi, functionName: 'quote' })) as Address;
    const [symbol, decimals] = await Promise.all([c.readContract({ address: q, abi: erc20Abi, functionName: 'symbol' }), c.readContract({ address: q, abi: erc20Abi, functionName: 'decimals' })]);
    quote = { symbol: String(symbol), decimals: Number(decimals) };
  }
  const state = p.phase === FLAP_LAUNCHED ? 'Launched' : p.phase === FLAP_MISSED ? 'Missed'
    : `Raised ${amount(p.curveBalance, quote.decimals)} of ${amount(p.raiseTarget, quote.decimals)} ${quote.symbol}`;
  const card = { rail: 'flap' as const, address: launcher, name: cfg.name, symbol: cfg.symbol, state, href: `${LAUNCHES_BASE}#/flap/${launcher}` };
  const rules = ruled ? await readRulesLine(c, launcher, ruled).catch(() => null) : launchRuleLine(card);
  // SH-294: the sale's link is its config's `meta` (CurveLauncher.sol, passed to the token unchanged at the launch).
  return { ...card, rules, picture: parsePictureLink(cfg.meta) };
}

/** FourToken.tsx `fourPhaseWord`: "Paused", "On PancakeSwap", "On the curve", "Not trading". */
export function fourPhaseWord(phase: number, paused: boolean): string {
  if (paused) return 'Paused';
  if (phase === FOUR_MIGRATED) return 'On PancakeSwap';
  if (phase === FOUR_TRADING) return 'On the curve';
  return 'Not trading';
}

/**
 * One OpenFour token: Core's record (name, symbol, vault, paused) and its vault's phase. SH-304 step 2: its rule line as
 * the launch page proves its kind (launch-rules.ts `readFourRulesLine`), or none when that cannot be read.
 */
export async function readFourCard(c: ReadClient, core: Address, token: Address, link: string | null = null, source: FourRulesSource & { readonly kind?: string | undefined } = {}): Promise<LaunchCardData> {
  const r = (await c.readContract({ address: core, abi: FOUR_CORE_ABI, functionName: 'tokens', args: [token] })) as readonly unknown[];
  const [name, symbol, vault, paused] = [String(r[4]), String(r[5]), r[10] as Address, r[18] === true];
  const phase = Number(await c.readContract({ address: vault, abi: FOUR_VAULT_ABI, functionName: 'phase' }));
  const card = { rail: 'four' as const, address: token, name, symbol, state: fourPhaseWord(phase, paused), href: `${LAUNCHES_BASE}#/four/${token}` };
  const rules = await (async () => readFourRulesLine(c, token, { presetId: BigInt(r[2] as bigint), creator: r[1] as Address }, source.kind, source))().catch(() => null);
  return { ...card, rules, picture: parsePictureLink(link) };
}

/** Every launch's card, the list reads and the card reads at most two at a time; Flap first, then Four.meme. */
export async function readLaunchCards(c: ReadClient, config: LaunchConfig): Promise<LaunchCardData[]> {
  const head = await c.getBlockNumber({ cacheTime: 0 });
  const { flap, four, links } = await listLaunches(c, config, head);
  const fourEntry = config.openfour;
  const jobs = [
    ...flap.map(({ launcher, tokenQuote, rules }) => () => readFlapCard(c, launcher, tokenQuote,
      rules ? { rulesVaultFactory: rules.rulesVaultFactory, shops: config.shops, stakes: config.stakes } : null)),
    ...(fourEntry ? four.map((token) => () => readFourCard(c, fourEntry.core, token, links.get(token.toLowerCase()) ?? null, {
      presetId: fourEntry.presetId, taxPresetId: fourEntry.taxPresetId, taxTemplate: fourEntry.taxTemplate, rulesTemplate: fourEntry.rulesTemplate,
      shops: config.shops, stakes: config.stakes, kind: fourEntry.kinds?.[token.toLowerCase()],
    })) : []),
  ];
  return inTwos(jobs);
}

/** The site's read client for these reads: its public read endpoints, each answer refused with HTTP 429 sent again. */
export function launchReadClient(urls: readonly string[]): PublicClient {
  const transports = urls.map((url) => http(url, { retryCount: 0, batch: false, fetchFn: refusedRetryFetch(), fetchOptions: { redirect: 'error' } }));
  const [only] = transports;
  if (!only) throw new Error('no read endpoint');
  return createPublicClient({ ccipRead: false, transport: transports.length === 1 ? only : fallback(transports, { retryCount: 0 }) }) as PublicClient;
}

/** The launch page's file, then every card (the page's own fetch; no credentials). */
export async function loadLaunchCards(urls: readonly string[], fetcher: typeof fetch = fetch): Promise<LaunchCardData[]> {
  const response = await fetcher(LAUNCHES_FILE, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`launch file: HTTP ${response.status}`);
  return readLaunchCards(launchReadClient(urls), parseLaunchConfig(await response.json()));
}
