// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
import { build, resolveConfig, type Alias, type Plugin, type Rolldown } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { alphaStandinOf, buildDefines, buildTargetOf, legalModeOf, productionSideEffects, sepoliaTradeOf } from '../build-target';
import { buildModeOf, squareHoleDeployments } from '../deployments-plugin';
import { squareHolePlaceholderGuard } from '../placeholder-guard';
import { TRADE_RULES, judgeModules, judgeTrade, loadGraph, scanDirectory } from '../production-check';
import { TRADE_SLOT_MARKER } from './features/trade-sepolia/TradeSlot';
import { termsTextOf, placeholdersIn } from './features/legal/terms-common';
import { PRODUCTION_TERMS } from './features/legal/terms-production';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '../..');
type Env = Record<string, string>;

/**
 * Every build variable this repository's build code names (the web build's config and plugins, the production check,
 * the server's release build), and a few that only sound like a switch. With `SH_TARGET` left out, none of them may
 * move a build into the test network mode.
 */
function tempting(): Env {
  const files = ['vite.config.ts', 'deployments-plugin.ts', 'placeholder-guard.ts', 'build-target.ts', 'dev-server-watch.ts', 'production-check.ts', 'playwright.production.config.ts'].map((file) => join(WEB, file));
  files.push(join(ROOT, 'infra/server/app/build.mjs'), join(ROOT, 'infra/server/app/config.mjs'));
  const names = new Set(['SH_TEST_NETWORK', 'SH_LEGAL_MODE', 'SH_NETWORK', 'SH_TESTNET', 'SH_LEGAL', 'VITE_SH_TEST_NETWORK', 'VITE_SH_TARGET', 'VITE_TEST_NETWORK', 'NODE_ENV', 'MODE']);
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:SH|VITE)_[A-Z0-9_]+\b/g)) names.add(match[0]);
  for (const name of ['SH_BUILD', 'SH_TARGET']) names.delete(name);
  // Values a switch could be hoping for; the local-chain variables, the trade opt-in (F156) and the Privy stand-in's
  // (F161 (4)), which a production build refuses, are not build switches (their own tests below set the opt-ins).
  return Object.fromEntries([...names].map((name) => [name, name.includes('LOCAL') || name === 'SH_SEPOLIA_TRADE' || name === 'SH_ALPHA_STANDIN' ? '' : 'sepolia']));
}

describe('the build target (SH-TA-02)', () => {
  it('reads SH_TARGET: unset or mainnet is the main site, sepolia the test site (production builds only), anything else fails', () => {
    expect(buildTargetOf({})).toBe('mainnet');
    expect(buildTargetOf({ SH_TARGET: '' })).toBe('mainnet');
    expect(buildTargetOf({ SH_TARGET: 'mainnet', SH_BUILD: 'production' })).toBe('mainnet');
    expect(buildTargetOf({ SH_TARGET: 'sepolia', SH_BUILD: 'production' })).toBe('sepolia');
    expect(() => buildTargetOf({ SH_TARGET: 'sepolia' })).toThrow('SH_TARGET=sepolia is a production target: set SH_BUILD=production as well');
    for (const value of ['Sepolia', ' sepolia', 'sepolia-test', 'test', 'testnet', '11155111', '1', 'true']) {
      expect(() => buildTargetOf({ SH_TARGET: value, SH_BUILD: 'production' }), value).toThrow('SH_TARGET must be unset, "mainnet" or "sepolia"');
    }
  });

  it('shows the test network notice only in a production build for Sepolia', () => {
    expect(legalModeOf({ SH_BUILD: 'production', SH_TARGET: 'sepolia' })).toBe('test-network');
    expect(legalModeOf({ SH_BUILD: 'production', SH_TARGET: 'mainnet' })).toBe('full');
    expect(legalModeOf({ SH_BUILD: 'production' })).toBe('full');
    expect(legalModeOf({})).toBe('full');
    expect(buildDefines({ SH_BUILD: 'production', SH_TARGET: 'sepolia' }, 'build')).toEqual({ 'import.meta.env.SH_PRODUCTION': 'true', 'import.meta.env.SH_TEST_NETWORK': 'true', 'import.meta.env.SH_SEPOLIA_TRADE': 'true', 'import.meta.env.SH_ALPHA_STANDIN': 'false' });
    expect(buildDefines({ SH_BUILD: 'production' }, 'build')).toEqual({ 'import.meta.env.SH_PRODUCTION': 'true', 'import.meta.env.SH_TEST_NETWORK': 'false', 'import.meta.env.SH_SEPOLIA_TRADE': 'false', 'import.meta.env.SH_ALPHA_STANDIN': 'false' });
    expect(buildDefines({}, 'build')).toEqual({ 'import.meta.env.SH_PRODUCTION': 'false', 'import.meta.env.SH_TEST_NETWORK': 'false', 'import.meta.env.SH_SEPOLIA_TRADE': 'false', 'import.meta.env.SH_ALPHA_STANDIN': 'false' });
    expect(buildDefines({}, 'serve')).toEqual({});
  });

  it('no other environment variable switches a mainnet build (or a production build with no target) into the test mode', () => {
    const others = tempting();
    expect(Object.keys(others).length).toBeGreaterThan(20);
    for (const target of [{ SH_TARGET: 'mainnet' }, {}]) {
      const env = { ...others, ...target, SH_BUILD: 'production' };
      expect(buildModeOf(env)).toBe('production');
      expect(legalModeOf(env)).toBe('full');
      expect(buildDefines(env, 'build')['import.meta.env.SH_TEST_NETWORK']).toBe('false');
      expect(buildDefines(env, 'serve')['import.meta.env.SH_TEST_NETWORK']).toBe('false');
      // F156: nor into the trade code.
      expect(sepoliaTradeOf(env)).toBe(false);
      expect(buildDefines(env, 'build')['import.meta.env.SH_SEPOLIA_TRADE']).toBe('false');
    }
  });
});

// --- the legal texts through a real build ---------------------------------------------------------------------------

const ENTRY = 'virtual:squarehole-legal-entry';
const RESOLVED = `\0${ENTRY}`;
/** What the app's pages read from the legal modules, as one bundle entry (the app's own build takes minutes). */
const entryPlugin: Plugin = {
  name: 'squarehole-legal-entry',
  resolveId: (id) => (id === ENTRY ? RESOLVED : null),
  load: (id) =>
    id === RESOLVED
      ? [
          `export { TERMS_GATE, TERMS_DOCUMENT, TERMS_SECTIONS, TERMS_VERSION, TEST_NETWORK_LINK } from ${JSON.stringify(join(WEB, 'src/features/legal/terms.ts'))};`,
          `export { PRIVACY_NOTICE, STORED_ON_DEVICE } from ${JSON.stringify(join(WEB, 'src/features/legal/privacy.ts'))};`,
          `export { OUR_BOXES, LEGAL_LEAD } from ${JSON.stringify(join(WEB, 'src/pages/about-content.ts'))};`,
        ].join('\n')
      : null,
};

