// @vitest-environment node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { getAddress, toFunctionSelector } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { buildTargetOf } from '../build-target';
import { thirdPartyNotices } from '../build/third-party-notices';
import { EXAMPLES_MANIFEST, exampleScriptsOf, allowancesFor, ALPHA_PAGES, ALPHA_PAGES_REGISTRY_KEY, ALPHA_PATTERN, PRIVY_HOSTS, STANDIN_PATTERN, judgeAlpha, packageKeyOf, privyModuleOf, privyOnlyPackages, TWIN_RULES, ALLOWANCES, FIXTURE_FILES, POOL_SWAP_TEST, RULES, TRADE_FOLDER, TRADE_RULES, TRADE_SELECTORS, TRADE_SLOT_MARKER, allowanceFor, chooseSource, decodeMappings, differences, fails, fixtureOnlyAddresses, htmlReferences, importsOf, buildOptionsOf, isPacked, jsonHolding, judge, judgeModules, judgeTrade, listMismatches, listOf, loadGraph, loadOf, MODULE_LIST, moduleIdOf, moveMaps, originalOf, outOf, outPathOf, placeholderList, pointedRun, pointerOf, POINTER, readModuleList, runCheck, scanDirectory, scanText, sourceHolding, targetOf, tradeModuleOf, tradeReport, twinOf, writeModuleList, writePointer, judgeRevealSeam, inertSeamCode, revealSeamExports, recordSeamChunks, writtenChunks, modeOf, REVEAL_SEAM_MARKERS, REVEAL_SEAM_MODULE, seamOf, WEB_TEST_SUPPORT, type Allowance, type BuildRole, type BuiltChunk, type CheckDeps, type Finding, type Home } from '../production-check';
import { TRADE_SLOT_MARKER as SLOT_MODULE_MARKER } from './features/trade-sepolia/TradeSlot';
import { ALPHA_PAGES as BUILT_PAGES, ALPHA_PAGES_REGISTRY } from '../build/alpha-pages';

/**
 * `pnpm check:production` (SH-V2-FE6): what the scan of the production bundle counts, where a match sits (text or
 * code), how a finding is traced to its source, and the allowances. The check itself builds the production site and
 * scans it; these cases pin its rules on small inputs.
 */
const words = (findings: readonly Finding[]) => findings.map((f) => `${f.rule}:${f.place}:${f.match}`);

describe('the rules', () => {
  it('demo and mock: the word in any casing, alone or as a part of a name, never inside another word', () => {
    const js = 'const a = "Demo data"; const b = `USDC-DEMO`; x.isDemo; const DEMO_LISTINGS = 1; y.demoState; "demonstrate"; "pseudodemo"; "ZodEmoji"; "mock data"; "Mocks"';
    expect(words(scanText(js, 'a.js'))).toEqual(['demo:text:Demo', 'demo:text:DEMO', 'demo:code:Demo', 'demo:code:DEMO', 'demo:code:demo', 'mock:text:mock', 'mock:text:Mocks']);
  });

  it('a match counts in text (strings, templates, regular expressions); a name in code is a note', () => {
    const js = 'const s = { "data-demo": true, demo: 1, label: "the Demo" }; const r = /demo/i; const t = `x ${demo} Demo`;';
    const found = scanText(js, 'a.js');
    expect(words(found)).toEqual(['demo:code:demo', 'demo:code:demo', 'demo:text:Demo', 'demo:text:demo', 'demo:code:demo', 'demo:text:Demo']);
    expect(found.filter(fails).map((f) => f.match)).toEqual(['Demo', 'demo', 'Demo']);
  });

  it('a style sheet’s selectors and custom properties are code; a quoted value is text; HTML and JSON are text', () => {
    expect(words(scanText('.sh-demo-badge{color:var(--sh-demo-bg)} .x::after{content:"Demo"}', 'a.css'))).toEqual(['demo:code:demo', 'demo:code:demo', 'demo:text:Demo']);
    expect(words(scanText('<title>Square Hole — Demo</title>', 'index.html'))).toEqual(['demo:text:Demo']);
    expect(words(scanText('{"use":"Demo box cover"}', 'manifest.json'))).toEqual(['demo:text:Demo']);
  });

  it('Demo addresses: a whole 0xde0… address or one built from the prefix, never a longer hash or 1e18 in hex', () => {
    const js = 'a="0xde00000000000000000000000000000000000a11"; b=`0xde00c${x}`; c="0xde0b6b3a7640000"; d="0xde0a9933a581a71606202474c2240edad558106f69e7aabbccddeeff00112233"';
    expect(words(scanText(js, 'a.js'))).toEqual(['demo-address:text:0xde00000000000000000000000000000000000a11', 'demo-address:text:0xde00c']);
  });

  it('invented addresses: the zero address with a tail above 0xff (the Demo FIT target’s), not a precompile, a placeholder or the burn address', () => {
    const tail = (hex: string) => `0x${'0'.repeat(40 - hex.length)}${hex}`;
    const js = `a="${tail('f17e')}"; b="${tail('2ae0')}"; c="${tail('1')}"; d="${tail('ff')}"; e="${tail('')}"; f="${tail('dEaD')}"; g="${tail('100')}"; h="0x${'0'.repeat(56)}f17e"`;
    expect(words(scanText(js, 'a.js'))).toEqual([`demo-address:text:${tail('f17e')}`, `demo-address:text:${tail('2ae0')}`, `demo-address:text:${tail('100')}`]);
  });

  it('local chains: a loopback host or anvil, in text or code', () => {
    const js = 'a="http://127.0.0.1:8545"; b="http://localhost"; c="Anvil (local 31337)"; d="[::1]"; e="0.0.0.0"; f="canvil"; g="http://localhost.example"';
    expect(words(scanText(js, 'a.js'))).toEqual(['local-rpc:text:127.0.0.1', 'local-rpc:text:localhost', 'local-rpc:text:Anvil', 'local-rpc:text:[::1]', 'local-rpc:text:0.0.0.0']);
  });

  it('legal placeholders (SH-V2-FE7): each open item whole, in text or code, never the pages’ own pattern for them', () => {
    const js = 'a="Square Hole is run by [COUNSEL: legal entity, once formed]."; b=`[FOUNDER + COUNSEL: delete this line]`; c=/(\\[(?:COUNSEL|FOUNDER|ENGINEERING)\\b[^\\]]*\\])/; d="[ENGINEERING: confirm]"; e="[founder: lower case]"';
    const found = scanText(js, 'a.js');
    expect(words(found)).toEqual(['placeholder:text:[COUNSEL: legal entity, once formed]', 'placeholder:text:[FOUNDER + COUNSEL: delete this line]', 'placeholder:text:[ENGINEERING: confirm]']);
    expect(found.every(fails)).toBe(true);
    expect(fails({ rule: 'placeholder', place: 'code' })).toBe(true);
    const listed = placeholderList([...found, { ...(found[0] as Finding), source: { file: 'apps/web/src/features/legal/privacy-production.ts', line: 9 } }]);
    expect(listed).toEqual([
      '  2× [COUNSEL: legal entity, once formed]  (a.js)',
      '  [FOUNDER + COUNSEL: delete this line]  (a.js)',
      '  [ENGINEERING: confirm]  (a.js)',
    ]);
  });

  it('fixture addresses: only the given ones, in any case', () => {
    const fixture = new Set(['0x00000000000000000000000000000000de000001']);
    expect(words(scanText('a="0x00000000000000000000000000000000DE000001"; b="0x0000000000000000000000000000000000000001"', 'a.js', fixture))).toEqual([
      // Invented as well (the zero address with a tail).
      'demo-address:text:0x00000000000000000000000000000000DE000001',
      'fixture-address:text:0x00000000000000000000000000000000DE000001',
    ]);
  });
});

describe('tracing a finding to its source', () => {
  it('decodes a source map and names the source line behind a generated position', () => {
    // Line 1: column 0 from a.ts line 1; column 10 from b.ts line 3. Line 2: column 4 from b.ts line 4.
    const map = { sources: ['a.ts', 'b.ts'], mappings: 'AAAA,UCEA;IACA' };
    const decoded = decodeMappings(map.mappings);
    expect(decoded).toEqual([[[0, 0, 0, 0], [10, 1, 2, 0]], [[4, 1, 3, 0]]]);
    expect(originalOf(map, decoded, 1, 3)).toEqual({ file: 'a.ts', line: 1 });
    expect(originalOf(map, decoded, 1, 12)).toEqual({ file: 'b.ts', line: 3 });
    expect(originalOf(map, decoded, 2, 2)).toBeNull();
  });

  it('inlined data without a mapping: the one source that holds the same words', () => {
    const map = { sources: ['code.ts', 'manifest.json'], mappings: '', sourcesContent: ['const x = 1;', '{\n  "use": "Demo box cover: Tin Cans (glass box)"\n}'] };
    expect(sourceHolding(map, '`Demo box cover: Tin Cans (glass box)`', 'Demo')).toEqual({ file: 'manifest.json', line: 2 });
    expect(sourceHolding(map, '`no such words`', 'Demo')).toBeNull();
  });

  it('names the mapped source unless only a JSON file holds the words (JSX text wrapped across lines stays its own)', () => {
    const jsx = 'export const Note = () => (\n  <p>\n    The Demo boxes live in\n    this tab only.\n  </p>\n);';
    const map = { sources: ['src/Note.tsx', 'src/legal/terms.ts', 'art/manifest.json'], mappings: '', sourcesContent: [jsx, "'The Demo boxes live in this tab only.'", '{"use": "Demo box cover"}'] };
    const literal = '`The Demo boxes live in this tab only.`';
    // terms.ts holds the exact words, Note.tsx only once its line breaks count as spaces: the mapping wins.
    expect(chooseSource(map, { file: 'src/Note.tsx', line: 3 }, { file: 'src/legal/terms.ts', line: 1 }, literal, 'Demo')).toEqual({ file: 'src/Note.tsx', line: 3 });
    // A code file never outranks the mapping, even where the mapped source does not hold the words.
    expect(chooseSource(map, { file: 'art/manifest.json', line: 1 }, { file: 'src/legal/terms.ts', line: 1 }, literal, 'Demo')).toEqual({ file: 'art/manifest.json', line: 1 });
    // Inlined JSON data: the nearest mapping is some other module's, so the JSON file that holds the words is named.
    expect(chooseSource(map, { file: 'src/Note.tsx', line: 1 }, { file: 'art/manifest.json', line: 1 }, '`Demo box cover`', 'Demo')).toEqual({ file: 'art/manifest.json', line: 1 });
    expect(chooseSource(map, null, { file: 'art/manifest.json', line: 1 }, '`Demo box cover`', 'Demo')).toEqual({ file: 'art/manifest.json', line: 1 });
    expect(chooseSource(map, { file: 'src/Note.tsx', line: 1 }, null, literal, 'Demo')).toEqual({ file: 'src/Note.tsx', line: 1 });
  });

  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('data a map does not list (a JSON module its source reads): the JSON beside the map’s sources', () => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-check-'));
    mkdirSync(join(dir, 'art'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'art', 'manifest.json'), '{\n  "use": "ORCHARD demo avatar (ordinary orchard tree)"\n}');
    const map = { sources: ['../art/cover.webp?no-inline'], mappings: '' };
    expect(jsonHolding(map, join(dir, 'assets'), '`ORCHARD demo avatar (ordinary orchard tree)`', 'demo')).toEqual({ file: join('..', 'art', 'manifest.json'), line: 2 });
  });

  it('scans every shipped text file, reads the maps beside the folder for the sources only, reads no text rule into a picture', () => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-check-'));
    const out = join(dir, 'dist');
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<title>Square Hole</title>');
    writeFileSync(join(out, 'assets', 'a.js'), 'const label = "Demo data";');
    // The map lives in the build's record, where the check's build moves it; its sourcesContent names the Demo too, and
    // it is never scanned. Its sources are relative to where the build wrote it, next to the script.
    const maps = join(dir, 'record', 'maps');
    mkdirSync(join(maps, 'assets'), { recursive: true });
    writeFileSync(join(maps, 'assets', 'a.js.map'), JSON.stringify({ version: 3, sources: ['../../src/a.ts'], sourcesContent: ['export const label = "Demo data";'], mappings: 'AAAA,cAAA' }));
    writeFileSync(join(out, 'assets', 'cover.webp'), Buffer.from([0x44, 0x65, 0x6d, 0x6f]));
    const found = scanDirectory(out, new Set(), RULES, maps);
    expect(found.map((f) => [f.file, f.rule, f.match])).toEqual([[join('assets', 'a.js'), 'demo', 'Demo']]);
    expect(found[0]?.source?.file).toMatch(/src[\\/]a\.ts$/);
  });
});

describe('allowances', () => {
  it('SH-203 af3: both targets allow only one literal demo parser key from the shared box reader', () => {
    const source = 'packages/chain/src/core/v2/open-reveal-json-v2.ts';
    const code = readFileSync(MODULE(source), 'utf8');
    expect(code).toContain("const KEPT_KEYS = new Set(['format', 'demo', 'encoded', 'specHash', 'spec', 'revealList']);");
    const findings = scanText('const keys = new Set([`format`,`demo`,`encoded`,`specHash`,`spec`,`revealList`]);', 'assets/BoxPage.js')
      .map(finding => ({ ...finding, source: { file: source, line: 6 } }));
    expect(findings).toHaveLength(1);
    const finding = findings[0] as Finding;
    for (const target of ['mainnet', 'sepolia'] as const) {
      const allowances = allowancesFor(target);
      expect(judge(findings, allowances).failing).toEqual([]);
      expect(judge(findings, allowances).allowed).toHaveLength(1);
      expect(judge([...findings, finding], allowances).failing).toHaveLength(2);
      for (const changed of [
        { ...finding, source: undefined }, { ...finding, source: { file: 'packages/chain/src/other.ts', line: 6 } },
        { ...finding, literal: undefined }, { ...finding, literal: '`demo mode`' }, { ...finding, match: 'Demo', literal: '`Demo`' },
        { ...finding, rule: 'mock' as const, match: 'mock', literal: '`mock`' },
      ]) expect(judge([changed], allowances).failing).toEqual([changed]);
    }
  });
  const finding = (file: string, rule: Finding['rule'], match: string): Finding => ({ rule, place: 'text', file: 'assets/a.js', line: 1, column: 0, match, excerpt: match, source: { file, line: 1 } });
  const allowances: Allowance[] = [
    { source: 'packages/x/src/a.ts', rules: ['demo'], reason: 'a' },
    { source: /^node_modules\/lib\//, rules: ['local-rpc'], match: /^localhost$/, reason: 'b' },
    { source: 'packages/y/src/never.ts', rules: ['demo'], reason: 'c' },
  ];

  it('covers a counting finding only by its source, its rule and (when given) its match', () => {
    expect(allowanceFor(finding('packages/x/src/a.ts', 'demo', 'Demo'), allowances)?.reason).toBe('a');
    expect(allowanceFor(finding('packages/x/src/a.ts', 'mock', 'mock'), allowances)).toBeNull();
    expect(allowanceFor(finding('node_modules/lib/x.js', 'local-rpc', 'localhost'), allowances)?.reason).toBe('b');
    expect(allowanceFor(finding('node_modules/lib/x.js', 'local-rpc', '127.0.0.1'), allowances)).toBeNull();
    expect(allowanceFor({ ...finding('packages/x/src/a.ts', 'demo', 'Demo'), source: undefined }, allowances)).toBeNull();
  });

  it('judges: failing, allowed, notes, and the allowances nothing matched', () => {
    const code: Finding = { ...finding('apps/web/src/a.ts', 'demo', 'isDemo'), place: 'code' };
    const result = judge([finding('packages/x/src/a.ts', 'demo', 'Demo'), finding('apps/web/src/b.ts', 'demo', 'Demo'), code], allowances);
    expect(result.failing.map((f) => f.source?.file)).toEqual(['apps/web/src/b.ts']);
    expect(result.allowed.map((a) => a.allowance.reason)).toEqual(['a']);
    expect(result.notes).toEqual([code]);
    expect(result.stale.map((a) => a.reason)).toEqual(['b', 'c']);
    expect(result.over).toEqual([]);
  });

  it('an allowance with a max covers at most that many findings: one more and all of them fail', () => {
    const capped: Allowance[] = [{ source: 'packages/x/src/a.ts', rules: ['demo'], max: 2, reason: 'a' }];
    const two = [finding('packages/x/src/a.ts', 'demo', 'Demo'), finding('packages/x/src/a.ts', 'demo', 'demo')];
    expect([judge(two, capped).failing.length, judge(two, capped).allowed.length]).toEqual([0, 2]);
    const three = judge([...two, finding('packages/x/src/a.ts', 'demo', 'DEMO')], capped);
    expect([three.failing.length, three.allowed.length, three.over.map((o) => o.count), three.stale]).toEqual([3, 0, [3], []]);
  });

  it('caps the allowances that hold words a visitor could read (the packages’ messages)', () => {
    const max = (source: string) => ALLOWANCES.find((allowance) => String(allowance.source).includes(source))?.max;
    expect([max('artwork/src/attributes.ts'), max('links')]).toEqual([3, 3]);
  });

  // Fix round 1, F2 (XR-SH-LINKS-WEB): the shared box-links canonicalizer's allowance covers its two refusal literals
  // as the build prints them, whole, and nothing else from that file: a real local URL there fails even under the cap.
  it('allows the box-links refusal literals whole; a local URL from the same file fails, even under the cap of 2', () => {
    const REFUSAL_SET = '/\\.(?:localhost|local|internal|test|invalid|example|onion|arpa)$/';
    const bundle = `const a=e=>e.hostname===\`localhost\`||CC.test(e.hostname),CC=${REFUSAL_SET};const b=()=>fetch(\`http://localhost:8545\`),c=()=>fetch("http://localhost:8545/rpc"),d="localhost:8545";`;
    const source = { file: 'packages/chain/src/core/v2/box-links-v2.ts', line: 21 };
    const found = scanText(bundle, 'assets/indexer-v2.js').map((f) => ({ ...f, source }));
    expect(found.map((f) => [f.rule, f.place, f.match, f.literal])).toEqual([
      ['local-rpc', 'text', 'localhost', 'localhost'],
      ['local-rpc', 'text', 'localhost', REFUSAL_SET],
      ['local-rpc', 'text', 'localhost', 'http://localhost:8545'],
      ['local-rpc', 'text', 'localhost', '"http://localhost:8545/rpc"'],
      ['local-rpc', 'text', 'localhost', '"localhost:8545"'],
    ]);
    const [hostname, set, template, quoted, bare] = found as [Finding, Finding, Finding, Finding, Finding];
    // The two refusals alone (the shipped build): allowed.
    expect(judge([hostname, set]).failing).toEqual([]);
    expect(judge([hostname, set]).allowed.map((entry) => entry.finding.literal)).toEqual(['localhost', REFUSAL_SET]);
    // One refusal gone and a local URL in its place: one finding of each, under the cap; the URL still fails.
    for (const url of [template, quoted, bare]) {
      const verdict = judge([hostname, url]);
      expect(verdict.failing.map((f) => f.literal), String(url.literal)).toEqual([url.literal]);
      expect(verdict.allowed.map((entry) => entry.finding.literal)).toEqual(['localhost']);
    }
    // A finding with no literal (code, or a map that names no text) is never covered by it.
    expect(allowanceFor({ ...hostname, literal: undefined })).toBeNull();
  });

  it('allows nothing from apps/web (SH-V2-FE7: the production legal texts name no Demo) and no placeholder anywhere', () => {
    const own = ALLOWANCES.filter((allowance) => typeof allowance.source === 'string' ? allowance.source.startsWith('apps/') : allowance.source.test('apps/web/src/features/boxes/demo-boxes.ts') || allowance.source.test('apps/web/src/features/legal/terms.ts'));
    expect(own).toEqual([]);
    expect(ALLOWANCES.filter((allowance) => allowance.rules.includes('placeholder'))).toEqual([]);
    for (const allowance of ALLOWANCES) expect(allowance.reason.length, String(allowance.source)).toBeGreaterThan(40);
  });
});

describe('the build about to be uploaded', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('is the scanned one when every file has the same bytes; a source map on either side is a difference (fix round af1)', () => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-check-'));
    const scanned = join(dir, 'scanned');
    const shipped = join(dir, 'shipped');
    for (const root of [scanned, shipped]) {
      mkdirSync(join(root, 'assets'), { recursive: true });
      writeFileSync(join(root, 'index.html'), '<title>Square Hole</title>');
      writeFileSync(join(root, 'assets', 'a.js'), 'const a = 1;');
    }
    expect(differences(scanned, shipped)).toEqual([]);
    writeFileSync(join(shipped, 'assets', 'a.js.map'), '{}');
    writeFileSync(join(scanned, 'assets', 'b.JS.MAP'), '{}');
    expect(differences(scanned, shipped)).toEqual([`only in ${shipped}: ${join('assets', 'a.js.map')}`, `missing from ${shipped}: ${join('assets', 'b.JS.MAP')}`]);
    rmSync(join(shipped, 'assets', 'a.js.map'));
    rmSync(join(scanned, 'assets', 'b.JS.MAP'));
    writeFileSync(join(shipped, 'assets', 'a.js'), 'const a = 2;');
    writeFileSync(join(shipped, 'assets', 'b.js'), 'const b = 1;');
    rmSync(join(shipped, 'index.html'));
    expect(differences(scanned, shipped)).toEqual([`differs: ${join('assets', 'a.js')}`, `only in ${shipped}: ${join('assets', 'b.js')}`, `missing from ${shipped}: index.html`]);
  });
});

