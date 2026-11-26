import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ABOUT, checkKit, wordProblems } from './check.mjs';
import { loadResvg } from './src/render.mjs';
import { C, SAMPLES } from './src/palette.mjs';

const root = new URL('./', import.meta.url);
const repo = new URL('../../../', import.meta.url);
const read = file => readFileSync(new URL(file, root));
const Resvg = await loadResvg();

test('the complete Lake House kit passes offline', () => {
  assert.deepEqual(checkKit({ Resvg }), []);
});

test('the public wording rules refuse the words that wait for counsel, outside the one line that names them', () => {
  for (const words of ['Holders earn tUSDC', 'a 12% yield', 'APY', 'rent income', 'monthly returns', 'Lake House LLC', 'passive', 'invest now', 'a dash — here']) {
    assert.ok(wordProblems(words).length > 0, words);
  }
  assert.deepEqual(wordProblems(`${ABOUT}\nPayments go into the pile; hand in HOUSE for a share.`), []);
  const readme = read('README.md').toString();
  assert.deepEqual(wordProblems(readme), [], 'the README names the refused words only on its rule line');
});

test('the check catches a stale logo, a wrong size, an unsafe SVG, a changed About line and a lost scene', () => {
  const run = replace => checkKit({ Resvg, read: file => replace(file, read) });
  assert.ok(run((f, r) => (f === 'art/logo.png' ? r('art/logo-48.png') : r(f))).some(e => /logo.png: (stale|expected 1024)/.test(e)));
  assert.ok(run((f, r) => (f === 'art/logo.svg' ? Buffer.from(r(f).toString().replace('</svg>', '<image href="https://invalid.example/a.png"/></svg>')) : r(f)))
    .some(e => /logo.svg: must be self-contained/.test(e)));
  assert.ok(run((f, r) => (f === 'README.md' ? Buffer.from(r(f).toString().replace(ABOUT, 'Test coins.')) : r(f))).some(e => /About line/.test(e)));
  assert.ok(run((f, r) => (f === 'storybook.md' ? Buffer.from(r(f).toString().replace('## 07 · Hand in HOUSE', '## 07 · The end')) : r(f))).some(e => /scene 7/.test(e)));
  assert.ok(run((f, r) => (f === 'README.md' ? Buffer.from(`${r(f)}\n![missing](art/absent.png)\n`) : r(f))).some(e => /art\/absent.png/.test(e)));
  assert.ok(run((f, r) => (f === 'storybook.md' ? Buffer.from(`${r(f)}\nHolders earn.\n`) : r(f))).some(e => /word rule/.test(e)));
});

test('ADR-0004: every colour is a patch of an approved reference crop; a changed reference or a patch on an excluded crop is refused', async () => {
  const { samplePalette } = await import('./src/sample.mjs');
  const repoRead = path => readFileSync(new URL(path, repo));
  const { colours, provenance } = samplePalette(Resvg, repoRead);
  assert.deepEqual(colours, { ...C });
  assert.equal(provenance.length, SAMPLES.length);
  const manifest = JSON.parse(repoRead('packages/design/art/manifest.json').toString());
  for (const p of provenance) assert.ok(manifest.assets.some(a => a.id === p.crop), p.name);
  // One changed byte in a reference picture: its pinned SHA-256 no longer holds.
  assert.throws(() => samplePalette(Resvg, path => {
    const bytes = repoRead(path);
    if (!path.endsWith('feed.png')) return bytes;
    const copy = Buffer.from(bytes); copy[copy.length - 20] ^= 1; return copy;
  }), /SHA-256 differs/);
  // A look-alike excluded over one sampled patch (woodMid, 1250,285): refused before any colour is read.
  assert.throws(() => samplePalette(Resvg, path => {
    const bytes = repoRead(path);
    if (!path.endsWith('manifest.json')) return bytes;
    const m = JSON.parse(bytes.toString());
    m.excluded.push({ what: 'test look-alike', source: 'feed.png', box: [1245, 280, 1256, 291], reason: 'test' });
    return Buffer.from(JSON.stringify(m));
  }), /excluded crop/);
  // A patch outside its named crop: refused too.
  assert.throws(() => samplePalette(Resvg, path => {
    const bytes = repoRead(path);
    if (!path.endsWith('manifest.json')) return bytes;
    const m = JSON.parse(bytes.toString());
    m.assets.find(a => a.id === 'shape-gem').box = [1554, 350, 1570, 360];
    return Buffer.from(JSON.stringify(m));
  }), /leaves the shape-gem crop/);
});

test('the CLI runs the check; importing it prints nothing', () => {
  const invoke = args => spawnSync(process.execPath, args, { cwd: fileURLToPath(repo), encoding: 'utf8' });
  const check = invoke([fileURLToPath(new URL('check.mjs', root))]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /lake-house kit: ok/);
  const build = invoke([fileURLToPath(new URL('build-art.mjs', root)), '--unknown']);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /unknown option/);
  const imported = invoke(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('check.mjs', root).href)});`]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