/** The legal entry built as vite.config.ts builds the site for `env`: its defines, its tree-shaking, its placeholder guard. */
async function buildLegal(env: Env): Promise<string> {
  const production = buildModeOf(env) === 'production';
  buildTargetOf(env);
  const output = (await build({
    configFile: false,
    root: WEB,
    logLevel: 'silent',
    define: buildDefines(env, 'build'),
    plugins: [entryPlugin, squareHolePlaceholderGuard(env, production)],
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      rolldownOptions: { input: ENTRY, preserveEntrySignatures: 'strict', ...(production ? { treeshake: { moduleSideEffects: productionSideEffects } } : {}) },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((result) => result.output).map((chunk) => (chunk.type === 'chunk' ? chunk.code : String(chunk.source))).join('\n');
}

describe('the legal texts a build ships (SH-TA-02)', () => {
  it('the drafts are present in the sources: the production Terms still hold their open items', () => {
    expect(placeholdersIn(termsTextOf(PRODUCTION_TERMS.gate, PRODUCTION_TERMS.document)).length).toBeGreaterThan(40);
  });

  it('the Sepolia test build passes with the drafts present and ships the notice, none of the drafts', async () => {
    const code = await buildLegal({ SH_BUILD: 'production', SH_TARGET: 'sepolia' });
    expect(code).toContain('Test network notice');
    expect(code).toContain('It runs on the Sepolia test network only.');
    expect(code).toContain('The smart contracts have not been audited by an outside firm. Our own reviews are not audits.');
    expect(code).toContain('2026-11-20-sepolia-test-6');
    expect(code).toContain('Not on mainnet yet');
    expect(code).toContain('That you accepted the test network notice: the version and the time.');
    expect(code).not.toContain('That you accepted the Terms');
    expect(code).not.toMatch(/\[(?:COUNSEL|FOUNDER|ENGINEERING)\b/);
    expect(code).not.toContain('Square Hole Terms of Use');
    expect(code).not.toContain('DRAFT pending legal review');
    expect(code).not.toContain('2026-10-15-production-draft-4');
  }, shLimit(60_000));

  it('a mainnet build with the same drafts is refused, whatever else the environment holds', async () => {
    const refusal = 'SH_BUILD=production: the legal texts still hold';
    await expect(buildLegal({ SH_BUILD: 'production', SH_TARGET: 'mainnet' })).rejects.toThrow(refusal);
    await expect(buildLegal({ SH_BUILD: 'production' })).rejects.toThrow(refusal);
    await expect(buildLegal({ ...tempting(), SH_BUILD: 'production', SH_TARGET: 'mainnet' })).rejects.toThrow(refusal);
  }, shLimit(60_000));

  it('a mainnet build let through for a test that is never uploaded still ships the full drafts, never the notice', async () => {
    const code = await buildLegal({ ...tempting(), SH_BUILD: 'production', SH_TARGET: 'mainnet', SH_ALLOW_PLACEHOLDERS: '1' });
    expect(code).toContain('Square Hole Terms of Use');
    expect(code).toContain('2026-10-15-production-draft-4');
    expect(code).toMatch(/\[COUNSEL\b/);
    expect(code).toContain('That you accepted the Terms: the version and the time.');
    expect(code).not.toContain('Test network notice');
    expect(code).not.toContain('2026-10-24-sepolia-test-2');
  }, shLimit(60_000));
});

// --- the Sepolia alpha's trade switch (F156, SH-ALPHA-BUILD-SWITCH) ------------------------------------------------

describe('the trade switch (F156)', () => {
  const REFUSED = 'SH_BUILD=production takes the trade switch from SH_TARGET alone: unset SH_SEPOLIA_TRADE';
  const TRADE = 'import.meta.env.SH_SEPOLIA_TRADE';

  it('is off in every mainnet build, whatever else the environment holds, and the build says so as the literal false', () => {
    const production = ([{}, { SH_TARGET: '' }, { SH_TARGET: 'mainnet' }] as Env[]).map((target) => ({ ...target, SH_BUILD: 'production' }));
    const mainnet: Env[] = [...production, ...production.map((env) => ({ ...env, SH_ALLOW_PLACEHOLDERS: '1', SH_SEPOLIA_TRADE: '' })), ...production.map((env) => ({ ...tempting(), ...env }))];
    for (const env of mainnet) {
      expect(buildTargetOf(env), JSON.stringify(env)).toBe('mainnet');
      expect(sepoliaTradeOf(env), JSON.stringify(env)).toBe(false);
      expect(buildDefines(env, 'build')[TRADE]).toBe('false');
      expect(buildDefines(env, 'serve')[TRADE]).toBe('false');
    }
  });

  it('is on only in the Sepolia production build and where a development build or the dev server opts in', () => {
    const on: string[] = [];
    for (const build of [undefined, '', 'development', 'production']) {
      for (const target of [undefined, '', 'mainnet', 'sepolia']) {
        for (const optIn of [undefined, '', '1']) {
          const env = Object.fromEntries(Object.entries({ SH_BUILD: build, SH_TARGET: target, SH_SEPOLIA_TRADE: optIn }).filter(([, value]) => value !== undefined)) as Env;
          const production = buildModeOf(env) === 'production';
          // SH_TARGET=sepolia is a production target (above); a production build refuses the opt-in (below).
          if ((target === 'sepolia' && !production) || (production && optIn === '1')) continue;
          if (sepoliaTradeOf(env)) on.push(JSON.stringify(env));
          // A build always carries the literal; the dev server only the opt-in's `true`, never a `false` vitest would misread.
          expect(buildDefines(env, 'build')[TRADE], JSON.stringify(env)).toBe(String(sepoliaTradeOf(env)));
          expect(buildDefines(env, 'serve')[TRADE], JSON.stringify(env)).toBe(production ? String(sepoliaTradeOf(env)) : optIn === '1' ? 'true' : undefined);
        }
      }
    }
    expect(on).toEqual([
      '{"SH_SEPOLIA_TRADE":"1"}',
      '{"SH_TARGET":"","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_TARGET":"mainnet","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"","SH_TARGET":"","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"","SH_TARGET":"mainnet","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"development","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"development","SH_TARGET":"","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"development","SH_TARGET":"mainnet","SH_SEPOLIA_TRADE":"1"}',
      '{"SH_BUILD":"production","SH_TARGET":"sepolia"}',
      '{"SH_BUILD":"production","SH_TARGET":"sepolia","SH_SEPOLIA_TRADE":""}',
    ]);
    // The dev server opted in gets the trade literal alone.
    expect(buildDefines({ SH_SEPOLIA_TRADE: '1' }, 'serve')).toEqual({ [TRADE]: 'true' });
  });

  it('a production build refuses the opt-in, mainnet or Sepolia, whatever else the environment holds; any other value fails everywhere', () => {
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'mainnet' }, { SH_BUILD: 'production', SH_TARGET: 'sepolia' }, { ...tempting(), SH_BUILD: 'production', SH_TARGET: 'mainnet' }]) {
      const asked = { ...env, SH_SEPOLIA_TRADE: '1' };
      expect(() => sepoliaTradeOf(asked), JSON.stringify(env)).toThrow(REFUSED);
      expect(() => buildDefines(asked, 'build')).toThrow(REFUSED);
      expect(() => buildDefines(asked, 'serve')).toThrow(REFUSED);
    }
    for (const value of ['0', 'true', 'yes', ' 1', '1 ', 'sepolia', 'on']) {
      for (const env of [{}, { SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'sepolia' }]) {
        expect(() => sepoliaTradeOf({ ...env, SH_SEPOLIA_TRADE: value }), value).toThrow(`SH_SEPOLIA_TRADE must be unset or "1" (got "${value}")`);
      }
    }
  });

  /** The real vite.config.ts, loaded afresh with `env` set in the process (then put back): its `define` for `command`. */
  async function configDefines(env: Readonly<Record<string, string | undefined>>, command: 'build' | 'serve'): Promise<Record<string, string>> {
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
      const config = (await import('../vite.config')).default as unknown as (env: { command: string; mode: string }) => { define: Record<string, string> };
      return config({ command, mode: command === 'build' ? 'production' : 'development' }).define;
    } finally {
      put(saved);
      vi.resetModules();
    }
  }

  it('the real vite.config.ts: vitest never sees the opt-in; the dev server and a development build do; a production build refuses it', async () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(await configDefines({ SH_SEPOLIA_TRADE: '1' }, 'serve')).toEqual({});
    expect(await configDefines({ SH_SEPOLIA_TRADE: '1', SH_BUILD: 'production', SH_TARGET: 'sepolia' }, 'serve')).toEqual({});
    const outside = { VITEST: undefined, SH_BUILD: undefined, SH_TARGET: undefined };
    expect(await configDefines({ ...outside, SH_SEPOLIA_TRADE: '1' }, 'serve')).toEqual({ [TRADE]: 'true' });
    expect((await configDefines({ ...outside, SH_SEPOLIA_TRADE: '1' }, 'build'))[TRADE]).toBe('true');
    expect((await configDefines({ ...outside, SH_SEPOLIA_TRADE: undefined }, 'build'))[TRADE]).toBe('false');
    expect((await configDefines({ ...outside, SH_SEPOLIA_TRADE: undefined, SH_BUILD: 'production', SH_TARGET: 'sepolia' }, 'build'))[TRADE]).toBe('true');
    expect((await configDefines({ ...outside, SH_SEPOLIA_TRADE: undefined, SH_BUILD: 'production', SH_TARGET: 'mainnet' }, 'build'))[TRADE]).toBe('false');
    await expect(configDefines({ ...outside, SH_SEPOLIA_TRADE: '1', SH_BUILD: 'production' }, 'build')).rejects.toThrow(REFUSED);
    await expect(configDefines({ ...outside, SH_SEPOLIA_TRADE: '1', SH_BUILD: 'production', SH_TARGET: 'sepolia' }, 'build')).rejects.toThrow(REFUSED);
  });
});

// --- the Privy stand-in's switch (F161 (4), SH-ALPHA-SITE) ---------------------------------------------------------

describe('the Privy stand-in (F161 (4), SH-ALPHA-SITE)', () => {
  const STANDIN = 'import.meta.env.SH_ALPHA_STANDIN';
  const REFUSED = 'SH_BUILD=production never takes the Privy stand-in: unset SH_ALPHA_STANDIN';

  it('is off unless a development build or the dev server opts in, with the alpha’s code on as well', () => {
    for (const env of [{}, { SH_SEPOLIA_TRADE: '1' }, { SH_BUILD: 'production', SH_TARGET: 'sepolia' }, { SH_BUILD: 'production' }, { ...tempting(), SH_BUILD: 'production', SH_TARGET: 'mainnet' }] as Env[]) {
      expect(alphaStandinOf(env), JSON.stringify(env)).toBe(false);
      expect(buildDefines(env, 'build')[STANDIN], JSON.stringify(env)).toBe('false');
    }
    expect(buildDefines({ SH_SEPOLIA_TRADE: '1' }, 'serve')).toEqual({ 'import.meta.env.SH_SEPOLIA_TRADE': 'true' });
    const on = { SH_SEPOLIA_TRADE: '1', SH_ALPHA_STANDIN: '1' };
    expect(alphaStandinOf(on)).toBe(true);
    expect(buildDefines(on, 'build')[STANDIN]).toBe('true');
    expect(buildDefines(on, 'serve')).toEqual({ 'import.meta.env.SH_SEPOLIA_TRADE': 'true', [STANDIN]: 'true' });
    expect(() => alphaStandinOf({ SH_ALPHA_STANDIN: '1' })).toThrow('SH_ALPHA_STANDIN=1 is the alpha\'s stand-in: set SH_SEPOLIA_TRADE=1 as well');
  });

  it('a production build refuses it, mainnet or Sepolia, whatever else the environment holds; any other value fails everywhere', () => {
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'sepolia' }, { ...tempting(), SH_BUILD: 'production', SH_TARGET: 'mainnet' }] as Env[]) {
      expect(() => alphaStandinOf({ ...env, SH_ALPHA_STANDIN: '1' }), JSON.stringify(env)).toThrow(REFUSED);
      expect(() => buildDefines({ ...env, SH_ALPHA_STANDIN: '1' }, 'build')).toThrow(REFUSED);
    }
    for (const value of ['0', 'true', ' 1', 'yes', 'sepolia']) {
      expect(() => alphaStandinOf({ SH_SEPOLIA_TRADE: '1', SH_ALPHA_STANDIN: value }), value).toThrow(`SH_ALPHA_STANDIN must be unset or "1" (got "${value}")`);
    }
  });
});

// --- the trade slot through a real build ------------------------------------------------------------------------------

const SLOT_ENTRY = 'virtual:squarehole-trade-slot-entry';
const SLOT_RESOLVED = `\0${SLOT_ENTRY}`;
/** What the v2 box page reads of the slot (its mount), as one bundle entry. */
const slotEntryPlugin: Plugin = {
  name: 'squarehole-trade-slot-entry',
  resolveId: (id) => (id === SLOT_ENTRY ? SLOT_RESOLVED : null),
  load: (id) => (id === SLOT_RESOLVED ? `export { TradeSlotMount } from ${JSON.stringify(join(WEB, 'src/features/core/v2/TradeSlotMount.tsx'))};` : null),
};

