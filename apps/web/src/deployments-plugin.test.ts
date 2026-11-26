import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { alphaManifestPath, arweavePictures, buildModeOf, coreManifestPaths, CORE_DEPLOYMENTS_DIR, deploymentsModule, fitMarketPaths, FIT_MARKETS_DIR, localArtGateways, LOCAL_VARIABLES, PRODUCTION_DESCRIPTION, PRODUCTION_TITLE, productionIndexHtml, SEPOLIA_ART_GATEWAY, sepoliaArtGateways, setManifestPath } from '../deployments-plugin';
import { SITE_CSP_ORIGINS } from './share/share-headers';
import { PICTURE_ORIGINS } from './features/pictures/arweave-hosts';
import { isProductionPage, PRODUCTION_STAMP } from './share/build-stamp';

/**
 * What `virtual:squarehole-deployments` embeds (deployments-plugin.ts). The Sepolia market record (the full v2
 * deployment with neutral names, apps/web/fit-markets/) ties those contracts to this app the moment a build carries it;
 * whether a public build should is the founder's open question (docs/evidence/SH-V2-sepolia-full.md C9, question 1),
 * so a plain production build must carry none until someone names it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SEPOLIA_RECORD = resolve(HERE, '../fit-markets/fit-market-11155111.json');
const SEPOLIA_TOKEN = (JSON.parse(readFileSync(SEPOLIA_RECORD, 'utf8')) as { contracts: { token: string } }).contracts.token;

/** The embedded `FIT_MARKETS` array, as the bundle would carry it. */
function markets(code: string): { chainId?: number; indexer?: unknown }[] {
  const line = code.split('\n').find((l) => l.startsWith('export const FIT_MARKETS = '));
  if (!line) throw new Error('no FIT_MARKETS export');
  return JSON.parse(line.slice('export const FIT_MARKETS = '.length, -1)) as { chainId?: number; indexer?: unknown }[];
}

