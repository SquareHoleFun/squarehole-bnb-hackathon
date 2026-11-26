import { isAddress, type Address } from 'viem';

/** One pile the page lists: the shared core (`IFeeRules`) behind either entry. */
export interface PileEntry {
  pile: Address;
  rail: 'flap' | 'openfour' | 'core';
  label?: string;
}

export interface FlapSale {
  launcher: Address;
  token?: Address;
}

export interface FlapConfig {
  portal: Address;
  /** The tax-token implementation the Portal clones (for the token address preview). */
  tokenImpl: Address;
  pileVaultFactory: Address;
  curveLauncherFactory: Address;
  /** PancakeSwap V2 router and wrapped BNB for the trade box; the entry's own testnet ones by default. */
  router?: Address;
  wbnb?: Address;
  /** Sales named by the deployment scripts; the page also reads the factory's creation events from `fromBlock`. */
  sales: FlapSale[];
  /** The second pair of factories: the same sale with an ERC-20 quote (Flap's test USDT), paid by approval. */
  tokenQuote?: FlapTokenQuote;
  /**
   * SH-287: the rules pairs (lane f's `deployments/97-rules-<variant>.json`): a launcher factory whose vault slot is a
   * RulesVaultFactory, per quote: `native` (BNB), `token` (the test token). Where one is set, Create uses it and offers
   * the creator's rules; without it the screens are today's.
   */
  rules?: { native?: FlapRulesPair; token?: FlapRulesPair };
}

export interface FlapRulesPair {
  launcherFactory: Address;
  rulesVaultFactory: Address;
  sales?: { launcher: Address; token: Address }[];
}

export interface FlapTokenQuote {
  /** The quote coin, and the name the page shows for it (its on-chain symbol may be terser). */
  quote: Address;
  label: string;
  launcherFactory: Address;
  pileVaultFactory: Address;
  sales: FlapSale[];
}

/** One OpenFour token, as the entry's scripts write it (`launch-preset.json`, `launch-tax.json`). */
export interface OpenFourToken {
  token: Address;
  tokenUri?: string;
  /**
   * 'preset': the Pile Bonding preset (the pile is the Trade module's); 'tax': the tax-vault template; 'tax-rules': the
   * rules tax-vault template (the creator's rules share the tax; the page proves the clone against `rulesTemplate`).
   */
  kind?: 'preset' | 'tax' | 'tax-rules';
  pile?: Address;
  taxVaultClone?: Address;
}

export interface OpenFourConfig {
  core: Address;
  tools: Address;
  /** Our Pile Bonding preset's id and OpenFour's Bonding Tax V1 id on the copy (decimal strings). */
  presetId?: string;
  taxPresetId?: string;
  /** Our PileTaxVault template: a tax token's vault must be a clone of it. */
  taxTemplate?: Address;
  /**
   * SH-287: our RulesTaxVault template (the OpenFour entry's tax-rules template record). Where it is set and the
   * creation signer offers the kind, a tax launch takes the creator's rules; a token whose vault is a clone of it shows
   * them. Without it the screens are today's.
   */
  rulesTemplate?: Address;
  /** The quote coins the creation signer allows. */
  quotes?: Address[];
  /** PancakeSwap V2 router for trades after migration; the entry's own testnet one by default. */
  router?: Address;
  /** Wrapped BNB: when it is a token's quote coin, the buy box offers to wrap BNB first. */
  wbnb?: Address;
  tokens: OpenFourToken[];
}

/** The deployment file (`addresses.json` beside the page). Validated as a whole: chain 97 only. */
export interface AppConfig {
  chainId: 97;
  /** The first read endpoint (also offered to a wallet that does not know the chain). */
  rpcUrl: string;
  /** Read endpoints tried in order when one refuses (rate limits). */
  rpcUrls: string[];
  explorer: string;
  /** First block to read events from (a decimal string), the block the factories were deployed in. */
  fromBlock: string;
  piles?: PileEntry[];
  flap?: FlapConfig;
  openfour?: OpenFourConfig;
  /**
   * SH-290: holder payouts on a token (bounties/core/src/IRailStake.sol): our stake factory. Without it the page shows
   * no holders panel, exactly as before.
   */
  railStake?: { factory: Address };
  /** SH-288: the card shops' factory (bounties/core RailShopFactory); without it no shop is shown or linked. */
  shops?: ShopsConfig;
}

export interface ShopsConfig {
  factory: Address;
}

export const BSC_TESTNET_ID = 97;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d+$/;