/**
 * SH-ALPHA-TEST-COINS: the second door's exact line, as routes.tsx holds it (the doors pin checks that it does), built
 * on its own: a module of apps/web/src, so its relative import resolves as the route's does.
 */
const COIN_DOOR_LINE = "const TestCoinPage = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('./features/trade-sepolia/TradeSlot').then((module) => ({ default: module.TestCoinPage }))) : null;";
const COIN_DOOR_ENTRY = join(WEB, 'src/coin-door-entry.virtual.tsx');
const coinDoorEntryPlugin: Plugin = {
  name: 'squarehole-coin-door-entry',
  resolveId: (id) => (id === COIN_DOOR_ENTRY ? COIN_DOOR_ENTRY : null),
  load: (id) => (id === COIN_DOOR_ENTRY ? `import { lazy } from 'react';\n${COIN_DOOR_LINE}\nexport { TestCoinPage };\n` : null),
};

/**
 * The mount (or another entry) built as vite.config.ts builds the site for `env` (its defines, its tree-shaking,
 * minified, and the site's deployments module, which the trade box reads for the local alpha's deployment:
 * SH-ALPHA-TRADE-BOX): every chunk.
 */
async function buildSlot(env: Env, input: string = SLOT_ENTRY, entry: Plugin = slotEntryPlugin): Promise<Rolldown.OutputChunk[]> {
  const production = buildModeOf(env) === 'production';
  buildTargetOf(env);
  const output = (await build({
    configFile: false,
    root: WEB,
    logLevel: 'silent',
    define: buildDefines(env, 'build'),
    plugins: [react(), squareHoleDeployments(env), entry],
    build: {
      write: false,
      emptyOutDir: false,
      rolldownOptions: {
        input,
        preserveEntrySignatures: 'strict',
        ...(production ? { treeshake: { moduleSideEffects: productionSideEffects }, output: { strictExecutionOrder: true } } : {}),
      },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((result) => result.output).filter((chunk): chunk is Rolldown.OutputChunk => chunk.type === 'chunk');
}

const TRADE_MODULE = /[\\/]trade-sepolia[\\/]/;
/** A chunk's modules from the trade folders, as repository paths. */
const tradeModules = (chunk: Rolldown.OutputChunk) => chunk.moduleIds.filter((id) => TRADE_MODULE.test(id)).map((id) => relative(ROOT, id).split(sep).join('/'));
/**
 * The chunks a built chunk imports dynamically (`import(\`./x.js\`)`, as the build writes it); React's own messages
 * quote `import('./MyComponent')` without the extension a chunk always has.
 */
const dynamicImports = (code: string): string[] => [...code.matchAll(/\bimport\(\s*[`'"](\.\/[^`'"]+\.js)[`'"]\s*\)/g)].map((match) => match[1] as string);

describe('the trade slot through a real build (F156)', () => {
  it('a mainnet build, and a development build without the opt-in, carry no trade code at all: one chunk, no trade module, no marker', async () => {
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'mainnet' }, {}] as Env[]) {
      const chunks = await buildSlot(env);
      expect(chunks.map((chunk) => chunk.isEntry), JSON.stringify(env)).toEqual([true]);
      expect(chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => TRADE_MODULE.test(id))).toEqual([]);
      expect(chunks.filter((chunk) => chunk.code.includes(TRADE_SLOT_MARKER) || chunk.code.includes('trade-sepolia'))).toEqual([]);
      // No dynamic import of a chunk is left at all (React's own messages mention `import()` in words).
      expect(dynamicImports(chunks[0]?.code ?? '')).toEqual([]);
    }
  }, shLimit(60_000));

  it('the Sepolia production build, and a development build opted in, load the slot from its own lazy chunk, never the entry', async () => {
    for (const env of [{ SH_BUILD: 'production', SH_TARGET: 'sepolia' }, { SH_SEPOLIA_TRADE: '1' }] as Env[]) {
      const chunks = await buildSlot(env);
      const entry = chunks.filter((chunk) => chunk.isEntry);
      const slot = chunks.filter((chunk) => chunk.code.includes(TRADE_SLOT_MARKER));
      expect(entry, JSON.stringify(env)).toHaveLength(1);
      expect(slot).toHaveLength(1);
      const [door] = entry as [Rolldown.OutputChunk];
      const [lazy] = slot as [Rolldown.OutputChunk];
      expect([lazy.isEntry, lazy.isDynamicEntry]).toEqual([false, true]);
      // SH-ALPHA-TRADE-BOX: the slot is the buy/sell box now, so its chunk holds the trade folders' modules (the site's
      // and the chain package's), the slot among them; no other chunk holds one.
      expect(tradeModules(lazy)).toContain('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
      expect(tradeModules(lazy)).toContain('packages/chain/src/trade-sepolia/trade.ts');
      // SH-ALPHA-TEST-COINS: the test-coin page and its calls ride in the same chunk (the second door opens this module).
      expect(tradeModules(lazy)).toContain('apps/web/src/features/trade-sepolia/TestCoinPage.tsx');
      expect(tradeModules(lazy)).toContain('packages/chain/src/trade-sepolia/coins.ts');
      // SH-ALPHA-SITE (F161 (4)): the Claim card rides in the same chunk; Privy's bridge for the made wallet is the one
      // trade module elsewhere, in a chunk only the slot's chunk loads, lazily, in its turn (with Privy's SDK behind it).
      expect(tradeModules(lazy)).toContain('apps/web/src/features/trade-sepolia/ClaimCard.tsx');
      const bridge = chunks.filter((chunk) => chunk !== lazy && tradeModules(chunk).length > 0);
      expect(bridge.map(tradeModules), JSON.stringify(env)).toEqual([['apps/web/src/features/trade-sepolia/privy-live.tsx']]);
      const [privy] = bridge as [Rolldown.OutputChunk];
      expect([privy.isEntry, privy.isDynamicEntry]).toEqual([false, true]);
      expect(dynamicImports(lazy.code)).toContain(`./${privy.fileName.replace(/^.*\//, '')}`);
      expect(dynamicImports(door.code)).not.toContain(`./${privy.fileName.replace(/^.*\//, '')}`);
      // The entry names the chunk only in its dynamic import, and holds no trade module or marker itself.
      expect(door.moduleIds.filter((id) => TRADE_MODULE.test(id))).toEqual([]);
      expect(door.code).not.toContain(TRADE_SLOT_MARKER);
      expect(door.code).not.toContain('trade-sepolia');
      expect(dynamicImports(door.code)).toEqual([`./${lazy.fileName.replace(/^.*\//, '')}`]);
    }
  }, shLimit(60_000));

  it('SH-ALPHA-TEST-COINS: the second door’s exact line folds away on mainnet, and on Sepolia opens the slot’s one lazy chunk', async () => {
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'mainnet' }] as Env[]) {
      const chunks = await buildSlot(env, COIN_DOOR_ENTRY, coinDoorEntryPlugin);
      expect(chunks.map((chunk) => chunk.isEntry), JSON.stringify(env)).toEqual([true]);
      expect(chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => TRADE_MODULE.test(id))).toEqual([]);
      expect(chunks.filter((chunk) => chunk.code.includes(TRADE_SLOT_MARKER) || chunk.code.includes('trade-sepolia'))).toEqual([]);
      expect(dynamicImports(chunks[0]?.code ?? '')).toEqual([]);
    }
    const chunks = await buildSlot({ SH_BUILD: 'production', SH_TARGET: 'sepolia' }, COIN_DOOR_ENTRY, coinDoorEntryPlugin);
    // The door takes only `TestCoinPage` from the module, so this build alone tree-shakes the slot's marker away; in the
    // site the mount's door keeps the whole module, and check:production refuses a Sepolia build without the marker.
    // The door opens one chunk; past it only Privy's bridge for the made wallet (SH-ALPHA-SITE), lazily in its turn.
    const [entry] = chunks.filter((chunk) => chunk.isEntry) as [Rolldown.OutputChunk];
    const opened = dynamicImports(entry.code);
    expect(opened).toHaveLength(1);
    const lazy = chunks.find((chunk) => `./${chunk.fileName.replace(/^.*\//, '')}` === opened[0]) as Rolldown.OutputChunk;
    expect([lazy.isEntry, lazy.isDynamicEntry]).toEqual([false, true]);
    expect(tradeModules(lazy)).toContain('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(tradeModules(lazy)).toContain('apps/web/src/features/trade-sepolia/TestCoinPage.tsx');
    expect(chunks.filter((chunk) => chunk !== lazy).flatMap(tradeModules)).toEqual(['apps/web/src/features/trade-sepolia/privy-live.tsx']);
  }, shLimit(60_000));
});

/**
 * SH-ALPHA-ONBOARDING (F166): the fourth door's exact line, as AlphaWelcomeMount.tsx holds it (the doors pin checks that
 * it does), built on its own: a module of apps/web/src/shell, so its relative import resolves as the mount's does.
 */
const WELCOME_DOOR_ENTRY = join(WEB, 'src/shell/welcome-door-entry.virtual.tsx');
const welcomeDoorEntryPlugin: Plugin = {
  name: 'squarehole-welcome-door-entry',
  resolveId: (id) => (id === WELCOME_DOOR_ENTRY ? WELCOME_DOOR_ENTRY : null),
  load: (id) => (id === WELCOME_DOOR_ENTRY ? `import { lazy } from 'react';\n${WELCOME_DOOR_LINE}\nexport { AlphaWelcome };\n` : null),
};
/** The gate's line, built on its own beside the mount, as the door's is. */
const WELCOME_GATE_ENTRY = join(WEB, 'src/shell/welcome-gate-entry.virtual.tsx');
const welcomeGateEntryPlugin: Plugin = {
  name: 'squarehole-welcome-gate-entry',
  resolveId: (id) => (id === WELCOME_GATE_ENTRY ? WELCOME_GATE_ENTRY : null),
  load: (id) => (id === WELCOME_GATE_ENTRY ? `${WELCOME_GATE_LINE}\nexport { LOAD_GATE };\n` : null),
};

describe('the welcome step’s door through a real build (F166, SH-ALPHA-ONBOARDING)', () => {
  it('folds away on mainnet, and on Sepolia opens the slot’s one lazy chunk, which holds the setup; past it only Privy’s bridge', async () => {
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'mainnet' }] as Env[]) {
      const chunks = await buildSlot(env, WELCOME_DOOR_ENTRY, welcomeDoorEntryPlugin);
      expect(chunks.map((chunk) => chunk.isEntry), JSON.stringify(env)).toEqual([true]);
      expect(chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => TRADE_MODULE.test(id) || /[\\/]alpha-sepolia[\\/]/.test(id))).toEqual([]);
      expect(chunks.filter((chunk) => chunk.code.includes(TRADE_SLOT_MARKER) || chunk.code.includes('trade-sepolia') || chunk.code.includes('/alpha/'))).toEqual([]);
      expect(dynamicImports(chunks[0]?.code ?? '')).toEqual([]);
    }
    const chunks = await buildSlot({ SH_BUILD: 'production', SH_TARGET: 'sepolia' }, WELCOME_DOOR_ENTRY, welcomeDoorEntryPlugin);
    const [entry] = chunks.filter((chunk) => chunk.isEntry) as [Rolldown.OutputChunk];
    const opened = dynamicImports(entry.code);
    expect(opened).toHaveLength(1);
    expect(entry.moduleIds.filter((id) => TRADE_MODULE.test(id))).toEqual([]);
    const lazy = chunks.find((chunk) => `./${chunk.fileName.replace(/^.*\//, '')}` === opened[0]) as Rolldown.OutputChunk;
    expect([lazy.isEntry, lazy.isDynamicEntry]).toEqual([false, true]);
    for (const module of ['TradeSlot.tsx', 'AlphaWelcome.tsx', 'SetupPanel.tsx', 'setup-run.ts', 'faucet-due.ts']) {
      expect(tradeModules(lazy)).toContain(`apps/web/src/features/trade-sepolia/${module}`);
    }
    expect(tradeModules(lazy)).toContain('packages/chain/src/trade-sepolia/coins.ts');
    expect(chunks.filter((chunk) => chunk !== lazy).flatMap(tradeModules)).toEqual(['apps/web/src/features/trade-sepolia/privy-live.tsx']);
  }, shLimit(60_000));

  it('its gate folds away on mainnet, and on Sepolia is a lazy chunk of the alpha’s own: our server’s answer and the hint, no trade code', async () => {
    const ALPHA_MODULE = /[\\/]alpha-sepolia[\\/]/;
    for (const env of [{ SH_BUILD: 'production' }, { SH_BUILD: 'production', SH_TARGET: 'mainnet' }] as Env[]) {
      const chunks = await buildSlot(env, WELCOME_GATE_ENTRY, welcomeGateEntryPlugin);
      expect(chunks.map((chunk) => chunk.isEntry), JSON.stringify(env)).toEqual([true]);
      expect(chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => TRADE_MODULE.test(id) || ALPHA_MODULE.test(id))).toEqual([]);
      expect(chunks.filter((chunk) => chunk.code.includes('/alpha/') || chunk.code.includes('alpha-sepolia'))).toEqual([]);
      expect(dynamicImports(chunks[0]?.code ?? '')).toEqual([]);
    }
    const chunks = await buildSlot({ SH_BUILD: 'production', SH_TARGET: 'sepolia' }, WELCOME_GATE_ENTRY, welcomeGateEntryPlugin);
    const [entry] = chunks.filter((chunk) => chunk.isEntry) as [Rolldown.OutputChunk];
    const opened = dynamicImports(entry.code);
    expect(opened).toHaveLength(1);
    const gate = chunks.find((chunk) => `./${chunk.fileName.replace(/^.*\//, '')}` === opened[0]) as Rolldown.OutputChunk;
    expect([gate.isEntry, gate.isDynamicEntry]).toEqual([false, true]);
    const own = gate.moduleIds.filter((id) => ALPHA_MODULE.test(id)).map((id) => relative(ROOT, id).split(sep).join('/'));
    expect(own).toContain('apps/web/src/features/alpha-sepolia/welcome-gate.ts');
    expect(own).toContain('apps/web/src/features/alpha-sepolia/alpha-api.ts');
    expect(chunks.flatMap(tradeModules)).toEqual([]);
    expect(chunks.filter((chunk) => chunk.code.includes(TRADE_SLOT_MARKER) || chunk.code.includes('trade-sepolia'))).toEqual([]);
  }, shLimit(60_000));
});

