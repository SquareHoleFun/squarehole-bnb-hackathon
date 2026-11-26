// SH-305: the Flap template launch UIs for our two rules curve launcher factories (BNB quote, test-dollar quote).
// Runs each component's own code (bounties/flap/ui/rules-*/Component.tsx, transpiled with the repository's
// typescript) and checks:
//  - the creation data the form hands to host.encode is byte for byte what Solidity's abi.encode(CurveConfig) gives
//    for the same inputs (pinned vectors from `forge script`, see VECTORS below);
//  - the component's keccak-256 and CREATE2 token prediction against known digests and our real sales on chain 97;
//  - each manifest's reads and actions against the deployed launcher's ABI, and the factory against the deployment;
//  - the two components differ only in their factory block; every message key exists in en, zh and ko.
// usage: node --test bounties/flap/ui/test/rules-ui.test.mjs   (from the repository's top folder)
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

// Pinned 26 Nov 2026 on the build machine: forge 1.8.3, `forge script` of a contract returning abi.encode(c) for the
// CurveConfig struct of bounties/flap/src/RulesCurveLauncher.sol (the token variant imports the same struct), with
// CreateRulesSale.s.sol's defaults for each VARIANT (600,000,000 sale tokens, 2 days, fee 100, buy 300, sell 500,
// burn 2000, tax 365 days; native: "Rules Pile", "RULE", 2.35 and 16 BNB; usdt: "Rules Pile USD", "RULEU", 1,700 and
// 11,600 of the quote) and the salt of our real rules sale of that variant (deployments/97-rules-*-sale.json).
const VECTORS = {
  'rules-bnb': '0x'
    + '0000000000000000000000000000000000000000000000000000000000000020'
    + '00000000000000000000000000000000000000000000000000000000000001a0'
    + '00000000000000000000000000000000000000000000000000000000000001e0'
    + '0000000000000000000000000000000000000000000000000000000000000220'
    + 'c5f201690b3c2ba7f1ac2437808b975f1d906be1d02de3a1280faf7028553487'
    + '000000000000000000000000000000000000000001f04ef12cb04cf158000000'
    + '000000000000000000000000000000000000000000000000209ce08c962b0000'
    + '000000000000000000000000000000000000000000000000de0b6b3a76400000'
    + '000000000000000000000000000000000000000000000000000000000002a300'
    + '0000000000000000000000000000000000000000000000000000000000000064'
    + '000000000000000000000000000000000000000000000000000000000000012c'
    + '00000000000000000000000000000000000000000000000000000000000001f4'
    + '00000000000000000000000000000000000000000000000000000000000007d0'
    + '0000000000000000000000000000000000000000000000000000000001e13380'
    + '000000000000000000000000000000000000000000000000000000000000000a'
    + '52756c65732050696c6500000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000004'
    + '52554c4500000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000000',
  'rules-usdt': '0x'
    + '0000000000000000000000000000000000000000000000000000000000000020'
    + '00000000000000000000000000000000000000000000000000000000000001a0'
    + '00000000000000000000000000000000000000000000000000000000000001e0'
    + '0000000000000000000000000000000000000000000000000000000000000220'
    + 'b94541e50f0bfadf6b9232458d112f216155e46f75c087e118f29add1a515cfe'
    + '000000000000000000000000000000000000000001f04ef12cb04cf158000000'
    + '00000000000000000000000000000000000000000000005c283d410394100000'
    + '000000000000000000000000000000000000000000000274d656ac90e3400000'
    + '000000000000000000000000000000000000000000000000000000000002a300'
    + '0000000000000000000000000000000000000000000000000000000000000064'
    + '000000000000000000000000000000000000000000000000000000000000012c'
    + '00000000000000000000000000000000000000000000000000000000000001f4'
    + '00000000000000000000000000000000000000000000000000000000000007d0'
    + '0000000000000000000000000000000000000000000000000000000001e13380'
    + '000000000000000000000000000000000000000000000000000000000000000e'
    + '52756c65732050696c6520555344000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000005'
    + '52554c4555000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000000',
};