type Check<T> = { ok: true; value: T } | { ok: false; problem: string };
class Bad extends Error {}
const fail = (path: string, what: string): never => {
  throw new Bad(`${path}: ${what}`);
};

function obj(v: unknown, path: string, keys: { required: string[]; optional: string[] }): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!keys.required.includes(k) && !keys.optional.includes(k)) fail(`${path}.${k}`, 'unknown field');
  for (const k of keys.required) if (!(k in r)) fail(`${path}.${k}`, 'missing');
  return r;
}
function addr(v: unknown, path: string): Address {
  if (typeof v !== 'string' || !ADDRESS.test(v)) fail(path, 'must be an address (0x and 40 hex digits)');
  // all lower case, or mixed case with a correct checksum (a mistyped checksum is refused)
  const a = v as string;
  if (a !== a.toLowerCase() && !isAddress(a, { strict: true })) fail(path, 'has a wrong checksum');
  return a as Address;
}
function optAddr(v: unknown, path: string): Address | undefined {
  return v === undefined ? undefined : addr(v, path);
}
function str(v: unknown, path: string, re?: RegExp): string {
  if (typeof v !== 'string' || (re && !re.test(v))) fail(path, 'has the wrong form');
  return v as string;
}
function list<T>(v: unknown, path: string, each: (x: unknown, p: string) => T, nonEmpty = false): T[] {
  if (!Array.isArray(v) || (nonEmpty && v.length === 0)) fail(path, nonEmpty ? 'must be a list with at least one entry' : 'must be a list');
  return (v as unknown[]).map((x, i) => each(x, `${path}[${i}]`));
}
/**
 * A list of entries (a launch, a pile): an entry the page cannot read is LEFT OUT with a console note naming it, so one
 * entry never stops the page; the rest are kept. A list that is not a list still stops it.
 */
