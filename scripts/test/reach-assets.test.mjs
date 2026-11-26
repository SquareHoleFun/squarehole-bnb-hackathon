import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertFresh, buildReachMap, GUARDS, MAP_PATH, mapText, ROOT } from '../gates/reach.mjs';
import { planMerge } from '../gates/verify-merge.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reach-assets-')), files = [];
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); if (!files.includes(path)) files.push(path); };
  write('package.json', JSON.stringify({ scripts: { verify: '', 'test:scripts': '' } }));
  write('packages/design/package.json', JSON.stringify({ name: '@squarehole/design' }));
  write('packages/design/vitest.config.ts', "export default {test:{include:['src/**/*.test.tsx']}};");
  for (const path of GUARDS) write(path, "import { it } from 'vitest'; it('guard', () => {});");
  const map = () => buildReachMap(root, files);
  const plan = path => planMerge(root, map(), { base: 'fixture', paths: [path] }, files);
  return { root, files, write, map, plan };
}

test('af4: review JSON-only manifest change selects the real components test or full lanes', () => {
  const map = JSON.parse(readFileSync(join(ROOT, MAP_PATH)));
  const plan = planMerge(ROOT, map, { base: 'review', paths: ['packages/design/art/manifest.json'] });
  assert.ok(plan.fullFallback || plan.selected.vitest?.includes('packages/design/src/art/components.test.tsx'));
});

for (const asset of ['art/manifest.json', 'src/theme.css', 'art/icon.svg', 'art/font.woff2']) {
  test(`af4: imported ${asset} reaches its consumer, enters related selection and invalidates the map`, () => {
    const { root, write, map, plan } = fixture(), path = `packages/design/${asset}`;
    write(path, '{}');
    write('packages/design/src/components.tsx', `import '../${asset}?raw'; export const component = 1;`);
    write('packages/design/src/components.test.tsx', "import { it } from 'vitest'; import './components'; it('component', () => {});");
    const selected = plan(path);
    assert.ok(selected.fullFallback || selected.selected.vitest.includes('packages/design/src/components.test.tsx'));
    if (!selected.fullFallback) assert.ok(selected.commands.filter(step => step.args.includes('related')).every(step => step.args.includes(path)));
    write(MAP_PATH, mapText(map()));
    write(path, '{"edited":true}');
    assert.throws(() => assertFresh(root, map()), /stale/);
  });
}

test('af4: assets with no established consumer use full lanes even inside a known package', () => {
  const { write, plan } = fixture();
  for (const path of ['packages/design/art/unimported.json', 'packages/design/src/unimported.css', 'apps/web/public/unknown.bin']) {
    write(path, 'asset');
    const selected = plan(path);
    assert.equal(selected.fullFallback, true, path);
    assert.equal(selected.commands.filter(step => step.args.includes('vitest') && step.args.includes('run')).length, 4);
  }
});

test('af4: unresolved relative imports propagate uncertainty through helpers', () => {
  const { write, map } = fixture();
  write('packages/design/src/helper.ts', "import data from './missing.json'; export { data };");
  write('packages/design/src/components.test.tsx', "import { it } from 'vitest'; import './helper'; it('component', () => {});");
  assert.ok(map().tests['packages/design/src/components.test.tsx'].reaches.includes('*'));
});