describe('virtual:squarehole-deployments', () => {
  it('a default production build (`vite build`, no variables) carries no market record, so no Sepolia rehearsal', () => {
    const { code } = deploymentsModule({ devServer: false, env: {} });
    expect(markets(code)).toEqual([]);
    expect(code).not.toContain(SEPOLIA_TOKEN);
    expect(code.toLowerCase()).not.toContain(SEPOLIA_TOKEN.toLowerCase());
    expect(code).not.toMatch(/Rehearsal/);
    // The local manifest follows the same rule (unchanged): none in a plain build.
    expect(code).toContain('export const LOCAL_MANIFEST = null;');
    expect(fitMarketPaths({ devServer: false, env: {} })).toEqual([]);
  });

  it('the dev server embeds the committed records (the founder sees the rehearsal with `pnpm dev`)', () => {
    const embedded = markets(deploymentsModule({ devServer: true, env: {} }).code);
    expect(embedded.map((record) => record.chainId)).toEqual([11_155_111]);
    expect(fitMarketPaths({ devServer: true, env: {} })).toEqual([resolve(FIT_MARKETS_DIR, 'fit-market-11155111.json')]);
  });

  it('a build carries a record only when SH_FIT_MARKET names it; `none` turns the dev server’s off', () => {
    const named = deploymentsModule({ devServer: false, env: { SH_FIT_MARKET: SEPOLIA_RECORD } });
    expect(markets(named.code).map((record) => record.chainId)).toEqual([11_155_111]);
    expect(named.code).toContain(SEPOLIA_TOKEN);
    expect(markets(deploymentsModule({ devServer: true, env: { SH_FIT_MARKET: 'none' } }).code)).toEqual([]);
    expect(() => deploymentsModule({ devServer: false, env: { SH_FIT_MARKET: resolve(HERE, 'no-such-record.json') } })).toThrow(/does not exist/);
  });

  it('SH_SEPOLIA_INDEXER_ORIGIN points only the Sepolia record at a live service', () => {
    const env = { SH_FIT_MARKET: SEPOLIA_RECORD, SH_SEPOLIA_INDEXER_ORIGIN: 'http://127.0.0.1:5393' };
    expect(markets(deploymentsModule({ devServer: false, env }).code)[0]?.indexer).toEqual({ origin: 'http://127.0.0.1:5393' });
    expect(markets(deploymentsModule({ devServer: false, env: { SH_FIT_MARKET: SEPOLIA_RECORD } }).code)[0]?.indexer).toBeNull();
  });

  it('core v1 (S10a § 2.3): Sepolia\'s committed manifest always (box 0\'s deployed version since 2026-10-21), a local one only when named', () => {
    const exported = (code: string, name: string): unknown => {
      const line = code.split('\n').find((l) => l.startsWith(`export const ${name} = `));
      if (!line) throw new Error(`no ${name} export`);
      return JSON.parse(line.slice(`export const ${name} = `.length, -1)) as unknown;
    };
    const plain = deploymentsModule({ devServer: false, env: {} }).code;
    const committed = JSON.parse(readFileSync(resolve(CORE_DEPLOYMENTS_DIR, '11155111.json'), 'utf8')) as unknown;
    expect(committed).toMatchObject({ schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 11_155_111, network: 'sepolia' });
    expect(exported(plain, 'CORE_MANIFESTS')).toEqual([committed]);
    expect(exported(plain, 'CORE_LOCAL_RPC_URL')).toBe('http://127.0.0.1:8562');
    expect(exported(plain, 'CORE_INDEXER_ORIGINS')).toEqual({ local: null, sepolia: null });
    expect(coreManifestPaths({ devServer: false, env: {} })).toEqual([resolve(CORE_DEPLOYMENTS_DIR, '11155111.json')]);
    const sepoliaFile = resolve(CORE_DEPLOYMENTS_DIR, '11155111.json');
    const named = deploymentsModule({ devServer: false, env: { SH_CORE_LOCAL_MANIFEST: sepoliaFile, SH_CORE_LOCAL_RPC_URL: 'http://127.0.0.1:8559', SH_CORE_LOCAL_INDEXER_ORIGIN: 'http://127.0.0.1:5398' } }).code;
    expect((exported(named, 'CORE_MANIFESTS') as unknown[]).length).toBe(2);
    expect(exported(named, 'CORE_LOCAL_RPC_URL')).toBe('http://127.0.0.1:8559');
    expect(exported(named, 'CORE_INDEXER_ORIGINS')).toEqual({ local: 'http://127.0.0.1:5398', sepolia: null });
    expect(() => deploymentsModule({ devServer: false, env: { SH_CORE_LOCAL_MANIFEST: resolve(HERE, 'no-such.json') } })).toThrow(/does not exist/);
    expect(() => deploymentsModule({ devServer: false, env: { SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://user:pw@example.com/path' } })).toThrow(/bare http/);
  });

  it('SH-V2-FE11: the local stack’s art gateways, bare loopback origins only; none for Sepolia outside its test target (SH-TA-26), none by default', () => {
    const exported = (code: string): unknown => {
      const line = code.split('\n').find((l) => l.startsWith('export const CORE_ART_GATEWAYS = '));
      if (!line) throw new Error('no CORE_ART_GATEWAYS export');
      return JSON.parse(line.slice('export const CORE_ART_GATEWAYS = '.length, -1)) as unknown;
    };
    expect(exported(deploymentsModule({ devServer: true, env: {} }).code)).toEqual({ local: [], sepolia: [] });
    expect(exported(deploymentsModule({ devServer: true, env: { SH_CORE_LOCAL_ART_GATEWAYS: 'http://127.0.0.1:5421' } }).code)).toEqual({ local: ['http://127.0.0.1:5421'], sepolia: [] });
    expect(localArtGateways(' http://127.0.0.1:5421/ , http://localhost:5422,http://[::1]:5423,http://127.0.0.1:5421 ')).toEqual(['http://127.0.0.1:5421', 'http://localhost:5422', 'http://[::1]:5423']);
    expect(localArtGateways('')).toEqual([]);
    expect(localArtGateways(undefined)).toEqual([]);
    for (const bad of ['https://ipfs.io', 'http://192.168.1.2:8080', 'http://127.0.0.1:5421/ipfs', 'http://u:p@127.0.0.1:5421', 'http://127.0.0.1:5421?x=1', 'http://127.0.0.1:5421#a', 'ftp://127.0.0.1', 'not a url', 'http://127.0.0.1.example.com']) {
      expect(() => localArtGateways(bad), bad).toThrow(/SH_CORE_LOCAL_ART_GATEWAYS/);
    }
  });
});

/**
 * F156 (SH-ALPHA-TRADE-BOX): the 31337 alpha's own manifest, in a development build only when SH_ALPHA_LOCAL_MANIFEST names
 * it; the trade box checks its `localDeployment` against the local core manifest (features/trade-sepolia/trade-target.ts).
 */
describe('virtual:squarehole-deployments: the local alpha’s manifest', () => {
  const exported = (code: string): unknown => {
    const line = code.split('\n').find((l) => l.startsWith('export const ALPHA_LOCAL_MANIFEST = '));
    if (!line) throw new Error('no ALPHA_LOCAL_MANIFEST export');
    return JSON.parse(line.slice('export const ALPHA_LOCAL_MANIFEST = '.length, -1)) as unknown;
  };

  it('embeds none unless SH_ALPHA_LOCAL_MANIFEST names a file; the named file as it is, and watched; never a core release', () => {
    expect(exported(deploymentsModule({ devServer: true, env: {} }).code)).toBeNull();
    expect(exported(deploymentsModule({ devServer: false, env: {} }).code)).toBeNull();
    expect(alphaManifestPath({ env: {} })).toBeNull();
    expect(alphaManifestPath({ env: { SH_ALPHA_LOCAL_MANIFEST: '  ' } })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'sh-alpha-manifest-'));
    try {
      const file = join(dir, 'alpha.json');
      const manifest = { schema: 'square-hole-alpha-local/1', chainId: 31337, localDeployment: { poolSwapTest: `0x${'4'.repeat(40)}` } };
      writeFileSync(file, JSON.stringify(manifest));
      for (const devServer of [false, true]) {
        const built = deploymentsModule({ devServer, env: { SH_ALPHA_LOCAL_MANIFEST: file } });
        expect(exported(built.code)).toEqual(manifest);
        expect(built.watch).toContain(file);
        expect(built.code.split('\n').find((l) => l.startsWith('export const CORE_MANIFESTS = '))).not.toContain('square-hole-alpha-local/1');
      }
      expect(() => deploymentsModule({ devServer: true, env: { SH_ALPHA_LOCAL_MANIFEST: join(dir, 'missing.json') } })).toThrow(/SH_ALPHA_LOCAL_MANIFEST names a file that does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's local manifest, its own file (never a core manifest's release), in a
 * development build only when SH_SET_LOCAL_MANIFEST names it. The app parses and checks it (features/set/set-build.ts).
 */
describe('virtual:squarehole-deployments: the add-on’s local manifest', () => {
  const exported = (code: string): unknown => {
    const line = code.split('\n').find((l) => l.startsWith('export const SET_LOCAL_MANIFEST = '));
    if (!line) throw new Error('no SET_LOCAL_MANIFEST export');
    return JSON.parse(line.slice('export const SET_LOCAL_MANIFEST = '.length, -1)) as unknown;
  };

  it('embeds none unless SH_SET_LOCAL_MANIFEST names a file; the named file as it is, and watched', () => {
    expect(exported(deploymentsModule({ devServer: true, env: {} }).code)).toBeNull();
    expect(exported(deploymentsModule({ devServer: false, env: {} }).code)).toBeNull();
    expect(setManifestPath({ env: {} })).toBeNull();
    expect(setManifestPath({ env: { SH_SET_LOCAL_MANIFEST: '  ' } })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'sh-set-manifest-'));
    try {
      const file = join(dir, 'set-release.json');
      const manifest = { schema: 'squarehole.set-release/v1', network: 'local', chainId: 31337 };
      writeFileSync(file, JSON.stringify(manifest));
      for (const devServer of [false, true]) {
        const built = deploymentsModule({ devServer, env: { SH_SET_LOCAL_MANIFEST: file } });
        expect(exported(built.code)).toEqual(manifest);
        expect(built.watch).toContain(file);
      }
      // It never joins the core manifests (their releases array stays the core file's own).
      expect(deploymentsModule({ devServer: false, env: { SH_SET_LOCAL_MANIFEST: file } }).code.split('\n').find((l) => l.startsWith('export const CORE_MANIFESTS = '))).not.toContain('squarehole.set-release/v1');
      expect(() => deploymentsModule({ devServer: true, env: { SH_SET_LOCAL_MANIFEST: join(dir, 'missing.json') } })).toThrow(/SH_SET_LOCAL_MANIFEST names a file that does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * SH-V2-FE6: `SH_BUILD=production`, the site with no Demo and no local chain. The module refuses every local variable
 * (never ignores one), embeds no local manifest or RPC URL, takes Sepolia records and manifests only and https indexer
 * origins on a public host; the page head loses index.html's Demo words.
 */
describe('virtual:squarehole-deployments in a production build', () => {
  const exported = (code: string, name: string): unknown => {
    const line = code.split('\n').find((l) => l.startsWith(`export const ${name} = `));
    if (!line) throw new Error(`no ${name} export`);
    return JSON.parse(line.slice(`export const ${name} = `.length, -1)) as unknown;
  };
  const PRODUCTION = { SH_BUILD: 'production' };
  const LOCAL_RECORD = resolve(HERE, '../e2e/fixtures/fit-market-31337.json');
  const LOCAL_CORE = resolve(HERE, '../e2e/fixtures/core-local/manifest-11155111.json');

  it('SH_BUILD: unset or development is today’s build, production the production site; anything else is refused', () => {
    expect([buildModeOf({}), buildModeOf({ SH_BUILD: '' }), buildModeOf({ SH_BUILD: 'development' }), buildModeOf(PRODUCTION)]).toEqual(['development', 'development', 'development', 'production']);
    expect(() => buildModeOf({ SH_BUILD: 'prod' })).toThrow(/SH_BUILD must be/);
  });

  it('embeds no local manifest, no local RPC URL and no local indexer, even in the dev server', () => {
    for (const devServer of [false, true]) {
      const { code } = deploymentsModule({ devServer, env: PRODUCTION });
      expect(exported(code, 'LOCAL_MANIFEST')).toBeNull();
      expect(exported(code, 'LOCAL_RPC_URL')).toBe('');
      expect(exported(code, 'CORE_LOCAL_RPC_URL')).toBe('');
      expect(exported(code, 'CORE_INDEXER_ORIGINS')).toEqual({ local: null, sepolia: null });
      expect(exported(code, 'CORE_ART_GATEWAYS')).toEqual({ local: [], sepolia: [] });
      expect(exported(code, 'FIT_MARKETS')).toEqual([]);
      expect(code).not.toMatch(/127\.0\.0\.1|localhost|31337|"network":"local"/);
    }
  });

  it('refuses every local variable instead of ignoring it (an empty one is no variable)', () => {
    for (const name of LOCAL_VARIABLES) {
      expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, [name]: 'x' } }), name).toThrow(`SH_BUILD=production carries no local chain: unset ${name}`);
      expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, [name]: '' } }), name).not.toThrow();
    }
  });

  it('takes Sepolia records and manifests only', () => {
    expect(exported(deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_FIT_MARKET: SEPOLIA_RECORD } }).code, 'FIT_MARKETS')).toHaveLength(1);
    expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_FIT_MARKET: LOCAL_RECORD } })).toThrow(/Sepolia market records only/);
    // A recorded core manifest of the local twin (network local) is a fixture: refused as Sepolia's.
    expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_CORE_SEPOLIA_MANIFEST: LOCAL_CORE } })).toThrow(/Sepolia core manifests only/);
  });

  it('takes https indexer origins on a public host only', () => {
    const env = { ...PRODUCTION, SH_FIT_MARKET: SEPOLIA_RECORD };
    for (const origin of ['http://127.0.0.1:5393', 'https://localhost:8443', 'https://192.168.1.4', 'http://indexer.example.com']) {
      expect(() => deploymentsModule({ devServer: false, env: { ...env, SH_SEPOLIA_INDEXER_ORIGIN: origin } }), origin).toThrow(/https origin on a public host/);
      expect(() => deploymentsModule({ devServer: false, env: { ...env, SH_CORE_SEPOLIA_INDEXER_ORIGIN: origin } }), origin).toThrow(/https origin on a public host/);
    }
    const ok = deploymentsModule({ devServer: false, env: { ...env, SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun' } }).code;
    expect(exported(ok, 'CORE_INDEXER_ORIGINS')).toEqual({ local: null, sepolia: 'https://api.squarehole.fun' });
  });

  it('SH-TA-26: the Sepolia test target asks our own node for Sepolia pictures; every other build names no Sepolia gateway', () => {
    const SEPOLIA_TARGET = { ...PRODUCTION, SH_TARGET: 'sepolia' };
    expect(SEPOLIA_ART_GATEWAY).toBe('https://api.squarehole.fun');
    expect(exported(deploymentsModule({ devServer: false, env: SEPOLIA_TARGET }).code, 'CORE_ART_GATEWAYS')).toEqual({ local: [], sepolia: ['https://api.squarehole.fun'] });
    // The release build's environment (infra/server/app/build.mjs) names the same origin for the indexer.
    const release = deploymentsModule({ devServer: false, env: { ...SEPOLIA_TARGET, SH_FIT_MARKET: 'none', SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun' } }).code;
    expect(exported(release, 'CORE_ART_GATEWAYS')).toEqual({ local: [], sepolia: [SEPOLIA_ART_GATEWAY] });
    for (const env of [{}, { SH_TARGET: '' }, PRODUCTION, { ...PRODUCTION, SH_TARGET: 'mainnet' }, { SH_BUILD: 'development', SH_TARGET: 'sepolia' }]) {
      expect(sepoliaArtGateways(env), JSON.stringify(env)).toEqual([]);
    }
    expect(exported(deploymentsModule({ devServer: true, env: {} }).code, 'CORE_ART_GATEWAYS')).toEqual({ local: [], sepolia: [] });
    // A bare https origin the site's CSP already allows for images and connections (the API's); the art list stays empty.
    expect(new URL(SEPOLIA_ART_GATEWAY).origin).toBe(SEPOLIA_ART_GATEWAY);
    expect(SITE_CSP_ORIGINS.api).toContain(SEPOLIA_ART_GATEWAY);
    expect(SITE_CSP_ORIGINS.art).toEqual([]);
  });

  it('SH-ARWEAVE-PICTURES-WEB: Arweave for v2 pictures in the Sepolia test target, and wherever SH_ARWEAVE_PICTURES=1 asks outside production; nowhere else', () => {
    const SEPOLIA_TARGET = { ...PRODUCTION, SH_TARGET: 'sepolia' };
    expect(exported(deploymentsModule({ devServer: false, env: SEPOLIA_TARGET }).code, 'CORE_ARWEAVE')).toEqual({ local: false, sepolia: true });
    expect(exported(deploymentsModule({ devServer: true, env: {} }).code, 'CORE_ARWEAVE')).toEqual({ local: false, sepolia: false });
    expect(exported(deploymentsModule({ devServer: false, env: {} }).code, 'CORE_ARWEAVE')).toEqual({ local: false, sepolia: false });
    expect(exported(deploymentsModule({ devServer: true, env: { SH_ARWEAVE_PICTURES: '1' } }).code, 'CORE_ARWEAVE')).toEqual({ local: true, sepolia: true });
    for (const env of [PRODUCTION, { ...PRODUCTION, SH_TARGET: 'mainnet' }, { ...PRODUCTION, SH_ARWEAVE_PICTURES: '1' }, { SH_TARGET: 'sepolia' }]) {
      expect(arweavePictures(env).local, JSON.stringify(env)).toBe(false);
    }
    // A mainnet build never turns it on, even when asked (only the Sepolia test target does).
    expect(arweavePictures({ ...PRODUCTION, SH_ARWEAVE_PICTURES: '1' }).sepolia).toBe(false);
    expect(arweavePictures({ ...PRODUCTION, SH_TARGET: 'mainnet' }).sepolia).toBe(false);
    expect(() => arweavePictures({ SH_ARWEAVE_PICTURES: 'yes' })).toThrow(/SH_ARWEAVE_PICTURES must be/);
    // Every host the pages use is in the site's connect-src.
    expect(SITE_CSP_ORIGINS.pictures).toEqual(PICTURE_ORIGINS);
  });

  it('SH_CORE_SEPOLIA_MANIFEST names Sepolia’s core manifest instead of the committed one (in either build)', () => {
    const file = resolve(HERE, '../../../packages/contracts/deployments/core-v1/11155111.json');
    expect(coreManifestPaths({ devServer: false, env: { SH_CORE_SEPOLIA_MANIFEST: file } })).toEqual([file]);
    expect(() => coreManifestPaths({ devServer: false, env: { SH_CORE_SEPOLIA_MANIFEST: resolve(HERE, 'no-such.json') } })).toThrow(/does not exist/);
  });

  it('SH-ALPHA-TRADE-BOX: refuses the local alpha’s manifest and embeds none, on either target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-alpha-manifest-'));
    try {
      const file = join(dir, 'alpha.json');
      writeFileSync(file, JSON.stringify({ schema: 'square-hole-alpha-local/1', chainId: 31337 }));
      expect(LOCAL_VARIABLES).toContain('SH_ALPHA_LOCAL_MANIFEST');
      for (const target of ['mainnet', 'sepolia']) {
        expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_TARGET: target, SH_ALPHA_LOCAL_MANIFEST: file } })).toThrow('SH_BUILD=production carries no local chain: unset SH_ALPHA_LOCAL_MANIFEST');
        const { code } = deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_TARGET: target } });
        expect(exported(code, 'ALPHA_LOCAL_MANIFEST')).toBeNull();
        expect(code).not.toContain('square-hole-alpha-local/1');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SH-EXISTING-NFTS-E08C: refuses the add-on’s local manifest and embeds none, whatever the build names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-set-manifest-'));
    try {
      const file = join(dir, 'set-release.json');
      writeFileSync(file, JSON.stringify({ schema: 'squarehole.set-release/v1', network: 'local' }));
      expect(LOCAL_VARIABLES).toContain('SH_SET_LOCAL_MANIFEST');
      for (const devServer of [false, true]) {
        expect(() => deploymentsModule({ devServer, env: { ...PRODUCTION, SH_SET_LOCAL_MANIFEST: file } })).toThrow('SH_BUILD=production carries no local chain: unset SH_SET_LOCAL_MANIFEST');
        const { code } = deploymentsModule({ devServer, env: PRODUCTION });
        expect(exported(code, 'SET_LOCAL_MANIFEST')).toBeNull();
        expect(code).not.toContain('squarehole.set-release/v1');
      }
      // The Sepolia test target (the release build's environment) is a production build too.
      expect(() => deploymentsModule({ devServer: false, env: { ...PRODUCTION, SH_TARGET: 'sepolia', SH_SET_LOCAL_MANIFEST: file } })).toThrow(/unset SH_SET_LOCAL_MANIFEST/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the page head: the generic title and description, no Demo', () => {
    const html = readFileSync(resolve(HERE, '../index.html'), 'utf8');
    // F130: index.html itself has the generic head in every build now; production keeps its stamp.
    expect(html).not.toMatch(/demo|mock|31337/i);
    expect(html).toContain(`<title>${PRODUCTION_TITLE}</title>`);
    const head = productionIndexHtml(html);
    expect(head).toContain(`<title>${PRODUCTION_TITLE}</title>`);
    expect(head).toContain(`<meta name="description" content="${PRODUCTION_DESCRIPTION}" />`);
    expect(head).not.toMatch(/demo|mock|31337/i);
    // The link-preview function's cue (src/share/build-stamp.ts), once.
    expect(head.split(PRODUCTION_STAMP)).toHaveLength(2);
    expect(isProductionPage(head)).toBe(true);
    expect(isProductionPage(html)).toBe(false);
    expect(() => productionIndexHtml('<html><head></head></html>')).toThrow(/needs a <title>/);
  });
});