function entries<T>(v: unknown, path: string, each: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  const out: T[] = [];
  (v as unknown[]).forEach((x, i) => {
    try {
      out.push(each(x, `${path}[${i}]`));
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      console.warn(`addresses file: left out ${e.message}`);
    }
  });
  return out;
}
/** An http(s) URL, parsed; plain http only where allowed (development and tests, for a local chain). */
function url(v: unknown, path: string, allowHttp: boolean): string {
  if (typeof v !== 'string') return fail(path, 'must be a URL');
  let u: URL;
  try {
    u = new URL(v as string);
  } catch {
    return fail(path, 'must be a URL');
  }
  if (!(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:')) || u.username || u.password) fail(path, 'must be an https URL');
  return (v as string).replace(/\/$/, '');
}

/** Validates a parsed deployment file as a whole; any problem refuses all of it. */
export function checkConfig(raw: unknown, opts: { allowHttp?: boolean } = {}): Check<AppConfig> {
  const allowHttp = opts.allowHttp ?? false;
  try {
    const r = obj(raw, 'file', { required: ['chainId', 'rpcUrls', 'explorer', 'fromBlock'], optional: ['rpcUrl', 'piles', 'flap', 'openfour', 'shops', 'railStake'] });
    if (r.chainId !== BSC_TESTNET_ID) fail('chainId', 'must be 97');
    const rpcUrls = list(r.rpcUrls, 'rpcUrls', (x, p) => url(x, p, allowHttp), true);
    const rpcUrl = r.rpcUrl === undefined ? rpcUrls[0]! : url(r.rpcUrl, 'rpcUrl', allowHttp);
    const explorer = url(r.explorer, 'explorer', false);
    const fromBlock = str(r.fromBlock, 'fromBlock', DECIMAL);
    const config: AppConfig = { chainId: 97, rpcUrl, rpcUrls, explorer, fromBlock };
    if (r.piles !== undefined) {
      config.piles = entries(r.piles, 'piles', (x, p) => {
        const e = obj(x, p, { required: ['pile', 'rail'], optional: ['label'] });
        if (!['flap', 'openfour', 'core'].includes(e.rail as string)) fail(`${p}.rail`, 'must be flap, openfour or core');
        return { pile: addr(e.pile, `${p}.pile`), rail: e.rail as PileEntry['rail'], ...(e.label === undefined ? {} : { label: str(e.label, `${p}.label`) }) };
      });
    }
    if (r.flap !== undefined) {
      const f = obj(r.flap, 'flap', { required: ['portal', 'tokenImpl', 'pileVaultFactory', 'curveLauncherFactory', 'sales'], optional: ['router', 'wbnb', 'tokenQuote', 'rules'] });
      const sale = (x: unknown, p: string) => {
        const e = obj(x, p, { required: ['launcher'], optional: ['token'] });
        return { launcher: addr(e.launcher, `${p}.launcher`), token: optAddr(e.token, `${p}.token`) };
      };
      let tokenQuote: FlapTokenQuote | undefined;
      if (f.tokenQuote !== undefined) {
        const t = obj(f.tokenQuote, 'flap.tokenQuote', { required: ['quote', 'label', 'launcherFactory', 'pileVaultFactory', 'sales'], optional: [] });
        tokenQuote = {
          quote: addr(t.quote, 'flap.tokenQuote.quote'),
          label: str(t.label, 'flap.tokenQuote.label', /^[A-Za-z0-9 ().-]{1,24}$/),
          launcherFactory: addr(t.launcherFactory, 'flap.tokenQuote.launcherFactory'),
          pileVaultFactory: addr(t.pileVaultFactory, 'flap.tokenQuote.pileVaultFactory'),
          sales: entries(t.sales, 'flap.tokenQuote.sales', sale),
        };
      }
      let rules: FlapConfig['rules'];
      if (f.rules !== undefined) {
        const r = obj(f.rules, 'flap.rules', { required: [], optional: ['native', 'token'] });
        const pair = (x: unknown, p: string): FlapRulesPair => {
          const e = obj(x, p, { required: ['launcherFactory', 'rulesVaultFactory'], optional: ['sales'] });
          const result: FlapRulesPair = {
            launcherFactory: addr(e.launcherFactory, `${p}.launcherFactory`),
            rulesVaultFactory: addr(e.rulesVaultFactory, `${p}.rulesVaultFactory`),
          };
          if (e.sales !== undefined) {
            result.sales = entries(e.sales, `${p}.sales`, (x, path) => {
              const s = obj(x, path, { required: ['launcher', 'token'], optional: [] });
              return { launcher: addr(s.launcher, `${path}.launcher`), token: addr(s.token, `${path}.token`) };
            });
          }
          return result;
        };
        rules = {
          ...(r.native === undefined ? {} : { native: pair(r.native, 'flap.rules.native') }),
          ...(r.token === undefined ? {} : { token: pair(r.token, 'flap.rules.token') }),
        };
      }
      config.flap = {
        portal: addr(f.portal, 'flap.portal'),
        tokenImpl: addr(f.tokenImpl, 'flap.tokenImpl'),
        pileVaultFactory: addr(f.pileVaultFactory, 'flap.pileVaultFactory'),
        curveLauncherFactory: addr(f.curveLauncherFactory, 'flap.curveLauncherFactory'),
        router: optAddr(f.router, 'flap.router'),
        wbnb: optAddr(f.wbnb, 'flap.wbnb'),
        sales: entries(f.sales, 'flap.sales', sale),
        tokenQuote,
        ...(rules ? { rules } : {}),
      };
    }
    if (r.shops !== undefined) {
      const sh = obj(r.shops, 'shops', { required: ['factory'], optional: [] });
      config.shops = { factory: addr(sh.factory, 'shops.factory') };
    }
    if (r.openfour !== undefined) {
      const o = obj(r.openfour, 'openfour', {
        required: ['core', 'tools', 'tokens'],
        optional: ['presetId', 'taxPresetId', 'taxTemplate', 'rulesTemplate', 'quotes', 'router', 'wbnb'],
      });
      // A tax preset without our template could not prove a tax vault is ours: refused, so no tax writes can follow.
      if (o.taxPresetId !== undefined && o.taxTemplate === undefined) fail('openfour.taxTemplate', 'is required with taxPresetId');
      config.openfour = {
        core: addr(o.core, 'openfour.core'),
        tools: addr(o.tools, 'openfour.tools'),
        presetId: o.presetId === undefined ? undefined : str(o.presetId, 'openfour.presetId', DECIMAL),
        taxPresetId: o.taxPresetId === undefined ? undefined : str(o.taxPresetId, 'openfour.taxPresetId', DECIMAL),
        taxTemplate: optAddr(o.taxTemplate, 'openfour.taxTemplate'),
        ...(o.rulesTemplate === undefined ? {} : { rulesTemplate: addr(o.rulesTemplate, 'openfour.rulesTemplate') }),
        quotes: o.quotes === undefined ? undefined : list(o.quotes, 'openfour.quotes', addr),
        router: optAddr(o.router, 'openfour.router'),
        wbnb: optAddr(o.wbnb, 'openfour.wbnb'),
        tokens: entries(o.tokens, 'openfour.tokens', (x, p) => {
          const t = obj(x, p, { required: ['token'], optional: ['kind', 'pile', 'taxVaultClone', 'tokenUri'] });
          if (t.kind !== undefined && t.kind !== 'preset' && t.kind !== 'tax' && t.kind !== 'tax-rules') fail(`${p}.kind`, 'must be preset, tax or tax-rules');
          return {
            token: addr(t.token, `${p}.token`),
            ...(t.tokenUri === undefined ? {} : { tokenUri: str(t.tokenUri, `${p}.tokenUri`) }),
            kind: t.kind as OpenFourToken['kind'],
            pile: optAddr(t.pile, `${p}.pile`),
            taxVaultClone: optAddr(t.taxVaultClone, `${p}.taxVaultClone`),
          };
        }),
      };
    }
    if (r.railStake !== undefined) {
      const s = obj(r.railStake, 'railStake', { required: ['factory'], optional: [] });
      config.railStake = { factory: addr(s.factory, 'railStake.factory') };
    }

    return { ok: true, value: config };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, problem: e.message };
    throw e;
  }
}

/**
 * Where the deployment file is: `addresses.json` under the build's base, always. Only a development build (the dev
 * server the tests use) also takes `?addresses=<name>.json`, a plain relative name inside the same folder; the
 * production bundle has no such parameter at all (`import.meta.env.DEV` folds to false there).
 */
export function addressesUrl(search: string, base: string, allowParam: boolean): string {
  return allowParam ? devAddressesUrl(search, base) : folderOf(base) + 'addresses.json';
}

const folderOf = (base: string) => (base.endsWith('/') ? base : base + '/');

/** Development only: `?addresses=<name>.json`, a plain relative name inside the same folder. */
function devAddressesUrl(search: string, base: string): string {
  const q = new URLSearchParams(search).get('addresses');
  if (q && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.json$/.test(q)) return folderOf(base) + q;
  return folderOf(base) + 'addresses.json';
}

export type Loaded = { ok: true; config: AppConfig } | { ok: false; problem: string };

/** Fetches the deployment file from this page's own origin (no redirect followed) and validates it. */
export async function fetchConfig(): Promise<Loaded> {
  const dev = import.meta.env.DEV;
  // The production bundle has only the plain name: `dev` is a build-time false there, and the branch with the
  // development reader is dropped from the bundle.
  const name = dev ? devAddressesUrl(window.location.search, import.meta.env.BASE_URL) : folderOf(import.meta.env.BASE_URL) + 'addresses.json';
  const target = new URL(name, window.location.href);
  if (target.origin !== window.location.origin) return { ok: false, problem: 'the deployment file must come from this site' };
  let res: Response;
  try {
    res = await fetch(target, { cache: 'no-store', redirect: 'error', credentials: 'omit' });
  } catch {
    return { ok: false, problem: 'the deployment file could not be read' };
  }
  if (!res.ok) return { ok: false, problem: `the deployment file could not be read (${res.status})` };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, problem: 'the deployment file is not JSON' };
  }
  const checked = checkConfig(raw, { allowHttp: dev });
  return checked.ok ? { ok: true, config: checked.value } : { ok: false, problem: checked.problem };
}

