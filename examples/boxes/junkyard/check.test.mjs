import assert from 'node:assert/strict';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { approved, checkKit, missingApproved, neighbours, pngSize, root, scanText } from './check.mjs';

/** A copy of this kit inside a stand-in repository (with the shared settings guide), removed when the test ends. */
function scratchKit(t) {
  const top = fileURLToPath(new URL('../../../', import.meta.url));
  mkdirSync(join(top, '.cache/tmp'), { recursive: true });
  const scratch = mkdtempSync(join(top, '.cache/tmp/junkyard-check-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  const kit = join(repo, 'examples/boxes/junkyard');
  const generated = (src) => /^build(\/|$)/.test(relative(root, src));
  cpSync(root, kit, { recursive: true, filter: (src) => !generated(src), mode: constants.COPYFILE_FICLONE });
  mkdirSync(join(repo, 'scripts/kits'), { recursive: true });
  writeFileSync(join(repo, 'scripts/kits/README.md'), '# Public example settings and pictures\n');
  const registry = 'packages/box-spec/examples/v2';
  mkdirSync(join(repo, registry), { recursive: true });
  cpSync(join(top, registry, 'junkyard.json'), join(repo, registry, 'junkyard.json'));
  return { scratch, repo, kit };
}

test('complete kit satisfies its delivery contract', () => {
  assert.deepEqual(checkKit(), []);
});

test('the recipe check rejects the former holders template and a mismatched Shop label', t => {
  const { repo, kit } = scratchKit(t);
  const path = join(repo, 'packages/box-spec/examples/v2/junkyard.json');
  const row = JSON.parse(readFileSync(path, 'utf8'));
  for (const template of [{ id: 'holders', name: 'To holders' }, { id: 'shop', name: 'To holders' }]) {
    writeFileSync(path, JSON.stringify({ ...row, template }));
    assert.deepEqual(checkKit(kit, repo), ['registry: expected the Shop template']);
  }
});

test('copy guard rejects promotion, named platform assets, quotes, dates and addresses', () => {
  for (const bad of ['Earn', 'yield', 'returns', 'gains', 'profit', 'income', 'investment', 'moon', '100x', 'prices', 'FIT', 'Misfits', '2026-10-12', '12/10/2026', 'October 12', '12 October', '$12', '12 USD', '0x' + 'ab'.repeat(20), 'A'.repeat(44), '\u2014']) {
    assert.ok(scanText(bad).length > 0, bad);
  }
  assert.deepEqual(scanText('The Junkyard uses $TRASH and PAXG. Wait 7 days. Picks cost 2x. The ceiling is 2x the seed. The creator buy is 0.3 ETH-equivalent. A benefit is not a promise.'), []);
});

test('details guard keeps the approved shop lines word for word', () => {
  assert.deepEqual(missingApproved(readFileSync(join(root, 'details.md'), 'utf8')), []);
  assert.deepEqual(missingApproved('Fees fill the shop up to a ceiling, then go to holders.'), [approved[1]]);
  assert.deepEqual(missingApproved(`Fees fill the shop up to a\nceiling, then go to holders. The warning: ${approved[1]}.`), []);
  assert.deepEqual(missingApproved('Fees fill the shop up to a cap, then go to holders.'), approved);
});

test('PNG guard rejects a renamed file, a truncated asset and corrupted pixels', () => {
  assert.throws(() => pngSize(Buffer.from('not a picture')), /not PNG/);
  const png = readFileSync(join(root, 'art/logo.png'));
  assert.deepEqual(pngSize(png), [1024, 1024]);
  assert.throws(() => pngSize(png.subarray(0, png.length - 12)), /incomplete PNG/);
  const changed = Buffer.from(png);
  changed[changed.length - 20] ^= 1;
  assert.throws(() => pngSize(changed), /CRC mismatch/);
});

test('beside the kit: only TA-23\'s settings file and TA-40\'s reviewed files; an unlisted or nested file is refused', (t) => {
  const { repo, kit } = scratchKit(t);
  assert.deepEqual(neighbours.filter((name) => !existsSync(join(root, name))), [], 'every listed neighbour is present');
  assert.deepEqual(checkKit(kit, repo), []);
  for (const extra of ['test-collections/unreviewed-executable.mjs', 'test-collections/art/bent-cans/nested/1.png',
    'test-collections/art/bent-cans/3.png', 'test-collections/art/rusty-nails/1.png', 'settings/other-boxspec-v2.json']) {
    const path = join(kit, extra);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not reviewed\n');
    assert.deepEqual(checkKit(kit, repo), [`unexpected ${extra}`]);
    rmSync(path);
  }
  assert.deepEqual(checkKit(kit, repo), []);
});

test('the one link out of the kit is the shared settings guide, a regular file inside the repository', (t) => {
  const { scratch, repo, kit } = scratchKit(t);
  const readme = join(kit, 'README.md');
  const text = readFileSync(readme, 'utf8');
  writeFileSync(join(scratch, 'outside.md'), 'outside the repository\n');
  writeFileSync(join(repo, 'package.json'), '{}\n');
  for (const link of ['../../../../outside.md', '../../../package.json', '../../../scripts/kits/README.md#x/../../../../outside.md']) {
    writeFileSync(readme, `${text}\n[elsewhere](${link})\n`);
    const errors = checkKit(kit, repo);
    if (link.includes('#')) assert.deepEqual(errors, [], 'an anchor on the guide is still the guide');
    else assert.deepEqual(errors, [`README.md: broken link ${link}`]);
  }
  writeFileSync(readme, text);
  // The README links the guide's binding section; a refusal names the link as written.
  const guideLink = text.match(/\]\((\.\.\/\.\.\/\.\.\/scripts\/kits\/README\.md(?:#[^)]*)?)\)/)?.[1];
  assert.ok(guideLink, 'the README links the shared settings guide');
  const guide = join(repo, 'scripts/kits/README.md');
  rmSync(guide);
  mkdirSync(guide);
  assert.deepEqual(checkKit(kit, repo), [`README.md: broken link ${guideLink}`], 'a directory is not the guide');
  rmSync(guide, { recursive: true });
  symlinkSync(join(scratch, 'outside.md'), guide);
  assert.deepEqual(checkKit(kit, repo), [`README.md: broken link ${guideLink}`], 'a link leaving the repository');
  rmSync(guide);
  assert.deepEqual(checkKit(kit, repo), [`README.md: broken link ${guideLink}`], 'a missing guide');
});