/**
 * Fix round 2 (XR-SH-ARWEAVE-PICTURES-WEB, F3): the unit-test build keeps Arweave off whatever the invoking environment
 * exports. vite.config.ts clears SH_ARWEAVE_PICTURES under Vitest (with SH_BUILD and SH_TARGET), and the plugin turns
 * Arweave off for any Vitest environment as well. The dev server and the opt-in live test (no Vitest) still turn it on.
 */
describe('fix round 2: Arweave in the unit-test build', () => {
  const PRODUCTION = { SH_BUILD: 'production' };
  const module = (plugin: Plugin): string => {
    const hooks = plugin as unknown as { configResolved: (config: unknown) => void; resolveId: (source: string) => string | null; load: (this: unknown, id: string) => string | null };
    hooks.configResolved({ command: 'serve', mode: 'test' });
    const id = hooks.resolveId('virtual:squarehole-deployments');
    if (id === null) throw new Error('the virtual module is not resolved');
    const code = hooks.load.call({ addWatchFile: () => undefined }, id);
    if (code === null) throw new Error('the virtual module has no code');
    return code;
  };
  const arweaveOf = (code: string): unknown => {
    const line = code.split('\n').find((entry) => entry.startsWith('export const CORE_ARWEAVE = '));
    if (!line) throw new Error('no CORE_ARWEAVE export');
    return JSON.parse(line.slice('export const CORE_ARWEAVE = '.length, -1)) as unknown;
  };
  /** The real vite.config.ts, loaded afresh with `env` set in the process (then put back): its deployments module. */
  async function configModule(env: Readonly<Record<string, string | undefined>>): Promise<string> {
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const put = (values: Readonly<Record<string, string | undefined>>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    };
    put(env);
    try {
      vi.resetModules();
      const config = (await import('../vite.config')).default as unknown as (env: { command: string; mode: string }) => { plugins: unknown[] };
      const plugin = config({ command: 'serve', mode: 'test' }).plugins.flat().find((entry) => (entry as Plugin | null)?.name === 'squarehole-deployments') as Plugin | undefined;
      if (!plugin) throw new Error('no squarehole-deployments plugin');
      return module(plugin);
    } finally {
      put(saved);
      vi.resetModules();
    }
  }

  it('vite.config.ts: under Vitest the build sees no SH_BUILD, SH_TARGET or SH_ARWEAVE_PICTURES; elsewhere it sees them as set', async () => {
    const { buildEnvOf } = await import('../vite.config');
    const asked = { SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_ARWEAVE_PICTURES: '1', SH_FIT_MARKET: 'none' };
    expect(buildEnvOf({ ...asked, VITEST: 'true' })).toMatchObject({ SH_BUILD: '', SH_TARGET: '', SH_ARWEAVE_PICTURES: '', SH_FIT_MARKET: 'none' });
    expect(buildEnvOf(asked)).toEqual(asked);
  });

  it('the plugin: a Vitest environment never turns Arweave on, whatever else it holds', () => {
    expect(arweavePictures({ VITEST: 'true', SH_ARWEAVE_PICTURES: '1' })).toEqual({ local: false, sepolia: false });
    expect(arweavePictures({ VITEST: 'true', ...PRODUCTION, SH_TARGET: 'sepolia' })).toEqual({ local: false, sepolia: false });
    // Outside Vitest the matrix is unchanged.
    expect(arweavePictures({ SH_ARWEAVE_PICTURES: '1' })).toEqual({ local: true, sepolia: true });
    expect(arweavePictures({ ...PRODUCTION, SH_TARGET: 'sepolia' })).toEqual({ local: false, sepolia: true });
  });

  it('the real vite.config.ts under Vitest, with SH_ARWEAVE_PICTURES=1 in the invoking environment: the virtual module says off', async () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(arweaveOf(await configModule({ SH_ARWEAVE_PICTURES: '1' }))).toEqual({ local: false, sepolia: false });
    // The same config outside Vitest (the dev server, the opt-in live test) still honours the opt-in.
    expect(arweaveOf(await configModule({ SH_ARWEAVE_PICTURES: '1', VITEST: undefined }))).toEqual({ local: true, sepolia: true });
  });
});