describe('fixture addresses', () => {
  it('lists an address of a recorded or invented deployment, never one a shipped source names too', () => {
    const fixture = fixtureOnlyAddresses();
    // The mock providers' persona (accounts fixture) is fixture-only; the zero address and Sepolia's real PoolManager are not.
    expect(fixture.has('0x00000000000000000000000000000000de000001')).toBe(true);
    expect(fixture.has(`0x${'0'.repeat(40)}`)).toBe(false);
    expect([...fixture].every((address) => /^0x[0-9a-f]{40}$/.test(address))).toBe(true);
    expect(FIXTURE_FILES.length).toBeGreaterThan(3);
  });
});

// --- the trade rule (F156, SH-ALPHA-BUILD-SWITCH) --------------------------------------------------------------------

describe('the trade rule (F156)', () => {
  it('names the alpha’s trade markers: the slot’s, PoolSwapTest on Sepolia, the swap and buy selectors, the folders’ name', () => {
    expect(TRADE_SLOT_MARKER).toBe('sh-trade-slot-f156');
    expect(getAddress(POOL_SWAP_TEST)).toBe('0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe');
    expect(TRADE_SELECTORS).toEqual([
      toFunctionSelector('swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)'),
      toFunctionSelector('buy(uint256,uint256,address,uint256)'),
    ]);
    expect(TRADE_SELECTORS).toEqual(['0x2229d0b4', '0x8945257c']);
    expect(TRADE_FOLDER).toBe('trade-sepolia');
    expect(TRADE_RULES.map((rule) => rule.id)).toEqual(['trade']);
    expect(RULES.map((rule) => rule.id)).toContain('trade');
  });

  it('finds each marker in any letter case, in text or in code, the address with or without its 0x; nothing else', () => {
    const js = [
      'a="sh-trade-slot-f156"', 'b="SH-TRADE-SLOT-F156"', 'c="0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe"', 'd="0x9b6b46e2c869aa39918db7f52f5557fe577b6eee"',
      'e="0x0000000000000000000000009B6B46E2C869AA39918DB7F52F5557FE577B6EEE"', 'f="0x2229d0b4"', 'g="0X8945257C00000000"', 'h=0x2229D0B4',
      'i="trade-sepolia/quote"', 'j=import(`./Trade-Sepolia-x.js`)',
      // Not markers: the words on their own, the slot's chunk name, the chain's other contracts, other selectors.
      'k="trade";l="Sepolia";m="TradeSlot-AbC.js";n=x.tradeSepolia;o="Trade tape";p="0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";q="0x2229d0b5";r="2229d0b4"',
    ].join(';');
    const found = scanText(js, 'a.js');
    expect(found.filter((finding) => finding.rule === 'trade').map((finding) => `${finding.place}:${finding.match}`)).toEqual([
      'text:sh-trade-slot-f156', 'text:SH-TRADE-SLOT-F156', 'text:0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe', 'text:0x9b6b46e2c869aa39918db7f52f5557fe577b6eee',
      'text:9B6B46E2C869AA39918DB7F52F5557FE577B6EEE', 'text:0x2229d0b4', 'text:0X8945257C', 'code:0x2229D0B4', 'text:trade-sepolia', 'text:Trade-Sepolia',
    ]);
    expect(found.filter((finding) => finding.rule === 'trade').every(fails)).toBe(true);
    expect(fails({ rule: 'trade', place: 'code' })).toBe(true);
    // In a style sheet and in HTML as well; the twin's scan runs the trade rule alone.
    expect(scanText('.sh-trade-sepolia__box{color:red}', 'a.css').map((finding) => `${finding.rule}:${finding.place}`)).toEqual(['trade:code']);
    expect(scanText('<p>0x8945257c</p> demo', 'index.html', new Set(), TRADE_RULES).map((finding) => finding.rule)).toEqual(['trade']);
  });

  it('reads the target as the build does (build-target.ts), and finds the trade slot by the marker its module exports', () => {
    expect([targetOf({}), targetOf({ SH_TARGET: '' }), targetOf({ SH_TARGET: 'mainnet' }), targetOf({ SH_TARGET: 'sepolia' })]).toEqual(['mainnet', 'mainnet', 'mainnet', 'sepolia']);
    for (const value of [undefined, '', 'mainnet', 'sepolia', 'Sepolia', ' sepolia', 'testnet', '11155111']) {
      const env = { SH_BUILD: 'production', ...(value === undefined ? {} : { SH_TARGET: value }) };
      const outcome = (read: () => string) => { try { return read(); } catch (error) { return `refused: ${(error as Error).message.split(' (got')[0]}`; } };
      expect(outcome(() => targetOf(env)), String(value)).toBe(outcome(() => buildTargetOf(env)));
    }
    expect(SLOT_MODULE_MARKER).toBe(TRADE_SLOT_MARKER);
  });

  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A build's shape as the site's build writes it: index.html, its entry, static and lazy chunks, a style, an orphan, public data. */
  const output = (files: Readonly<Record<string, string>> = {}): string => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-trade-'));
    const base: Record<string, string> = {
      'index.html': '<title>Square Hole</title><script type="module" crossorigin src="/assets/index-a.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/vendor-b.js">\n<link rel="stylesheet" crossorigin href="/assets/web-c.css">\n<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n<script src="https://example.org/x.js"></script>',
      'favicon.svg': '<svg/>',
      'assets/index-a.js': 'import{t as e}from"./web-d.js";e();',
      'assets/web-d.js': 'import{v as n}from"./vendor-b.js";export const t=()=>import(`./BoxPage-e.js`),u=()=>import(x);',
      'assets/vendor-b.js': 'export const v=1;',
      'assets/web-c.css': '.sh-page{color:red}',
      'assets/BoxPage-e.js': 'import{v as n}from"./vendor-b.js";import{s}from"./shared-f.js";export{s};export*from"./shared-f.js";const l=()=>import("./TradeSlot-g.js");export{l};',
      'assets/shared-f.js': 'export const s=2;',
      'assets/TradeSlot-g.js': 'var t=`sh-trade-slot-f156`,n=()=>null;export{t as TRADE_SLOT_MARKER,n as default};',
      'assets/TradeSlot-g.css': '.sh-x{color:red}',
      'assets/orphan-h.js': 'export const o=1;',
      'nft/1.json': '{"name":"one"}',
      ...files,
    };
    for (const [name, text] of Object.entries(base)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  const trade = (out: string, target: 'mainnet' | 'sepolia') => judgeTrade(scanDirectory(out), target, loadGraph(out));
  const where = (findings: readonly Finding[]) => findings.map((finding) => `${finding.file.split(sep).join('/')}:${finding.match}`);
  const ALL = '`sh-trade-slot-f156`,p=`0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe`,q=`0x2229d0b4`,r=`0x8945257c`,f=`trade-sepolia`';

  it('the load graph: what index.html loads at first paint, and the chunks only a dynamic import reaches', () => {
    expect(htmlReferences('<script type="module" src="/a.js"></script><link rel="modulepreload" href=\'/b.js\'><link href="/c.css" rel="stylesheet">')).toEqual(['/a.js', '/b.js', '/c.css']);
    expect(importsOf('import{a}from"./a.js";import"./side.js";export{b}from"./b.js";export*from"./c.js";const d=()=>import(`./d.js`),e=()=>import("./e.js"),f=()=>import(`./${x}.js`),g=()=>import(y);')).toEqual({ static: ['./a.js', './side.js', './b.js', './c.js'], dynamic: ['./d.js', './e.js'] });
    const graph = loadGraph(output());
    expect([...graph.firstPaint].sort()).toEqual(['assets/index-a.js', 'assets/vendor-b.js', 'assets/web-c.css', 'assets/web-d.js', 'favicon.svg', 'index.html']);
    expect([...graph.lazy].sort()).toEqual(['assets/BoxPage-e.js', 'assets/TradeSlot-g.js', 'assets/shared-f.js']);
    expect([loadOf(graph, 'index.html'), loadOf(graph, join('assets', 'TradeSlot-g.js')), loadOf(graph, join('assets', 'orphan-h.js')), loadOf(graph, join('assets', 'TradeSlot-g.css'))]).toEqual(['first paint', 'lazy', 'not loaded by a script', 'not loaded by a script']);
  });

  it('a Sepolia build: every marker in a lazily loaded chunk, the slot among them, passes', () => {
    const out = output({ 'assets/TradeSlot-g.js': `var t=${ALL};export{t as TRADE_SLOT_MARKER};` });
    const judged = trade(out, 'sepolia');
    expect(judged.failing).toEqual([]);
    expect(where(judged.lazy)).toEqual(['assets/TradeSlot-g.js:sh-trade-slot-f156', 'assets/TradeSlot-g.js:0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe', 'assets/TradeSlot-g.js:0x2229d0b4', 'assets/TradeSlot-g.js:0x8945257c', 'assets/TradeSlot-g.js:trade-sepolia']);
    expect(judged.slot).toBe(true);
    const report = tradeReport(judged, loadGraph(out), 'trade');
    expect(report.ok).toBe(true);
    expect(report.lines).toEqual(['trade: 5 trade markers, all in lazily loaded chunks (assets/TradeSlot-g.js), the trade slot among them']);
    // A lazy chunk the slot's chunk shares with the box page may hold them too: it loads only after a dynamic import.
    expect(trade(output({ 'assets/shared-f.js': 'export const s=`0x2229d0b4`;' }), 'sepolia').failing).toEqual([]);
  });

  it('a mainnet build: each marker fails wherever it is, a lazily loaded chunk included', () => {
    const lazy = trade(output({ 'assets/TradeSlot-g.js': `var t=${ALL};export{t as TRADE_SLOT_MARKER};` }), 'mainnet');
    expect(where(lazy.failing)).toEqual(['assets/TradeSlot-g.js:sh-trade-slot-f156', 'assets/TradeSlot-g.js:0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe', 'assets/TradeSlot-g.js:0x2229d0b4', 'assets/TradeSlot-g.js:0x8945257c', 'assets/TradeSlot-g.js:trade-sepolia']);
    expect([lazy.lazy, lazy.slot]).toEqual([[], false]);
    const places: Record<string, string> = {
      'index.html': '<title>Square Hole</title><script type="module" crossorigin src="/assets/index-a.js"></script><!-- 0x9b6b46e2c869aa39918db7f52f5557fe577b6eee -->',
      'assets/index-a.js': 'import{t as e}from"./web-d.js";e(`0x2229d0b4`);',
      'assets/vendor-b.js': 'export const v=`0x8945257c`;',
      'assets/web-c.css': '.sh-trade-sepolia{color:red}',
      'assets/orphan-h.js': 'export const o=`sh-trade-slot-f156`;',
      'nft/1.json': '{"router":"0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe"}',
    };
    for (const [file, text] of Object.entries(places)) {
      // The slot's chunk without its marker: one marker, placed in one file at a time.
      const judged = trade(output({ 'assets/TradeSlot-g.js': 'var n=()=>null;export{n as default};', [file]: text }), 'mainnet');
      expect(where(judged.failing), file).toHaveLength(1);
      expect(where(judged.failing)[0]?.startsWith(`${file}:`), file).toBe(true);
      const report = tradeReport(judged, loadGraph(dir as string), 'trade');
      expect(report.ok).toBe(false);
      expect(report.lines.at(-1)).toBe('trade: 1 trade marker where a mainnet build holds none');
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
    expect(tradeReport(trade(output({ 'assets/TradeSlot-g.js': 'var n=()=>null;export{n as default};' }), 'mainnet'), loadGraph(dir as string), 'trade')).toEqual({ ok: true, lines: ['trade: no trade marker'] });
  });

  it('a Sepolia build fails on a marker outside the lazy chunks: the page, the entry, a chunk it imports, a style, an orphan, public data', () => {
    const places: Record<string, string> = {
      'index.html': '<title>Square Hole</title><script type="module" crossorigin src="/assets/index-a.js"></script><!-- 0x9b6b46e2c869aa39918db7f52f5557fe577b6eee -->',
      'assets/index-a.js': 'import{t as e}from"./web-d.js";e(`0x2229d0b4`);',
      'assets/web-d.js': 'import{v as n}from"./vendor-b.js";export const t=()=>import(`./BoxPage-e.js`),k=`trade-sepolia`;',
      'assets/vendor-b.js': 'export const v=`0x8945257c`;',
      'assets/web-c.css': '.sh-trade-sepolia{color:red}',
      'assets/TradeSlot-g.css': '.sh-trade-sepolia{color:red}',
      'assets/orphan-h.js': 'export const o=`0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe`;',
      'nft/1.json': '{"router":"0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe"}',
    };
    for (const [file, text] of Object.entries(places)) {
      const judged = trade(output({ [file]: text }), 'sepolia');
      expect(where(judged.failing), file).toHaveLength(1);
      expect(where(judged.failing)[0]?.startsWith(`${file}:`), file).toBe(true);
      expect(judged.slot).toBe(true);
      const report = tradeReport(judged, loadGraph(dir as string), 'trade');
      expect(report.ok).toBe(false);
      expect(report.lines.at(-1)).toBe('trade: 1 trade marker where only a lazily loaded chunk may hold one');
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('a Sepolia build without the trade slot in a lazy chunk fails, even with no marker out of place', () => {
    const judged = trade(output({ 'assets/TradeSlot-g.js': 'var p=`0x2229d0b4`;export{p};' }), 'sepolia');
    expect([judged.failing, judged.slot]).toEqual([[], false]);
    const report = tradeReport(judged, loadGraph(dir as string), 'trade');
    expect(report.ok).toBe(false);
    expect(report.lines).toEqual(['trade: the Sepolia build holds no trade slot (sh-trade-slot-f156) in a lazily loaded chunk: the switch is off there, or the slot left its module']);
    // The slot in the entry instead: out of place, and still no slot where it belongs.
    rmSync(dir as string, { recursive: true, force: true });
    const entry = trade(output({ 'assets/TradeSlot-g.js': 'var n=()=>null;export{n as default};', 'assets/index-a.js': 'import{t as e}from"./web-d.js";e(`sh-trade-slot-f156`);' }), 'sepolia');
    expect([where(entry.failing), entry.slot]).toEqual([['assets/index-a.js:sh-trade-slot-f156'], false]);
  });
});

// --- fix round af1 (XR-ALPHA-SWITCH) ---------------------------------------------------------------------------------

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MODULE = (path: string) => join(REPO, path);
/** Fix round af3, F4: ids a bundler or a plugin may hand back with a personal path inside, in each form the check meets. */
const ODD_IDS: readonly string[] = [
  `\0${MODULE('node_modules/.pnpm/x/index.js')}?commonjs-proxy`,
  `\0virtual:${MODULE('y.js')}`,
  `repo:${MODULE('apps/web/src/x.ts')}`,
  `external:file://${MODULE('w.js')}`,
  `plugin:${MODULE('v.js')}`,
  `plugin:${homedir()}/elsewhere/v.js`,
  `virtual:\0${MODULE('q.js')}`,
  `${MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx')}?importer=${MODULE('apps/web/src/a.ts')}`,
  '\0/opt/elsewhere/x.js',
  'repo:../../etc/passwd',
];
const SLOT_MODULE = MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx');

/**
 * A small site as the check's build leaves it: index.html, its entry and a static chunk, a lazy page chunk and, for
 * the Sepolia target, the slot's lazy chunk. `extra` adds or replaces files; `modules` adds module ids to a chunk of the
 * list. Returns the module list, as the check's build does (the run itself writes it into the record).
 */
function writeSite(outDir: string, target: 'mainnet' | 'sepolia', extra: Readonly<Record<string, string | Buffer>> = {}, modules: Readonly<Record<string, readonly string[]>> = {}): BuiltChunk[] {
  const files: Record<string, string | Buffer> = {
    'third-party-notices.txt': noticeFixture(),
    'index.html': '<title>Square Hole</title><script type="module" crossorigin src="/assets/index-a.js"></script><link rel="modulepreload" crossorigin href="/assets/web-b.js">',
    'assets/index-a.js': 'import{t as e}from"./web-b.js";e();',
    'assets/web-b.js': 'export const t=()=>import(`./BoxPage-c.js`);',
    'assets/BoxPage-c.js': target === 'sepolia' ? 'export const p=()=>import(`./TradeSlot-d.js`);' : 'export const p=()=>null;',
    ...(target === 'sepolia' ? { 'assets/TradeSlot-d.js': 'var t=`sh-trade-slot-f156`,n=()=>null;export{t as TRADE_SLOT_MARKER,n as default};' } : {}),
    // F161 (4), SH-ALPHA-SITE: the Sepolia build's join page (Privy's SDK in a lazy chunk) and the desk, each with its notices.
    ...(target === 'sepolia' ? {
      'join/index.html': '<title>Square Hole alpha</title><script type="module" crossorigin src="/join/assets/join-a.js"></script>',
      'join/assets/join-a.js': 'export const s=()=>import(`./privy-b.js`),m=()=>fetch(`/alpha/me`);',
      'join/assets/privy-b.js': 'export const h=`https://auth.privy.io`;',
      'join/assets/third-party-notices.txt': noticeFixture(),
      'desk/index.html': '<title>Alpha desk</title><script type="module" crossorigin src="/desk/assets/desk-a.js"></script>',
      'desk/assets/desk-a.js': 'export const d=()=>fetch(`/desk/api/signups`);',
      'desk/assets/third-party-notices.txt': noticeFixture(),
    } : {}),
    ...extra,
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(outDir, dirname(name)), { recursive: true });
    writeFileSync(join(outDir, name), body);
  }
  const chunks: BuiltChunk[] = [
    { fileName: 'assets/index-a.js', moduleIds: [MODULE('apps/web/src/main.tsx')] },
    { fileName: 'assets/web-b.js', moduleIds: [MODULE('apps/web/src/App.tsx')] },
    { fileName: 'assets/BoxPage-c.js', moduleIds: [MODULE('apps/web/src/pages/BoxPage.tsx'), MODULE('apps/web/src/features/core/v2/TradeSlotMount.tsx')] },
    ...(target === 'sepolia' ? [{ fileName: 'assets/TradeSlot-d.js', moduleIds: [SLOT_MODULE] }] : []),
    ...(target === 'sepolia' ? [
      { fileName: 'join/assets/join-a.js', moduleIds: [MODULE('apps/web/src/features/alpha-sepolia/join/JoinPage.tsx')] },
      { fileName: 'join/assets/privy-b.js', moduleIds: [MODULE('apps/web/src/features/trade-sepolia/privy-load.ts')] },
      { fileName: 'desk/assets/desk-a.js', moduleIds: [MODULE('apps/web/src/features/alpha-sepolia/desk/DeskPage.tsx')] },
    ] : []),
    ...Object.keys(extra).filter((name) => /\.[mc]?js$/i.test(name) && !['assets/index-a.js', 'assets/web-b.js', 'assets/BoxPage-c.js', 'assets/TradeSlot-d.js', 'join/assets/join-a.js', 'join/assets/privy-b.js', 'desk/assets/desk-a.js'].includes(name)).map((fileName) => ({ fileName, moduleIds: [MODULE('apps/web/src/other.ts')] })),
  ].map((chunk) => ({ ...chunk, moduleIds: [...chunk.moduleIds, ...(modules[chunk.fileName] ?? [])] }));
  return chunks;
}

/** The stand-in apps/web of a test: a real (link-free) temporary folder, with the check's root inside it. */
const homeOf = (web: string): Home => ({ web, owned: join(web, '.cache', 'production-check') });

/** The run a test's `--out` was last built into, as its pointer names it (fix round af3). */
function latestRun(out: string, web: string): string {
  const pointed = pointedRun(out, homeOf(web));
  if (!('run' in pointed)) throw new Error(pointed.problem);
  return pointed.run;
}

/**
 * Stand-ins for the builds and the output lines: `site` writes each build (the twin's target comes in `overrides`);
 * `web` is the test's apps/web, which every `--out` lies inside.
 */
function stubDeps(target: 'mainnet' | 'sepolia', site: (outDir: string, target: 'mainnet' | 'sepolia') => BuiltChunk[], web: string) {
  const builds: Array<readonly [string, Readonly<Record<string, string>>]> = [];
  /** Each build's role and the folder of the run its records went to (fix round af3). */
  const roles: Array<readonly [BuildRole, string]> = [];
  const warned: string[] = [];
  const errors: string[] = [];
  const deps: CheckDeps = {
    env: target === 'sepolia' ? { SH_TARGET: 'sepolia' } : {},
    home: homeOf(web),
    build: (outDir, overrides, record, role) => {
      builds.push([outDir, overrides]);
      roles.push([role, record]);
      return site(outDir, (overrides.SH_TARGET as 'mainnet' | 'sepolia' | undefined) ?? target);
    },
    fixtures: () => new Set(),
    warn: (line) => warned.push(line),
    error: (line) => errors.push(line),
  };
  return { deps, builds, roles, warned, errors };
}

describe('fix round af1, F1: every file of the folder, whatever its name', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const fresh = () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af1-')));
    return join(dir, 'check', 'dist');
  };

  it('a clean site passes on both targets: the control for every case below', () => {
    for (const target of ['mainnet', 'sepolia'] as const) {
      const out = fresh();
      const run = stubDeps(target, (folder, built) => writeSite(folder, built), dir as string);
      expect(runCheck(['--out', out], run.deps), `${target}: ${run.errors.join('\n')}`).toBe(0);
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  // The reviewer's cases: 0x2229d0b4 in a .map, .cjs, .wasm, .bin, .JS and .gz file, a map holding the folder's name and
  // the slot's marker; and the .js control. Each is added to a clean site of either target, alone.
  const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.from('0x2229d0b4', 'latin1')]);
  const bin = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x13, 0x88]), Buffer.from('0x2229D0B4', 'latin1'), Buffer.from([0x00, 0xc3, 0x28])]);
  const map = JSON.stringify({ version: 3, sources: ['../../src/features/trade-sepolia/TradeSlot.tsx'], sourcesContent: ["export const TRADE_SLOT_MARKER = 'sh-trade-slot-f156';"], mappings: '' });
  const CASES: ReadonlyArray<readonly [string, string | Buffer, RegExp]> = [
    ['assets/web-b.js.map', '{"version":3,"sources":[],"sourcesContent":["0x2229d0b4"],"mappings":""}', /^source-map\s+code\s+assets\/web-b\.js\.map:1:0/m],
    ['assets/TradeSlot-z.js.map', map, /^source-map\s+code\s+assets\/TradeSlot-z\.js\.map:1:0/m],
    ['assets/x.cjs', 'module.exports="0x2229d0b4";', /^trade text\s+assets\/x\.cjs:1:/m],
    ['assets/x.wasm', wasm, /^trade code\s+assets\/x\.wasm:1:8/m],
    ['assets/x.bin', bin, /^trade code\s+assets\/x\.bin:1:5/m],
    ['assets/X.JS', 'export const s="0x2229D0B4";', /^trade text\s+assets\/X\.JS:1:16/m],
    ['assets/x.js.gz', gzipSync('export const s="0x2229d0b4";'), /^packed\s+code\s+assets\/x\.js\.gz:1:0/m],
    ['assets/x.br', 'not brotli at all, but named so', /^packed\s+code\s+assets\/x\.br:1:0/m],
    ['assets/x.js', 'export const s="0x2229d0b4";', /^trade text\s+assets\/x\.js:1:16/m],
  ];

  for (const [file, body, shown] of CASES) {
    it(`fails on ${file}, on mainnet and on the Sepolia test site`, () => {
      for (const target of ['mainnet', 'sepolia'] as const) {
        const out = fresh();
        const run = stubDeps(target, (folder, built) => writeSite(folder, built, built === target ? { [file]: body } : {}), dir as string);
        expect(runCheck(['--out', out], run.deps), `${target} ${file}`).toBe(1);
        expect(run.errors.join('\n').replaceAll('\\', '/'), `${target} ${file}`).toMatch(shown);
        rmSync(dir as string, { recursive: true, force: true });
      }
    });
  }

  it('reads compressed files by their first bytes too, whatever their name', () => {
    expect(isPacked('assets/data.bin', gzipSync('x'))).toBe(true);
    expect(isPacked('assets/data.json', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isPacked('a.txt', Buffer.from('BZh91AY&SY', 'latin1'))).toBe(true);
    expect(isPacked('a.txt', Buffer.from('BZh is just text', 'latin1'))).toBe(false);
    expect(isPacked('cover.webp', Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'))).toBe(false);
    expect(isPacked('font.woff2', Buffer.from('wOF2', 'latin1'))).toBe(false);
    for (const name of ['a.GZ', 'a.tgz', 'a.Br', 'a.zip', 'a.jar', 'a.zst', 'a.bz2', 'a.xz', 'a.7z', 'a.lz4', 'a.Z']) expect(isPacked(name, Buffer.from('x')), name).toBe(true);
  });

  it('the check moves only its chunks’ own maps out of the folder; any other map stays and fails; one added to the upload fails --same-as', () => {
    const out = fresh();
    const chunks = writeSite(out, 'mainnet', { 'assets/web-b.js.map': '{}', 'assets/index-a.js.map': '{}', 'stray.js.map': '{}' });
    const maps = join(dir as string, 'record', 'maps');
    expect(moveMaps(out, maps, chunks)).toBe(2);
    expect(existsSync(join(out, 'assets', 'web-b.js.map'))).toBe(false);
    expect(existsSync(join(maps, 'assets', 'web-b.js.map'))).toBe(true);
    expect(existsSync(join(maps, 'assets', 'index-a.js.map'))).toBe(true);
    // A map that no chunk of the build owns (one copied from apps/web/public): it stays, and the scan fails on it.
    expect(existsSync(join(out, 'stray.js.map'))).toBe(true);
    expect(scanDirectory(out).filter((finding) => finding.rule === 'source-map').map((finding) => finding.file)).toEqual(['stray.js.map']);
    rmSync(join(out, 'stray.js.map'));
    // The upload beside it: the same files and one map more.
    const shipped = join(dir as string, 'upload');
    cpSync(out, shipped, { recursive: true });
    writeFileSync(join(shipped, 'assets', 'web-b.js.map'), '{}');
    const run = stubDeps('mainnet', (folder, built) => (folder === out ? chunks : writeSite(folder, built)), dir as string);
    expect(runCheck(['--out', out, '--same-as', shipped], run.deps)).toBe(1);
    expect(run.errors).toContain(`not the scanned build: only in ${shipped}: ${join('assets', 'web-b.js.map')}`);
  });
});

describe('fix round af1, F2: the bundler’s module list', () => {
  // F161 (4): the Sepolia site's join and desk pages are first paints of their own; Privy's chunk is lazy.
  const graph = { firstPaint: new Set(['index.html', 'assets/index-a.js', 'assets/web-b.js', 'join/index.html', 'join/assets/join-a.js', 'desk/index.html', 'desk/assets/desk-a.js']), lazy: new Set(['assets/BoxPage-c.js', 'assets/TradeSlot-d.js', 'join/assets/privy-b.js']) };
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('a trade module is any module in a directory named trade-sepolia under apps/web/src or packages/<name>/src', () => {
    expect(tradeModuleOf(SLOT_MODULE)).toBe('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(tradeModuleOf(MODULE('apps/web/src/pages/trade-sepolia/TestCoinPage.tsx?v=1'))).toBe('apps/web/src/pages/trade-sepolia/TestCoinPage.tsx');
    expect(tradeModuleOf(MODULE('packages/chain/src/trade-sepolia/guard.ts'))).toBe('packages/chain/src/trade-sepolia/guard.ts');
    expect(tradeModuleOf(MODULE('packages/chain/src/write/executor.ts'))).toBeNull();
    expect(tradeModuleOf(MODULE('apps/web/src/features/core/v2/TradeSlotMount.tsx'))).toBeNull();
    expect(tradeModuleOf(MODULE('apps/web/src/trade-sepolia.ts'))).toBeNull();
    expect(tradeModuleOf(MODULE('node_modules/x/trade-sepolia/y.js'))).toBeNull();
    expect(tradeModuleOf('\0vite/preload-helper.js')).toBeNull();
  });

  it('mainnet: a trade module in any chunk fails, a lazy one included; Sepolia: only outside the lazily loaded chunks', () => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-af1-'));
    const out = join(dir, 'dist');
    const chunks = writeSite(out, 'sepolia');
    const lazyOnly = judgeModules(chunks, 'sepolia', graph, out, 'modules');
    expect(lazyOnly.ok, lazyOnly.lines.join('\n')).toBe(true);
    expect(lazyOnly.lazy).toEqual(['assets/TradeSlot-d.js ← apps/web/src/features/trade-sepolia/TradeSlot.tsx', 'join/assets/privy-b.js ← apps/web/src/features/trade-sepolia/privy-load.ts']);
    const mainnet = judgeModules(chunks, 'mainnet', graph, out, 'modules');
    expect(mainnet.lines).toEqual([
      'modules: trade module assets/TradeSlot-d.js ← apps/web/src/features/trade-sepolia/TradeSlot.tsx (a mainnet build holds none)',
      // F161 (4): the alpha's own folders and its join page's Privy loader, none of them in a mainnet build.
      'modules: alpha module join/assets/join-a.js ← apps/web/src/features/alpha-sepolia/join/JoinPage.tsx (a mainnet build holds none)',
      'modules: trade module join/assets/privy-b.js ← apps/web/src/features/trade-sepolia/privy-load.ts (a mainnet build holds none)',
      'modules: alpha module desk/assets/desk-a.js ← apps/web/src/features/alpha-sepolia/desk/DeskPage.tsx (a mainnet build holds none)',
    ]);
    // A package trade folder reached from the entry's chunk (the executor importing it, say): out of place on Sepolia too.
    const leaked = chunks.map((chunk) => (chunk.fileName === 'assets/web-b.js' ? { ...chunk, moduleIds: [...chunk.moduleIds, MODULE('packages/chain/src/trade-sepolia/guard.ts')] } : chunk));
    expect(judgeModules(leaked, 'sepolia', graph, out, 'modules').lines).toEqual(['modules: trade module assets/web-b.js ← packages/chain/src/trade-sepolia/guard.ts (first paint, not a lazily loaded chunk)']);
  });

  it('the list must be this build’s: missing, empty, partial or naming a chunk that is not there, it fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'sh-production-af1-'));
    const out = join(dir, 'dist');
    const chunks = writeSite(out, 'mainnet');
    expect(judgeModules(chunks, 'mainnet', graph, out, 'modules').ok).toBe(true);
    expect(judgeModules(null, 'mainnet', graph, out, 'modules').lines[0]).toMatch(/^modules: no module list for this build/);
    expect(judgeModules([], 'mainnet', graph, out, 'modules').ok).toBe(false);
    expect(judgeModules(chunks.slice(1), 'mainnet', graph, out, 'modules').lines[0]).toContain('scripts it does not list: assets/index-a.js');
    expect(judgeModules([...chunks, { fileName: 'assets/gone-e.js', moduleIds: [] }], 'mainnet', graph, out, 'modules').lines[0]).toContain('chunks it lists that are not there: assets/gone-e.js');
    writeFileSync(join(out, 'assets', 'late-f.MJS'), 'export {};');
    expect(judgeModules(chunks, 'mainnet', graph, out, 'modules').lines[0]).toContain('scripts it does not list: assets/late-f.MJS');
    writeFileSync(join(dir, 'list.json'), '{"not":"a list"}');
    expect(readModuleList(join(dir, 'list.json'))).toBeNull();
  });

  it('runs on the build and the twin: a trade module that leaves no marker still fails the mainnet build', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af1-')));
    const out = join(dir, 'check', 'dist');
    // The slot's module bundled into the mainnet build's page chunk, its marker gone (a module the scan cannot read by its text).
    const run = stubDeps('mainnet', (folder, built) => writeSite(folder, built, {}, built === 'mainnet' ? { 'assets/BoxPage-c.js': [SLOT_MODULE] } : {}), dir);
    expect(runCheck(['--out', out], run.deps)).toBe(1);
    expect(run.errors).toContain('modules, this mainnet build: trade module assets/BoxPage-c.js ← apps/web/src/features/trade-sepolia/TradeSlot.tsx (a mainnet build holds none)');
  });
});