describe('fix round af1, F2: a door the source pin would miss is in the module list', () => {
  it('the reviewer’s concatenated import, built for mainnet, ships the slot; the module list and the marker scan both catch it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-trade-concat-')));
    try {
      const entry = join(dir, 'leak.ts');
      const src = relative(dir, join(WEB, 'src')).split(sep).join('/');
      writeFileSync(entry, `export const leak = () => import(${JSON.stringify(`./${src}/features/`)} + "trade-sepolia/TradeSlot");\n`);
      const out = join(dir, 'dist');
      const env = { SH_BUILD: 'production' };
      const result = (await build({
        configFile: false,
        root: WEB,
        logLevel: 'silent',
        define: buildDefines(env, 'build'),
        // The site's deployments module, as vite.config.ts has it: the slot's trade box reads it (SH-ALPHA-TRADE-BOX).
        plugins: [react(), squareHoleDeployments(env)],
        build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry, preserveEntrySignatures: 'strict', treeshake: { moduleSideEffects: productionSideEffects } } },
      })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
      const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output)
        .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk').map((chunk) => ({ fileName: chunk.fileName, moduleIds: chunk.moduleIds }));
      const graph = loadGraph(out);
      const modules = judgeModules(chunks, 'mainnet', graph, out, 'modules');
      expect(modules.ok).toBe(false);
      expect(modules.lines.join('\n')).toMatch(/trade module assets\/TradeSlot-[\w-]+\.js ← apps\/web\/src\/features\/trade-sepolia\/TradeSlot\.tsx \(a mainnet build holds none\)/);
      expect(judgeTrade(scanDirectory(out, new Set(), TRADE_RULES), 'mainnet', graph).failing.map((finding) => finding.match)).toContain(TRADE_SLOT_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, shLimit(60_000));
});

// --- the trade folders' doors (F156; fix round af1, F2) ---------------------------------------------------------------

/** The modules the pin reads: every script and TypeScript kind. Declarations, tests and test support never ship. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = { '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX };
const NOT_SHIPPED_MODULE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test-support\//;

/** The trade folder a repository path is in: a directory named trade-sepolia under apps/web/src or packages/<name>/src. */
const tradeFolderOf = (rel: string): string | null => /^((?:apps\/web\/src|packages\/[^/]+\/src)\/(?:[^/]+\/)*?trade-sepolia)(?:\/|$)/.exec(rel)?.[1] ?? null;

interface Door {
  readonly from: string;
  readonly kind: 'static' | 'dynamic' | 'require';
  readonly specifier: string;
  readonly to: string;
}

/** The first door from outside the trade folders: the slot's mount, its dynamic import behind the switch. */
const DOOR: Door = { from: 'apps/web/src/features/core/v2/TradeSlotMount.tsx', kind: 'dynamic', specifier: '../../trade-sepolia/TradeSlot', to: 'apps/web/src/features/trade-sepolia/TradeSlot.tsx' };
/**
 * The second, added on purpose by SH-ALPHA-TEST-COINS (work package G phase 2): the test-coin page's route, its dynamic
 * import behind the same switch, into the same module as the slot's (so the trade code stays one lazy chunk).
 */
const COIN_DOOR: Door = { from: 'apps/web/src/routes.tsx', kind: 'dynamic', specifier: './features/trade-sepolia/TradeSlot', to: 'apps/web/src/features/trade-sepolia/TradeSlot.tsx' };
/**
 * The third, added on purpose by SH-ALPHA-SITE (F161 (4), work package L): the alpha's public join page, its dynamic
 * import of Privy's loader behind the same switch (features/trade-sepolia/privy-load.ts, never the trade box). The join
 * page is its own build (build/alpha-pages.ts), so its trade code is a lazy chunk of that build.
 */