// The factory's pure curveFor(saleTokens, targetRaise, virtualBnb), called on 26 Nov 2026 at the corrected BNB rules
// factory 0xa0c6D7be020eD3699508745A4dbAC1A8a1B415C2 on chain 97 (cast call, one at a time; the same six answers as
// the first factory gave): virtual tokens, raise, pool tokens, total supply; null where it reverts "curve too steep for
// its sale". The first two inputs are the settings of the first set's two real sales (their virtualTokens,
// raiseTarget, poolToken and totalSupply as read from their launchers).
const CURVES = [
  [[600_000_000n * 10n ** 18n, 10n ** 17n, 68n * 10n ** 16n],
    [4680000000000000000000000000n, 100000000000000000n, 523076923076923076923076923n, 1123076923076923076923076923n]],
  [[600_000_000n * 10n ** 18n, 1700n * 10n ** 18n, 11600n * 10n ** 18n],
    [4694117647058823529411764705n, 1700000000000000000001n, 523308270676691729323576752n, 1123308270676691729323576752n]],
  [[600_000_000n * 10n ** 18n, 1n, 16n * 10n ** 18n],
    [9600000000000000000600000000000000000000000000n, 1n, 599999999999999999962500000n, 1199999999999999999962500000n]],
  [[100n * 10n ** 18n, 3n, 1n], [133333333333333333333n, 4n, 26666666666666666666n, 126666666666666666666n]],
  [[10n ** 18n, 2350000000000000000n, 1n], null],
  [[100n * 10n ** 18n, 2350000000000000000n, 10n ** 15n],
    [100042553191489361702n, 2350000000000000008n, 42535091450446618n, 100042535091450446618n]],
];

const VARIANTS = [
  { dir: 'rules-bnb', abi: 'RulesCurveLauncher.json', deployment: '97-v2-rules-native.json', sale: '97-v2-rules-native-sale.json',
    vectorSalt: '0xc5f201690b3c2ba7f1ac2437808b975f1d906be1d02de3a1280faf7028553487',
    name: 'Rules Pile', symbol: 'RULE', target: 2_350_000_000_000_000_000n, depth: 16n * 10n ** 18n, buyRest: true },
  { dir: 'rules-usdt', abi: 'RulesTokenCurveLauncher.json', deployment: '97-v2-rules-usdt.json', sale: '97-v2-rules-usdt-sale.json',
    vectorSalt: '0xb94541e50f0bfadf6b9232458d112f216155e46f75c087e118f29add1a515cfe',
    name: 'Rules Pile USD', symbol: 'RULEU', target: 1_700n * 10n ** 18n, depth: 11_600n * 10n ** 18n, buyRest: false },
];

/** The component's private helpers, reached by appending one export to a transpiled copy (the shipped file keeps
 * exactly the two named exports Flap's checker requires). React is stubbed: nothing here renders. */
