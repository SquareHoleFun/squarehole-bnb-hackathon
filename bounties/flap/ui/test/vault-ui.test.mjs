// SH-309: the Flap vault UIs for our piles and rules vaults (bounties/flap/ui/square-hole-pile, square-hole-rules).
// Checks without a browser or a chain:
//  - every ABI fragment in each VaultABI.ts block matches the corrected contracts' ABI files (names, inputs, outputs,
//    mutability), the fixtures in abi-v2-3031bdb9/ (built from the merged SH-308 tree at 3031bdb9);
//  - the rules UI's resolvedContracts entry (resolver, allowed write, reads) equals its pile fragments;
//  - each manifest's bindings name our vault factories and real 7777 test tokens from the deployment files;
//  - the components' own decisions, run from their source: a zero quote sends nothing, the quote coin's decimals,
//    the exact "All" round trip, the pile section when the pile cannot be resolved, the notes beside a buy and burn;
//  - every message key the components use is in i18n.json (English only), and none is unused;
//  - after Flap's report on the pile page: the unit learned from the asset's own contract when the host's payment
//    token is another coin or missing, the quote read again on every refresh round, the "How it works" lines in the
//    closed "More" part, no internal work label in the files that are packaged, amounts that are not zero never
//    shown as "0" (rounded down, three significant digits), token counts with thousands separators;
//  - the last round before sending: no asset read when the host describes the coin, the coin never holds back the
//    page's own state, a read that throws at once, every answer kept, a digit symbol refused; no figure of one vault
//    shown for another, nor of one wallet for another; the display quote without any lock; the coin asked once
//    while its answer is on its way; coin amounts grouped; the redeem handler's order.
// usage: node --test bounties/flap/ui/test/vault-ui.test.mjs   (from the repository's top folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, '..');
const flap = join(here, '..', '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const json = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'));
const text = (...p) => readFileSync(join(...p), 'utf8');

/** "function name(type a, type b) [view|pure|payable] returns (type c)" -> { name, inputs, outputs, mutability } */
function parseFragment(fragment) {
  const m = /^function (\w+)\(([^)]*)\)((?: \w+)*?)(?: returns \(([^)]*)\))?$/.exec(fragment.trim());
  assert.ok(m, 'fragment ' + fragment);
  const types = (list) => (list ?? '').split(',').map((x) => x.trim().split(' ')[0]).filter(Boolean);
  const words = m[3].trim().split(/\s+/);
  const mutability = ['view', 'pure', 'payable'].find((w) => words.includes(w)) ?? 'nonpayable';
  return { name: m[1], inputs: types(m[2]), outputs: types(m[4]), mutability };
}

function fragmentsOf(source, name) {
  const block = new RegExp('export const ' + name + ' = parseAbi\\(\\[([\\s\\S]*?)\\]\\);').exec(source);
  assert.ok(block, name + ' in VaultABI.ts');
  return [...block[1].matchAll(/"(function [^"]+)"/g)].map((x) => x[1]);
}

function matchesAbi(fragments, abi, label) {
  for (const fragment of fragments) {
    const f = parseFragment(fragment);
    const found = abi.find((x) => x.type === 'function' && x.name === f.name
      && x.inputs.length === f.inputs.length && x.inputs.every((i, k) => i.type === f.inputs[k]));
    assert.ok(found, `${label}: ${f.name}(${f.inputs}) is in the ABI`);
    assert.deepEqual(found.outputs.map((o) => o.type), f.outputs, `${label}: ${f.name} returns`);
    assert.equal(found.stateMutability, f.mutability, `${label}: ${f.name} mutability`);
  }
}

/** A component's private helpers, reached by appending one export to a transpiled copy; the SDK, the UI kit and the
 * ABI block are stubbed: nothing here renders or reads a chain. */
function load(dir, names) {
  const source = text(ui, dir, 'Component.tsx') + `\nexport const __test = { ${names.join(', ')} };\n`;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const stubs = {
    react: { useCallback: (f) => f, useEffect() {}, useMemo: (f) => f(), useRef: () => ({ current: 0 }), useState: (v) => [v, () => {}] },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'fragment' },
    '@/src/sdk': {},
    '@/src/ui': {},
    './VaultABI': { vaultAbi: [], pileAbi: [], kindCreator: 1, kindPile: 2, kindBuyBurn: 3 },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((id) => stubs[id], module, module.exports);
  return module.exports.__test;
}

const helpers = ['exactDecimal', 'parseExact', 'shown', 'grouped', 'tokenCount', 'quoteUnit', 'needsUnitRead', 'unitFromCoin', 'owned', 'coinText', 'askQuote', 'howLines', 'redeemRefusal', 'minOutFor'];
const pileUi = load('square-hole-pile', helpers);
const rulesUi = load('square-hole-rules', [...helpers, 'pileView', 'burnNotes']);
const pileSource = text(ui, 'square-hole-pile', 'VaultABI.ts');
const rulesSource = text(ui, 'square-hole-rules', 'VaultABI.ts');
const fixtures = join(here, 'abi-v2-3031bdb9');
const pileVaultAbi = json(fixtures, 'PileVault.json');
const rulesVaultAbi = json(fixtures, 'RulesVault.json');

test('the pile UI: its fragments match the PileVault ABI, mutability included', () => {
  matchesAbi(fragmentsOf(pileSource, 'vaultAbi'), pileVaultAbi, 'PileVault');
});

test('the rules UI: its fragments match the RulesVault ABI (pileOf and payOwedCreator included), its pile fragments the pile ABI', () => {
  matchesAbi(fragmentsOf(rulesSource, 'vaultAbi'), rulesVaultAbi, 'RulesVault');
  matchesAbi(fragmentsOf(rulesSource, 'pileAbi'), pileVaultAbi, 'pile');
  const kinds = Object.fromEntries([...rulesSource.matchAll(/export const kind(\w+) = (\d+);/g)].map((x) => [x[1], Number(x[2])]));
  assert.deepEqual(kinds, { Creator: 1, Pile: 2, BuyBurn: 3 }, 'IRuleSplitter.Kind: NONE, CREATOR, PILE, BUY_BURN');
});

test('the fragment comparison catches a wrong mutability and a missing function (controls)', () => {
  assert.throws(() => matchesAbi(['function pile() returns (uint256)'], pileVaultAbi, 'control'), /mutability/);
  assert.throws(() => matchesAbi(['function pileOf(address token_) view returns (address pile)'], pileVaultAbi, 'control'), /is in the ABI/);
});

test('rules UI: one note beside a waiting buy and burn, true in every state', () => {
  assert.deepEqual(rulesUi.burnNotes(0n), [], 'nothing waits: no note');
  assert.deepEqual(rulesUi.burnNotes(5n), ['notices.burnPaced']);
  const en = json(ui, 'square-hole-rules', 'i18n.json').en;
  assert.match(en['notices.burnPaced'], /at most once a minute/);
  assert.ok(!/ten minutes/.test(en['notices.burnPaced']), 'no ten-minute window any more');
  assert.ok(!/\d+ ?(s|sec|seconds|min)\b.*left|countdown/i.test(JSON.stringify(en)), 'no countdown');
});

