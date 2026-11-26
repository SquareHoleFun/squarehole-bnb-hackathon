import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkKit, wordProblems } from './check.mjs';

const root = new URL('./', import.meta.url);
const read = file => readFileSync(new URL(file, root));

test('the complete kit passes offline, with ten SVG/PNG pairs and seven scenes', () => {
  assert.deepEqual(checkKit(), []);
});

test('word rules catch prohibited names, claims and recipe wording', () => {
  for (const words of ['FIT', 'Misfits', 'misfit magic', '$1', 'token only', 'token-only', 'guaranteed returns', 'risk-free', 'Tether', 'Paxos']) {
    assert.ok(wordProblems(words).length > 0, words);
  }
  assert.deepEqual(wordProblems('LEAD is priced in PEPE; Sepolia uses Test PEPE and Test Gold test stand-ins. Coin pile.'), []);
});

test('checks reject missing art, wrong dimensions, stale renders, unsafe SVG and broken doc links', () => {
  const run = replace => checkKit({ read: file => replace(file, read) });
  assert.ok(run((f, r) => { if (f === 'art/scenes/scene-07.png') throw new Error('missing'); return r(f); }).some(e => /scene-07.png.*missing/.test(e)));
  assert.ok(run((f, r) => {
    const bytes = r(f);
    if (f === 'art/logo.png') bytes.writeUInt32BE(100, 16);
    return bytes;
  }).some(e => /logo.png.*1024/.test(e)));
  assert.ok(run((f, r) => f === 'art/cover.png' ? r('art/logo.png') : r(f)).some(e => /cover.png.*render/.test(e)));
  assert.ok(run((f, r) => f === 'art/logo.svg' ? Buffer.from(r(f).toString().replace('</svg>', '<image href="https://invalid.example/a.png"/></svg>')) : r(f)).some(e => /logo.svg.*self-contained/.test(e)));
  assert.ok(run((f, r) => f === 'README.md' ? Buffer.from(`${r(f)}\n![missing](art/absent.png)`) : r(f)).some(e => /art\/absent.png/.test(e)));
  assert.ok(run((f, r) => f === 'README.md' ? Buffer.from(`${r(f)}\nGuaranteed returns`) : r(f)).some(e => /word rule/.test(e)));
});

test('CLI checks execute through a symlink; importing either script does not run it', () => {
  const repo = new URL('../../../', root);
  const scratch = new URL('.cache/tmp/', repo);
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(fileURLToPath(scratch), 'alchemist-entry-'));
  // Retained in ignored scratch space: the lane never deletes files.
  const linked = join(dir, 'kit');
  symlinkSync(fileURLToPath(root), linked, 'dir');
  const invoke = args => spawnSync(process.execPath, args, { cwd: fileURLToPath(repo), encoding: 'utf8' });
  const check = invoke([join(linked, 'check.mjs')]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /10 SVG\/PNG pairs; 7 scenes/);
  const build = invoke([join(linked, 'build-art.mjs'), '--unknown']);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /unknown option/);
  const imported = invoke(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('check.mjs', root).href)}); await import(${JSON.stringify(new URL('build-art.mjs', root).href)});`]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
