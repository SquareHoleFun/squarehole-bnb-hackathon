import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkKit, root, wordProblems } from './check.mjs';

const read = file => readFileSync(join(root, file));
const run = replace => checkKit({ read: file => replace(file, read) });
const repo = fileURLToPath(new URL('../../../', import.meta.url));
function scratch(t, prefix) {
  mkdirSync(join(repo, '.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(join(repo, '.cache/tmp', prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the complete kit passes offline: logo, recipe, settings download, words and approved lines', () => {
  assert.deepEqual(checkKit(), []);
});

test('word rules catch claims, quotes, dates, addresses and em dashes, and pass the kit wording', () => {
  for (const words of ['earn', 'yields', 'returns', 'gains', 'profit', 'invest', 'to the moon', 'prices', 'FIT', 'Misfits', 'guaranteed',
    'risk-free', 'token only', 'Just the token', '2026-10-24', 'Oct 24', `0x${'ab'.repeat(20)}`, '$5', '10 USD', 'one \u2014 two']) {
    assert.ok(wordProblems(words).length > 0, words);
  }
  assert.deepEqual(wordProblems('A shop for one outside NFT collection. A pick costs 2x the sell-back price. Fees fill the shop up to a ceiling, then go to holders.'), []);
});

test('checks reject a missing or stale logo, unsafe SVG, broken links, banned words and a missing approved line', () => {
  assert.ok(run((f, r) => { if (f === 'art/logo.png') throw new Error('missing'); return r(f); }).some(e => /art\/logo.png: missing/.test(e)));
  assert.ok(run((f, r) => { const bytes = Buffer.from(r(f)); if (f === 'art/logo.png') bytes.writeUInt32BE(100, 16); return bytes; }).some(e => /logo.png: expected 1024 x 1024/.test(e)));
  assert.ok(run((f, r) => (f === 'art/logo.png' ? Buffer.concat([r(f), Buffer.from([0])]) : r(f))).some(e => /logo.png: stale or invalid render/.test(e)));
  assert.ok(run((f, r) => (f === 'art/logo.svg' ? Buffer.from(r(f).toString().replace('</svg>', '<image href="https://invalid.example/a.png"/></svg>')) : r(f))).some(e => /logo.svg: must be self-contained/.test(e)));
  const readme = edit => run((f, r) => (f === 'README.md' ? Buffer.from(edit(r(f).toString())) : r(f)));
  assert.ok(readme(text => `${text}\n![missing](art/absent.png)\n`).some(e => /broken link art\/absent.png/.test(e)));
  assert.ok(readme(text => `${text}\n[outside](../../../../outside.md)\n`).some(e => /broken link \.\.\/\.\.\/\.\.\/\.\.\/outside.md/.test(e)));
  assert.ok(readme(text => `${text}\nGuaranteed returns.\n`).some(e => /README.md: banned word/.test(e)));
  assert.ok(readme(text => text.replace('Fees fill the shop up to a ceiling, then go to holders.', 'Fees go to the shop.')).some(e => /missing the approved line "Fees fill/.test(e)));
});

test('checks pin the recipe and the settings download', () => {
  const row = '../../../packages/box-spec/examples/v2/one-collection-shop.json';
  const rowEdit = edit => run((f, r) => (f === row ? Buffer.from(JSON.stringify(edit(JSON.parse(r(f))))) : r(f)));
  assert.ok(rowEdit(e => { e.template = { id: 'holders', name: 'To holders' }; return e; }).some(e => /recipe must use the Shop template/.test(e)));
  assert.ok(rowEdit(e => { e.contents.shop.curator = 'creator'; return e; }).some(e => /one TA-40 collection with no curator/.test(e)));
  assert.ok(rowEdit(e => { e.contents.shop.collections[0].starterIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']; return e; }).some(e => /ids 3 to 12/.test(e)));
  assert.ok(rowEdit(e => { e.contents.shop.seedT = (BigInt(e.contents.shop.givePricesT[0]) * 3n).toString(); return e; }).some(e => /exactly two sell-backs/.test(e)));
  const settings = 'settings/one-collection-shop-boxspec-v2.json';
  const fileEdit = edit => run((f, r) => (f === settings ? Buffer.from(JSON.stringify(edit(JSON.parse(r(f))))) : r(f)));
  assert.ok(fileEdit(file => ({ ...file, specHash: `0x${'0'.repeat(64)}` })).some(e => /settings: not a Create download or a damaged one/.test(e)));
  assert.ok(fileEdit(file => ({ ...file, pictures: [...file.pictures, file.pictures[0]] })).some(e => /logo alone/.test(e)));
});

test('an unlisted file anywhere in the kit is unexpected', t => {
  const dir = join(scratch(t, 'one-shop-files-'), 'kit');
  cpSync(root, dir, { recursive: true });
  writeFileSync(join(dir, 'art', 'extra.png'), read('art/logo.png'));
  const problems = checkKit({ dir, read: file => readFileSync(join(file.startsWith('../') ? root : dir, file)) });
  assert.ok(problems.includes('unexpected art/extra.png'), problems.join('\n'));
});

test('the CLI runs through a symlink; importing either script prints nothing', t => {
  const linked = join(scratch(t, 'one-shop-entry-'), 'kit');
  symlinkSync(root, linked, 'dir');
  const invoke = args => spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
  const check = invoke([join(linked, 'check.mjs')]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /One-collection shop: checks passed/);
  const build = invoke([join(linked, 'build-art.mjs'), '--unknown']);
  assert.equal(build.status, 1); assert.match(build.stderr, /unknown option/);
  const imported = invoke(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('check.mjs', import.meta.url).href)}); await import(${JSON.stringify(new URL('build-art.mjs', import.meta.url).href)});`]);
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
});