test("the rules UI's resolvedContracts entry equals its pile fragments and the component's resolver id", () => {
  const manifest = json(ui, 'square-hole-rules', 'manifest.json');
  const pileFragments = fragmentsOf(rulesSource, 'pileAbi').map(parseFragment);
  const component = text(ui, 'square-hole-rules', 'Component.tsx');
  for (const binding of manifest.match.bindings) {
    assert.equal(binding.resolvedContracts.length, 1);
    const [entry] = binding.resolvedContracts;
    assert.equal(entry.id, 'pile');
    assert.ok(component.includes('sdk.resolveContract("pile", [context.tokenAddress])'));
    const resolver = parseFragment(entry.resolver);
    assert.deepEqual(resolver, { name: 'pileOf', inputs: ['address'], outputs: ['address'], mutability: 'view' });
    for (const sig of [...entry.allow, ...entry.read]) {
      const f = parseFragment(sig);
      assert.ok(pileFragments.some((p) => JSON.stringify(p) === JSON.stringify(f)), sig + ' is a pile fragment');
    }
    assert.deepEqual(entry.allow.map((s) => parseFragment(s).name), ['redeem']);
  }
});

test('the manifests bind our vault factories, each with a real 7777 test token', () => {
  const pile = json(ui, 'square-hole-pile', 'manifest.json');
  const rules = json(ui, 'square-hole-rules', 'manifest.json');
  const factories = (m) => m.match.bindings.map((b) => b.factoryAddress.toLowerCase()).sort();
  assert.deepEqual(factories(pile), [json(flap, 'deployments', '97-v2.json').pileVaultFactory, json(flap, 'deployments', '97-v2-usdt.json').tokenPileVaultFactory].map((a) => a.toLowerCase()).sort());
  assert.deepEqual(factories(rules), [json(flap, 'deployments', '97-v2-rules-native.json').rulesVaultFactory, json(flap, 'deployments', '97-v2-rules-usdt.json').rulesVaultFactory].map((a) => a.toLowerCase()).sort());
  for (const m of [pile, rules]) {
    for (const b of m.match.bindings) {
      assert.equal(b.chainId, 97);
      assert.equal(b.tokenAddresses.length, 1);
      assert.match(b.tokenAddresses[0], /^0x[0-9a-fA-F]{36}7777$/);
    }
  }
  // each binding's test token is the launched token of a sale of that pair (deployment files 97-v2-*-sale.json)
  const sales = ['97-v2-pile-sale.json', '97-v2-usdt-sale.json', '97-v2-rules-native-sale.json', '97-v2-rules-usdt-sale.json']
    .map((f) => json(flap, 'deployments', f).token.toLowerCase());
  for (const m of [pile, rules]) {
    for (const b of m.match.bindings) {
      assert.ok(sales.includes(b.tokenAddresses[0].toLowerCase()), b.tokenAddresses[0] + ' is a v2 sale token');
    }
  }
});

for (const [dir, c] of [['square-hole-pile', pileUi], ['square-hole-rules', rulesUi]]) {
  test(`${dir}: a quote of 0 sends nothing (refused on the page, and at the press before any approval)`, () => {
    const base = { balance: 10n ** 18n, amount: 10n ** 17n, quote: 5n, unitKnown: true };
    assert.equal(c.redeemRefusal(base), null);
    assert.equal(c.redeemRefusal({ ...base, quote: 0n }), 'states.forNothing');
    assert.equal(c.redeemRefusal({ ...base, quote: null }), 'states.loading');
    assert.equal(c.redeemRefusal({ ...base, amount: 2n * 10n ** 18n }), 'states.tooMany');
    assert.equal(c.redeemRefusal({ ...base, balance: 0n }), 'states.noTokens');
    assert.equal(c.redeemRefusal({ ...base, amount: null }), 'states.enterAmount');
    assert.equal(c.minOutFor(0n), null);
    assert.equal(c.minOutFor(7n), 7n);
    // the press reads a fresh quote and stops on null BEFORE the approval: the order in the source
    const source = text(ui, dir, 'Component.tsx');
    const press = source.slice(source.indexOf('a hand-in that would pay nothing stops here'));
    assert.ok(press.indexOf('minOutFor(') < press.indexOf('functionName: "approve"'), 'the zero check comes before the approval');
  });

  test(`${dir}: the quote coin's decimals (native 18, a 6-decimal payment token, an unknown coin)`, () => {
    assert.deepEqual(c.quoteUnit('0x' + '00'.repeat(20), undefined, 'tBNB'), { symbol: 'tBNB', decimals: 18 });
    const usdc = { address: '0x' + 'ab'.repeat(20), symbol: 'USDC', decimals: 6 };
    assert.deepEqual(c.quoteUnit('0x' + 'AB'.repeat(20), usdc, 'tBNB'), { symbol: 'USDC', decimals: 6 });
    assert.equal(c.quoteUnit('0x' + 'cd'.repeat(20), usdc, 'tBNB'), null);
    assert.equal(c.shown(1_234_567n, 6), '1.2345');
    assert.equal(c.shown(1_234_567n, 6, 8), '1.234567');
    assert.equal(c.shown(1_234_567n, 18), '0.00000000000123', 'a tiny amount keeps its first three digits');
    assert.equal(c.redeemRefusal({ balance: 1n, amount: 1n, quote: 1n, unitKnown: false }), 'states.unitUnknown');
  });

  test(`${dir}: "All" round-trips exactly (18 places, above 2^53, tiny and huge balances)`, () => {
    for (const wei of [1n, 10n ** 10n, 123456789012345678901234567n, 2n ** 60n + 1n, 10n ** 40n + 1n, 999999999999999999n]) {
      const typed = c.exactDecimal(wei, 18);
      assert.match(typed, /^[0-9]+(\.[0-9]+)?$/, 'plain digits: ' + typed);
      assert.equal(c.parseExact(typed, 18), wei, typed);
    }
    assert.equal(c.exactDecimal(1234567n, 6), '1.234567');
    assert.equal(c.parseExact('1.2345678', 6), null, 'more places than the coin has');
    assert.equal(c.parseExact('1e-8', 18), null);
    assert.equal(c.parseExact('0', 18), null);
  });
}

