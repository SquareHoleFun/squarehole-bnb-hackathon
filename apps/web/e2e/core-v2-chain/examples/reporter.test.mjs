import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { stringify } from './support.mjs';

// The real reporter, writing under a temporary root instead of the repository's .cache.
async function reporterAt(root) {
  const url = new URL('./reporter.mjs', import.meta.url);
  const module = new SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  const bindings = { 'node:fs': await import('node:fs'), './support.mjs': { ROOT: pathToFileURL(`${root}/`), stringify } };
  await module.link(name => {
    assert.ok(bindings[name], `unexpected import: ${name}`);
    return new SyntheticModule(Object.keys(bindings[name]), function () {
      for (const [key, value] of Object.entries(bindings[name])) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return new module.namespace.default();
}
const ended = (title, status, attachment, annotations = []) => [{ title, annotations },
  { status, duration: 7, errors: [], attachments: attachment ? [{ name: 'example-evidence', body: Buffer.from(JSON.stringify(attachment)) }] : [] }];

test('every ended life rewrites its evidence each run, a skipped one included, stamped with the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sh-examples-reporter-'));
  const evidence = join(root, '.cache/examples-e2e/evidence');
  mkdirSync(evidence, { recursive: true });
  // A failed life's file left by an earlier run, before its example was gated.
  writeFileSync(join(evidence, 'dragons-hoard.json'), JSON.stringify({ example: 'dragons-hoard', transactions: ['0xold'] }));
  const reporter = await reporterAt(root);
  reporter.onBegin();
  reporter.onTestEnd(...ended('dragons-hoard · Coin pile', 'skipped', null, [{ type: 'skip', description: 'FE12: site choice' }]));
  reporter.onTestEnd(...ended('one-dollar · Coin pile', 'passed', { example: 'one-dollar', completed: ['page-state'], pictures: { logo: '0x01' } }));
  reporter.onTestEnd(...ended('../escape · Coin pile', 'passed', { example: 'x' }));
  reporter.onTestEnd(...ended('link-marines-v2 · Collection', 'passed', { example: 'link-marines-v2', completed: ['item-claim'] }));
  reporter.onTestEnd(...ended('link-marines-v2/../x · Collection', 'passed', { example: 'y' }));
  reporter.onEnd({ status: 'passed' });

  const read = name => JSON.parse(readFileSync(join(evidence, name), 'utf8'));
  const skipped = read('dragons-hoard.json');
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.run, reporter.run);
  assert.deepEqual(skipped.annotations, [{ type: 'skip', description: 'FE12: site choice' }]);
  assert.equal(skipped.transactions, undefined, 'nothing of the earlier run survives');
  const passed = read('one-dollar.json');
  assert.deepEqual({ status: passed.status, run: passed.run, completed: passed.completed, logo: passed.pictures.logo },
    { status: 'passed', run: reporter.run, completed: ['page-state'], logo: '0x01' });
  assert.equal(read('link-marines-v2.json').status, 'passed', 'a versioned registry id writes its evidence');
  assert.deepEqual(readdirSync(evidence).sort(), ['dragons-hoard.json', 'link-marines-v2.json', 'one-dollar.json'], 'a title that is not a registry id writes nothing');
  assert.equal(existsSync(join(root, '.cache/escape.json')), false);
  const results = JSON.parse(readFileSync(join(root, '.cache/examples-e2e/results.json'), 'utf8'));
  assert.equal(results.run, reporter.run);
  assert.deepEqual(results.examples.map(row => [row.example, row.status]), [['dragons-hoard', 'skipped'], ['one-dollar', 'passed'], ['../escape', 'passed'],
    ['link-marines-v2', 'passed'], ['link-marines-v2/../x', 'passed']]);
  assert.match(readFileSync(join(root, '.cache/examples-e2e/results.md'), 'utf8'), /\| one-dollar \| Coin pile \| page-state \| passed \| 7 ms \|/);
});