const JOIN_DOOR: Door = { from: 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx', kind: 'dynamic', specifier: '../../trade-sepolia/privy-load', to: 'apps/web/src/features/trade-sepolia/privy-load.ts' };
/** The join page's door line, as JoinPage.tsx holds it. */
const JOIN_DOOR_LINE = "const LOAD_PRIVY = import.meta.env?.SH_SEPOLIA_TRADE === true ? (appId: string) => import('../../trade-sepolia/privy-load').then((module) => module.loadPrivyBridge(appId)) : null;";
/**
 * The fourth, added on purpose by SH-ALPHA-ONBOARDING (F166): the alpha's welcome step on the app's pages, the shell's
 * mount, its dynamic import behind the same switch, into the same module as the slot's and the route's (so the trade code
 * stays one lazy chunk).
 */
const WELCOME_DOOR: Door = { from: 'apps/web/src/shell/AlphaWelcomeMount.tsx', kind: 'dynamic', specifier: '../features/trade-sepolia/TradeSlot', to: 'apps/web/src/features/trade-sepolia/TradeSlot.tsx' };
/** The welcome step's door line, as AlphaWelcomeMount.tsx holds it. */
const WELCOME_DOOR_LINE = "const AlphaWelcome = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('../features/trade-sepolia/TradeSlot').then((module) => ({ default: module.AlphaWelcome }))) : null;";
/** Its gate's line, before the door (no trade code: our server's answer and the device's hint), behind the same literal. */
const WELCOME_GATE_LINE = "const LOAD_GATE = import.meta.env?.SH_SEPOLIA_TRADE === true ? () => import('../features/alpha-sepolia/welcome-gate') : null;";
/** Every door from outside the trade folders, and none besides. */
const DOORS: readonly Door[] = [DOOR, COIN_DOOR, JOIN_DOOR, WELCOME_DOOR];
const byFrom = (a: Door, b: Door) => a.from.localeCompare(b.from);

/** Where a module specifier leads: a dependency (outside this repository), an existing file, or nothing it can find. */
type Resolution = { readonly kind: 'dependency' } | { readonly kind: 'file'; readonly path: string } | { readonly kind: 'missing'; readonly path: string };

/** Node's order of `exports` pattern keys (PATTERN_KEY_COMPARE): the longer base up to the `*`, then the longer key. */
function patternKeyCompare(a: string, b: string): number {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const aBase = aStar === -1 ? a.length : aStar + 1;
  const bBase = bStar === -1 ? b.length : bStar + 1;
  if (aBase > bBase) return -1;
  if (bBase > aBase) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * An `exports` target as a path, when it is a string. A condition object or an array is not followed: which branch a
 * build takes depends on its conditions, so the specifier fails closed as unresolved (no workspace package has one).
 */
const targetPathOf = (target: unknown): string | null => (typeof target === 'string' ? target : null);

/**
 * A package's `exports` target for a subpath, as Node resolves it (fix round af3, F2): an exact key without `*`; else
 * the best pattern key by Node's order, where the subpath starts with its base, ends with its trailer and is at least
 * as long as the key; each `*` of the target then takes the matched part.
 */
function exportTarget(exports: Readonly<Record<string, unknown>>, key: string): string | null {
  if (!key.includes('*') && Object.hasOwn(exports, key)) return targetPathOf(exports[key]);
  let best = '';
  let matched = '';
  for (const pattern of Object.keys(exports)) {
    const star = pattern.indexOf('*');
    if (star === -1 || pattern.lastIndexOf('*') !== star) continue;
    const base = pattern.slice(0, star);
    const trailer = pattern.slice(star + 1);
    if (key.startsWith(base) && key.length >= pattern.length && key.endsWith(trailer) && patternKeyCompare(best, pattern) === 1) {
      best = pattern;
      matched = key.slice(star, key.length - trailer.length);
    }
  }
  const target = best === '' ? null : targetPathOf(exports[best]);
  return target === null ? null : target.split('*').join(matched);
}

/**
 * Vite's own two aliases (`clientAlias`, vite/dist/node/chunks/node.js:37153), exactly as every resolved config holds
 * them: the pattern's source and flags, the replacement (`/@fs/` and Vite's own client file) and no resolver of their
 * own. Fix round af4, F3: only these two entries pass, each once; any other entry fails, a lookalike of them included.
 */
const VITE_DIR = dirname(createRequire(join(WEB, 'package.json')).resolve('vite/package.json'));
const VITE_ALIASES: ReadonlyArray<{ readonly source: string; readonly replacement: string }> = [
  { source: '^\\/?@vite\\/env', replacement: posix.join('/@fs/', join(VITE_DIR, 'dist/client/env.mjs').split(sep).join('/')) },
  { source: '^\\/?@vite\\/client', replacement: posix.join('/@fs/', join(VITE_DIR, 'dist/client/client.mjs').split(sep).join('/')) },
];
const isViteAlias = (entry: Alias, own: (typeof VITE_ALIASES)[number]): boolean => entry.find instanceof RegExp && entry.find.source === own.source
  && entry.find.flags === '' && entry.replacement === own.replacement && entry.customResolver === undefined;

/** The entries of a resolved alias list that are not Vite's own two (each taken once), and either of those two missing. */
function userAliasEntriesOf(aliases: readonly Alias[]): { readonly entries: Alias[]; readonly missing: string[] } {
  const entries = [...aliases];
  const missing: string[] = [];
  for (const own of VITE_ALIASES) {
    const at = entries.findIndex((entry) => isViteAlias(entry, own));
    if (at === -1) missing.push(`Vite's own alias /${own.source}/ is missing or changed`);
    else entries.splice(at, 1);
  }
  return { entries, missing };
}

/**
 * The environments the config is resolved in: the unit tests' own (vite.config.ts `buildEnvOf` clears the build
 * variables under Vitest) and each production build that ships, as `pnpm check:production` builds it. A shipped build
 * never carries a shell's opt-ins (infra/server/app/build.mjs passes a closed environment), so they are blanked there.
 */
const SHIPPED = { VITEST: '', SH_BUILD: 'production', SH_ALLOW_PLACEHOLDERS: '1', SH_SEPOLIA_TRADE: '', SH_ARWEAVE_PICTURES: '' };
const CONFIG_ENVS: ReadonlyArray<Readonly<Record<string, string>>> = [{}, { ...SHIPPED, SH_TARGET: 'mainnet' }, { ...SHIPPED, SH_TARGET: 'sepolia' }];

/**
 * Fix round af3, F3: the aliases apps/web's Vite config resolves to (its own, its plugins', any spelling), loaded with
 * Vite's own `resolveConfig` (its `loadConfigFromFile`, then the plugins' `config` hooks, then its own two aliases) for
 * each environment above and both commands; Vite's built-in two left out. The doors pin does not follow aliases, so
 * any one fails it.
 */
async function viteAliasesOf(web: string): Promise<string[]> {
  const found = new Set<string>();
  for (const env of CONFIG_ENVS) {
    // Each environment's variables for its resolution only; the caller's own values (stubs included) come back after.
    const before = Object.keys(env).map((name) => [name, process.env[name]] as const);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try {
      for (const command of ['build', 'serve'] as const) {
        const config = await resolveConfig({ root: web, configFile: join(web, 'vite.config.ts'), logLevel: 'silent' }, command, env.SH_BUILD === 'production' ? 'production' : 'development');
        const { entries, missing } = userAliasEntriesOf(config.resolve.alias);
        for (const line of [...missing, ...entries.map((entry) => String(entry.find))]) found.add(line);
      }
    } finally {
      for (const [name, value] of before) vi.stubEnv(name, value);
    }
  }
  return [...found];
}

/**
 * Every module edge into a trade folder across apps/web/src and packages/<name>/src, resolved as the site's build
 * resolves it: relative paths to their file (any extension, index files, a `.js` naming a `.ts`, a query cut off),
 * root-absolute paths from Vite's root (apps/web), workspace names through the package's `exports` (exact keys and `*`
 * patterns) or `main`. Fix round af2, F3: an internal specifier the pin cannot resolve fails closed, and so does any
 * tsconfig `paths` or Vite alias (the pin does not follow them; none exist). Allowed: an edge between two trade folders
 * (never from a package's into the site's), and `DOORS`. Refused besides: an `import()`, `require()` or
 * `import.meta.glob` whose path is not one plain string (fix round af2, F4: no file is exempt), and a trade folder's
 * name in any other text of a module outside the folders, an unresolved specifier's included. Type-only imports are
 * erased, so they open no door, but they must still resolve.
 */
function scanDoors(root: string): { readonly files: number; readonly edges: number; readonly doors: Door[]; readonly violations: string[] } {
  const packageDirs = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, 'packages', entry.name));
  const roots = [join(root, 'apps/web/src'), ...packageDirs.map((dir) => join(dir, 'src')).filter((dir) => existsSync(dir))];
  const packages = new Map<string, { readonly dir: string; readonly exports: Readonly<Record<string, unknown>> | null; readonly main: string | null }>();
  /** Fix round af4, F2: workspace package.json files with a `browser` field, which Vite follows and this pin does not. */
  const browserFields: string[] = [];
  for (const dir of [join(root, 'apps/web'), ...packageDirs]) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; exports?: unknown; main?: string; browser?: unknown };
    if (Object.hasOwn(json, 'browser')) browserFields.push(relative(root, join(dir, 'package.json')).split(sep).join('/'));
    if (dir === join(root, 'apps/web')) continue;
    const exports = typeof json.exports === 'string' ? { '.': json.exports } : typeof json.exports === 'object' && json.exports !== null ? json.exports as Record<string, unknown> : null;
    if (json.name) packages.set(json.name, { dir, exports, main: json.main ?? null });
  }
  const repo = (path: string) => relative(root, path).split(sep).join('/');
  const fileAt = (base: string): Resolution => {
    const named = /\.[mc]?jsx?$/.test(base) ? ['.ts', '.tsx', '.mts', '.cts'].map((ext) => base.replace(/\.[mc]?jsx?$/, ext)) : [];
    const candidates = [base, ...[...MODULE_EXTENSIONS, '.json'].map((ext) => `${base}${ext}`), ...named, ...MODULE_EXTENSIONS.map((ext) => join(base, `index${ext}`))];
    const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    return found === undefined ? { kind: 'missing', path: base } : { kind: 'file', path: found };
  };
  const resolved = (from: string, specifier: string): Resolution => {
    // A package's subpath import (`#name`, package.json `imports`) is internal and not followed: it fails closed (no
    // package has `imports` today). Checked before a query or hash is cut off, which would leave nothing of it.
    if (specifier.startsWith('#')) return { kind: 'missing', path: join(root, specifier) };
    const clean = specifier.replace(/[?#].*$/, '');
    if (clean === '.' || clean === '..' || clean.startsWith('./') || clean.startsWith('../')) return fileAt(resolve(dirname(from), clean));
    // Vite serves and builds a root-absolute path from its root, apps/web, whichever module asks.
    if (clean.startsWith('/')) return fileAt(join(root, 'apps/web', clean));
    const name = [...packages.keys()].filter((key) => clean === key || clean.startsWith(`${key}/`)).sort((a, b) => b.length - a.length)[0];
    const found = name === undefined ? undefined : packages.get(name);
    if (name === undefined || found === undefined) return clean.startsWith('@squarehole/') ? { kind: 'missing', path: clean } : { kind: 'dependency' };
    const sub = clean.slice(name.length);
    const target = found.exports === null ? (sub === '' ? found.main ?? 'src/index.ts' : sub.slice(1)) : exportTarget(found.exports, `.${sub}`);
    return target === null ? { kind: 'missing', path: join(found.dir, sub) } : fileAt(resolve(found.dir, target));
  };
  const doors: Door[] = [];
  // A `browser` field remaps a package's files for a client build (`{"./src/safe.ts": "./src/trade-sepolia/guard.ts"}`):
  // the pin does not follow it, so any one fails it (none exists).
  const violations: string[] = browserFields.map((file) => `${file}: a "browser" field, which this pin does not follow`);
  // tsconfig `paths` would resolve names this pin does not follow: refuse them outright (none exist). Vite aliases are
  // read from the resolved config (`viteAliasesOf`).
  for (const dir of [root, join(root, 'apps/web'), ...packageDirs]) {
    for (const name of existsSync(dir) ? readdirSync(dir).filter((entry) => /^tsconfig.*\.json$/.test(entry)) : []) {
      const parsed = ts.parseConfigFileTextToJson(join(dir, name), readFileSync(join(dir, name), 'utf8'));
      const paths = (parsed.config as { compilerOptions?: { paths?: unknown } } | undefined)?.compilerOptions?.paths;
      if (parsed.error !== undefined || paths !== undefined) violations.push(`${repo(join(dir, name))}: ${parsed.error === undefined ? 'tsconfig paths, which this pin does not resolve' : 'a tsconfig this pin cannot read'}`);
    }
  }
  let files = 0;
  let edges = 0;
  for (const top of roots) {
    for (const name of readdirSync(top, { recursive: true }) as string[]) {
      const path = join(top, name);
      const rel = repo(path);
      const kind = SCRIPT_KINDS[extname(path)];
      if (kind === undefined || NOT_SHIPPED_MODULE.test(rel) || !statSync(path).isFile()) continue;
      files += 1;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind);
      const fromFolder = tradeFolderOf(rel);
      const at = (node: ts.Node) => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
      /** Specifiers resolved to a file: only those leave the trade-folder text check below. */
      const handled = new Set<ts.Node>();
      const edge = (node: ts.Node, how: Door['kind'], literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, typeOnly = false) => {
        const target = resolved(path, literal.text);
        if (target.kind === 'dependency') return;
        if (target.kind === 'missing') {
          violations.push(`${at(node)}: ${how} ${literal.text} cannot be resolved (${repo(target.path)})`);
          return;
        }
        handled.add(literal);
        edges += 1;
        const to = repo(target.path);
        if (typeOnly || tradeFolderOf(to) === null) return;
        if (fromFolder !== null && !(fromFolder.startsWith('packages/') && to.startsWith('apps/'))) return;
        const door: Door = { from: rel, kind: how, specifier: literal.text, to };
        if (DOORS.some((allowed) => JSON.stringify(door) === JSON.stringify(allowed))) doors.push(door);
        else violations.push(`${at(node)}: ${how} ${literal.text} reaches ${to}`);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) edge(node, 'static', node.moduleSpecifier, node.importClause?.isTypeOnly === true);
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) edge(node, 'static', node.moduleSpecifier, node.isTypeOnly);
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) edge(node, 'static', node.moduleReference.expression, node.isTypeOnly);
        else if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const how = callee.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic' : ts.isIdentifier(callee) && callee.text === 'require' ? 'require'
            : ts.isPropertyAccessExpression(callee) && ts.isMetaProperty(callee.expression) && callee.name.text.startsWith('glob') ? 'glob' : null;
          const [argument] = node.arguments;
          if (how === 'dynamic' || how === 'require') {
            if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) edge(node, how, argument);
            else violations.push(`${at(node)}: ${how === 'dynamic' ? 'import()' : 'require()'} with a computed path: ${node.getText(source).slice(0, 100)}`);
          } else if (how === 'glob') violations.push(`${at(node)}: import.meta.glob opens computed paths: ${node.getText(source).slice(0, 100)}`);
        }
        if (fromFolder === null && !handled.has(node) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes('trade-sepolia')) {
          violations.push(`${at(node)}: names a trade folder in its text: ${JSON.stringify(node.text)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return { files, edges, doors, violations };
}

describe('the trade folders’ doors (F156; fix round af1, F2)', () => {
  it('the site and every package: four doors from outside, the slot’s mount, the test-coin route, the join page’s Privy loader and the welcome step’s mount, no computed module path and no Vite alias', async () => {
    // A shell's opt-ins (the trade switch, Arweave pictures) change nothing: the unit tests and the shipped builds drop them.
    vi.stubEnv('SH_SEPOLIA_TRADE', '1');
    vi.stubEnv('SH_ARWEAVE_PICTURES', '1');
    try {
      expect(await viteAliasesOf(WEB)).toEqual([]);
      expect([process.env.SH_SEPOLIA_TRADE, process.env.SH_ARWEAVE_PICTURES]).toEqual(['1', '1']);
    } finally {
      vi.unstubAllEnvs();
    }
    const scan = scanDoors(ROOT);
    // 832 shipped modules at fix round af1 (tests, test support and declarations do not ship), and every one of their
    // internal specifiers resolved to a file (fix round af2: one that does not fails the pin).
    expect(scan.files).toBeGreaterThan(700);
    expect(scan.edges).toBeGreaterThan(2000);
    expect(scan.violations).toEqual([]);
    expect([...scan.doors].sort(byFrom)).toEqual([...DOORS].sort(byFrom));
    const mount = readFileSync(join(WEB, 'src/features/core/v2/TradeSlotMount.tsx'), 'utf8');
    expect(mount).toContain("const TradeSlot = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('../../trade-sepolia/TradeSlot')) : null;");
    // SH-ALPHA-TEST-COINS: the second door, behind the same build literal, and its route only when the door is open.
    const routes = readFileSync(join(WEB, 'src/routes.tsx'), 'utf8');
    expect(routes).toContain(COIN_DOOR_LINE);
    expect(routes).toContain("{TestCoinPage ? <Route path=\"test-coins\" element={lazyRoute(TestCoinPage, 'the test coins', {})} /> : null}");
    // SH-ALPHA-SITE: the third door, behind the same literal.
    expect(readFileSync(join(WEB, 'src/features/alpha-sepolia/join/JoinPage.tsx'), 'utf8')).toContain(JOIN_DOOR_LINE);
    // SH-ALPHA-ONBOARDING (F166): the fourth door, behind the same literal, and the shell renders its mount above every page.
    expect(readFileSync(join(WEB, 'src/shell/AlphaWelcomeMount.tsx'), 'utf8')).toContain(WELCOME_DOOR_LINE);
    expect(readFileSync(join(WEB, 'src/shell/AlphaWelcomeMount.tsx'), 'utf8')).toContain(WELCOME_GATE_LINE);
    expect(readFileSync(join(WEB, 'src/shell/Shell.tsx'), 'utf8')).toContain('<AlphaWelcomeMount />\n        <Outlet />');
  });

  /** A small repository: the site's slot and mount, a package with a trade folder and an export of it, an executor. */
  const BASE: Readonly<Record<string, string>> = {
    'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/index.ts', './trade-sepolia': './src/trade-sepolia/index.ts' } }),
    'packages/chain/src/index.ts': 'export const chain = 1;\n',
    'packages/chain/src/write/executor.ts': "import { chain } from '../index';\nexport const send = chain;\n",
    'packages/chain/src/trade-sepolia/index.ts': "export * from './guard';\n",
    'packages/chain/src/trade-sepolia/guard.ts': "import { chain } from '../index';\nexport const guard = chain;\n",
    'apps/web/src/main.tsx': "import { TradeSlot } from './features/core/v2/TradeSlotMount';\nexport { TradeSlot };\n",
    'apps/web/src/features/core/v2/TradeSlotMount.tsx': "import { lazy } from 'react';\nimport type { Props } from '../../trade-sepolia/props';\nexport type { Props };\nexport const TradeSlot = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('../../trade-sepolia/TradeSlot')) : null;\n",
    'apps/web/src/features/trade-sepolia/props.ts': 'export interface Props { readonly x: number }\n',
    'apps/web/src/features/trade-sepolia/TradeSlot.tsx': "import { guard } from '@squarehole/chain/trade-sepolia';\nimport { send } from '../../../../../packages/chain/src/write/executor';\nexport default function TradeSlot() { return guard + send; }\n",
    'apps/web/src/features/trade-sepolia/TradeSlot.test.ts': "import TradeSlot from './TradeSlot';\nimport { guard } from '../../../../../packages/chain/src/trade-sepolia/guard';\nexport { TradeSlot, guard };\n",
    'apps/web/src/pages/trade-sepolia/TestCoinPage.tsx': "import TradeSlot from '../../features/trade-sepolia/TradeSlot';\nexport default TradeSlot;\n",
    'apps/web/src/slot.test.ts': "import TradeSlot from './features/trade-sepolia/TradeSlot';\nexport { TradeSlot };\n",
  };

  function repoWith(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'sh-trade-doors-'));
    for (const [name, text] of Object.entries({ ...BASE, ...files })) {
      mkdirSync(join(root, dirname(name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return root;
  }

  it('a fixture with the allowed edges only passes: the door, a web trade folder to a package one, folder to folder, type-only and test imports', () => {
    const root = repoWith({});
    try {
      const scan = scanDoors(root);
      expect(scan.violations).toEqual([]);
      expect(scan.doors).toEqual([DOOR]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SH-ALPHA-SITE: the join page’s door passes only as itself: from JoinPage.tsx, a dynamic import of Privy’s loader', () => {
    const door = "export const LOAD = import.meta.env?.SH_SEPOLIA_TRADE === true ? () => import('../../trade-sepolia/privy-load') : null;\n";
    const files = { 'apps/web/src/features/trade-sepolia/privy-load.ts': 'export const loadPrivyBridge = () => null;\n' };
    const open = repoWith({ ...files, 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx': door });
    try {
      const scan = scanDoors(open);
      expect(scan.violations).toEqual([]);
      expect([...scan.doors].sort(byFrom)).toEqual([DOOR, JOIN_DOOR].sort(byFrom));
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
    // The same import from the desk, or a static one from the join page: refused.
    for (const [extra, violation] of [
      [{ 'apps/web/src/features/alpha-sepolia/desk/DeskPage.tsx': door }, 'apps/web/src/features/alpha-sepolia/desk/DeskPage.tsx:1: dynamic ../../trade-sepolia/privy-load reaches apps/web/src/features/trade-sepolia/privy-load.ts'],
      [{ 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx': "import { loadPrivyBridge } from '../../trade-sepolia/privy-load';\nexport { loadPrivyBridge };\n" }, 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx:1: static ../../trade-sepolia/privy-load reaches apps/web/src/features/trade-sepolia/privy-load.ts'],
    ] as const) {
      const root = repoWith({ ...files, ...extra });
      try {
        expect(scanDoors(root).violations, violation).toContain(violation);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('SH-ALPHA-TEST-COINS: the second door passes only as itself: from the route file, a dynamic import of the slot’s module', () => {
    const door = "import { lazy } from 'react';\nexport const TestCoinPage = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('./features/trade-sepolia/TradeSlot').then((module) => ({ default: module.TestCoinPage }))) : null;\n";
    const open = repoWith({ 'apps/web/src/routes.tsx': door });
    try {
      const scan = scanDoors(open);
      expect(scan.violations).toEqual([]);
      expect([...scan.doors].sort(byFrom)).toEqual([DOOR, COIN_DOOR].sort(byFrom));
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
    // The same import from another file, a static import from the route file, or the route into another module: refused.
    const refused: ReadonlyArray<readonly [Readonly<Record<string, string>>, string]> = [
      [{ 'apps/web/src/other.tsx': door }, 'apps/web/src/other.tsx:2: dynamic ./features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx'],
      [{ 'apps/web/src/routes.tsx': "import TradeSlot from './features/trade-sepolia/TradeSlot';\nexport { TradeSlot };\n" }, 'apps/web/src/routes.tsx:1: static ./features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx'],
      [{ 'apps/web/src/routes.tsx': "export const Page = () => import('./features/trade-sepolia/props');\n" }, 'apps/web/src/routes.tsx:1: dynamic ./features/trade-sepolia/props reaches apps/web/src/features/trade-sepolia/props.ts'],
    ];
    for (const [files, violation] of refused) {
      const root = repoWith(files);
      try {
        expect(scanDoors(root).violations).toEqual([violation]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('SH-ALPHA-ONBOARDING: the fourth door passes only as itself: from the shell’s welcome mount, a dynamic import of the slot’s module', () => {
    const door = `import { lazy } from 'react';\nexport ${WELCOME_DOOR_LINE}\n`;
    const open = repoWith({ 'apps/web/src/shell/AlphaWelcomeMount.tsx': door });
    try {
      const scan = scanDoors(open);
      expect(scan.violations).toEqual([]);
      expect([...scan.doors].sort(byFrom)).toEqual([DOOR, WELCOME_DOOR].sort(byFrom));
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
    // The same import from the shell itself, a static import from the mount, or the mount into another module: refused.
    const refused: ReadonlyArray<readonly [Readonly<Record<string, string>>, string]> = [
      [{ 'apps/web/src/shell/Shell.tsx': door }, 'apps/web/src/shell/Shell.tsx:2: dynamic ../features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx'],
      [{ 'apps/web/src/shell/AlphaWelcomeMount.tsx': "import TradeSlot from '../features/trade-sepolia/TradeSlot';\nexport { TradeSlot };\n" }, 'apps/web/src/shell/AlphaWelcomeMount.tsx:1: static ../features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx'],
      [{ 'apps/web/src/shell/AlphaWelcomeMount.tsx': "export const Step = () => import('../features/trade-sepolia/props');\n" }, 'apps/web/src/shell/AlphaWelcomeMount.tsx:1: dynamic ../features/trade-sepolia/props reaches apps/web/src/features/trade-sepolia/props.ts'],
    ];
    for (const [files, violation] of refused) {
      const root = repoWith(files);
      try {
        expect(scanDoors(root).violations).toEqual([violation]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  const LEAKS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>, readonly string[]]> = [
    ['the reviewer’s concatenation', { 'apps/web/src/leak.ts': 'export const leak = () => import("./features/" + "trade-sepolia/TradeSlot");\n' },
      ['apps/web/src/leak.ts:1: import() with a computed path: import("./features/" + "trade-sepolia/TradeSlot")', 'apps/web/src/leak.ts:1: names a trade folder in its text: "trade-sepolia/TradeSlot"']],
    ['a .js importer', { 'apps/web/src/leak.js': "import TradeSlot from './features/trade-sepolia/TradeSlot';\nexport { TradeSlot };\n" },
      ['apps/web/src/leak.js:1: static ./features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx']],
    ['an .mjs dynamic import', { 'apps/web/src/leak.mjs': "export const leak = () => import('./features/trade-sepolia/TradeSlot.tsx');\n" },
      ['apps/web/src/leak.mjs:1: dynamic ./features/trade-sepolia/TradeSlot.tsx reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx']],
    ['a package re-export', { 'packages/chain/src/index.ts': "export const chain = 1;\nexport * from './trade-sepolia';\n" },
      ['packages/chain/src/index.ts:2: static ./trade-sepolia reaches packages/chain/src/trade-sepolia/index.ts']],
    ['the executor importing the package trade folder', { 'packages/chain/src/executor.ts': "import { guard } from './trade-sepolia/guard';\nexport const send = guard;\n" },
      ['packages/chain/src/executor.ts:1: static ./trade-sepolia/guard reaches packages/chain/src/trade-sepolia/guard.ts']],
    ['a workspace name from the site', { 'apps/web/src/quote.ts': "export { guard } from '@squarehole/chain/trade-sepolia';\n" },
      ['apps/web/src/quote.ts:1: static @squarehole/chain/trade-sepolia reaches packages/chain/src/trade-sepolia/index.ts']],
    ['a workspace subpath that names no trade folder', {
      'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/index.ts', './trade-sepolia': './src/trade-sepolia/index.ts', './orders': './src/trade-sepolia/index.ts' } }),
      'apps/web/src/orders.ts': "export { guard } from '@squarehole/chain/orders';\n",
    }, ['apps/web/src/orders.ts:1: static @squarehole/chain/orders reaches packages/chain/src/trade-sepolia/index.ts']],
    // Fix round af2, F3: forms a real Vite build resolves into a trade folder, and what the pin cannot resolve.
    ['a root-absolute import, from Vite’s root', { 'apps/web/src/root.ts': 'export { default } from "/src/features/trade-sepolia/TradeSlot";\n' },
      ['apps/web/src/root.ts:1: static /src/features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx']],
    ['a wildcard workspace export', {
      'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/index.ts', './trade-sepolia': './src/trade-sepolia/index.ts', './orders/*': './src/trade-sepolia/*.ts' } }),
      'apps/web/src/orders.ts': "export { guard } from '@squarehole/chain/orders/guard';\n",
    }, ['apps/web/src/orders.ts:1: static @squarehole/chain/orders/guard reaches packages/chain/src/trade-sepolia/guard.ts']],
    // Fix round af3, F2: two patterns that both match; Node (and Vite) take the longer key on a tie of bases.
    ['overlapping export patterns, as Node orders them', {
      'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/index.ts', './trade-sepolia': './src/trade-sepolia/index.ts', './orders/*': './src/safe.ts', './orders/*.js': './src/trade-sepolia/*.ts' } }),
      'packages/chain/src/safe.ts': 'export const guard = 0;\n',
      'apps/web/src/orders.ts': "export { guard } from '@squarehole/chain/orders/guard.js';\n",
    }, ['apps/web/src/orders.ts:1: static @squarehole/chain/orders/guard.js reaches packages/chain/src/trade-sepolia/guard.ts']],
    ['a condition-object export, which the pin does not follow', {
      'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/index.ts', './trade-sepolia': './src/trade-sepolia/index.ts', './orders': { import: './src/trade-sepolia/index.ts', default: './src/safe.ts' } } }),
      'apps/web/src/orders.ts': "export { guard } from '@squarehole/chain/orders';\n",
    }, ['apps/web/src/orders.ts:1: static @squarehole/chain/orders cannot be resolved (packages/chain/orders)']],
    ['a package subpath import, which the pin does not follow', { 'apps/web/src/hash.ts': "export * from '#orders';\n" },
      ['apps/web/src/hash.ts:1: static #orders cannot be resolved (#orders)']],
    // Fix round af4, F2: the reviewer's browser mapping, which makes Vite bundle the trade file behind a safe export.
    ['a workspace package’s "browser" field', {
      'packages/chain/package.json': JSON.stringify({ name: '@squarehole/chain', exports: { '.': './src/safe.ts', './trade-sepolia': './src/trade-sepolia/index.ts' }, browser: { './src/safe.ts': './src/trade-sepolia/guard.ts' } }),
      'packages/chain/src/safe.ts': 'export const guard = 0;\n',
      'apps/web/src/orders.ts': "export { guard } from '@squarehole/chain';\n",
    }, ['packages/chain/package.json: a "browser" field, which this pin does not follow']],
    ['the site’s own "browser" field', { 'apps/web/package.json': JSON.stringify({ name: '@squarehole/web', browser: { './src/main.tsx': './src/features/trade-sepolia/TradeSlot.tsx' } }) },
      ['apps/web/package.json: a "browser" field, which this pin does not follow']],
    ['an unresolved specifier that spells a trade folder', { 'apps/web/src/missing.ts': "import './features/trade-sepolia/Missing';\n" },
      ['apps/web/src/missing.ts:1: static ./features/trade-sepolia/Missing cannot be resolved (apps/web/src/features/trade-sepolia/Missing)', 'apps/web/src/missing.ts:1: names a trade folder in its text: "./features/trade-sepolia/Missing"']],
    ['a dependency’s name that spells a trade folder', { 'apps/web/src/kit.ts': "export { x } from 'trade-sepolia-kit';\n" },
      ['apps/web/src/kit.ts:1: names a trade folder in its text: "trade-sepolia-kit"']],
    ['a workspace subpath the package does not export', { 'apps/web/src/nope.ts': "export * from '@squarehole/chain/nope';\n" },
      ['apps/web/src/nope.ts:1: static @squarehole/chain/nope cannot be resolved (packages/chain/nope)']],
    ['tsconfig paths', { 'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@trade/*': ['src/features/trade-sepolia/*'] } } }) },
      ['apps/web/tsconfig.json: tsconfig paths, which this pin does not resolve']],
    // Fix round af2, F4: no file is exempt; a real createRequire in discovery.ts loads the guard by a computed name.
    ['a computed require from createRequire in discovery.ts', {
      'packages/indexer/package.json': JSON.stringify({ name: '@squarehole/indexer', exports: { '.': './src/index.ts' } }),
      'packages/indexer/src/core/set-v2/discovery.ts': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const guard = require(\"@squarehole/chain/\" + \"orders\");\n",
    }, ['packages/indexer/src/core/set-v2/discovery.ts:3: require() with a computed path: require("@squarehole/chain/" + "orders")']],
    ['a computed require', { 'apps/web/src/r.cjs': "const name = 'x';\nmodule.exports = require(name);\n" },
      ['apps/web/src/r.cjs:2: require() with a computed path: require(name)']],
    ['a glob', { 'apps/web/src/g.ts': "export const all = import.meta.glob('./features/*/*.tsx');\n" },
      ["apps/web/src/g.ts:1: import.meta.glob opens computed paths: import.meta.glob('./features/*/*.tsx')"]],
    ['a worker named by its path', { 'apps/web/src/w.ts': "export const worker = new URL('./features/trade-sepolia/worker.ts', import.meta.url);\n" },
      ['apps/web/src/w.ts:1: names a trade folder in its text: "./features/trade-sepolia/worker.ts"']],
    ['a package trade folder reaching into the site', { 'packages/chain/src/trade-sepolia/back.ts': "import TradeSlot from '../../../../apps/web/src/features/trade-sepolia/TradeSlot';\nexport { TradeSlot };\n" },
      ['packages/chain/src/trade-sepolia/back.ts:1: static ../../../../apps/web/src/features/trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx']],
    ['a second, static door in the mount', { 'apps/web/src/features/core/v2/TradeSlotMount.tsx': `${BASE['apps/web/src/features/core/v2/TradeSlotMount.tsx'] ?? ''}import Static from '../../trade-sepolia/TradeSlot';\nexport { Static };\n` },
      ['apps/web/src/features/core/v2/TradeSlotMount.tsx:5: static ../../trade-sepolia/TradeSlot reaches apps/web/src/features/trade-sepolia/TradeSlot.tsx']],
  ];

  for (const [name, files, expected] of LEAKS) {
    it(`refuses ${name}`, () => {
      const root = repoWith(files);
      try {
        expect(scanDoors(root).violations).toEqual(expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('fix round af3, F2: overlapping export patterns, as Vite’s own resolver picks them', () => {
  // The reviewer's exports; the pin's choice for each subpath must be the file a real Vite build bundles.
  const EXPORTS = { '.': './src/index.ts', './orders/*': './src/safe.ts', './orders/*.js': './src/trade-sepolia/*.ts' };
  for (const [subpath, expected] of [['orders/guard.js', './src/trade-sepolia/guard.ts'], ['orders/guard', './src/safe.ts']] as const) {
    it(`@fixture/chain/${subpath} is ${expected}, for the pin and for Vite`, async () => {
      expect(exportTarget(EXPORTS, `./${subpath}`)).toBe(expected);
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-trade-exports-')));
      try {
        const pkg = join(dir, 'node_modules', '@fixture', 'chain');
        mkdirSync(join(pkg, 'src', 'trade-sepolia'), { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/chain', type: 'module', exports: EXPORTS }));
        writeFileSync(join(pkg, 'src', 'index.ts'), 'export const index = 0;\n');
        writeFileSync(join(pkg, 'src', 'safe.ts'), "export const guard: string = 'safe';\n");
        writeFileSync(join(pkg, 'src', 'trade-sepolia', 'guard.ts'), "export const guard: string = 'trade';\n");
        writeFileSync(join(dir, 'main.ts'), `import { guard } from '@fixture/chain/${subpath}';\nexport default guard;\n`);
        const result = (await build({
          configFile: false,
          root: dir,
          logLevel: 'silent',
          build: { outDir: join(dir, 'dist'), emptyOutDir: true, minify: false, rolldownOptions: { input: join(dir, 'main.ts'), preserveEntrySignatures: 'strict' } },
        })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
        const ids = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output)
          .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk').flatMap((chunk) => chunk.moduleIds);
        expect(ids.map((id) => relative(pkg, id).split(sep).join('/')).filter((id) => id.startsWith('src/'))).toEqual([expected.slice(2)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, shLimit(60_000));
  }
});

describe('fix round af4, F2: a package’s "browser" field, which Vite follows in a client build', () => {
  it('the reviewer’s mapping: Vite bundles the trade file behind the safe export, so the pin refuses the field', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-trade-browser-')));
    try {
      const pkg = join(dir, 'node_modules', '@fixture', 'chain');
      mkdirSync(join(pkg, 'src', 'trade-sepolia'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/chain', type: 'module', exports: { '.': './src/safe.ts' }, browser: { './src/safe.ts': './src/trade-sepolia/guard.ts' } }));
      writeFileSync(join(pkg, 'src', 'safe.ts'), "export const guard: string = 'safe';\n");
      writeFileSync(join(pkg, 'src', 'trade-sepolia', 'guard.ts'), "export const guard: string = 'trade';\n");
      writeFileSync(join(dir, 'main.ts'), "import { guard } from '@fixture/chain';\nexport default guard;\n");
      const result = (await build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        build: { outDir: join(dir, 'dist'), emptyOutDir: true, minify: false, rolldownOptions: { input: join(dir, 'main.ts'), preserveEntrySignatures: 'strict' } },
      })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
      const ids = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output)
        .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk').flatMap((chunk) => chunk.moduleIds);
      expect(ids.map((id) => relative(pkg, id).split(sep).join('/')).filter((id) => id.startsWith('src/'))).toEqual(['src/trade-sepolia/guard.ts']);
      // The pin reads the export alone (safe.ts): it cannot see the remap, so the field itself fails it.
      expect(exportTarget({ '.': './src/safe.ts' }, '.')).toBe('./src/safe.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, shLimit(60_000));
});

describe('fix round af3, F3: a Vite alias in any spelling fails the doors pin', () => {
  it('fix round af4, F3: only Vite’s own two pass, each once and exactly; a lookalike by flags, replacement, resolver or kind does not', () => {
    const own: Alias[] = VITE_ALIASES.map((alias) => ({ find: new RegExp(alias.source), replacement: alias.replacement }));
    expect(userAliasEntriesOf(own)).toEqual({ entries: [], missing: [] });
    const env = VITE_ALIASES[0] as (typeof VITE_ALIASES)[number];
    const lookalikes: Alias[] = [
      { find: new RegExp(env.source, 'i'), replacement: env.replacement },
      { find: new RegExp(env.source), replacement: '/src/features/trade-sepolia/TradeSlot.tsx' },
      { find: new RegExp(env.source), replacement: env.replacement, customResolver: () => null },
      { find: env.source, replacement: env.replacement },
    ];
    // Vite puts the site's aliases before its own (`mergeAlias`), so each lookalike comes first, where it would win.
    for (const lookalike of lookalikes) expect(userAliasEntriesOf([lookalike, ...own]), String(lookalike.find)).toEqual({ entries: [lookalike], missing: [] });
    // One of Vite's own missing, and a second copy of one.
    expect(userAliasEntriesOf([own[1] as Alias]).missing).toEqual([`Vite's own alias /${env.source}/ is missing or changed`]);
    expect(userAliasEntriesOf([...own, own[0] as Alias]).entries).toEqual([own[0]]);
  });

  const CONFIGS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>, readonly string[]]> = [
    ['no alias', { 'vite.config.ts': 'export default {};\n' }, []],
    ['a quoted key', { 'vite.config.ts': 'export default { resolve: { "alias": { "@orders": "./src/features/trade-sepolia" } } };\n' }, ['@orders']],
    ['a shorthand', { 'vite.config.ts': 'const alias = { "@orders": "./src/features/trade-sepolia" };\nexport default { resolve: { alias } };\n' }, ['@orders']],
    ['an imported alias', { 'vite.config.ts': "import { alias } from './aliases';\nexport default { resolve: { alias } };\n", 'aliases.ts': "export const alias = [{ find: '@orders', replacement: './src/features/trade-sepolia' }];\n" }, ['@orders']],
    ['a config function', { 'vite.config.ts': 'export default () => ({ resolve: { alias: [{ find: /^@trade\\//, replacement: "/src/features/trade-sepolia/" }] } });\n' }, ['/^@trade\\//']],
    ['a plugin’s alias', { 'vite.config.ts': "export default { plugins: [{ name: 'adds-an-alias', config: () => ({ resolve: { alias: { '@p': '/src/features/trade-sepolia' } } }) }] };\n" }, ['@p']],
    ['an alias in the production build only', { 'vite.config.ts': "export default { resolve: { alias: process.env.SH_BUILD === 'production' && !process.env.VITEST ? { '@ship': '/src/features/trade-sepolia' } : {} } };\n" }, ['@ship']],
    // Fix round af4, F3: lookalikes of Vite's own two, the reviewer's case-insensitive one and one with the same pattern.
    ['a case-insensitive lookalike of a Vite alias', { 'vite.config.ts': "export default { resolve: { alias: [{ find: /^\\/?@vite\\/env/i, replacement: '/src/features/trade-sepolia/TradeSlot.tsx' }] } };\n" }, ['/^\\/?@vite\\/env/i']],
    ['a lookalike with the same pattern', { 'vite.config.ts': "export default { resolve: { alias: [{ find: /^\\/?@vite\\/env/, replacement: '/src/features/trade-sepolia/TradeSlot.tsx' }] } };\n" }, ['/^\\/?@vite\\/env/']],
    ['an alias in the Sepolia build only', { 'vite.config.ts': "export default ({ command }) => ({ resolve: { alias: command === 'build' && process.env.SH_TARGET === 'sepolia' ? [{ find: '@test-site', replacement: '/src/features/trade-sepolia' }] : [] } });\n" }, ['@test-site']],
  ];
  for (const [name, files, expected] of CONFIGS) {
    it(`${expected.length === 0 ? 'passes' : 'finds'} ${name}`, async () => {
      const web = realpathSync(mkdtempSync(join(tmpdir(), 'sh-trade-alias-')));
      try {
        for (const [file, text] of Object.entries(files)) writeFileSync(join(web, file), text);
        expect(await viteAliasesOf(web)).toEqual(expected);
      } finally {
        rmSync(web, { recursive: true, force: true });
      }
    }, shLimit(30_000));
  }
});