describe('SH-252: the examples’ copied scripts, accepted outside the module list only by the committed manifest', () => {
  // The explainer's own scripts (apps/web/public/examples, apps/web/build/examples-copy.mjs) are no bundler chunk.
  const graph = { firstPaint: new Set(['index.html', 'assets/index-a.js', 'assets/web-b.js', 'join/index.html', 'join/assets/join-a.js', 'desk/index.html', 'desk/assets/desk-a.js']), lazy: new Set(['assets/BoxPage-c.js', 'assets/TradeSlot-d.js', 'join/assets/privy-b.js']) };
  const COPY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'examples');
  const SCRIPTS = Object.keys((JSON.parse(readFileSync(EXAMPLES_MANIFEST, 'utf8')) as { files: Record<string, unknown> }).files).filter((name) => /\.js$/.test(name));
  const TARGETS = ['mainnet', 'sepolia'] as const;
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  /** The examples' scripts as committed, beside a site's own files. */
  const addScripts = (out: string) => {
    for (const name of SCRIPTS) {
      mkdirSync(dirname(join(out, 'examples', name)), { recursive: true });
      cpSync(join(COPY, name), join(out, 'examples', name));
    }
  };
  const site = (target: 'mainnet' | 'sepolia') => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-examples-')));
    const out = join(dir, 'check', 'dist');
    const chunks = writeSite(out, target);
    addScripts(out);
    return { out, chunks };
  };
  /** A manifest of the test's own, outside the build. */
  let manifests = 0;
  const manifestAt = (text: string) => {
    manifests += 1;
    const path = join(dir as string, `examples-manifest-${manifests}.json`);
    writeFileSync(path, text);
    return path;
  };

  it('accepts the 12 scripts as committed, on both targets, and counts them in its line', () => {
    expect(SCRIPTS.length).toBe(12);
    for (const target of TARGETS) {
      const { out, chunks } = site(target);
      const judged = judgeModules(chunks, target, graph, out, 'modules');
      expect(judged.ok, `${target}: ${judged.lines.join('\n')}`).toBe(true);
      expect(judged.examples).toBe(12);
      expect(judged.lines[1]).toBe('modules: 12 scripts outside the module list accepted by the examples manifest');
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('refuses a script under examples/ that the manifest does not list, by its name', () => {
    for (const target of TARGETS) {
      const { out, chunks } = site(target);
      writeFileSync(join(out, 'examples', 'extra.js'), 'export {};');
      const judged = judgeModules(chunks, target, graph, out, 'modules');
      expect(judged.ok).toBe(false);
      expect(judged.lines).toContain('modules: examples/extra.js is no chunk of this build and the examples manifest does not list it');
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('refuses a listed script whose bytes differ by one byte, by its name', () => {
    for (const target of TARGETS) {
      const { out, chunks } = site(target);
      const file = join(out, 'examples', 'follow', 'rent-free.js');
      const bytes = readFileSync(file);
      bytes[10] = (bytes[10] ?? 0) ^ 1;
      writeFileSync(file, bytes);
      const judged = judgeModules(chunks, target, graph, out, 'modules');
      expect(judged.ok).toBe(false);
      expect(judged.lines.some((line) => line.startsWith('modules: examples/follow/rent-free.js is no chunk of this build and its bytes are not the ones the examples manifest lists'))).toBe(true);
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('refuses a script outside examples/ that is no chunk, as before, the examples’ own still counted', () => {
    for (const target of TARGETS) {
      const { out, chunks } = site(target);
      writeFileSync(join(out, 'assets', 'late-f.js'), 'export {};');
      mkdirSync(join(out, 'examplesx'), { recursive: true });
      writeFileSync(join(out, 'examplesx', 'follow.js'), readFileSync(join(COPY, 'follow.js')));
      const judged = judgeModules(chunks, target, graph, out, 'modules');
      expect(judged.ok).toBe(false);
      expect(judged.lines[0]).toContain('scripts it does not list: assets/late-f.js, examplesx/follow.js;');
      expect(judged.examples).toBe(12);
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('refuses a manifest whose entry leaves examples/: no script outside the module list is accepted then', () => {
    const { out, chunks } = site('sepolia');
    for (const name of ['../assets/index-a.js', '/etc/x.js', 'follow/../../x.js', './follow.js', 'follow//x.js', 'a\\b.js']) {
      const examples = exampleScriptsOf(manifestAt(JSON.stringify({ files: { [name]: { sha256: 'a'.repeat(64) } } })));
      expect(examples.ok, name).toBe(false);
      if (!examples.ok) expect(examples.problem, name).toContain(`names ${JSON.stringify(name)}, a path that leaves examples/`);
      const judged = judgeModules(chunks, 'sepolia', graph, out, 'modules', undefined, examples);
      expect(judged.ok, name).toBe(false);
      expect(judged.lines[0], name).toContain(JSON.stringify(name));
      expect(judged.examples, name).toBe(0);
    }
  });

  it('fails closed on a manifest that is missing, does not parse or is malformed, on both targets', () => {
    for (const target of TARGETS) {
      const { out, chunks } = site(target);
      const cases: ReadonlyArray<readonly [string, string]> = [
        [join(dir as string, 'no-such-manifest.json'), 'is missing or does not parse'],
        [manifestAt('{ "files": '), 'is missing or does not parse'],
        [manifestAt('{"files":[]}'), 'lists no files'],
        [manifestAt('{"files":{"follow.js":{}}}'), 'gives follow.js no SHA-256'],
      ];
      for (const [path, problem] of cases) {
        const judged = judgeModules(chunks, target, graph, out, 'modules', undefined, exampleScriptsOf(path));
        expect(judged.ok, `${target}: ${problem}`).toBe(false);
        expect(judged.lines[0], `${target}: ${problem}`).toContain(problem);
        expect(judged.lines[0]).toContain('so no script outside the module list can be accepted');
        expect(judged.lines.join('\n')).toMatch(/scripts it does not list: examples\/follow\/bag-holders\.js, .*examples\/follow\.js, examples\/pager\.js;/);
      }
      // Fail closed even with no example script in the build at all.
      rmSync(join(out, 'examples'), { recursive: true, force: true });
      expect(judgeModules(chunks, target, graph, out, 'modules', undefined, exampleScriptsOf(join(dir as string, 'no-such-manifest.json'))).ok).toBe(false);
      rmSync(dir as string, { recursive: true, force: true });
      dir = null;
    }
  });

  it('reads the committed manifest, never one in the build it judges', () => {
    const { out, chunks } = site('mainnet');
    writeFileSync(join(out, 'examples', 'extra.js'), 'export {};');
    writeFileSync(join(out, 'examples', 'examples-manifest.json'), JSON.stringify({ files: { 'extra.js': { sha256: createHash('sha256').update('export {};').digest('hex') } } }));
    expect(judgeModules(chunks, 'mainnet', graph, out, 'modules').lines).toContain('modules: examples/extra.js is no chunk of this build and the examples manifest does not list it');
  });

  it('a forbidden marker inside an examples script is still found by the content scan', () => {
    const { out } = site('mainnet');
    const file = join(out, 'examples', 'follow.js');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nconst s = 'sh-trade-slot-f156';\n`);
    const found = scanDirectory(out).filter((finding) => finding.file === join('examples', 'follow.js'));
    expect(found.map((finding) => [finding.rule, finding.match])).toEqual([['trade', 'sh-trade-slot-f156']]);
  });

  it('in the check on both targets: the build and its twin accept them, and the verdict line counts them', () => {
    for (const target of TARGETS) {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-examples-')));
      const out = join(dir, 'check', 'dist');
      const run = stubDeps(target, (folder, built) => {
        const chunks = writeSite(folder, built);
        addScripts(folder);
        return chunks;
      }, dir);
      expect(runCheck(['--out', out], run.deps), `${target}: ${run.errors.join('\n')}`).toBe(0);
      expect(run.warned.filter((line) => line.startsWith('modules, ') && line.endsWith(': 12 scripts outside the module list accepted by the examples manifest'))).toHaveLength(2);
      expect(run.warned.at(-1)).toMatch(new RegExp(`^check:production: \\d+ shipped files \\(${target}\\), .*; 12 scripts outside the module list accepted by the examples manifest; `));
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  }, shLimit(60_000));
});

describe('fix round af1, F3: the run itself, its twin and its exit code', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const folders = () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af1-')));
    return { web: dir, out: join(dir, 'check', 'dist') };
  };

  it('builds the caller’s target, then the other target into its run, and passes when both are clean', () => {
    const { web, out } = folders();
    const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built), web);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
    const latest = latestRun(out, web);
    // SH-203: then its own target again with --mode test (the seam build), in the same run.
    expect(run.builds).toEqual([[out, {}], [twinOf(latest, 'mainnet').out, { SH_TARGET: 'mainnet' }], [seamOf(latest).out, {}]]);
    // Fix round af3: the caller's build as it ships, its records in the new run; the twin's role, inside that run.
    expect(run.roles).toEqual([['build', latest], ['twin', twinOf(latest, 'mainnet').record], ['seam', seamOf(latest).record]]);
    expect(run.warned).toContain('trade, this sepolia build: 2 trade markers, all in lazily loaded chunks (assets/TradeSlot-d.js, join/assets/privy-b.js), the trade slot among them');
    expect(run.warned).toContain('alpha, this sepolia build: the join and desk pages, no stand-in');
    expect(run.warned.some((line) => line.startsWith('alpha, the mainnet twin (') && line.endsWith('): no alpha page, call or stand-in'))).toBe(true);
    expect(run.warned.some((line) => line.startsWith('trade, the mainnet twin (') && line.endsWith('): no trade marker'))).toBe(true);
    expect(run.warned.some((line) => line.startsWith('modules, the mainnet twin (') && line.endsWith('none from a trade folder'))).toBe(true);
  });

  it('(a) a clean Sepolia build with a leaking mainnet twin exits 1: by a marker, or by a module alone', () => {
    for (const leak of ['marker', 'module'] as const) {
      const { web, out } = folders();
      const run = stubDeps('sepolia', (folder, built) => built === 'mainnet'
        ? writeSite(folder, built, leak === 'marker' ? { 'assets/index-a.js': 'import{t as e}from"./web-b.js";e(`0x8945257c`);' } : {}, leak === 'module' ? { 'assets/web-b.js': [MODULE('packages/chain/src/trade-sepolia/guard.ts')] } : {})
        : writeSite(folder, built), web);
      expect(runCheck(['--out', out], run.deps), leak).toBe(1);
      expect(run.errors.some((line) => line.includes('the mainnet twin')), leak).toBe(true);
      expect(run.errors.at(-1), leak).toContain('the mainnet twin fails the trade rule');
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  it('(b) a twin that is never built fails, and a twin an earlier run left cannot stand in: every run is a new folder', () => {
    const { web, out } = folders();
    const nothing = stubDeps('sepolia', (folder, built) => (built === 'mainnet' ? [] : writeSite(folder, built)), web);
    expect(runCheck(['--out', out], nothing.deps)).toBe(1);
    expect(nothing.errors.some((line) => line.includes('not built (no index.html)'))).toBe(true);
    // A clean run leaves a whole twin in its folder; the next run's twin build writes nothing, in a new folder.
    const clean = stubDeps('sepolia', (folder, built) => writeSite(folder, built), web);
    expect(runCheck(['--out', out], clean.deps)).toBe(0);
    const earlier = twinOf(latestRun(out, web), 'mainnet').out;
    expect(existsSync(join(earlier, 'index.html'))).toBe(true);
    const stale = stubDeps('sepolia', (folder, built) => (built === 'mainnet' ? [] : writeSite(folder, built)), web);
    expect(runCheck(['--out', out], stale.deps)).toBe(1);
    expect(stale.errors.some((line) => line.includes('not built (no index.html)'))).toBe(true);
    // The earlier twin is still where it was: nothing is deleted, and nothing old stands in for the new run.
    expect(existsSync(join(earlier, 'index.html'))).toBe(true);
    expect(existsSync(join(twinOf(latestRun(out, web), 'mainnet').out, 'index.html'))).toBe(false);
  });

  it('(c) the twin’s own verdict decides: the same clean build passes or fails by its twin alone, either target', () => {
    for (const target of ['mainnet', 'sepolia'] as const) {
      const other = target === 'mainnet' ? 'sepolia' : 'mainnet';
      const verdict = (twinLeaks: boolean) => {
        const { web, out } = folders();
        // A leaking Sepolia twin carries a marker at first paint; a leaking mainnet twin a lazy slot (both out of place).
        const leak: Record<string, string> = other === 'sepolia' ? { 'assets/web-b.js': 'export const t=()=>import(`./BoxPage-c.js`),k=`trade-sepolia`;' } : { 'assets/TradeSlot-d.js': 'var t=`sh-trade-slot-f156`;export{t};' };
        const run = stubDeps(target, (folder, built) => writeSite(folder, built, built === other && twinLeaks ? leak : {}), web);
        const code = runCheck(['--out', out], run.deps);
        rmSync(dir as string, { recursive: true, force: true });
        return code;
      };
      expect([verdict(false), verdict(true)], target).toEqual([0, 1]);
    }
  });

  it('--no-build builds nothing, says the twin went unchecked, and needs the module list its build left in its run', () => {
    const { web, out } = folders();
    expect(runCheck(['--out', out], stubDeps('sepolia', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    const run = stubDeps('sepolia', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build'], run.deps), run.errors.join('\n')).toBe(0);
    expect(run.builds).toEqual([]);
    expect(run.warned).toContain('trade, the mainnet twin: neither built nor checked (--no-build)');
    rmSync(listOf(latestRun(out, web)));
    const missing = stubDeps('sepolia', () => [], web);
    expect(runCheck(['--out', out, '--no-build'], missing.deps)).toBe(1);
    expect(missing.errors.some((line) => line.startsWith('modules, this sepolia build: no module list in the run the pointer names'))).toBe(true);
    // Fix round af2, F1: nothing of the check's lies next to --out.
    expect(readdirSync(dirname(out)).sort()).toEqual(['dist']);
  });
});

// --- fix round af2 (XR2-ALPHA-SWITCH) --------------------------------------------------------------------------------

describe('fix round af2, F1 (and af3, F1): the check writes only its own folders, and deletes nothing', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const path of dirs) rmSync(path, { recursive: true, force: true });
    dirs = [];
  });
  const temp = (name: string) => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), `sh-production-af2-${name}-`)));
    dirs.push(path);
    return path;
  };
  const sentinel = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not the check’s\n');
    return path;
  };

  it('files where round 1 kept its maps and twins, next to --out, survive a good build and a failed one', () => {
    const web = temp('web');
    const out = join(web, 'x', 'dist');
    const kept = [join(web, 'x', 'maps', 'dist', 'unrelated.txt'), join(web, 'x', 'twin-mainnet', 'dist', 'unrelated.txt'), join(web, 'x', 'twin-sepolia', 'dist', 'unrelated.txt')].map(sentinel);
    expect(runCheck(['--out', out], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    for (const path of kept) expect(readFileSync(path, 'utf8'), path).toBe('not the check’s\n');
    const failing = stubDeps('mainnet', () => { throw new Error('the build failed before it wrote anything'); }, web);
    expect(() => runCheck(['--out', out], failing.deps)).toThrow('the build failed before it wrote anything');
    for (const path of kept) expect(readFileSync(path, 'utf8'), path).toBe('not the check’s\n');
    // What the check wrote is in its root: a run folder for the good build, one for the failed one, and the pointer.
    expect(readdirSync(join(homeOf(web).owned, 'runs'))).toHaveLength(2);
    expect(existsSync(listOf(latestRun(out, web)))).toBe(true);
    expect(readdirSync(join(web, 'x')).sort()).toEqual(['dist', 'maps', 'twin-mainnet', 'twin-sepolia']);
  });

  it('fix round af3: every run is a new folder; earlier runs, and anything else in the root, stay as they are', () => {
    const web = temp('web');
    const out = join(web, 'x', 'dist');
    const run = () => runCheck(['--out', out], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web).deps);
    expect(run()).toBe(0);
    const first = latestRun(out, web);
    const firstList = readFileSync(listOf(first), 'utf8');
    const theirs = sentinel(join(homeOf(web).owned, 'runs', 'theirs', 'keep.txt'));
    const loose = sentinel(join(first, 'old.txt'));
    expect(run()).toBe(0);
    const second = latestRun(out, web);
    expect(second).not.toBe(first);
    expect(readFileSync(listOf(first), 'utf8')).toBe(firstList);
    for (const path of [theirs, loose]) expect(readFileSync(path, 'utf8'), path).toBe('not the check’s\n');
    expect(existsSync(join(twinOf(first, 'sepolia').out, 'index.html'))).toBe(true);
    expect(readdirSync(join(homeOf(web).owned, 'runs')).sort()).toEqual([basename(first), basename(second), 'theirs'].sort());
    // The pointer was replaced in one rename: no temporary file is left beside it.
    expect(readdirSync(dirname(pointerOf(out, homeOf(web))))).toEqual([basename(pointerOf(out, homeOf(web)))]);
    expect(JSON.parse(readFileSync(pointerOf(out, homeOf(web)), 'utf8'))).toEqual({ schema: POINTER, out: 'x/dist', run: basename(second) });
  });

  it('fix round af3: no code path of the check deletes, the pointer is replaced in one rename, the twin is never emptied', () => {
    const source = readFileSync(join(REPO, 'apps/web/production-check.ts'), 'utf8');
    const fsImport = /import \{([^}]*)\} from 'node:fs';/.exec(source)?.[1] ?? '';
    expect(fsImport.length).toBeGreaterThan(0);
    for (const name of ['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync']) expect(fsImport.split(',').map((part) => part.trim()), name).not.toContain(name);
    expect(source).not.toMatch(/\b(?:rmSync|rmdirSync|unlinkSync|rimraf)\b|\bfs\.(?:promises|rm|unlink)\b|node:fs\/promises/);
    // The pointer is replaced in one rename of a file written exclusively beside it, never written in place.
    const writer = source.slice(source.indexOf('export function writePointer('), source.indexOf('\n}\n', source.indexOf('export function writePointer(')));
    expect(writer).toMatch(/writeFileSync\(temporary, [^\n]*\{ flag: 'wx' \}\);\n\s*renameSync\(temporary, pointer\);/);
    expect(writer).not.toMatch(/writeFileSync\(pointer\b/);
    expect(buildOptionsOf('twin', '/x')).toEqual({ sourcemap: false, outDir: '/x', emptyOutDir: false, copyPublicDir: false });
    // SH-203: the seam build is built as the twin is, inside its run, never emptied.
    expect(buildOptionsOf('seam', '/x')).toEqual({ sourcemap: false, outDir: '/x', emptyOutDir: false, copyPublicDir: false });
    // The caller's --out is built as the shipped build is: Vite empties it itself, as it did at dd6e1af75.
    expect(buildOptionsOf('build', '/x')).toEqual({ sourcemap: 'hidden', outDir: '/x', emptyOutDir: true });
  });

  it('fix round af3: a pointer from another output is refused, and so is one naming another output’s run or no run', () => {
    const web = temp('web');
    const a = join(web, 'a', 'dist');
    const b = join(web, 'b', 'dist');
    for (const out of [a, b]) expect(runCheck(['--out', out], stubDeps('sepolia', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    const again = () => {
      const run = stubDeps('sepolia', () => { throw new Error('no build expected'); }, web);
      return { code: runCheck(['--out', b, '--no-build'], run.deps), errors: run.errors.join('\n') };
    };
    expect(again().code).toBe(0);
    const runA = latestRun(a, web);
    const runB = latestRun(b, web);
    const pointerA = readFileSync(pointerOf(a, homeOf(web)), 'utf8');
    const pointerB = readFileSync(pointerOf(b, homeOf(web)), 'utf8');
    // A's pointer put in B's place.
    writeFileSync(pointerOf(b, homeOf(web)), pointerA);
    expect(again()).toMatchObject({ code: 1, errors: expect.stringContaining('the pointer is for a/dist, not b/dist') });
    // B's own pointer, but naming A's run.
    writeFileSync(pointerOf(b, homeOf(web)), JSON.stringify({ schema: POINTER, out: 'b/dist', run: basename(runA) }));
    expect(again()).toMatchObject({ code: 1, errors: expect.stringContaining('not a run made for this output') });
    // A run name of the right form that does not exist, and no pointer at all.
    writeFileSync(pointerOf(b, homeOf(web)), JSON.stringify({ schema: POINTER, out: 'b/dist', run: `${basename(runB).slice(0, -6)}ZZZZZZ` }));
    expect(again()).toMatchObject({ code: 1, errors: expect.stringContaining('no folder of the check') });
    writeFileSync(pointerOf(b, homeOf(web)), pointerB);
    expect(again().code).toBe(0);
    // A's run's list put in B's run: it says it describes a/dist.
    writeFileSync(listOf(runB), readFileSync(listOf(runA)));
    expect(again()).toMatchObject({ code: 1, errors: expect.stringContaining('written for a/dist, not b/dist') });
  });

  it('a link cannot lead it out: neither a linked parent of its root nor a linked run', () => {
    const web = temp('web');
    const outside = temp('outside');
    const kept = sentinel(join(outside, 'production-check', 'runs', 'keep.txt'));
    // apps/web/.cache as a link to a folder outside apps/web.
    symlinkSync(outside, join(web, '.cache'));
    expect(() => runCheck(['--out', join(web, 'x', 'dist')], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web).deps)).toThrow(/production-check is a link|\.cache is a link/);
    expect(readFileSync(kept, 'utf8')).toBe('not the check’s\n');
    expect(readdirSync(join(outside, 'production-check', 'runs'))).toEqual(['keep.txt']);
    // The same link to an empty folder outside: refused before anything is made there.
    const web3 = temp('web3');
    const empty = temp('empty');
    symlinkSync(empty, join(web3, '.cache'));
    expect(() => runCheck(['--out', join(web3, 'x', 'dist')], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web3).deps)).toThrow(/production-check is a link|\.cache is a link/);
    expect(readdirSync(empty)).toEqual([]);
    // A pointer that names a run which is a link to a folder outside: refused, nothing read or written there.
    const web2 = temp('web2');
    const out = join(web2, 'x', 'dist');
    expect(runCheck(['--out', out], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web2).deps)).toBe(0);
    const linked = `${latestRun(out, web2).slice(0, -6)}LINKED`;
    symlinkSync(outside, linked);
    writeFileSync(pointerOf(out, homeOf(web2)), JSON.stringify({ schema: POINTER, out: 'x/dist', run: basename(linked) }));
    const run = stubDeps('mainnet', () => { throw new Error('no build expected'); }, web2);
    expect(runCheck(['--out', out, '--no-build'], run.deps)).toBe(1);
    expect(run.errors.join('\n')).toContain('no folder of the check');
    expect(readdirSync(outside).sort()).toEqual(['production-check']);
  });

  it('fix round af4, F1: a linked pointers folder, even one that stays inside apps/web, is refused before anything is made', () => {
    // The reviewer's case: pointers/ links to a folder of apps/web the check does not own, holding a file of the pointer's name.
    const web = temp('web');
    const out = join(web, 'x', 'dist');
    const owned = homeOf(web).owned;
    mkdirSync(owned, { recursive: true });
    const unowned = join(web, 'unowned');
    const kept = sentinel(join(unowned, basename(pointerOf(out, homeOf(web)))));
    symlinkSync(unowned, join(owned, 'pointers'));
    const run = stubDeps('mainnet', (folder, built) => writeSite(folder, built), web);
    expect(() => runCheck(['--out', out], run.deps)).toThrow(/production-check\/pointers is a link/);
    expect(readFileSync(kept, 'utf8')).toBe('not the check’s\n');
    expect(readdirSync(unowned)).toEqual([basename(kept)]);
    // Refused before the build and before any folder of the check's was made.
    expect(run.builds).toEqual([]);
    expect(readdirSync(owned)).toEqual(['pointers']);
  });

  it('fix round af4, F1: a runs folder linked to another root’s runs is refused on --no-build, with that root’s pointer', () => {
    // The reviewer's case: a nested root inside apps/web checks the same output path; the outer root's runs/ links to
    // the nested root's runs, its pointer is copied, and the output holds the same bytes.
    const web = temp('web');
    const nested = join(web, 'n');
    mkdirSync(nested);
    const nestedOut = join(nested, 'x', 'dist');
    expect(runCheck(['--out', nestedOut], stubDeps('mainnet', (folder, built) => writeSite(folder, built), nested).deps)).toBe(0);
    const out = join(web, 'x', 'dist');
    cpSync(nestedOut, out, { recursive: true });
    const owned = homeOf(web).owned;
    mkdirSync(join(owned, 'pointers'), { recursive: true });
    symlinkSync(join(homeOf(nested).owned, 'runs'), join(owned, 'runs'));
    cpSync(pointerOf(nestedOut, homeOf(nested)), pointerOf(out, homeOf(web)));
    const again = stubDeps('mainnet', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build'], again.deps)).toBe(1);
    expect(again.errors.join('\n')).toContain('production-check/runs is a link');
    // A run's own records are read only as plain files and folders: a module list that is a link is refused too.
    const web2 = temp('web2');
    const out2 = join(web2, 'x', 'dist');
    expect(runCheck(['--out', out2], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web2).deps)).toBe(0);
    const list = listOf(latestRun(out2, web2));
    const elsewhere = join(web2, 'elsewhere.json');
    cpSync(list, elsewhere);
    rmSync(list);
    symlinkSync(elsewhere, list);
    const linked = stubDeps('mainnet', () => { throw new Error('no build expected'); }, web2);
    expect(runCheck(['--out', out2, '--no-build'], linked.deps)).toBe(1);
    expect(linked.errors.join('\n')).toContain("the run's module list is a link");
    // And a pointer that is a link to a copy of itself.
    const web3 = temp('web3');
    const out3 = join(web3, 'x', 'dist');
    expect(runCheck(['--out', out3], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web3).deps)).toBe(0);
    const pointer = pointerOf(out3, homeOf(web3));
    const copy = join(web3, 'pointer-copy.json');
    cpSync(pointer, copy);
    rmSync(pointer);
    symlinkSync(copy, pointer);
    const viaLink = stubDeps('mainnet', () => { throw new Error('no build expected'); }, web3);
    expect(runCheck(['--out', out3, '--no-build'], viaLink.deps)).toBe(1);
    expect(viaLink.errors.join('\n')).toMatch(/the pointer \.cache\/production-check\/pointers\/dist-[0-9a-f]{16}\.json is a link/);
  });

  it('fix round af4, F1: a pointer names only a run of the check’s: a folder elsewhere, or a link inside runs/, is refused', () => {
    const web = temp('web');
    const out = join(web, 'x', 'dist');
    expect(runCheck(['--out', out], stubDeps('mainnet', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    const before = readFileSync(pointerOf(out, homeOf(web)), 'utf8');
    const elsewhere = join(web, 'elsewhere');
    mkdirSync(elsewhere);
    expect(() => writePointer(out, elsewhere, homeOf(web))).toThrow(/is no run of the check's/);
    const linked = join(homeOf(web).owned, 'runs', `${basename(latestRun(out, web)).slice(0, -6)}LINKED`);
    symlinkSync(elsewhere, linked);
    expect(() => writePointer(out, linked, homeOf(web))).toThrow(/is no run of the check's/);
    expect(readFileSync(pointerOf(out, homeOf(web)), 'utf8')).toBe(before);
  });

  it('refuses an --out outside apps/web by its real path, apps/web itself, its own folders and the check’s root', () => {
    const web = temp('web');
    const outside = temp('outside');
    const home = homeOf(web);
    expect(outOf(join(web, '.production', 'check', 'dist'), home)).toBe(join(web, '.production', 'check', 'dist'));
    expect(() => outOf(join(outside, 'dist'), home)).toThrow('--out must lie inside');
    expect(() => outOf(web, home)).toThrow('--out must lie inside');
    for (const name of ['src', 'public', 'e2e', 'functions', 'fit-markets', 'node_modules']) expect(() => outOf(join(web, name, 'dist'), home), name).toThrow('--out may not be, hold or lie inside');
    expect(() => outOf(join(web, '.cache'), home)).toThrow('--out may not be, hold or lie inside');
    expect(() => outOf(join(home.owned, 'runs', 'x'), home)).toThrow('--out may not be, hold or lie inside');
    // A link inside apps/web that leads outside it.
    symlinkSync(outside, join(web, 'escape'));
    expect(() => outOf(join(web, 'escape', 'dist'), home)).toThrow('--out must lie inside');
    // Nothing was built or written for a refused --out.
    expect(() => runCheck(['--out', join(outside, 'dist')], stubDeps('mainnet', () => { throw new Error('no build expected'); }, web).deps)).toThrow('--out must lie inside');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('the release’s two processes: the second, with --no-build and --same-as, finds what the first wrote, from --out alone', () => {
    const web = temp('web');
    const out = join(web, '.production', 'check', 'dist');
    expect(runCheck(['--out', out], stubDeps('sepolia', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    const shipped = join(temp('upload'), 'public');
    cpSync(out, shipped, { recursive: true });
    const second = stubDeps('sepolia', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build', '--same-as', shipped], second.deps), second.errors.join('\n')).toBe(0);
    expect(second.warned.at(-1)).toContain('is the scanned build, file for file');
  });
});

describe('fix round af2, F2: the module list vouches only for the files it hashed, for its target', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const built = (target: 'mainnet' | 'sepolia') => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af2-')));
    const out = join(dir, 'check', 'dist');
    expect(runCheck(['--out', out], stubDeps(target, (folder, which) => writeSite(folder, which), dir).deps)).toBe(0);
    return { web: dir, out, record: latestRun(out, dir) };
  };
  const again = (web: string, out: string, target: 'mainnet' | 'sepolia') => {
    const run = stubDeps(target, () => { throw new Error('no build expected'); }, web);
    return { code: runCheck(['--out', out, '--no-build'], run.deps), errors: run.errors };
  };

  it('the list names every file with its SHA-256, the target and its schema', () => {
    const { out, record } = built('sepolia');
    const list = readModuleList(listOf(record));
    expect(list?.schema).toBe(MODULE_LIST);
    expect(list?.target).toBe('sepolia');
    expect(Object.keys(list?.files ?? {}).sort()).toEqual(['assets/BoxPage-c.js', 'assets/TradeSlot-d.js', 'assets/index-a.js', 'assets/web-b.js', 'desk/assets/desk-a.js', 'desk/assets/third-party-notices.txt', 'desk/index.html', 'index.html', 'join/assets/join-a.js', 'join/assets/privy-b.js', 'join/assets/third-party-notices.txt', 'join/index.html', 'third-party-notices.txt']);
    expect(list?.files['index.html']).toMatch(/^[0-9a-f]{64}$/);
    expect(listMismatches(list as NonNullable<typeof list>, out, 'sepolia', homeOf(dir as string))).toEqual([]);
    expect(list?.out).toBe(outPathOf(out, homeOf(dir as string)));
    // Written once: a run is new for every build, so a second list there is refused.
    expect(() => writeModuleList(record, out, 'sepolia', [], homeOf(dir as string))).toThrow(/EEXIST/);
  });

  it('the reviewer’s case: the same name with other, marker-free bytes fails --no-build; so does a file added, one gone, another target or schema', () => {
    const { web, out, record } = built('mainnet');
    expect(again(web, out, 'mainnet').code).toBe(0);
    writeFileSync(join(out, 'assets', 'index-a.js'), 'import{t as e}from"./web-b.js";e(1);');
    const changed = again(web, out, 'mainnet');
    expect(changed.code).toBe(1);
    expect(changed.errors.join('\n')).toContain("modules, this mainnet build: the module list is not this folder's build: assets/index-a.js changed");
    writeFileSync(join(out, 'assets', 'index-a.js'), 'import{t as e}from"./web-b.js";e();');
    expect(again(web, out, 'mainnet').code).toBe(0);
    writeFileSync(join(out, 'assets', 'extra.txt'), 'x');
    expect(again(web, out, 'mainnet').errors.join('\n')).toContain('assets/extra.txt was added');
    rmSync(join(out, 'assets', 'extra.txt'));
    rmSync(join(out, 'assets', 'BoxPage-c.js'));
    expect(again(web, out, 'mainnet').errors.join('\n')).toContain('assets/BoxPage-c.js is gone');
    writeSite(out, 'mainnet');
    expect(again(web, out, 'mainnet').code).toBe(0);
    expect(again(web, out, 'sepolia').errors.join('\n')).toContain('written for the mainnet target, not sepolia');
    const list = readModuleList(listOf(record));
    writeFileSync(listOf(record), JSON.stringify({ ...list, schema: 'squarehole.production-check.modules/1' }));
    expect(again(web, out, 'mainnet').errors.join('\n')).toContain(`written as squarehole.production-check.modules/1, not ${MODULE_LIST}`);
  });
});

describe('fix round af2, addendum: what the check writes holds no personal path', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const walkFiles = (folder: string): string[] => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  it('module ids are written repository-relative, by kind; virtual and other ids as they are; an outside path only as a hash', () => {
    expect(moduleIdOf(MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx'))).toBe('repo:apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(moduleIdOf(MODULE('apps/web/src/x.css?inline'))).toBe('repo:apps/web/src/x.css?inline');
    expect(moduleIdOf(MODULE('node_modules/.pnpm/react@19.3.0/node_modules/react/index.js'))).toBe('dependency:node_modules/.pnpm/react@19.3.0/node_modules/react/index.js');
    expect(moduleIdOf('\0vite/preload-helper.js')).toBe('virtual:vite/preload-helper.js');
    expect(moduleIdOf('react')).toBe('external:react');
    expect(moduleIdOf('/' + 'Us' + 'ers/someone/elsewhere/x.js')).toMatch(/^outside:[0-9a-f]{16}$/);
    expect(moduleIdOf('repo:apps/web/src/main.tsx')).toBe('repo:apps/web/src/main.tsx');
    // The trade rule reads the written form as it reads a path, a workspace link in node_modules included.
    expect(tradeModuleOf('repo:apps/web/src/features/trade-sepolia/TradeSlot.tsx')).toBe('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(tradeModuleOf(MODULE('node_modules/@squarehole/chain/src/trade-sepolia/guard.ts'))).toBe('node_modules/@squarehole/chain/src/trade-sepolia/guard.ts');
    expect(tradeModuleOf('virtual:trade-sepolia/x')).toBeNull();
  });

  it('fix round af3, F4: a virtual id with a path in it, and an id that only looks written, are written without the root', () => {
    // The reviewer's case: NUL, the absolute root, a query (the CommonJS proxies name their files so).
    expect(moduleIdOf(`\0${MODULE('node_modules/.pnpm/x/index.js')}?commonjs-proxy`)).toBe('virtual:dependency:node_modules/.pnpm/x/index.js?commonjs-proxy');
    expect(moduleIdOf(`\0${MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx')}?commonjs-proxy`)).toBe('virtual:repo:apps/web/src/features/trade-sepolia/TradeSlot.tsx?commonjs-proxy');
    expect(tradeModuleOf(`\0${MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx')}?commonjs-proxy`)).toBe('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(moduleIdOf('\0/opt/elsewhere/x.js')).toMatch(/^virtual:outside:[0-9a-f]{16}$/);
    // The root inside another virtual id, or in a query: written <repo>, the rest kept (a trade file keeps its name).
    expect(moduleIdOf(`\0virtual:${MODULE('y.js')}`)).toBe('virtual:virtual:<repo>/y.js');
    const queried = `${MODULE('apps/web/src/features/trade-sepolia/TradeSlot.tsx')}?importer=${MODULE('apps/web/src/a.ts')}`;
    expect(moduleIdOf(queried)).toBe('repo:apps/web/src/features/trade-sepolia/TradeSlot.tsx?importer=<repo>/apps/web/src/a.ts');
    expect(tradeModuleOf(queried)).toBe('apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(moduleIdOf(`plugin:${homedir()}/elsewhere/v.js`)).toBe('external:plugin:<home>/elsewhere/v.js');
    // Written-looking ids are checked, not trusted.
    expect(moduleIdOf(`repo:${MODULE('apps/web/src/x.ts')}`)).toBe('repo:apps/web/src/x.ts');
    expect(moduleIdOf(`virtual:${MODULE('z.js')}?commonjs-exports`)).toBe('virtual:repo:z.js?commonjs-exports');
    expect(moduleIdOf(`virtual:\0${MODULE('q.js')}`)).toBe('virtual:repo:q.js');
    expect(moduleIdOf(`external:file://${MODULE('w.js')}`)).toBe('repo:w.js');
    expect(moduleIdOf('repo:../../etc/passwd')).toBe('external:../../etc/passwd');
    expect(moduleIdOf('repo:node_modules/x/index.js')).toBe('external:node_modules/x/index.js');
    expect(moduleIdOf('outside:not-a-hash')).toBe('external:not-a-hash');
    expect(moduleIdOf(`plugin:${MODULE('v.js')}`)).toBe('external:plugin:<repo>/v.js');
    // The builder writes the ids and the check writes them again: the second time changes nothing.
    for (const id of ODD_IDS) expect(moduleIdOf(moduleIdOf(id)), JSON.stringify(id)).toBe(moduleIdOf(id));
  });

  it('fix round af3, F4: a run whose bundler hands back such ids writes no file that holds the root', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af3-')));
    const out = join(dir, 'check', 'dist');
    // The trade file with the root in its query goes where Sepolia allows it, the lazy slot chunk; the rest at first paint.
    const trade = ODD_IDS.filter((id) => tradeModuleOf(id) !== null);
    expect(trade).toHaveLength(1);
    const modules = (built: 'mainnet' | 'sepolia', tradeAt: string) => ({ 'assets/web-b.js': ODD_IDS.filter((id) => !trade.includes(id)), ...(built === 'sepolia' ? { [tradeAt]: trade } : {}) });
    const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built, {}, modules(built, 'assets/TradeSlot-d.js')), dir);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
    // Its name survives the writing: put at first paint, the module list still finds it.
    const misplaced = stubDeps('sepolia', (folder, built) => writeSite(folder, built, {}, modules(built, 'assets/web-b.js')), dir);
    expect(runCheck(['--out', join(dir, 'other', 'dist')], misplaced.deps)).toBe(1);
    expect(misplaced.errors).toContain('modules, this sepolia build: trade module assets/web-b.js ← apps/web/src/features/trade-sepolia/TradeSlot.tsx (first paint, not a lazily loaded chunk)');
    const written = walkFiles(homeOf(dir).owned);
    expect(written.length).toBeGreaterThan(3);
    for (const file of written) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes(REPO), file).toBe(false);
      expect(text.includes(homedir()), file).toBe(false);
    }
    const ids = readModuleList(listOf(latestRun(out, dir)))?.chunks.flatMap((chunk) => chunk.moduleIds) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['virtual:dependency:node_modules/.pnpm/x/index.js?commonjs-proxy', 'virtual:virtual:<repo>/y.js', 'repo:apps/web/src/x.ts', 'repo:w.js', 'external:plugin:<repo>/v.js', 'external:plugin:<home>/elsewhere/v.js']));
  });

  it('no file the check writes, its module list included, holds the repository’s absolute root', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-af2-')));
    const out = join(dir, 'check', 'dist');
    // The stand-in builds hand back absolute ids, as the bundler does.
    expect(runCheck(['--out', out], stubDeps('sepolia', (folder, built) => writeSite(folder, built), dir).deps)).toBe(0);
    expect(runCheck(['--out', out, '--no-build'], stubDeps('sepolia', () => { throw new Error('no build expected'); }, dir).deps)).toBe(0);
    const written = walkFiles(homeOf(dir).owned);
    expect(written.length).toBeGreaterThan(2);
    for (const file of written) expect(readFileSync(file, 'utf8').includes(REPO), file).toBe(false);
    const list = readModuleList(listOf(latestRun(out, dir)));
    expect(list?.chunks.flatMap((chunk) => chunk.moduleIds)).toContain('repo:apps/web/src/features/trade-sepolia/TradeSlot.tsx');
    expect(list?.chunks.flatMap((chunk) => chunk.moduleIds).every((id) => /^(?:repo|dependency|virtual|external|outside):/.test(id))).toBe(true);
  });
});

// --- SH-NOTICES-RELEASE-CHECK: the plugin's text format, without a real build ---------------------------------------

const FONT_ROOT = MODULE('packages/design/node_modules/@fontsource-variable/plus-jakarta-sans');
const FONT = JSON.parse(readFileSync(join(FONT_ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const FONT_KEY = `${FONT.name}@${FONT.version}`;
const FONT_TEXT = readFileSync(join(FONT_ROOT, 'LICENSE'), 'utf8');
const FONT_COPYRIGHT = FONT_TEXT.split('\n')[0] as string;
const NOTICE_TEXT = 'MIT License\nCopyright (c) Test Authors\nPermission is hereby granted, free of charge.\n';
const noticeHash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
type NoticeEntry = { key: string; license: string; text: string; copyright?: string };

function noticeFixture(entries: readonly NoticeEntry[] = [], font = true): string {
  const all = [...(font ? [{ key: FONT_KEY, license: 'OFL-1.1', text: FONT_TEXT, copyright: FONT_COPYRIGHT }] : []), ...entries];
  const sections = ['Third-party notices\n\nPackages contributing code, styles or assets to this build.\n'];
  for (const entry of all) sections.push(`Package: ${entry.key}\nLicense: ${entry.license}\nCopyright lines:\n${entry.copyright ?? 'Copyright (c) Test Authors'}\nLicense file: LICENSE -> ${noticeHash(entry.text)}\n`);
  for (const text of new Set(all.map((entry) => entry.text))) sections.push(`Text: ${noticeHash(text)}\n${text}${text.endsWith('\n') ? '' : '\n'}`);
  return `${sections.join('\n')}\n`;
}

// New cases keep all stand-in builds and package fixtures under the repository's ignored scratch folder.
function noticeCase() {
  const scratch = MODULE('.cache/notices-release-check-tests');
  mkdirSync(scratch, { recursive: true });
  const web = realpathSync(mkdtempSync(join(scratch, 'case-')));
  const out = join(web, 'check', 'dist');
  const pkg = (name = '@notice/one', version = '1.2.3', directory = `node_modules/${name}`) => {
    const root = join(web, directory);
    mkdirSync(join(root, '_esm'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
    writeFileSync(join(root, '_esm', 'package.json'), '{"type":"module"}');
    const module = join(root, '_esm', 'index.js');
    writeFileSync(module, 'export const value = 1;');
    return { module, entry: { key: `${name}@${version}`, license: 'MIT', text: NOTICE_TEXT } };
  };
  return { web, out, pkg };
}

describe('SH-NOTICES-RELEASE-CHECK: every checked build carries complete notices', () => {
  it.each(['mainnet', 'sepolia'] as const)('accepts notices and two versions of a scoped bundled package on %s and its twin', (target) => {
    const { web, out, pkg } = noticeCase();
    const one = pkg();
    const two = pkg('@notice/one', '2.0.0', 'node_modules/.pnpm/one@2/node_modules/@notice/one');
    const run = stubDeps(target, (folder, built) => writeSite(folder, built, {
      'third-party-notices.txt': noticeFixture([one.entry, two.entry]),
    }, { 'assets/BoxPage-c.js': [one.module, `${two.module}?commonjs-entry`] }), web);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
    // The build, its twin and (SH-203) the seam build in --mode test.
    expect(run.builds).toHaveLength(3);
    const upload = join(web, 'upload');
    cpSync(out, upload, { recursive: true });
    const again = stubDeps(target, () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build', '--same-as', upload], again.deps), again.errors.join('\n')).toBe(0);
    expect(again.builds).toEqual([]);
  });

  const invalid: ReadonlyArray<readonly [string, (entry: NoticeEntry) => string | null, string]> = [
    ['missing', () => null, 'missing file'],
    ['empty', () => ' \n\t', 'empty file'],
    ['bundled package omitted', () => noticeFixture(), 'missing package @notice/one@1.2.3'],
    ['wrong version', (entry) => noticeFixture([{ ...entry, key: '@notice/one@0.1.0' }]), 'missing package @notice/one@1.2.3'],
    ['disallowed license', (entry) => noticeFixture([{ ...entry, license: 'GPL-3.0-only' }]), 'license "GPL-3.0-only" is not allowed for @notice/one@1.2.3'],
    ['unsafe OR expression', (entry) => noticeFixture([{ ...entry, license: '(MIT OR GPL-3.0-only)' }]), 'license "(MIT OR GPL-3.0-only)" is not allowed for @notice/one@1.2.3'],
    ['missing license declaration', (entry) => noticeFixture([entry]).replace('License: MIT\n', ''), 'missing license for @notice/one@1.2.3'],
    ['font license changed', (entry) => noticeFixture([entry]).replace('License: OFL-1.1', 'License: MIT'), `missing OFL-1.1 license for ${FONT_KEY}`],
    ['malformed notice reference', (entry) => noticeFixture([entry]).replace('License: MIT\n', 'License: MIT\nNotice file: NOTICE -> sha256:broken\n'), 'invalid text reference for @notice/one@1.2.3'],
    ['font entry omitted', (entry) => noticeFixture([entry], false), `missing package ${FONT_KEY}`],
    ['font terms incomplete', (entry) => noticeFixture([entry]).replace(FONT_TEXT, `${FONT_COPYRIGHT}\n`), 'missing or changed text sha256:'],
    ['font copyright line omitted', (entry) => noticeFixture([entry]).replace(`Copyright lines:\n${FONT_COPYRIGHT}`, 'Copyright lines:\n(none)'), `missing font copyright for ${FONT_KEY}`],
    ['font text replaced with valid short text', (entry) => noticeFixture([entry]).replaceAll(FONT_TEXT, 'SIL OPEN FONT LICENSE\n').replaceAll(noticeHash(FONT_TEXT), noticeHash('SIL OPEN FONT LICENSE\n')), `missing complete OFL-1.1 text for ${FONT_KEY}`],
    ['license reference omitted', (entry) => noticeFixture([entry]).replace(`License file: LICENSE -> ${noticeHash(NOTICE_TEXT)}\n`, ''), 'missing license text reference for @notice/one@1.2.3'],
    ['dangling text reference', (entry) => noticeFixture([entry]).replace(` -> ${noticeHash(NOTICE_TEXT)}`, ` -> sha256:${'0'.repeat(64)}`), 'missing or changed text sha256:'],
  ];

  it.each(invalid)('fails with one plain notices line when %s (build and --no-build)', (_name, notices, problem) => {
    for (const target of ['mainnet', 'sepolia'] as const) {
      const { web, out, pkg } = noticeCase();
      const one = pkg();
      const text = notices(one.entry);
      const run = stubDeps(target, (folder, built) => {
        const chunks = writeSite(folder, built, { 'third-party-notices.txt': noticeFixture([one.entry]) }, { 'assets/BoxPage-c.js': [one.module] });
        if (folder === out) {
          if (text === null) renameSync(join(folder, 'third-party-notices.txt'), join(web, 'kept-notices.txt'));
          else writeFileSync(join(folder, 'third-party-notices.txt'), text);
        }
        return chunks;
      }, web);
      expect(runCheck(['--out', out], run.deps), _name).toBe(1);
      const expected = `notices, this ${target} build: third-party-notices.txt: ${problem}`;
      const lines = run.errors.filter((line) => line.startsWith('notices,'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(expected);
      expect(lines[0]).not.toMatch(/[\r\n]/);
      const again = stubDeps(target, () => { throw new Error('no build expected'); }, web);
      expect(runCheck(['--out', out, '--no-build'], again.deps), _name).toBe(1);
      expect(again.errors.some((line) => line.startsWith(expected))).toBe(true);
      expect(again.builds).toEqual([]);
    }
  });

  it('accepts the installed font and npm notices serialized by the actual plugin, without invoking Vite', () => {
    const { web, out } = noticeCase();
    const react = MODULE('apps/web/node_modules/react/index.js');
    const plugin = thirdPartyNotices();
    const hook = typeof plugin.generateBundle === 'function' ? plugin.generateBundle : plugin.generateBundle?.handler;
    expect(hook).toBeDefined();
    let notices = '';
    Reflect.apply(hook as NonNullable<typeof hook>, { emitFile: (asset: { fileName: string; source: string }) => {
      expect(asset.fileName).toBe('third-party-notices.txt');
      notices = asset.source;
    } }, [{}, { inputs: { type: 'asset', originalFileNames: [react, join(FONT_ROOT, 'wght.css')] } }, false]);
    expect(notices).toContain(FONT_TEXT);
    const run = stubDeps('mainnet', (folder, built) => writeSite(folder, built, {
      'third-party-notices.txt': notices,
    }, { 'assets/BoxPage-c.js': [realpathSync(react)] }), web);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
  });

  it('matches every identifier on the plugin allowlist and accepts safe AND/OR expressions', () => {
    const plugin = readFileSync(MODULE('apps/web/build/third-party-notices.ts'), 'utf8');
    const list = /const ALLOWED = new Set\(\[([^\]]+)\]\)/.exec(plugin)?.[1];
    expect(list).toBeDefined();
    const identifiers = [...(list ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
    const checker = readFileSync(MODULE('apps/web/production-check.ts'), 'utf8');
    const checkedList = /const NOTICE_LICENSES = new Set\(\[([^\]]+)\]\)/.exec(checker)?.[1];
    expect([...(checkedList ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()).toEqual([...identifiers].sort());
    for (const license of [...identifiers, '(MIT OR Apache-2.0) AND ISC']) {
      const { web, out, pkg } = noticeCase();
      const one = pkg();
      const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built, {
        'third-party-notices.txt': noticeFixture([{ ...one.entry, license }]),
      }, { 'assets/BoxPage-c.js': [one.module] }), web);
      expect(runCheck(['--out', out], run.deps), `${license}: ${run.errors.join('\n')}`).toBe(0);
    }
  });

  it.each(['MIT OR', '(MIT', 'MIT WITH unknown', 'MIT/ISC', 'Unknown'])('refuses malformed or unapproved license %s', (license) => {
    const { web, out, pkg } = noticeCase();
    const one = pkg();
    const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built, {
      'third-party-notices.txt': noticeFixture([{ ...one.entry, license }]),
    }, { 'assets/BoxPage-c.js': [one.module] }), web);
    expect(runCheck(['--out', out], run.deps)).toBe(1);
    expect(run.errors).toContain(`notices, this sepolia build: third-party-notices.txt: license ${JSON.stringify(license)} is not allowed for ${one.entry.key}`);
  });

  it.each(['terms without a trailing newline', 'terms with CRLF\r\n', 'terms with blank lines\n\n'])('reads shared texts and marked standard-license references: %j', (text) => {
    const { web, out, pkg } = noticeCase();
    const one = pkg();
    const two = pkg('two', '2.0.0');
    const entries = [one, two].map(({ entry }) => ({ ...entry, text }));
    const notices = noticeFixture(entries).replaceAll(`License file: LICENSE -> ${noticeHash(text)}`, `License text: MIT (standard text; the package ships none) -> ${noticeHash(text)}\nCopyright source: https://example.com/license (date read: 2026-10-29)\nSource header -> ${noticeHash(text)}`);
    const run = stubDeps('mainnet', (folder, built) => writeSite(folder, built, {
      'third-party-notices.txt': notices,
    }, { 'assets/BoxPage-c.js': [one.module, two.module] }), web);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
  });

  it('requires both versions: the older bundled version cannot stand in for the newer one', () => {
    const { web, out, pkg } = noticeCase();
    const one = pkg();
    const two = pkg('@notice/one', '2.0.0', 'node_modules/.pnpm/one@2/node_modules/@notice/one');
    const run = stubDeps('mainnet', (folder, built) => writeSite(folder, built, {
      'third-party-notices.txt': noticeFixture([one.entry]),
    }, { 'assets/BoxPage-c.js': [one.module, two.module] }), web);
    expect(runCheck(['--out', out], run.deps)).toBe(1);
    expect(run.errors).toContain('notices, this mainnet build: third-party-notices.txt: missing package @notice/one@2.0.0');
  });

  it('still detects changed scanned notices against the saved module-list hash on --no-build', () => {
    const { web, out } = noticeCase();
    expect(runCheck(['--out', out], stubDeps('sepolia', (folder, built) => writeSite(folder, built), web).deps)).toBe(0);
    writeFileSync(join(out, 'third-party-notices.txt'), `${noticeFixture()}\n`);
    const again = stubDeps('sepolia', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build'], again.deps)).toBe(1);
    expect(again.errors.join('\n')).toContain('third-party-notices.txt changed');
  });

  it.each(['mainnet', 'sepolia'] as const)('fails when only the %s twin is missing its notices', (twin) => {
    const { web, out } = noticeCase();
    const run = stubDeps(twin === 'mainnet' ? 'sepolia' : 'mainnet', (folder, built) => {
      const chunks = writeSite(folder, built);
      if (built === twin) renameSync(join(folder, 'third-party-notices.txt'), join(web, 'kept-twin-notices.txt'));
      return chunks;
    }, web);
    expect(runCheck(['--out', out], run.deps)).toBe(1);
    expect(run.errors.filter((line) => line.startsWith(`notices, the ${twin} twin`))).toEqual([
      expect.stringMatching(/third-party-notices\.txt: missing file$/),
    ]);
  });

  it('checks the twin against its own packages, even when the caller does not bundle them', () => {
    const { web, out, pkg } = noticeCase();
    const one = pkg();
    const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built, {},
      built === 'mainnet' ? { 'assets/BoxPage-c.js': [one.module] } : {}), web);
    expect(runCheck(['--out', out], run.deps)).toBe(1);
    expect(run.errors.filter((line) => line.startsWith('notices,'))).toEqual([
      expect.stringMatching(/^notices, the mainnet twin .*third-party-notices\.txt: missing package @notice\/one@1\.2\.3$/),
    ]);
  });

  it('--no-build --same-as fails when only the upload notices differ, even when both files are valid', () => {
    const { web, out } = noticeCase();
    const run = stubDeps('sepolia', (folder, built) => writeSite(folder, built), web);
    expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
    const upload = join(web, 'upload');
    cpSync(out, upload, { recursive: true });
    writeFileSync(join(upload, 'third-party-notices.txt'), `${noticeFixture()}\n`);
    const again = stubDeps('sepolia', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build', '--same-as', upload], again.deps)).toBe(1);
    expect(again.errors).toContain('not the scanned build: differs: third-party-notices.txt');
    expect(again.builds).toEqual([]);
  });
});

// --- F161 (4), SH-ALPHA-SITE: Privy's SDK, the alpha's pages and calls, the suites' stand-in --------------------------

describe('Privy’s SDK and the alpha’s pages (F161 (4), SH-ALPHA-SITE)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const site = (target: 'mainnet' | 'sepolia', extra: Readonly<Record<string, string>> = {}, modules: Readonly<Record<string, readonly string[]>> = {}) => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-alpha-')));
    const out = join(dir, 'dist');
    return { out, chunks: writeSite(out, target, extra, modules) };
  };
  const privy = privyOnlyPackages(REPO);
  /** A real installed package's folder, repository-relative, by its pnpm folder's start. */
  const installed = (start: string, name: string): string => {
    const folder = readdirSync(MODULE('node_modules/.pnpm')).find((entry) => entry.startsWith(start));
    if (!folder) throw new Error(`${start} is not installed`);
    return `node_modules/.pnpm/${folder}/node_modules/${name}`;
  };

  it('names Privy’s two hosts as trade markers, and nothing else of Privy’s', () => {
    expect(PRIVY_HOSTS).toEqual(['auth.privy.io', 'privy.systems']);
    const found = (text: string) => words(scanText(text, 'a.js', new Set(), TRADE_RULES));
    expect(found('fetch(`https://auth.privy.io/api/v1/apps`)')).toEqual(['trade:text:auth.privy.io']);
    expect(found('const rpc = "https://11155111.rpc.privy.systems"')).toEqual(['trade:text:privy.systems']);
    expect(found('const host = "AUTH.PRIVY.IO"')).toEqual(['trade:text:AUTH.PRIVY.IO']);
    expect(found('"@privy-io/react-auth"; "privy.io"; "auth_privy_io"')).toEqual([]);
  });

  it('every HTML page is a first paint: the join page’s entry and its static imports, its dynamic imports lazy', () => {
    const { out } = site('sepolia');
    const graph = loadGraph(out);
    for (const file of ['index.html', 'join/index.html', 'join/assets/join-a.js', 'desk/index.html', 'desk/assets/desk-a.js']) expect(graph.firstPaint.has(file), file).toBe(true);
    expect(graph.lazy.has('join/assets/privy-b.js')).toBe(true);
    expect(graph.firstPaint.has('join/assets/privy-b.js')).toBe(false);
  });

  it('a Sepolia build fails on Privy’s host at the join page’s first paint; a mainnet build anywhere', () => {
    const { out } = site('sepolia', { 'join/assets/join-a.js': 'export const s=()=>import(`./privy-b.js`),u=`https://auth.privy.io`;' });
    const judgement = judgeTrade(scanDirectory(out, new Set(), TRADE_RULES), 'sepolia', loadGraph(out));
    expect(judgement.failing.map((finding) => `${finding.file}:${finding.match}`)).toEqual(['join/assets/join-a.js:auth.privy.io']);
    const clean = site('sepolia');
    expect(judgeTrade(scanDirectory(clean.out, new Set(), TRADE_RULES), 'sepolia', loadGraph(clean.out)).failing).toEqual([]);
    const mainnet = site('mainnet', { 'assets/BoxPage-c.js': 'export const p=()=>`https://auth.privy.io`;' });
    expect(judgeTrade(scanDirectory(mainnet.out, new Set(), TRADE_RULES), 'mainnet', loadGraph(mainnet.out)).failing.map((finding) => finding.match)).toEqual(['auth.privy.io']);
  });

  it('reads Privy’s own packages from the install: @privy-io/* and what only it brings, never the site’s own', () => {
    // Each package where the site's own code reaches it, and Privy's where only Privy's SDK does.
    const resolvedKey = (from: string, name: string): string => packageKeyOf(realpathSync(MODULE(`${from}/node_modules/${name}`)).slice(REPO.length + 1)) as string;
    const reactAuth = resolvedKey('apps/web', '@privy-io/react-auth');
    const theirViem = packageKeyOf(realpathSync(MODULE(`${reactAuth}/../../viem`)).slice(REPO.length + 1)) as string;
    const ourViem = resolvedKey('packages/chain', 'viem');
    expect(theirViem).toContain('viem@2.57.8');
    expect(ourViem).toContain('viem@2.56.8');
    expect(privy.has(reactAuth)).toBe(true);
    expect(privy.has(theirViem)).toBe(true);
    expect(privy.has(installed('styled-components@', 'styled-components'))).toBe(true);
    expect(privy.has(ourViem)).toBe(false);
    expect(privy.has(resolvedKey('apps/web', 'react'))).toBe(false);
    expect(privy.has(resolvedKey('apps/web', 'react-dom'))).toBe(false);
    expect(privy.has(resolvedKey('apps/web', '@tanstack/react-query'))).toBe(false);
    expect(packageKeyOf(`${reactAuth}/dist/esm/index.mjs`)).toBe(reactAuth);
    expect(privyModuleOf(MODULE(`${theirViem}/_esm/index.js`), privy)).toBe(theirViem);
    expect(privyModuleOf(MODULE(`${ourViem}/_esm/index.js`), privy)).toBeNull();
    expect(privyModuleOf(MODULE('apps/web/src/main.tsx'), privy)).toBeNull();
    // Any @privy-io package, installed or not, is Privy's.
    expect(privyModuleOf(MODULE('node_modules/.pnpm/@privy-io+next@9.9.9/node_modules/@privy-io/next/index.js'), privy)).toBe('node_modules/.pnpm/@privy-io+next@9.9.9/node_modules/@privy-io/next');
  });

  it('a module of Privy’s SDK is a trade module: lazily loaded on Sepolia only, never at a first paint, never on mainnet', () => {
    const module = MODULE(`${installed('@privy-io+react-auth@3.51.0', '@privy-io/react-auth')}/dist/esm/index.mjs`);
    const lazy = site('sepolia', {}, { 'join/assets/privy-b.js': [module] });
    const sepolia = judgeModules(lazy.chunks, 'sepolia', loadGraph(lazy.out), lazy.out, 'modules', privy);
    expect(sepolia.ok, sepolia.lines.join('\n')).toBe(true);
    expect(sepolia.privy).toBe(1);
    expect(sepolia.lines[0]).toContain(', and 1 modules of Privy’s SDK in 1 lazily loaded chunks'.replace('’', "'"));
    const early = site('sepolia', {}, { 'join/assets/join-a.js': [module] });
    expect(judgeModules(early.chunks, 'sepolia', loadGraph(early.out), early.out, 'modules', privy).lines).toEqual([`modules: trade module join/assets/join-a.js ← ${installed('@privy-io+react-auth@3.51.0', '@privy-io/react-auth')} (first paint, not a lazily loaded chunk)`]);
    const main = site('mainnet', {}, { 'assets/BoxPage-c.js': [module] });
    expect(judgeModules(main.chunks, 'mainnet', loadGraph(main.out), main.out, 'modules', privy).lines).toEqual([`modules: trade module assets/BoxPage-c.js ← ${installed('@privy-io+react-auth@3.51.0', '@privy-io/react-auth')} (a mainnet build holds none)`]);
  });

  it('the alpha rule: our alpha-api’s paths and the two pages in a Sepolia build only, and the stand-in in none', () => {
    expect('fetch(`/alpha/me`) fetch(`/desk/api/signups`)'.match(ALPHA_PATTERN)).toEqual(['/alpha/', '/desk/api/']);
    expect('location.assign(`/__standin/privy/authorize`)'.match(STANDIN_PATTERN)).toEqual(['/__standin/']);
    expect(TWIN_RULES.map((rule) => rule.id)).toEqual(['trade', 'alpha', 'standin']);
    const sepolia = site('sepolia');
    expect(judgeAlpha(scanDirectory(sepolia.out, new Set(), TWIN_RULES), 'sepolia', sepolia.out, 'alpha')).toEqual({ ok: true, lines: ['alpha: the join and desk pages, no stand-in'] });
    // The same pages and calls fail a mainnet build: by the files under join/ and desk/, and by every call.
    const asMainnet = judgeAlpha(scanDirectory(sepolia.out, new Set(), TWIN_RULES), 'mainnet', sepolia.out, 'alpha');
    expect(asMainnet.ok).toBe(false);
    expect(asMainnet.lines).toContain('alpha: the alpha\'s join page (4 files under join/) where a mainnet build holds none');
    expect(asMainnet.lines).toContain('alpha: the alpha\'s desk page (3 files under desk/) where a mainnet build holds none');
    expect(asMainnet.lines.at(-1)).toBe('alpha: 2 traces of the alpha\'s calls or its stand-in where a mainnet build holds none');
    const mainnet = site('mainnet', { 'assets/web-b.js': 'export const t=()=>import(`./BoxPage-c.js`),m=()=>fetch(`/alpha/me`);' });
    expect(judgeAlpha(scanDirectory(mainnet.out, new Set(), TWIN_RULES), 'mainnet', mainnet.out, 'alpha').lines[0]).toMatch(/^alpha +text +assets\/web-b\.js/);
    // A Sepolia build without its join page, or with the stand-in's trace anywhere: refused.
    const noJoin = site('sepolia');
    rmSync(join(noJoin.out, 'join', 'index.html'));
    expect(judgeAlpha(scanDirectory(noJoin.out, new Set(), TWIN_RULES), 'sepolia', noJoin.out, 'alpha').lines).toEqual(['alpha: the Sepolia build holds no join/index.html (build/alpha-pages.ts)']);
    const standin = site('sepolia', { 'join/assets/privy-b.js': 'export const h=`https://auth.privy.io`,s=`/__standin/privy/token`;' });
    expect(judgeAlpha(scanDirectory(standin.out, new Set(), TWIN_RULES), 'sepolia', standin.out, 'alpha').ok).toBe(false);
  });

  it('the module list: no alpha module in a mainnet build, and the stand-in’s module in no production build', () => {
    const standin = MODULE('apps/web/src/features/trade-sepolia/test-support/privy-standin.ts');
    const sepolia = site('sepolia', {}, { 'join/assets/privy-b.js': [standin] });
    expect(judgeModules(sepolia.chunks, 'sepolia', loadGraph(sepolia.out), sepolia.out, 'modules', privy).lines).toEqual(['modules: stand-in module join/assets/privy-b.js ← apps/web/src/features/trade-sepolia/test-support/privy-standin.ts (no production build holds one)']);
    const main = site('mainnet', {}, { 'assets/BoxPage-c.js': [MODULE('apps/web/src/features/alpha-sepolia/alpha-api.ts')] });
    expect(judgeModules(main.chunks, 'mainnet', loadGraph(main.out), main.out, 'modules', privy).lines).toEqual(['modules: alpha module assets/BoxPage-c.js ← apps/web/src/features/alpha-sepolia/alpha-api.ts (a mainnet build holds none)']);
  });

  it('a run fails a Sepolia build without its pages, and a mainnet build or twin that holds one (exit 1, never 3)', () => {
    const web = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-alpha-run-')));
    dir = web;
    const out = join(web, 'check', 'dist');
    const clean = stubDeps('sepolia', (folder, built) => writeSite(folder, built), web);
    expect(runCheck(['--out', out], clean.deps), clean.errors.join('\n')).toBe(0);
    const missing = stubDeps('sepolia', (folder, built) => {
      const chunks = writeSite(folder, built);
      if (built === 'sepolia') rmSync(join(folder, 'desk', 'index.html'));
      return chunks;
    }, web);
    expect(runCheck(['--out', out], missing.deps)).toBe(1);
    expect(missing.errors).toContain('alpha, this sepolia build: the Sepolia build holds no desk/index.html (build/alpha-pages.ts)');
    const leak = stubDeps('sepolia', (folder, built) => (built === 'mainnet' ? writeSite(folder, built, { 'join/index.html': '<title>x</title>' }) : writeSite(folder, built)), web);
    expect(runCheck(['--out', out], leak.deps)).toBe(1);
    expect(leak.errors.some((line) => line.startsWith('alpha, the mainnet twin (') && line.includes('join page (1 files under join/)'))).toBe(true);
  });

  it('each alpha page’s own notices copy must name its chunks’ packages', () => {
    const web = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-alpha-notices-')));
    dir = web;
    const out = join(web, 'check', 'dist');
    const gone = stubDeps('sepolia', (folder, built) => {
      const chunks = writeSite(folder, built);
      if (built === 'sepolia') rmSync(join(folder, 'join', 'assets', 'third-party-notices.txt'));
      return chunks;
    }, web);
    expect(runCheck(['--out', out], gone.deps)).toBe(1);
    expect(gone.errors).toContain('notices, this sepolia build: join/assets/third-party-notices.txt: missing file');
  });

  it('the allowances for Privy’s libraries hold for Sepolia builds only: a mainnet run neither uses them nor calls them stale', () => {
    const sepoliaOnly = ALLOWANCES.filter((allowance) => allowance.targets?.includes('sepolia') && !allowance.targets.includes('mainnet'));
    expect(sepoliaOnly.length).toBe(4);
    for (const allowance of sepoliaOnly) {
      expect(String(allowance.source)).toMatch(/node_modules/);
      expect(allowance.max, String(allowance.source)).toBeGreaterThan(0);
    }
    expect(allowancesFor('mainnet').filter((allowance) => sepoliaOnly.includes(allowance))).toEqual([]);
    expect(allowancesFor('sepolia').filter((allowance) => sepoliaOnly.includes(allowance))).toHaveLength(4);
    const finding: Finding = { rule: 'local-rpc', place: 'text', file: 'join/assets/x.js', line: 1, column: 0, match: 'localhost', excerpt: '', source: { file: 'node_modules/.pnpm/@simplewebauthn+browser@13.3.0/node_modules/@simplewebauthn/browser/esm/helpers/isValidDomain.js', line: 12 } };
    expect(judge([finding], allowancesFor('sepolia')).failing).toEqual([]);
    expect(judge([finding], allowancesFor('mainnet')).failing).toEqual([finding]);
    expect(judge([], allowancesFor('mainnet')).stale.some((allowance) => sepoliaOnly.includes(allowance))).toBe(false);
  });

  it('the check’s builder and the pages’ build share one registry and one list of pages', () => {
    expect(Symbol.keyFor(ALPHA_PAGES_REGISTRY)).toBe(ALPHA_PAGES_REGISTRY_KEY);
    expect(BUILT_PAGES.map((page) => page.name)).toEqual([...ALPHA_PAGES]);
    const source = readFileSync(MODULE('apps/web/production-check.ts'), 'utf8');
    expect(source).toContain('globalThis[Symbol.for(${JSON.stringify(ALPHA_PAGES_REGISTRY_KEY)})] = pages;');
    expect(source).toContain('.filter((item) => item.type === \'chunk\'), ...pages.chunks];');
  });
});

// --- SH-203 (SH-202 af3, fix round af1): the reveal session's test seam -----------------------------------------------

describe('SH-203: the reveal-seam rule, in every build: the caller’s, its twin and a production build with --mode test', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const folders = () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sh-production-seam-')));
    return { web: dir, out: join(dir, 'check', 'dist') };
  };
  const SEAM_SUPPORT = MODULE('apps/web/src/features/core/v2/reveal-test-seam.test-support.ts');
  const INERT = MODULE(REVEAL_SEAM_MODULE);
  const INERT_CODE = '//#region src/features/core/v2/reveal-test-seam.ts\nconst revealTestOverride = () => void 0;\n//#endregion';
  // Exact modules[id].code reported by all real Vite 8 builds on d1955826f, 14 November 2026. Dependencies: [].
  const LAZY_CODE = `//#region src/features/core/v2/reveal-test-seam.ts
var revealTestOverride;
function init_reveal_test_seam() {
\treturn (init_reveal_test_seam = __esmMin((() => {
\t\trevealTestOverride = () => void 0;
\t})))();
}

//#endregion`;
  const lazyBad = {
    reviewProbe: 'var spare; function revealTestOverride(){return (revealTestOverride=liveHelper(()=>{spare=()=>void 0;}))();}',
    exportedInitializer: 'var spare; function revealTestOverride(){return (revealTestOverride=__esmMin(()=>{spare=()=>void 0;}))();}',
    renamedHelper: LAZY_CODE.replaceAll('__esmMin', 'x'),
    missingLookup: LAZY_CODE.replaceAll('revealTestOverride', 'spare'),
    helperVar: LAZY_CODE.replace('var revealTestOverride;', 'var revealTestOverride, __esmMin;').replace('revealTestOverride = () => void 0;', 'revealTestOverride = () => void 0; __esmMin = () => void 0;'),
    helperFunction: `${LAZY_CODE}\nfunction __esmMin() {}`,
    helperImport: `import { __esmMin } from './helper'; ${LAZY_CODE}`,
    helperAssign: `${LAZY_CODE}\n__esmMin = liveHelper;`,
    helperParameter: LAZY_CODE.replace('() => void 0', '(__esmMin) => void 0'),
    helperNamedExpression: LAZY_CODE.replace('() => void 0', 'function __esmMin() {}'),
    exportedInit: `${LAZY_CODE}\nexport { init_reveal_test_seam };`,
    parameterUndefined: LAZY_CODE.replace('() => void 0', '(undefined) => undefined'),
    namedUndefined: LAZY_CODE.replace('() => void 0', 'function undefined() { return undefined; }'),
    localUndefined: LAZY_CODE.replace('() => void 0', '() => { const undefined = {}; return undefined; }'),
    bindingUndefined: LAZY_CODE.replaceAll('revealTestOverride', 'undefined'),
    initializerUndefined: LAZY_CODE.replaceAll('init_reveal_test_seam', 'undefined'),
    registry: LAZY_CODE.replace('() => void 0', 'new WeakMap()'),
    forwardedFunction: LAZY_CODE.replace('() => void 0', 'lookup'),
    liveFunction: LAZY_CODE.replace('() => void 0', '(t) => registry.get(t)'),
    defaultParameter: LAZY_CODE.replace('() => void 0', '(t = read()) => void 0'),
    asyncFunction: LAZY_CODE.replace('() => void 0', 'async () => void 0'),
    secondAssignment: LAZY_CODE.replace('revealTestOverride = () => void 0;', 'revealTestOverride = () => void 0; revealTestOverride = () => undefined;'),
    undeclaredAssignment: LAZY_CODE.replace('revealTestOverride =', 'other ='),
    propertyAssignment: LAZY_CODE.replace('revealTestOverride =', 'revealTestOverride.x ='),
    compoundAssignment: LAZY_CODE.replace('revealTestOverride =', 'revealTestOverride ||='),
    callbackCall: LAZY_CODE.replace('revealTestOverride =', 'read(); revealTestOverride ='),
    callbackRead: LAZY_CODE.replace('revealTestOverride =', 'registry; revealTestOverride ='),
    callbackBinding: LAZY_CODE.replace('revealTestOverride =', 'const registry = {}; revealTestOverride ='),
    callbackReturn: LAZY_CODE.replace('revealTestOverride =', 'return revealTestOverride ='),
    callbackParameter: LAZY_CODE.replace('__esmMin((()', '__esmMin(((undefined)'),
    callbackFunction: LAZY_CODE.replace('__esmMin((() =>', '__esmMin((function ()'),
    asyncCallback: LAZY_CODE.replace('__esmMin((()', '__esmMin((async ()'),
    helperProperty: LAZY_CODE.replace('__esmMin', 'helpers.esm'),
    helperUndefined: LAZY_CODE.replace('__esmMin', 'undefined'),
    helperLocal: LAZY_CODE.replace('__esmMin', 'revealTestOverride'),
    extraHelperArgument: LAZY_CODE.replace('})))();', '}), read()))();'),
    wrongSelfAssignment: LAZY_CODE.replace('return (init_reveal_test_seam =', 'return (other ='),
    initializerParameter: LAZY_CODE.replace('init_reveal_test_seam()', 'init_reveal_test_seam(undefined)'),
    initializerStatement: LAZY_CODE.replace('\treturn (', '\tread(); return ('),
    invocationArgument: LAZY_CODE.replace('})))();', '})))(read());'),
    unassigned: LAZY_CODE.replace('var revealTestOverride;', 'var revealTestOverride, other;'),
    duplicateBinding: LAZY_CODE.replace('var revealTestOverride;', 'var revealTestOverride, revealTestOverride;'),
    initializedBinding: LAZY_CODE.replace('var revealTestOverride;', 'var revealTestOverride = () => void 0;'),
    letBinding: LAZY_CODE.replace('var revealTestOverride;', 'let revealTestOverride;'),
    moduleCall: `${LAZY_CODE}\ninit_reveal_test_seam();`,
    importImplementation: `import { lookup } from './helper.js';\n${LAZY_CODE}`,
    exportImplementation: `${LAZY_CODE}\nexport { lookup } from './helper.js';`,
  };
  // The review's control: a usable registry and installer under the allowed module, without any of the marker names.
  const LIVE_CODE = 'const o = new WeakMap();\nconst revealTestOverride = (t) => o.get(t);\nfunction put(t, v) { o.set(t, v); }';
  /** A site whose BoxPage chunk holds the seam module, rendered as `code` (false: no rendered code recorded). */
  const seamSite = (folder: string, built: 'mainnet' | 'sepolia', code: string | null | false = INERT_CODE): BuiltChunk[] =>
    writeSite(folder, built, {}, { 'assets/BoxPage-c.js': [INERT] }).map((chunk) => chunk.fileName === 'assets/BoxPage-c.js' ? { ...chunk, ...(code === false ? {} : { seamCode: { [INERT]: code } }), seamDependencies: { [INERT]: [] } } : chunk);

  it('the seam build is the only one in Vite’s test mode; the test support is any *.test-support module or test-support/ folder of the app', () => {
    expect([modeOf('build'), modeOf('twin'), modeOf('seam')]).toEqual([null, null, 'test']);
    for (const path of ['apps/web/src/features/core/v2/reveal-test-seam.test-support.ts', 'apps/web/src/features/core/v2/reveal-items.test-support.ts',
      'apps/web/src/features/core/v2/test-support/reveal-session-double.ts', 'apps/web/src/test-support/legacy-pages.tsx']) expect(WEB_TEST_SUPPORT.test(path), path).toBe(true);
    for (const path of [REVEAL_SEAM_MODULE, 'apps/web/src/features/core/v2/reveal-session.ts', 'packages/chain/src/write/test-support/fake.ts']) expect(WEB_TEST_SUPPORT.test(path), path).toBe(false);
    const support = readFileSync(join(REPO, 'apps/web/src/features/core/v2/reveal-test-seam.test-support.ts'), 'utf8');
    for (const marker of REVEAL_SEAM_MARKERS.slice(0, 2)) expect(support).toContain(`function ${marker}`);
  });

  it('af1: inertness is read from the rendered code: functions returning nothing pass; a registry, state, a call or a default value fails', () => {
    for (const code of [INERT_CODE, 'const a = () => undefined;', 'function a(t) {}', 'const a = function (t) { return; };', 'export const a = (t) => void 0;']) expect(inertSeamCode(code), String(code)).toBe(true);
    for (const code of [null, '', LIVE_CODE, 'function revealTestOverride(undefined) { return undefined; }', 'const a = function undefined() { return undefined; };', 'const undefined = () => void 0; const a = () => undefined;', 'function a() { const undefined = {}; return undefined; }', 'const a = () => void 0; export { missing as revealTestOverride };', 'const o = new Map();', 'const a = (t) => t;', 'const a = (t) => o.get(t);', 'const a = (t = f()) => undefined;',
      'const a = () => { o.x = 1; };', 'f();', 'const a = async () => undefined;', 'let a = 1;', 'export * from "./x";', 'const a = ( => ;']) expect(inertSeamCode(code), String(code)).toBe(false);
  });

  it('af4 B: export names come from all source export forms, excluding types', () => {
    const source = readFileSync(join(REPO, REVEAL_SEAM_MODULE), 'utf8');
    expect(revealSeamExports(source)).toEqual(['revealTestOverride']);
    expect(revealSeamExports(`${source}\nexport { init_reveal_test_seam };`)).toEqual(['revealTestOverride', 'init_reveal_test_seam']);
    expect(revealSeamExports('const lookup = () => {}; export { lookup as revealTestOverride };')).toEqual(['revealTestOverride', 'lookup']);
    expect(revealSeamExports(`${source}\nexport { init_reveal_test_seam as spare };`)).toEqual(['revealTestOverride', 'spare', 'init_reveal_test_seam']);
    expect(revealSeamExports('export type T = {}; export interface I {} export type { T }; export { type I };')).toEqual([]);
    for (const code of ['export * from "./x";', 'export * as lookup from "./x";', 'export default () => {};']) {
      expect(revealSeamExports(code)).toContain('<unsupported export>');
    }
  });

  it('af4 B: accepts the real lazy initializer and multiple once-assigned inert bindings', () => {
    for (const code of [LAZY_CODE,
      LAZY_CODE.replace('var revealTestOverride;', 'var revealTestOverride, other;').replace('revealTestOverride = () => void 0;', 'revealTestOverride = () => void 0; other = function (t) { return; };'),
    ]) expect(inertSeamCode(code), code).toBe(true);
  });

  it.each(Object.entries(lazyBad))('af3: refuses the lazy initializer variant %s', (_name, code) => {
    expect(inertSeamCode(code), code).toBe(false);
  });

  it('af1: the real seam module, built by Vite in production with --mode test, renders inert code and passes the rule', async () => {
    // An isolated build of the one module, as reveal-boundary.test.ts makes it: no app config, env files, server or network.
    const entry = join(REPO, REVEAL_SEAM_MODULE);
    const dependencies: Record<string, readonly string[]> = {};
    const result = await build({ configFile: false, envFile: false, mode: 'test', logLevel: 'silent',
      plugins: [{ name: 'record-reveal-seam', generateBundle() {
        for (const id of this.getModuleIds()) { const info = this.getModuleInfo(id); if (info) dependencies[id] = [...info.importedIds, ...info.dynamicallyImportedIds]; }
      } }],
      build: { write: false, minify: true, lib: { entry, formats: ['es'] } } });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : [])).filter((o) => o.type === 'chunk');
    const written = writtenChunks(recordSeamChunks(chunks, dependencies));
    const code = Object.values(written[0]?.seamCode ?? {})[0];
    expect(typeof code).toBe('string');
    expect(inertSeamCode(code ?? null), String(code)).toBe(true);
    const { web } = folders();
    expect(judgeRevealSeam(written, join(web, 'none'), 'x')).toEqual({ ok: true, lines: ['x: no test seam installer, registry or test support; the seam lookup only, inert as built'] });
  }, shLimit(60_000));

  it('judges a module list and its scripts: the inert lookup passes; a live seam fails by its module, a marker, its rendered code, or missing code (the controls)', () => {
    const { web } = folders();
    const outDir = join(web, 'site');
    expect(judgeRevealSeam(seamSite(outDir, 'mainnet'), outDir, 'x')).toEqual({ ok: true, lines: ['x: no test seam installer, registry or test support; the seam lookup only, inert as built'] });
    expect(judgeRevealSeam(writeSite(outDir, 'mainnet'), outDir, 'x').lines).toEqual(['x: no test seam installer, registry or test support; no reveal seam module bundled']);
    const live = writeSite(outDir, 'mainnet', {}, { 'assets/BoxPage-c.js': [SEAM_SUPPORT] });
    expect(judgeRevealSeam(live, outDir, 'x')).toEqual({ ok: false, lines: ['x: test-support module assets/BoxPage-c.js ← apps/web/src/features/core/v2/reveal-test-seam.test-support.ts (no production build holds one)'] });
    for (const marker of REVEAL_SEAM_MARKERS) {
      const named = writeSite(outDir, 'mainnet', { 'assets/BoxPage-c.js': `export const p=()=>null,q=\`${marker}\`;` });
      expect(judgeRevealSeam(named, outDir, 'x'), marker).toEqual({ ok: false, lines: [`x: assets/BoxPage-c.js names ${marker} (the reveal test seam)`] });
    }
    // af1, the review's control: a usable registry under the allowed module id, with none of the marker names.
    expect(judgeRevealSeam(seamSite(outDir, 'mainnet', LIVE_CODE), outDir, 'x')).toEqual({ ok: false, lines: [`x: assets/BoxPage-c.js ← ${REVEAL_SEAM_MODULE} is not inert as built (more than functions returning nothing)`] });
    expect(judgeRevealSeam(seamSite(outDir, 'mainnet', false), outDir, 'x')).toEqual({ ok: false, lines: [`x: assets/BoxPage-c.js ← ${REVEAL_SEAM_MODULE} without its rendered code (its inertness is unknown)`] });
    expect(judgeRevealSeam(null, outDir, 'x')).toEqual({ ok: false, lines: ['x: no module list for this build'] });
  });

  it.each([{ shape: 'plain', code: INERT_CODE }, { shape: 'real Rolldown', code: LAZY_CODE }])('a run judges its build, its twin and its --mode test build with $shape code, and passes when all are clean', ({ code }) => {
    for (const target of ['mainnet', 'sepolia'] as const) {
      const { web, out } = folders();
      const twin = target === 'mainnet' ? 'sepolia' : 'mainnet';
      const run = stubDeps(target, (folder, built) => seamSite(folder, built, code), web);
      expect(runCheck(['--out', out], run.deps), run.errors.join('\n')).toBe(0);
      const latest = latestRun(out, web);
      expect(run.roles.map(([role]) => role)).toEqual(['build', 'twin', 'seam']);
      expect(run.roles.at(-1)).toEqual(['seam', seamOf(latest).record]);
      expect(run.warned).toContain(`reveal-seam, this ${target} build: no test seam installer, registry or test support; the seam lookup only, inert as built`);
      expect(run.warned.some((line) => line.startsWith(`reveal-seam, the ${twin} twin (`) && line.endsWith('the seam lookup only, inert as built'))).toBe(true);
      expect(run.warned.some((line) => line.startsWith(`reveal-seam, the ${target} build in --mode test (`) && line.endsWith('the seam lookup only, inert as built'))).toBe(true);
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  it('the control: a live seam fails the run wherever it is: the shipped build, only the twin, or only the --mode test build; an unbuilt seam build fails too', () => {
    for (const where of ['build', 'twin', 'seam'] as const) {
      for (const live of ['module', 'registry'] as const) {
        const { web, out } = folders();
        const run = stubDeps('mainnet', (folder, built) => {
          const here = where === 'build' ? folder === out : where === 'twin' ? folder.includes('twin-') : folder.includes('seam-test');
          if (!here) return seamSite(folder, built);
          return live === 'module' ? writeSite(folder, built, {}, { 'assets/BoxPage-c.js': [SEAM_SUPPORT] }) : seamSite(folder, built, LIVE_CODE);
        }, web);
        expect(runCheck(['--out', out], run.deps), `${where} ${live}`).toBe(1);
        expect(run.errors.at(-1), `${where} ${live}`).toContain(where === 'build' ? 'this build fails the reveal-seam rule'
          : where === 'twin' ? 'the sepolia twin fails the trade rule, notices requirement or reveal-seam rule' : 'the --mode test build fails the reveal-seam rule');
        rmSync(dir as string, { recursive: true, force: true });
      }
    }
    const { web, out } = folders();
    const unbuilt = stubDeps('mainnet', (folder, built) => (folder.includes('seam-test') ? [] : seamSite(folder, built)), web);
    expect(runCheck(['--out', out], unbuilt.deps)).toBe(1);
    expect(unbuilt.errors.some((line) => line.includes('--mode test') && line.includes('not built (no index.html)'))).toBe(true);
  });

  it('af4 B: records the offered runtime across chunks and requires its helper definition', () => {
    const runtime = '\0rolldown/runtime.js';
    const code = 'var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);';
    const chunks = recordSeamChunks([
      { fileName: 'page.js', moduleIds: [INERT], modules: { [INERT]: { code: LAZY_CODE } } },
      { fileName: 'runtime.js', moduleIds: [runtime], modules: { [runtime]: { code } } },
    ], { [INERT]: [] });
    expect(chunks[0]?.seamRuntime).toEqual({ [runtime]: code });
    const { web } = folders();
    expect(judgeRevealSeam(writtenChunks(chunks), web, 'x').ok).toBe(true);
    expect(judgeRevealSeam(writtenChunks(chunks.map(c => ({ ...c, seamRuntime: {} }))), web, 'x').ok).toBe(false);
    for (const bad of [null, '', 'void __esmMin;', 'var other = () => {};']) {
      expect(judgeRevealSeam(writtenChunks(chunks.map((c) => ({ ...c, seamRuntime: { [runtime]: bad } }))), web, 'x').ok).toBe(false);
    }
  });

  it('af2 R2-M2: records the exported implementation and its dependencies across chunks', () => {
    const helper = MODULE('apps/web/src/ordinary-helper.ts');
    const leaf = MODULE('apps/web/src/ordinary-leaf.ts');
    const chunks = recordSeamChunks([
      { fileName: 'entry.js', moduleIds: [INERT], modules: { [INERT]: { code: null } } },
      { fileName: 'helper.js', moduleIds: [helper, leaf], modules: { [helper]: { code: 'const lookup = t => registry.get(t);' }, [leaf]: { code: 'const registry = new WeakMap();' } } },
    ], { [INERT]: [helper], [helper]: [leaf], [leaf]: [] });
    expect(chunks[0]?.seamCode).toEqual({ [INERT]: null, [helper]: 'const lookup = t => registry.get(t);', [leaf]: 'const registry = new WeakMap();' });
    expect(chunks[0]?.seamDependencies).toEqual({ [INERT]: [helper], [helper]: [leaf], [leaf]: [] });
    const { web } = folders();
    const judged = judgeRevealSeam(writtenChunks(chunks), web, 'x');
    expect(judged.ok).toBe(false);
    expect(judged.lines.some((line) => line.includes('ordinary-leaf.ts is not inert'))).toBe(true);
    const reexportOnly = recordSeamChunks([
      { fileName: 'helper.js', moduleIds: [helper], modules: { [helper]: { code: LIVE_CODE } } },
    ], { [INERT]: [helper], [helper]: [] });
    expect(reexportOnly[0]?.seamCode?.[helper]).toBe(LIVE_CODE);
    expect(judgeRevealSeam(writtenChunks(reexportOnly), web, 'x').lines.some((line) => line.includes('ordinary-helper.ts is not inert'))).toBe(true);
  });

  it('af2 R2-M2: shadowing, forwarding, unread dependencies and absent code fail in every build path', () => {
    const helper = MODULE('apps/web/src/ordinary-helper.ts');
    const leaf = MODULE('apps/web/src/ordinary-leaf.ts');
    const cases: Readonly<Record<string, Partial<Pick<BuiltChunk, 'seamCode' | 'seamDependencies' | 'moduleIds'>>>> = {
      ...Object.fromEntries(Object.entries(lazyBad).map(([name, code]) => [name, { seamCode: { [INERT]: code } }])),
      parameter: { seamCode: { [INERT]: 'function revealTestOverride(undefined) { return undefined; }' } },
      namedFunction: { seamCode: { [INERT]: 'const revealTestOverride = function undefined() { return undefined; };' } },
      unknownExport: { seamCode: { [INERT]: 'const a = () => void 0; export { missing as revealTestOverride };' } },
      local: { seamCode: { [INERT]: 'function revealTestOverride(t) { const undefined = t; return undefined; }' } },
      closure: { seamCode: { [INERT]: 'const undefined = () => void 0; function revealTestOverride() { return undefined; }' } },
      reexport: { seamCode: { [INERT]: 'export { lookup as revealTestOverride } from "./ordinary-helper.js";' }, seamDependencies: { [INERT]: [helper] } },
      forward: { seamCode: { [INERT]: 'const revealTestOverride = t => lookup(t);' }, seamDependencies: { [INERT]: [helper] } },
      unlistedReexport: { moduleIds: [], seamCode: { [INERT]: null, [helper]: LIVE_CODE }, seamDependencies: { [INERT]: [helper], [helper]: [] } },
      null: { seamCode: { [INERT]: null } },
      empty: { seamCode: { [INERT]: '' } },
      missing: { seamCode: {} },
      unknownGraph: { seamCode: { [INERT]: INERT_CODE }, seamDependencies: {} },
      unreadHelper: { seamCode: { [INERT]: INERT_CODE }, seamDependencies: { [INERT]: [helper] } },
      nullHelper: { seamCode: { [INERT]: INERT_CODE, [helper]: null }, seamDependencies: { [INERT]: [helper], [helper]: [] } },
      liveDependency: { seamCode: { [INERT]: INERT_CODE, [helper]: INERT_CODE, [leaf]: LIVE_CODE }, seamDependencies: { [INERT]: [helper], [helper]: [leaf], [leaf]: [] } },
    };
    for (const target of ['mainnet', 'sepolia'] as const) for (const where of ['build', 'twin', 'seam'] as const) {
      for (const [name, change] of Object.entries(cases)) {
        const { web, out } = folders();
        const run = stubDeps(target, (folder, built) => {
          const here = where === 'build' ? folder === out : where === 'twin' ? folder.includes('twin-') : folder.includes('seam-test');
          return seamSite(folder, built).map((chunk) => here && chunk.fileName === 'assets/BoxPage-c.js' ? { ...chunk, ...change } : chunk);
        }, web);
        expect(runCheck(['--out', out], run.deps), `${target} ${where} ${name}`).toBe(1);
        expect(run.errors.some((line) => line.includes('reveal-seam') && line.includes(where === 'build' ? `this ${target} build` : where === 'twin' ? 'twin (' : '--mode test (')), `${target} ${where} ${name}`).toBe(true);
        rmSync(web, { recursive: true, force: true });
      }
    }
  }, shLimit(30_000));

  it('the rendered code survives the run’s module list: --no-build judges the scanned build by it, and says the seam build went unchecked', () => {
    const { web, out } = folders();
    expect(runCheck(['--out', out], stubDeps('mainnet', (folder, built) => seamSite(folder, built), web).deps)).toBe(0);
    const again = stubDeps('mainnet', () => { throw new Error('no build expected'); }, web);
    expect(runCheck(['--out', out, '--no-build'], again.deps), again.errors.join('\n')).toBe(0);
    expect(again.warned).toContain('reveal-seam, the mainnet build in --mode test: neither built nor checked (--no-build)');
    expect(again.warned).toContain('reveal-seam, this mainnet build: no test seam installer, registry or test support; the seam lookup only, inert as built');
  });
});