test('rules UI: the pile section when the pile cannot be resolved says so and links nowhere', () => {
  assert.equal(rulesUi.pileView([1, 3], false, false), 'none', 'no PILE rule: no section');
  assert.equal(rulesUi.pileView([1, 2, 3], true, false), 'redeem');
  assert.equal(rulesUi.pileView([2], false, true), 'unreachable');
  assert.equal(rulesUi.pileView([2], false, false), 'reading');
  const source = text(ui, 'square-hole-rules', 'Component.tsx');
  assert.ok(!/ExternalLink|sslip|https?:\/\//.test(source), 'no link and no site address in the vault UI');
  assert.ok(source.includes('view === "unreachable" ? <Alert tone="warning">{t("states.pileUnreachable")}</Alert>'));
});

for (const dir of ['square-hole-pile', 'square-hole-rules']) {
  test(`${dir}: one load at a time; a load's result is dropped only when the inputs changed (never by the timer)`, () => {
    const source = text(ui, dir, 'Component.tsx');
    const load = source.slice(source.indexOf('const loadData = useCallback(async () => {'));
    // one load at a time, but a load still running after 30 seconds no longer holds the page
    assert.match(load, /^const loadData = useCallback\(async \(\) => \{\s+(\/\/[^\n]*\n\s+)?if \(inFlight\.current && nowMs\(\) - startedAt\.current < 30_000\) return;\s+inFlight\.current = true;\s+startedAt\.current = nowMs\(\);\s+const r = revision\.current;/);
    if (dir === 'square-hole-rules') {
      // a new account's balance never pairs with an old account's allowance: the allowance comes from the pile read
      assert.ok(load.includes('setMineRaw({ of: mineOf, balance: known, allowance: null });'));
      assert.ok(!load.includes('m?.allowance'));
    }
    assert.ok(!source.includes('++revision.current'), 'no load moves the revision on');
    assert.ok(source.includes('revision.current += 1; inFlight.current = false; };'), 'only the cleanup (inputs changed, unmount) does');
    if (dir === 'square-hole-rules') {
      // the rules and the shares are shown before the pile is resolved, and the pile is time-boxed
      assert.ok(load.indexOf('setLoading(false);') < load.indexOf('sdk.resolveContract("pile"'), 'shares before the pile');
      assert.ok(load.includes('setTimeout(() => resolve(null), 20_000)'), 'the pile waits at most 20 seconds');
    }
  });

  test(`${dir}: every message key used is in i18n.json (English), none unused, no visitor text says Starts`, () => {
    const source = text(ui, dir, 'Component.tsx');
    const messages = json(ui, dir, 'i18n.json');
    assert.deepEqual(Object.keys(messages), ['en']);
    assert.deepEqual(json(ui, dir, 'manifest.json').i18n, ['en']);
    const used = [...new Set([...source.matchAll(/\bt\("([A-Za-z.]+)"\)/g)].map((x) => x[1]))].sort();
    assert.deepEqual(Object.keys(messages.en).sort(), used);
    for (const value of Object.values(messages.en)) {
      assert.ok(!/\bStarts?\b/.test(value), value);
      assert.ok(!/every trade/i.test(value), 'no "every trade": ' + value);
    }
  });
}

// ── After Flap's report on the pile page ────────────────────────────────────────────────────────────────────────────

const zero = '0x' + '00'.repeat(20);
const usdt = '0x190C989D5665a0e404B444b53CAE9AbCfb600157';

for (const [dir, c] of [['square-hole-pile', pileUi], ['square-hole-rules', rulesUi]]) {
  test(`${dir}: the unit comes from the asset's own contract when the host's payment token is another coin or missing`, () => {
    const other = { address: '0x' + 'cd'.repeat(20), symbol: 'CAKE', decimals: 9 };
    const read = { decimals: 18, symbol: 'USDT' };
    // the fall-back: no payment token passed, or another coin passed
    assert.deepEqual(c.quoteUnit(usdt, undefined, 'tBNB', read), { symbol: 'USDT', decimals: 18 });
    assert.deepEqual(c.quoteUnit(usdt, other, 'tBNB', read), { symbol: 'USDT', decimals: 18 }, 'never the other coin\'s unit');
    assert.deepEqual(c.quoteUnit(usdt, undefined, 'tBNB', { decimals: 6n, symbol: 'USDC' }), { symbol: 'USDC', decimals: 6 }, 'a uint8 answered as bigint');
    // the host's own description of the asset still wins, and the native coin ignores any read
    assert.deepEqual(c.quoteUnit(usdt, { address: usdt, symbol: 'tUSDT', decimals: 18 }, 'tBNB', { decimals: 6, symbol: 'X' }), { symbol: 'tUSDT', decimals: 18 });
    assert.deepEqual(c.quoteUnit(zero, other, 'tBNB', read), { symbol: 'tBNB', decimals: 18 });
    // a wrong or missing answer is no unit: the page shows no amount and refuses
    assert.equal(c.quoteUnit(usdt, other, 'tBNB'), null, 'not read');
    assert.equal(c.quoteUnit(usdt, other, 'tBNB', null), null, 'the read failed');
    for (const decimals of [37, -1, 1.5, '18', null, undefined, 2n ** 70n, Number.NaN]) {
      assert.equal(c.quoteUnit(usdt, undefined, 'tBNB', { decimals, symbol: 'USDT' }), null, 'decimals ' + String(decimals));
    }
    for (const symbol of ['', 'US DT', 'X'.repeat(17), 'USD\n', 'ＵＳＤＴ', 7, null, undefined, '000', '1INCH', '$USD', '.USD', '-', 'USD/T']) {
      assert.equal(c.quoteUnit(usdt, undefined, 'tBNB', { decimals: 18, symbol }), null, 'symbol ' + JSON.stringify(symbol));
    }
    for (const symbol of ['USD', 'tUSDT', 'USD.e', 'a-b_c', 'X'.repeat(16)]) {
      assert.deepEqual(c.quoteUnit(usdt, undefined, 'tBNB', { decimals: 18, symbol }), { symbol, decimals: 18 }, symbol);
    }
    assert.equal(c.redeemRefusal({ balance: 1n, amount: 1n, quote: 1n, unitKnown: false }), 'states.unitUnknown');

    // the source: the load asks an ERC-20 asset (as the quote token) for decimals and symbol, reads only; the unit the
    // page uses takes that answer, kept with its chain and asset; the refusal still hangs on the unit
    const source = text(ui, dir, 'Component.tsx');
    const load = source.slice(source.indexOf('const loadData = useCallback(async () => {'), source.indexOf('useEffect(() => {'));
    assert.ok(load.includes('const quoteTokenAddress = asset;'));
    for (const name of ['decimals', 'symbol']) {
      assert.ok(load.includes(`sdk.readContract<unknown>({ contract: "token", address: quoteTokenAddress, abi: erc20Abi, functionName: "${name}" })`), name + ' is read on the asset');
    }
    assert.equal([...source.matchAll(/quoteTokenAddress/g)].length, [...load.matchAll(/quoteTokenAddress/g)].length, 'the asset address is used in the load only');
    assert.ok(!/(simulateContract|writeContract)\([^)]*quoteTokenAddress/.test(source), 'nothing is written to the asset');
    assert.ok(!load.includes('context.paymentToken'), 'the load does not hang on the host\'s payment token object (a new object there would restart it)');
    const state = dir === 'square-hole-pile' ? 'state' : 'shared';
    assert.ok(source.includes(`const unitRead = ${state} ? owned(unitAnswer, \`\${context.chainId}:\${${state}.asset}\`)?.read ?? null : null;`), 'the answer is used only for its chain and asset');
    assert.ok(source.includes(`const unit = ${state} ? quoteUnit(${state}.asset, context.paymentToken, t("units.native"), unitRead) : null;`));
    assert.ok(source.includes('unitKnown: unit !== null'));
    // no declared extra contract: the manifest's bindings stay as they were
    for (const b of json(ui, dir, 'manifest.json').match.bindings) assert.equal(b.externalContracts, undefined);
  });

  test(`${dir}: the coin is asked only when the host does not describe it, and never holds back the page's own state`, async () => {
    const other = '0x' + 'cd'.repeat(20);
    // no extra read when the host's payment token IS the asset; never for the native coin
    assert.equal(c.needsUnitRead(usdt, usdt.toLowerCase(), 18), false, 'the host describes the asset');
    assert.equal(c.needsUnitRead(zero, undefined, undefined), false, 'the native coin');
    assert.equal(c.needsUnitRead(zero, other, 9), false);
    assert.equal(c.needsUnitRead(usdt, undefined, undefined), true, 'no payment token');
    assert.equal(c.needsUnitRead(usdt, other, 18), true, 'another coin');
    assert.equal(c.needsUnitRead(usdt, usdt, 37), true, 'the host\'s decimals are not usable');
    assert.equal(c.needsUnitRead(usdt, usdt, undefined), true);
    const source = text(ui, dir, 'Component.tsx');
    const load = source.slice(source.indexOf('const loadData = useCallback(async () => {'), source.indexOf('useEffect(() => {'));
    assert.equal([...load.matchAll(/needsUnitRead\(/g)].length, 1);
    const gate = load.indexOf('if (needsUnitRead(quoteTokenAddress, paymentAddress, paymentDecimals)) {');
    const ask = load.indexOf('void unitFromCoin(unitAnswers.current, unitOf, [');
    assert.ok(gate !== -1 && ask > gate, 'the asset is asked only inside the gate');
    assert.equal([...source.matchAll(/unitFromCoin\(/g)].length, 2, 'defined once, called once');
    assert.ok(load.indexOf('() => sdk.readContract<unknown>({ contract: "token", address: quoteTokenAddress, abi: erc20Abi, functionName: "decimals" }),\n          () => sdk.readContract<unknown>({ contract: "token", address: quoteTokenAddress, abi: erc20Abi, functionName: "symbol" }),') > ask, 'each read is its own function, started by unitFromCoin');
    assert.ok(!/await\s+unitFromCoin|await\s+Promise\.all\(\[[^\]]*unit/.test(load), 'the coin is never awaited by the load');
    // the page's own state is published BEFORE the coin is asked: tiles, rules, share-out and pay-owed never wait
    const core = dir === 'square-hole-pile' ? 'setStateRaw({ of: identity, asset, pile, circulating, paidOut, perToken, tokenDecimals: Number(decimals) });'
      : 'setSharedRaw({ of: identity, asset, pending, totalOwed, rules, tokenDecimals: Number(decimals) });';
    assert.ok(load.indexOf(core) !== -1 && load.indexOf(core) < gate, 'the core state is set first');
    if (dir === 'square-hole-rules') assert.ok(load.indexOf('setLoading(false);') < gate, 'and the page is usable');
    assert.ok(source.includes('const paymentAddress = context.paymentToken?.address;') && source.includes('const paymentDecimals = context.paymentToken?.decimals;'));

    // unitFromCoin itself. A read that throws AT ONCE is a failed read, not an escape, and the other read's failure is
    // not left unhandled; a failed pair is forgotten and asked again.
    const unhandled = [];
    const note = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', note);
    const answers = new Map();
    let asked = 0;
    const count = (f) => () => { asked += 1; return f(); };
    const thrown = c.unitFromCoin(answers, 'k', [count(() => { throw new Error('at once'); }), count(() => Promise.reject(new Error('the other one')))]);
    assert.ok(thrown instanceof Promise, 'no synchronous throw');
    assert.equal(asked, 0, 'each read starts in its own promise callback');
    assert.equal(await thrown, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answers.size, 0, 'a failed pair is forgotten');
    assert.equal(asked, 2, 'both reads were started');
    assert.equal(await c.unitFromCoin(answers, 'k', [count(() => Promise.resolve(18)), count(() => Promise.reject(new Error('later')))]), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answers.size, 0);
    assert.equal(asked, 4, 'asked again after a failed pair');
    // ONE pair of reads while the answer is on its way: a refresh in between starts nothing
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const first = c.unitFromCoin(answers, 'k', [count(() => slow), count(() => Promise.resolve('000'))]);
    const second = c.unitFromCoin(answers, 'k', [count(() => Promise.resolve(18)), count(() => Promise.resolve('USD'))]);
    assert.equal(second, first, 'the pending promise itself');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 6, 'one pair only');
    release(99);
    // an answer that is NOT usable is kept all the same and never asked again
    const odd = await first;
    assert.deepEqual(odd, { decimals: 99, symbol: '000' });
    assert.equal(c.quoteUnit(usdt, undefined, 'tBNB', odd), null, 'and it gives no unit');
    assert.equal(await c.unitFromCoin(answers, 'k', [count(() => Promise.resolve(18)), count(() => Promise.resolve('USD'))]), odd, 'the kept answer');
    assert.equal(asked, 6, 'not asked a second time');
    // another chain or asset has its own answer
    assert.deepEqual(await c.unitFromCoin(answers, 'k2', [count(() => Promise.resolve(18)), count(() => Promise.resolve('USD'))]), { decimals: 18, symbol: 'USD' });
    assert.equal(asked, 8);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', note);
    assert.deepEqual(unhandled, [], 'no failure is left unhandled');
    assert.ok(load.includes('const unitOf = `${context.chainId}:${quoteTokenAddress}`;'), 'kept per chain and asset');
    assert.ok(source.includes('const unitAnswers = useRef(new Map<string, Promise<UnitRead>>());'), 'for the visit, from the moment it is asked');
  });

  test(`${dir}: no figure of one vault is ever shown for another (vault, token, chain, coin, amount)`, () => {
    const a = { of: '97:0xaa:0xbb', v: 1 };
    assert.equal(c.owned(a, '97:0xaa:0xbb'), a);
    assert.equal(c.owned(a, '97:0xaa:0xcc'), null, 'another token');
    assert.equal(c.owned(a, '56:0xaa:0xbb'), null, 'another chain');
    assert.equal(c.owned(a, null), null);
    assert.equal(c.owned(null, '97:0xaa:0xbb'), null);
    const source = text(ui, dir, 'Component.tsx');
    assert.ok(source.includes('const identity = `${context.chainId}:${context.vaultAddress}:${context.tokenAddress}`;'));
    const uses = dir === 'square-hole-pile'
      ? ['const state = owned(stateRaw, identity);', 'const mine = owned(mineRaw, mineOf);',
        'const quoteKey = state && amount !== null ? `${identity}:${state.asset}:${amount}` : null;']
      : ['const shared = owned(sharedRaw, identity);', 'const mine = owned(mineRaw, mineOf);',
        'const coinOf = shared ? `${identity}:${shared.asset}` : null;', 'const pile = owned(pileRaw, coinOf);',
        'const pileFailed = pileFailedOf !== null && pileFailedOf === coinOf;',
        'const quoteKey = coinOf !== null && pile && amount !== null ? `${coinOf}:${amount}` : null;'];
    for (const line of [...uses, 'const amountText = owned(amountRaw, identity)?.text ?? "";',
      'const setAmountText = (text: string) => setAmountRaw({ of: identity, text });',
      'const quote = owned(quoteRaw, quoteKey)?.value ?? null;',
      'const setQuote = (value: bigint | null) => setQuoteRaw(value === null || quoteKey === null ? null : { of: quoteKey, value });']) {
      assert.ok(source.includes(line), line);
    }
    // every figure the load keeps names what it was read for; nothing is kept without it
    const raw = dir === 'square-hole-pile' ? ['State', 'Mine'] : ['Shared', 'Pile', 'Mine'];
    for (const name of raw) {
      const sets = [...source.matchAll(new RegExp(`set${name}Raw\\(([^)]{0,24})`, 'g'))].map((x) => x[1]);
      assert.ok(sets.length >= 2, name);
      const owner = name === 'Mine' ? '{ of: mineOf' : name === 'Pile' ? '{ of: figureOf' : '{ of: identity';
      for (const arg of sets) assert.ok(arg === 'null' || arg.startsWith(owner), `set${name}Raw(${arg}`);
      assert.equal([...source.matchAll(new RegExp(`\\b${name.toLowerCase()}Raw\\b`, 'g'))].length, 2, name.toLowerCase() + 'Raw is read once, through owned()');
    }
    if (dir === 'square-hole-rules') {
      assert.ok(source.includes('const figureOf = `${identity}:${asset}`;'), 'the pile is kept with the asset it was read under');
      assert.ok(source.includes('setPileRaw({ of: figureOf, ...next.pile });') && source.includes('setPileFailedOf(figureOf);'));
    }
    assert.ok(!/useState<(PileState|Shared|Pile|Mine|bigint) \| null>|useState\(""\)/.test(source), 'no figure or typed amount is kept without its owner');
    assert.ok(/\[context\.chainId, context\.tokenAddress, context\.userAddress, context\.vaultAddress, identity, mineOf, paymentAddress, paymentDecimals, sdk, t, validVault, wallet\.isWrongNetwork\]/.test(source), 'a load belongs to one identity');
  });

  test(`${dir}: a wallet switch shows no figure of the previous wallet (balance, allowance)`, () => {
    const source = text(ui, dir, 'Component.tsx');
    // the visitor's own figures name the chain, the vault, the token AND the connected account
    assert.ok(source.includes('const mineOf = `${identity}:${context.userAddress ?? ""}`;'));
    assert.ok(source.includes('const mine = owned(mineRaw, mineOf);'));
    const before = { of: '97:0xaa:0xbb:0x' + 'a1'.repeat(20), balance: 5n, allowance: 5n };
    assert.equal(c.owned(before, '97:0xaa:0xbb:0x' + 'a1'.repeat(20)), before);
    assert.equal(c.owned(before, '97:0xaa:0xbb:0x' + 'b2'.repeat(20)), null, 'another wallet: nothing of the previous one');
    assert.equal(c.owned(before, '97:0xaa:0xbb:'), null, 'disconnected');
    // everything that uses them reads `mine`, never the kept value: "All", the balance row, the refusal, the approval
    assert.equal([...source.matchAll(/\bmineRaw\b/g)].length, 2, 'mineRaw is read once, through owned()');
    for (const use of ['setAmountText(exactDecimal(mine.balance, tokenDecimals))', 'value={mine ? grouped(shown(mine.balance, tokenDecimals)) : "-"}',
      'balance: mine?.balance ?? null', 'if ((mine?.allowance ?? 0n) < amount) {']) assert.ok(source.includes(use), use);
    const sets = [...source.matchAll(/setMineRaw\(([^)]{0,14})/g)].map((x) => x[1]);
    assert.ok(sets.length >= 3);
    for (const arg of sets) assert.ok(arg === 'null' || arg.startsWith('{ of: mineOf'), 'setMineRaw(' + arg);
  });

  test(`${dir}: the display quote holds nothing: shown only for what the page shows now, never stuck`, async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const later = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
    let page = 'v:5';
    const shownNow = [];
    const showing = () => page;
    const show = (key, value) => shownNow.push([key, value]);
    // a LATE answer for the amount still on the page is shown
    const slow = later();
    const asked = c.askQuote('v:5', () => slow.promise, showing, show);
    await tick();
    assert.deepEqual(shownNow, []);
    slow.release(11n);
    await asked;
    assert.deepEqual(shownNow, [['v:5', 11n]]);
    // an answer for ANOTHER amount, or another vault, is dropped when it arrives
    const old = later();
    const dropped = c.askQuote('v:5', () => old.promise, showing, show);
    page = 'v:6';
    old.release(12n);
    await dropped;
    const other = c.askQuote('w:6', () => Promise.resolve(13n), showing, show);
    await other;
    assert.deepEqual(shownNow, [['v:5', 11n]], 'nothing new was shown');
    page = null;
    await c.askQuote('v:6', () => Promise.resolve(14n), showing, show);
    assert.deepEqual(shownNow, [['v:5', 11n]], 'no amount on the page: nothing is shown');
    // a quote that NEVER answers does not prevent the next one, and two on their way both land
    page = 'v:6';
    c.askQuote('v:6', () => new Promise(() => {}), showing, show);
    const a = later();
    const b = later();
    const one = c.askQuote('v:6', () => a.promise, showing, show);
    const two = c.askQuote('v:6', () => b.promise, showing, show);
    b.release(21n);
    await two;
    a.release(20n);
    await one;
    assert.deepEqual(shownNow.slice(1), [['v:6', 21n], ['v:6', 20n]], 'each answer for the amount on the page is shown as it lands');
    // a failed quote, also one that throws at once, changes nothing and escapes nowhere
    const failed = c.askQuote('v:6', () => { throw new Error('at once'); }, showing, show);
    assert.ok(failed instanceof Promise);
    assert.equal(await failed, undefined);
    assert.equal(await c.askQuote('v:6', () => Promise.reject(new Error('later')), showing, show), undefined);
    assert.equal(shownNow.length, 3);

    // the source: no flag, no queue, no release timer in the quote path
    const source = text(ui, dir, 'Component.tsx');
    const path = source.slice(source.indexOf('const quoteFor = useCallback('), source.indexOf('const blocked = '));
    assert.ok(path.length > 300, 'the quote path');
    const code = path.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/\b(flight|flights|again|debouncing|startedAt|nowMs|inFlight|lock|queue|pending)\b|30_000|useRef|useState|\.current\s*(\+|-)?=(?!=)[^;]*;[^\n]*\n(?<!showing\.current = [^\n]*\n)/.test(code), 'nothing is held in the quote path');
    assert.deepEqual([...code.matchAll(/(\w+)\.current\b/g)].map((x) => x[1]).filter((name) => name !== 'showing'), [], 'the only ref in the path is what the page shows now');
    assert.ok(!/const (flight|flights|again|debouncing|wanted) = useRef/.test(source) && !/function (refreshQuote|quoteLands)/.test(source), 'the lock is gone');
    assert.ok(source.includes('const showing = useRef<{ key: string; amount: bigint } | null>(null);'), 'only what the page shows now is kept');
    assert.match(path, /void askQuote\(key, (\(\) => sdk\.readContract<bigint>\(\{ contract: "vault"|async \(\) => \{\s+const handle = await sdk\.resolveContract\("pile")/);
    assert.ok(path.includes('() => showing.current?.key ?? null, (of, value) => setQuoteRaw({ of, value }));'));
    assert.equal([...path.matchAll(/functionName: "quoteRedeem", args: \[amountNow\]/g)].length, 1);
    // a change of the amount: the page's key moves at once; the one timer is the 0.4 s wait, and its cleanup stops
    // only that wait (no answer is cancelled)
    assert.ok(path.includes('showing.current = quoteKey !== null && amount !== null ? { key: quoteKey, amount } : null;'));
    assert.equal([...path.matchAll(/setTimeout|setInterval/g)].length, 1);
    assert.ok(path.includes('const timer = setTimeout(() => quoteFor(quoteKey, amount), 400);\n    return () => clearTimeout(timer);'));
    // every landed refresh round asks again, with no cleanup and no condition but an entered amount
    assert.match(path, /useEffect\(\(\) => \{\s+const now = showing\.current;\s+if \(now !== null\) quoteFor\(now\.key, now\.amount\);\s+\}, \[quoteFor, round\]\);/);
    assert.equal([...path.matchAll(/return \(\) =>/g)].length, 1, 'one cleanup in the path: the wait\'s');
    // the answer is DISPLAYED only for the key the page shows
    assert.ok(source.includes('const quote = owned(quoteRaw, quoteKey)?.value ?? null;'));
    // a landed load moves the round on, once, after its fresh numbers are set
    const load = source.slice(source.indexOf('const loadData = useCallback(async () => {'), source.indexOf('useEffect(() => {'));
    assert.equal([...load.matchAll(/setRound\(\(n\) => n \+ 1\);/g)].length, 1);
    const landed = dir === 'square-hole-pile' ? 'setStateRaw({ of: identity, asset, pile,' : 'setPileRaw({ of: figureOf, ...next.pile });';
    assert.ok(load.indexOf(landed) !== -1 && load.indexOf(landed) < load.indexOf('setRound('), 'after the fresh numbers are set');
    assert.ok(source.includes('const [round, setRound] = useState(0);'));
  });

  test(`${dir}: the redeem handler's order: zero stop, exact approval to the right address, a fresh quote, redeem with it as the minimum`, () => {
    const source = text(ui, dir, 'Component.tsx');
    const pilePage = dir === 'square-hole-pile';
    const handler = pilePage
      ? source.slice(source.indexOf('async function redeem() {'), source.indexOf('return <div className="w-full'))
      : source.slice(source.indexOf('const redeem = () => send("redeemed", async () => {'), source.indexOf('const noteText'));
    const steps = pilePage ? [
      'if (unavailable || amount === null || lock.current) return;',
      'const quoteNow = () => sdk.readContract<bigint>({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "quoteRedeem", args: [amount] });',
      'if (minOutFor(await quoteNow()) === null) { setQuote(0n); setError(t("states.forNothing")); return; }',
      'if ((mine?.allowance ?? 0n) < amount) {',
      'const approval = await sdk.simulateContract({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "approve", args: [context.vaultAddress, amount] });',
      'const approvalHash = await sdk.writeContract(approval.request);',
      'const approvalReceipt = await sdk.waitForTx(approvalHash);',
      'if (approvalReceipt.status !== "success") { setError(t("errors.reverted")); return; }',
      'const minOut = minOutFor(await quoteNow());',
      'if (minOut === null) { setQuote(0n); setError(t("states.forNothing")); return; }',
      'const simulation = await sdk.simulateContract({ contract: "vault", address: context.vaultAddress, abi: vaultAbi, functionName: "redeem", args: [amount, minOut] });',
      'const hash = await sdk.writeContract(simulation.request);',
      'const receipt = await sdk.waitForTx(hash);',
    ] : [
      'if (redeemBlocked || amount === null || !pile) return false;',
      'const handle = await sdk.resolveContract("pile", [context.tokenAddress]);',
      'const first = await sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [amount] });',
      'if (minOutFor(first) === null) { setQuote(0n); setError(t("states.forNothing")); return false; }',
      'if ((mine?.allowance ?? 0n) < amount) {',
      'const approval = await sdk.simulateContract({ contract: "token", address: context.tokenAddress, abi: erc20Abi, functionName: "approve", args: [handle.address, amount] });',
      'if (!(await confirmed(await sdk.writeContract(approval.request)))) return false;',
      'const minOut = minOutFor(await sdk.readContract<bigint>({ contract: handle, abi: pileAbi, functionName: "quoteRedeem", args: [amount] }));',
      'if (minOut === null) { setQuote(0n); setError(t("states.forNothing")); return false; }',
      'const simulation = await sdk.simulateContract({ contract: handle, abi: pileAbi, functionName: "redeem", args: [amount, minOut] });',
      'if (!(await confirmed(await sdk.writeContract(simulation.request)))) return false;',
    ];
    let at = -1;
    for (const step of steps) {
      const next = handler.indexOf(step, at + 1);
      assert.ok(next > at, 'in this order: ' + step);
      assert.equal(handler.indexOf(step, next + 1), -1, 'once: ' + step);
      at = next;
    }
    // the handler writes twice at most (the approval, the redeem) and to nothing else
    assert.equal([...handler.matchAll(/sdk\.writeContract\(/g)].length, 2);
    assert.equal([...handler.matchAll(/sdk\.simulateContract\(/g)].length, 2);
    assert.equal([...source.matchAll(/sdk\.writeContract\(/g)].length, pilePage ? 2 : 4, 'the page\'s writes: ' + (pilePage ? 'approve, redeem' : 'share out, pay a creator part, approve, redeem'));
    assert.ok(!/redeemTo|setApprovalForAll|maxUint|MAX_UINT|2n \*\* 256n/.test(source), 'no other recipient, no unlimited approval');
  });

  test(`${dir}: coin amounts read with thousands separators in their whole part; the amount field does not`, () => {
    const usd = { symbol: 'USD', decimals: 18 };
    assert.equal(c.coinText(1_080_000_000n * 10n ** 18n + 5n * 10n ** 17n, usd), '1,080,000,000.5 USD');
    assert.equal(c.coinText(999n * 10n ** 18n, usd), '999 USD');
    assert.equal(c.coinText(1234n * 10n ** 18n + 123456789n * 10n ** 9n, usd, 8), '1,234.12345678 USD');
    assert.equal(c.coinText(462962n, { symbol: 'tBNB', decimals: 18 }, 8), '0.000000000000462 tBNB');
    assert.equal(c.coinText(0n, usd), '0 USD');
    assert.equal(c.coinText(5n, null), '-', 'no unit: no amount');
    assert.equal(c.coinText(1_234_567_890n, { symbol: 'USDC', decimals: 6 }), '1,234.5678 USDC');
    const source = text(ui, dir, 'Component.tsx');
    assert.ok(source.includes('const coin = (value: bigint, places = 4) => coinText(value, unit, places);'));
    // the parser takes plain digits only, as before, and "All" types none
    assert.equal(c.parseExact('1,080', 18), null);
    assert.equal(c.parseExact('1080', 18), 1080n * 10n ** 18n);
    assert.ok(!c.exactDecimal(1_080_000_000n * 10n ** 18n, 18).includes(','));
  });

  test(`${dir}: "How it works" is a list in the closed "More" part, every line with its text`, () => {
    const source = text(ui, dir, 'Component.tsx');
    const en = json(ui, dir, 'i18n.json').en;
    const more = source.slice(source.indexOf('<details'), source.indexOf('</details>'));
    assert.match(more, /^<details className="[^"]*">\s*<summary[^>]*>\{t\("labels\.more"\)\}<\/summary>/, 'the More part, closed by default (no open attribute)');
    assert.ok(!/<details[^>]*\bopen\b/.test(source), 'never open by default');
    assert.equal([...source.matchAll(/<details/g)].length, 1);
    assert.ok(more.includes('<h4 className="pt-2 text-xs font-semibold text-white/70">{t("sections.how")}</h4>'), 'the small heading');
    assert.match(more, /<ul [^>]*>\s*\{howLines\([^\n]*\)\.map\(\(key\) => <li key=\{key\}>\{howText\[key\]\}<\/li>\)\}\s*<\/ul>/, 'the list');
    assert.equal([...source.matchAll(/howLines\(/g)].length, 2, 'defined once, used once: inside More');
    assert.equal(en['sections.how'], 'How it works');
    // every "how." key of the component has a line, and every line of the list is one of them
    const howKeys = Object.keys(en).filter((k) => k.startsWith('how.')).sort();
    const all = dir === 'square-hole-pile'
      ? [...c.howLines(zero), ...c.howLines(usdt)]
      : [...c.howLines([1, 2, 3], zero), ...c.howLines([1, 2, 3], usdt)];
    assert.deepEqual([...new Set(all)].sort(), howKeys);
    for (const key of howKeys) assert.ok(source.includes(`"${key}": t("${key}")`), key + ' in the list\'s texts');
    // the lines both pages share, word for word
    assert.equal(en['how.whole'], 'Whoever hands in the whole circulating supply gets the whole pile.');
    // only a redemption pays the connected wallet (on the rules page "Pay this part now" pays the creator's payee)
    assert.equal(en['how.payoutNative'], 'What you redeem is paid in tBNB to the connected wallet. A contract wallet must be able to receive tBNB.');
    assert.equal(en['how.payoutToken'], 'What you redeem is paid to the connected wallet.');
    for (const value of Object.values(en)) assert.ok(!/^Payouts? /.test(value), value);
    assert.ok(!/tBNB/.test(en['how.payoutToken']), 'a token payout never names tBNB');
    assert.match(en['how.taxEnds'], /^The tax stops when the token's tax period ends\. /);
    assert.match(en['how.lag'], /when Flap's tax processor pays out/);
    assert.match(en['how.approval'], /[Yy]our wallet may ask for an approval first\.$/);
    assert.match(en['how.upgrade'], /^Flap's Guardian can upgrade this vault's code/);
    assert.match(en['how.share'], /^One token's share is the pile divided by the circulating supply\. That supply leaves out only burned tokens and tokens (this vault|the pile) holds\.$/);
    // never a cap of the platform, never a trust label of our own
    for (const value of Object.values(en)) assert.ok(!/platform|verified by|audited|trusted|safe\b/i.test(value), value);
  });

  test(`${dir}: an amount that is not zero never reads "0"; small amounts keep three digits, rounded down`, () => {
    assert.equal(c.shown(462962n, 18), '0.000000000000462');
    assert.equal(c.shown(462962n, 18, 8), '0.000000000000462', 'also in the 8-place tiles');
    assert.equal(c.shown(0n, 18), '0');
    assert.equal(c.shown(1n, 18), '0.000000000000000001');
    assert.equal(c.shown(999n, 18), '0.000000000000000999');
    assert.equal(c.shown(1999n, 18), '0.00000000000000199', 'down, never up');
    // normal amounts keep their form
    assert.equal(c.shown(500000000000000n, 18), '0.0005');
    assert.equal(c.shown(1_234_567n, 6), '1.2345');
    assert.equal(c.shown(1_234_567n, 6, 8), '1.234567');
    assert.equal(c.shown(12n * 10n ** 18n + 345678912345678912n, 18), '12.3456');
    assert.equal(c.shown(10n ** 18n, 18), '1');
    assert.equal(c.shown(7n, 0), '7');
    // over many amounts: never "0" for a positive amount, never more than the true amount, at most 0.1% below it
    // or within the last shown place
    let x = 1n;
    for (let k = 0; k < 400; k += 1) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n);
      for (const decimals of [0, 6, 18]) {
        const value = (x >> BigInt(k % 60)) + 1n;
        for (const places of [4, 8]) {
          const out = c.shown(value, decimals, places);
          assert.notEqual(out, '0', `${value} at ${decimals}`);
          const [whole, fraction = ''] = out.split('.');
          const back = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
          assert.ok(back <= value, `${out} is not above ${value}`);
          assert.ok(back * 100n >= value * 99n || fraction.length >= places, `${out} keeps three digits of ${value}`);
        }
      }
    }
    const source = text(ui, dir, 'Component.tsx');
    assert.ok(!/parseFloat|toFixed|toLocaleString|Intl\./.test(source), 'amounts are formatted from bigint, not through floating point');
  });

  test(`${dir}: token counts read with thousands separators`, () => {
    assert.equal(c.tokenCount(1_080_000_000n * 10n ** 18n, 18), '1,080,000,000');
    assert.equal(c.tokenCount(1_080_000_000n * 10n ** 18n + 999n, 18), '1,080,000,000', 'whole tokens, rounded down');
    assert.equal(c.tokenCount(999n * 10n ** 18n, 18), '999');
    assert.equal(c.tokenCount(1000n * 10n ** 18n, 18), '1,000');
    assert.equal(c.tokenCount(0n, 18), '0');
    assert.equal(c.tokenCount(5n * 10n ** 17n, 18), '0.5', 'below one token: not "0"');
    assert.equal(c.tokenCount(1n, 18), '0.000000000000000001');
    assert.equal(c.grouped('1234567.5'), '1,234,567.5');
    assert.equal(c.grouped('123'), '123');
    assert.equal(c.grouped('0.0001234'), '0.0001234', 'the fraction is never grouped');
    assert.equal(c.grouped(c.shown(1_234_567n * 10n ** 18n + 5n * 10n ** 17n, 18)), '1,234,567.5', 'your tokens: grouped, the fraction kept');
    const source = text(ui, dir, 'Component.tsx');
    assert.ok(source.includes('value={mine ? grouped(shown(mine.balance, tokenDecimals)) : "-"}'), 'your tokens');
    assert.ok(source.includes(dir === 'square-hole-pile'
      ? 'value={state ? tokenCount(state.circulating, tokenDecimals) : "-"}'
      : 'value={tokenCount(rule.burned, tokenDecimals)}'), 'the supply, or the tokens burned');
    // "All" still types the exact plain balance (no separators reach the input)
    assert.ok(source.includes('setAmountText(exactDecimal(mine.balance, tokenDecimals))'));
  });

  test(`${dir}: the brand mark is drawn inside the component and points nowhere outside the package`, () => {
    const source = text(ui, dir, 'Component.tsx');
    const marks = [...source.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((x) => x[0]);
    assert.equal(marks.length, 1, 'one inline picture: the mark');
    const [mark] = marks;
    // beside the title, in the header's first row, before the risk badge
    const header = source.slice(source.indexOf('<CardHeader'), source.indexOf('</CardHeader>'));
    assert.ok(header.includes(mark));
    assert.ok(header.indexOf(mark) < header.indexOf('<CardTitle>{t("title")}</CardTitle>'));
    assert.ok(header.indexOf('<CardTitle>') < header.indexOf('<StatusBadge'));
    // the simple mark: a rounded square with a rim, 28 px, named for a screen reader
    assert.match(mark, /^<svg className="h-7 w-7 shrink-0" width="28" height="28" viewBox="0 0 32 32" role="img" aria-label=\{t\("brand\.name"\)\}>/);
    assert.equal(json(ui, dir, 'i18n.json').en['brand.name'], 'Square Hole');
    assert.ok(mark.includes('<rect x="2" y="2" width="28" height="28" rx="8" fill="url(#square-hole-mark)" />'));
    assert.ok(mark.includes('<rect x="10.5" y="10.5" width="11" height="11" rx="2" fill="#080d16" />'));
    assert.ok(mark.includes('<linearGradient id="square-hole-mark"'));
    // only static graphic nodes; no link, no motion, no handler
    const tags = [...new Set([...mark.matchAll(/<([A-Za-z]+)/g)].map((x) => x[1]))].sort();
    assert.deepEqual(tags, ['defs', 'linearGradient', 'rect', 'stop', 'svg']);
    assert.ok(!/animate|<a\b|\bon[A-Z]\w*=|style=|xmlns/.test(mark));
    // no src, href or url() in the whole component points outside the package: the only url() is the mark's own gradient
    assert.deepEqual([...source.matchAll(/url\(([^)]*)\)/g)].map((x) => x[1]), ['#square-hole-mark']);
    assert.ok(!/\b(src|href|xlinkHref|srcSet|poster)\s*=/.test(source), 'no src or href attribute at all');
    assert.ok(!/https?:\/\/|data:|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(source), 'no address of any outside file');
    assert.ok(!/\bfetch\(|<img\b|<image\b|<use\b|import\(/.test(source));
  });

  test(`${dir}: no internal work label in the four files that are packaged`, () => {
    for (const file of ['Component.tsx', 'VaultABI.ts', 'i18n.json', 'manifest.json']) {
      const body = text(ui, dir, file);
      assert.ok(!/\bSH-?\d{2,}/i.test(body), file + ' names a work label');
      assert.ok(!/\blane [a-z]\b|\.test\.mjs|corrected (set|contracts?)/i.test(body), file + ' names our own workflow');
    }
  });
}

test('the pile UI: the label, the description and the payout line by the coin', () => {
  const en = json(ui, 'square-hole-pile', 'i18n.json').en;
  assert.equal(en['labels.circulating'], 'Circulating supply (includes the pool)');
  assert.equal(en.description, "Part of the trading tax fills this pile, after any burn share and Flap's fee. Any curve sale fees went in at the launch. Hand in tokens to take your share of it.");
  assert.equal(en['how.taxEnds'], "The tax stops when the token's tax period ends. Trades after that bring no new tax to the pile.");
  assert.equal(en['how.lag'], "New tax reaches the pile when Flap's tax processor pays out, so the pile can lag trading.");
  assert.equal(en['how.approval'], 'Your wallet may ask for an approval first.');
  assert.equal(en['how.upgrade'], "Flap's Guardian can upgrade this vault's code.");
  assert.deepEqual(pileUi.howLines(zero), ['how.share', 'how.whole', 'how.taxEnds', 'how.lag', 'how.approval', 'how.payoutNative', 'how.upgrade']);
  assert.deepEqual(pileUi.howLines(usdt), ['how.share', 'how.whole', 'how.taxEnds', 'how.lag', 'how.approval', 'how.payoutToken', 'how.upgrade']);
  assert.deepEqual(pileUi.howLines(null), ['how.share', 'how.whole', 'how.taxEnds', 'how.lag', 'how.approval', 'how.upgrade'], 'before the vault is read: no payout line');
});

test('the rules UI: the lines follow the parts the vault has; the present sentences are unchanged', () => {
  const en = json(ui, 'square-hole-rules', 'i18n.json').en;
  // unchanged
  assert.equal(en.description, 'Part of the trading tax arrives here and is shared by the parts the creator chose before the sale.');
  assert.equal(en['notices.anyone'], 'Anyone can share out. A part that cannot go out yet waits.');
  assert.equal(en['notices.burnPaced'], 'Buys at most once a minute, a little each time; the rest waits.');
  // new
  assert.equal(en['how.sources'], "Any burn share and Flap's fee come off the tax before it arrives here. Any curve sale fees arrived here at the launch.");
  assert.equal(en['how.taxEnds'], "The tax stops when the token's tax period ends. Trades after that bring no new tax here.");
  assert.equal(en['how.payee'], 'A creator part goes to the address the creator chose before the sale. It can be a wallet or a contract, for example a staking pool or a card shop. A contract then follows its own rules.');
  assert.equal(en['how.burn'], "Buy and burn buys the token from the pool and burns it. Each buy is at most 0.05% of the pool's coin side, with a minimum worked out from the pool's reserves at that moment.");
  assert.equal(en['how.upgrade'], "Flap's Guardian can upgrade this vault's code and the pile's code.");
  const always = ['how.sources', 'how.taxEnds', 'how.lag'];
  assert.deepEqual(rulesUi.howLines(null, null), [...always, 'how.upgrade'], 'before the rules are read');
  assert.deepEqual(rulesUi.howLines([1], zero), [...always, 'how.payee', 'how.upgrade'], 'a creator part only');
  assert.deepEqual(rulesUi.howLines([2], zero), [...always, 'how.share', 'how.whole', 'how.approval', 'how.payoutNative', 'how.upgrade'], 'the pile only');
  assert.deepEqual(rulesUi.howLines([2], usdt), [...always, 'how.share', 'how.whole', 'how.approval', 'how.payoutToken', 'how.upgrade']);
  assert.deepEqual(rulesUi.howLines([1, 3], zero), [...always, 'how.payee', 'how.burn', 'how.upgrade'], 'no pile part: no pile line, no payout line');
  assert.deepEqual(rulesUi.howLines([1, 2, 3], usdt), [...always, 'how.payee', 'how.burn', 'how.share', 'how.whole', 'how.approval', 'how.payoutToken', 'how.upgrade']);
});