/** Every pile the config names, once each. */
export function allPiles(c: AppConfig): PileEntry[] {
  const seen = new Set<string>();
  const out: PileEntry[] = [];
  const add = (p: PileEntry) => {
    const k = p.pile.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  };
  (c.piles ?? []).forEach(add);
  (c.openfour?.tokens ?? []).forEach((t) => t.pile && add({ pile: t.pile, rail: 'openfour' }));
  return out;
}

/** Whether a pile is one the deployment file names (writes are allowed on it). */
/** The token the deployment file pairs with this pile (an OpenFour token's pile), if it names one. */
export function listedTokenOf(c: AppConfig, pile: string): Address | undefined {
  return c.openfour?.tokens.find((t) => t.pile?.toLowerCase() === pile.toLowerCase())?.token;
}

export function isListedPile(c: AppConfig, pile: string): boolean {
  return allPiles(c).some((p) => p.pile.toLowerCase() === pile.toLowerCase());
}

/** The name the page shows for a coin: the deployment's label for its test token, else the coin's own symbol. */
export function coinLabel(c: AppConfig, address: string, onChainSymbol: string): string {
  const t = c.flap?.tokenQuote;
  return t && t.quote.toLowerCase() === address.toLowerCase() ? t.label : onChainSymbol;
}