function load(source) {
  const withExport = source + '\nexport const __test = { configParameters, configValues, readForm, initialForm, curveFor, keccak, predictToken, fitsToken, mineSalt, toHex, buyRestHere };\n';
  const { outputText } = ts.transpileModule(withExport, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const stubs = {
    react: { useEffect() {}, useRef() { return { current: false }; }, useState(v) { return [v, () => {}]; } },
    'react/jsx-runtime': { jsx() { return null; }, jsxs() { return null; }, Fragment: 'fragment' },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((id) => stubs[id], module, module.exports);
  return module.exports.__test;
}

// A plain ABI encoder for the types the form uses (tuple, string, bytes32, uintN), written from the Solidity ABI
// specification and independent of the component, standing in for the host's `encode`.
function word(n) {
  return n.toString(16).padStart(64, '0');
}
function dynamic(p) {
  return p.type === 'string' || (p.type === 'tuple' && p.components.some(dynamic));
}
function encodeOne(p, v) {
  if (p.type === 'tuple') return encodeTuple(p.components, p.components.map((c, i) => (Array.isArray(v) ? v[i] : v[c.name])));
  if (p.type === 'string') {
    const hex = Buffer.from(v, 'utf8').toString('hex');
    return word(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  }
  if (p.type === 'bytes32') {
    assert.match(v, /^0x[0-9a-f]{64}$/i);
    return v.slice(2).toLowerCase();
  }
  const bits = /^uint(\d+)$/.exec(p.type);
  assert.ok(bits, 'unsupported type ' + p.type);
  assert.equal(typeof v, 'bigint', p.name + ' is a bigint');
  assert.ok(v >= 0n && v < 1n << BigInt(bits[1]), p.name + ' fits ' + p.type);
  return word(v);
}
function encodeTuple(params, values) {
  const heads = [];
  const tails = [];
  let tailOffset = BigInt(params.length * 32);
  params.forEach((p, i) => {
    const enc = encodeOne(p, values[i]);
    if (dynamic(p)) {
      heads.push(word(tailOffset));
      tails.push(enc);
      tailOffset += BigInt(enc.length / 2);
    } else {
      heads.push(enc);
    }
  });
  return heads.join('') + tails.join('');
}
const encode = (params, values) => '0x' + encodeTuple(params, values);

const sources = Object.fromEntries(VARIANTS.map((v) => [v.dir, readFileSync(join(ui, v.dir, 'Component.tsx'), 'utf8')]));

for (const v of VARIANTS) {
  const source = sources[v.dir];
  const c = load(source);
  const manifest = json(ui, v.dir, 'manifest.json');
  const messages = json(ui, v.dir, 'i18n.json');
  // the corrected contracts' interface (abi-v2-3031bdb9/, from the merged SH-308 tree; byte-equal to abi/ for these two)
  const abi = json(here, 'abi-v2-3031bdb9', v.abi);
  const deployment = json(flap, 'deployments', v.deployment);
  const sale = json(flap, 'deployments', v.sale);
  const form = { ...c.initialForm, name: v.name, symbol: v.symbol };

  test(`${v.dir}: the encoder reproduces the Foundry vector from the script defaults typed in by hand`, () => {
    const config = {
      name: v.name, symbol: v.symbol, meta: '', salt: v.vectorSalt, saleTokens: 600_000_000n * 10n ** 18n,
      targetRaise: v.target, virtualBnb: v.depth, duration: 172_800n, tradeFeeBps: 100n, buyTaxBps: 300n,
      sellTaxBps: 500n, burnShareBps: 2000n, taxDuration: 31_536_000n,
    };
    assert.equal(encode(c.configParameters, [config]), VECTORS[v.dir]);
  });

  test(`${v.dir}: the form's data for the default settings equals the Foundry bytes`, () => {
    const read = c.readForm(form);
    assert.ok('config' in read, 'the defaults are a valid form');
    assert.equal(encode(c.configParameters, c.configValues(read.config, v.vectorSalt)), VECTORS[v.dir]);
  });

  test(`${v.dir}: the form refuses what the factory refuses`, () => {
    const bad = (patch) => c.readForm({ ...form, ...patch }).field;
    assert.equal(bad({ name: ' ' }), 'name');
    assert.equal(bad({ target: '0' }), 'target');
    assert.equal(bad({ target: '1e18' }), 'target');
    assert.equal(bad({ hours: '721' }), 'hours');
    assert.equal(bad({ hours: '0' }), 'hours');
    assert.equal(bad({ buyTax: '0.5' }), 'buyTax');
    assert.equal(bad({ buyTax: '10.01' }), 'buyTax');
    assert.equal(bad({ buyTax: '0', sellTax: '0' }), 'sellTax');
    assert.equal(bad({ fee: '5.01' }), 'fee');
    assert.equal(bad({ burn: '100' }), 'burn');
    assert.equal(bad({ taxDays: '0' }), 'taxDays');
    assert.equal(bad({ saleTokens: '600000000.5' }), 'saleTokens');
    // a 1-wei raise passes the curve checks: the factory's own curveFor gives raise 1 for it (CURVES below); only
    // Flap's minimum could refuse it, and that is zero for these factories today
    const ok = c.readForm({ ...form, buyTax: '0', sellTax: '1', target: '0.000000000000000001' });
    assert.ok('config' in ok);
    assert.equal(ok.config.targetRaise, 1n);
  });

  test(`${v.dir}: the curve equals the factory's curveFor, read on chain 97`, () => {
    for (const [args, want] of CURVES) {
      const got = c.curveFor(...args);
      assert.deepEqual(got && [got.virtualTokens, got.raise, got.poolToken, got.totalSupply], want, args.join(', '));
    }
  });

  // One case per curve bound of checkConfig, each refused for exactly that reason and accepted without it.
  const refusal = (patch) => {
    const r = c.readForm({ ...form, ...patch });
    return 'config' in r ? 'accepted' : r.field + ':' + (r.reason ?? '');
  };
  test(`${v.dir}: bound 1, virtual tokens above the sale ("curve too steep")`, () => {
    assert.equal(refusal({ saleTokens: '1', target: '2.35', depth: '0.000000000000000001' }), 'depth:curveSteep');
  });
  test(`${v.dir}: bound 2, the pool gets at least one token ("pool below one token")`, () => {
    assert.equal(refusal({ saleTokens: '100', target: '2.35', depth: '0.001' }), 'depth:poolSmall');
    assert.equal(refusal({ saleTokens: '100', target: '2.35', depth: '0.06' }), 'accepted');
  });
  test(`${v.dir}: bound 3, the raise within one millionth of the target ("raise off target")`, () => {
    assert.equal(refusal({ saleTokens: '100', target: '0.000000000000000003', depth: '0.000000000000000001' }), 'target:raiseOff');
  });
  test(`${v.dir}: bound 4, a supply of 100 to 10^15 tokens ("supply out of range")`, () => {
    assert.equal(refusal({ saleTokens: '50' }), 'saleTokens:supplyRange');
    assert.equal(refusal({ saleTokens: '9999999999999999' }), 'saleTokens:supplyRange');
    assert.equal(refusal({ saleTokens: '60' }), 'accepted');
  });
  test(`${v.dir}: bound 5, the raise fits a V2 reserve (test-dollar factory only)`, () => {
    const big = { target: '9999999999999999', depth: '9999999999999999' };
    assert.equal(refusal(big), v.buyRest ? 'accepted' : 'target:raiseTooBig');
  });

  test(`${v.dir}: keccak-256 matches known digests`, () => {
    const hex = (s) => c.toHex(c.keccak(Buffer.from(s, 'utf8')));
    assert.equal(hex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    assert.equal(hex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    // 64 and 135 bytes (the longest single block, padding byte 0x81); digests from viem 2's keccak256
    assert.equal(hex('a'.repeat(64)), '0x1036d73cc8350b0635393d79759b10488165e792073f84d4462e22edec243b92');
    assert.equal(hex('a'.repeat(135)), '0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446');
  });

  test(`${v.dir}: the token address of our real rules sale`, () => {
    assert.equal(c.predictToken(sale.salt), sale.token.toLowerCase());
    assert.ok(c.fitsToken(sale.salt));
    assert.ok(!c.fitsToken('0x1234'), 'not a salt');
  });

  test(`${v.dir}: the manifest names the deployed factory and the launcher ABI`, () => {
    assert.equal(manifest.chainId, deployment.chainId);
    assert.equal(manifest.factoryAddress, deployment.launcherFactory.toLowerCase());
    assert.ok(source.includes('const factoryAddress = "' + manifest.factoryAddress + '"'));
    assert.ok(source.includes('const portalAddress = "' + deployment.portal.toLowerCase() + '"'));
    assert.equal(c.buyRestHere, v.buyRest);
    assert.equal(Object.hasOwn(manifest.transactions.actions, 'complete'), v.buyRest);
    const fn = (name) => abi.find((x) => x.type === 'function' && x.name === name);
    for (const [key, read] of Object.entries(manifest.reads)) {
      const f = fn(read.functionName);
      assert.ok(f, key + ': ' + read.functionName + ' exists');
      assert.deepEqual(f.inputs.map((i) => i.type), read.account ? ['address'] : [], key + ' inputs');
      assert.deepEqual(f.outputs.map((o) => o.type), [read.returns], key + ' returns');
      assert.equal(f.stateMutability, 'view');
    }
    for (const [name, mutability] of Object.entries(manifest.transactions.actions)) {
      const f = fn(name);
      assert.ok(f, name + ' exists');
      assert.equal(f.inputs.length, 0, name + ' takes no argument');
      assert.equal(f.stateMutability, mutability, name + ' mutability');
    }
  });

  test(`${v.dir}: every message the component uses is in en, zh and ko; no visitor text says Starts`, () => {
    const used = new Set([...source.matchAll(/\bm\.([a-zA-Z]+)|reason: "([a-zA-Z]+)"/g)].map((x) => x[1] ?? x[2]));
    const keys = Object.keys(messages.en);
    assert.deepEqual([...used].filter((k) => !keys.includes(k)), []);
    assert.deepEqual(keys.filter((k) => !used.has(k)), []);
    for (const locale of ['zh', 'ko']) assert.deepEqual(Object.keys(messages[locale]).sort(), [...keys].sort());
    for (const text of Object.values(messages.en)) assert.ok(!/\bStarts?\b/.test(text), text);
  });
}

test('a mined salt gives a token address ending in 7777', async () => {
  const c = load(sources['rules-bnb']);
  const salt = await c.mineSalt(new Uint8Array(32).fill(7));
  assert.match(salt, /^0x[0-9a-f]{64}$/);
  assert.ok(c.predictToken(salt).endsWith('7777'));
});

test('the two components differ only inside the factory block', () => {
  const outside = (s) => {
    const start = s.indexOf('// ── This factory ');
    const end = s.indexOf('// ── End of the factory\'s lines');
    assert.ok(start > 0 && end > start);
    return s.slice(0, start) + s.slice(end);
  };
  assert.equal(outside(sources['rules-usdt']), outside(sources['rules-bnb']));
});
