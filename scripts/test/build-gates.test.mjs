import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('ship typechecks the same web project before bundling; standalone web build still checks types', () => {
  const root = JSON.parse(readFileSync('package.json')).scripts;
  const web = JSON.parse(readFileSync('apps/web/package.json')).scripts;
  assert.equal(web.build.split(' && ')[0], web.typecheck);
  assert.equal(web.typecheck, 'tsc --noEmit -p .');
  assert.match(root.typecheck, /pnpm -r .*typecheck/);
  assert.ok(root.verify.indexOf('pnpm typecheck') < root.verify.indexOf('pnpm build'));
  assert.equal(root.build, 'pnpm --filter @squarehole/web exec vite build');
  assert.match(root.lint, /--cache --cache-location \.cache\//);
});
