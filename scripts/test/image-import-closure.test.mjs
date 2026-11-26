import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditImages, composeServices, dockerImage, importsOf, reportAudit, smokeCommands } from '../gates/image-import-closure.mjs';

const real = auditImages();
test('cards includes the WebP child and the offline pixel check as entries', () => {
  const cards = real.results.find(r => r.services.includes('cards'));
  for (const file of ['src/webp-child.ts', 'scripts/check-webp.ts']) {
    assert.ok(cards.entries.some(e => e.endsWith(file)), file);
    assert.ok(cards.reached.has(`packages/cards/${file}`), file);
  }
  const root = process.cwd();
  const original = readFileSync('infra/server/cards.Dockerfile', 'utf8');
  const withoutChild = original.replace('COPY packages/cards/src packages/cards/src',
    'COPY packages/cards/src/service packages/cards/src/service');
  const broken = auditImages({ root, texts: new Map([['infra/server/cards.Dockerfile', withoutChild]]) });
  assert.ok(broken.results.find(r => r.services.includes('cards')).missing.some(m => m.path.endsWith('/src/webp-child.ts')));
});
for (const image of real.results) test(`every reachable repository module is copied: ${image.dockerfile}`, () => {
  assert.deepEqual(image.missing, [], reportAudit({ results: [image], escapes: [] }));
});
test('the gate belongs to test:scripts without a second opt-in command', () => {
  assert.match(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:scripts'], /scripts\/test\/\*\.test\.mjs/);
});
test('the chain runtime has no relative imports into another package', () => {
  assert.deepEqual(real.escapes.filter(e => e.file.startsWith('packages/chain/src/') && e.kind !== 'type'
    && !/(?:\.test\.|\.d\.ts$|test-support|fixture)/.test(e.file)), []);
});
test('all same-image services and the actual smoke commands are enumerated', () => {
  const keeper = real.results.find(r => r.services.includes('keeper'));
  assert.deepEqual(keeper.services, ['keeper', 'keeper-set', 'alpha-sender', 'agents']);
  for (const check of smokeCommands()) assert.ok(real.results.some(r => r.entries.includes(`${check.service} smoke: ${check.args.join(' ')}`)), check.service);
  assert.ok(keeper.reached.has('infra/server/services/keeper.mjs'), 'computed enabled driver is walked');
  assert.ok(real.results.find(r => r.services.includes('reveal')).reached.has('packages/artwork/src/box-commitment.ts'), 'literal artwork loader calls are walked');
});

function fixture({ main = "export { value } from './middle';", middle = "export { value } from './missing';", extra = {}, beforeInstall = '', install = '--filter fixture...', copy = '', compose = '', smoke = [] } = {}) {
  const texts = new Map(Object.entries({
    'infra/server/compose.yaml': `services:\n  one:\n    image: local:test\n    build:\n      context: ../..\n      dockerfile: Service.Dockerfile\n${compose}`,
    'Service.Dockerfile': `FROM node:fixture\nWORKDIR /app\nCOPY package.json pnpm-lock.yaml ./\n${beforeInstall}\nRUN pnpm install --frozen-lockfile --prod ${install}\nCOPY src/main.ts src/middle.ts src/\nCOPY register.mjs ./\n${copy}\nCMD ["node", "--import", "./register.mjs", "src/main.ts"]\n`,
    'package.json': '{"name":"fixture"}',
    'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\nimporters:\n  .: {}\n',
    'register.mjs': readFileSync('packages/chain/scripts/register-ts.mjs', 'utf8'), 'src/main.ts': main, 'src/middle.ts': middle,
    'src/missing.ts': 'export const value = 1;', ...extra,
  }));
  return auditImages({ files: [...texts.keys()], texts, smoke });
}
test('finds a transitive export gap with entry, importer, image destination and startup timing', () => {
  const [gap] = fixture().results[0].missing;
  assert.match(gap.entry, /src\/main.ts/);
  assert.equal(gap.importer, 'src/middle.ts');
  assert.equal(gap.path, '/app/src/missing.ts');
  assert.equal(gap.when, 'startup');
  assert.deepEqual(fixture({ copy: 'COPY src/missing.ts src/' }).results[0].missing, []);
});
test('follows literal dynamic imports, cycles and side-effect imports, ignoring erased types', () => {
  const a = fixture({ main: "import type { T } from './types'; import { type U } from './types'; import './middle';",
    middle: "import './main'; export const load = () => import('./missing');" });
  assert.ok(a.results[0].missing.every(m => m.path === '/app/src/missing.ts' && m.when.startsWith('deferred')));
  assert.ok(a.results[0].missing.length);
});
test('uses copied package exports and declared production workspace links, never checkout node_modules', () => {
  const extra = workspaceFixture();
  const a = fixture({ main: "import '@squarehole/part/feature';", extra,
    beforeInstall: 'COPY packages/part/package.json packages/part/',
    copy: 'COPY packages/part/src/feature.ts packages/part/src/' });
  assert.ok(a.results[0].missing.every(m => m.path === '/app/packages/part/src/hidden.ts'));
  assert.ok(a.results[0].missing.length);
});

function workspaceFixture() {
  return {
    'package.json': '{"name":"fixture","dependencies":{"@squarehole/part":"workspace:*"}}',
    'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\nimporters:\n  .:\n    dependencies:\n      \'@squarehole/part\':\n        specifier: workspace:*\n        version: link:packages/part\n  packages/part: {}\n',
    'packages/part/package.json': '{"name":"@squarehole/part","exports":{"./feature":"./src/feature.ts"}}',
    'packages/part/src/feature.ts': "export { value } from './hidden';",
    'packages/part/src/hidden.ts': 'export const value = 1;',
  };
}
test('M1 rejects a copied manifest dependency missing from its frozen lock importer', () => {
  for (const kind of ['dependencies', 'devDependencies']) {
    assert.throws(() => fixture({ main: '', extra: {
      'package.json': JSON.stringify({ name: 'fixture', [kind]: { zod: '4.6.5' } }),
    } }), /lockfile.*specifier.*zod/);
  }
  const lock = readFileSync('pnpm-lock.yaml', 'utf8').replace(/( {2}packages\/domain:\n {4}dependencies:\n) {6}'@noble\/hashes':\n {8}specifier: 2\.4\.0\n {8}version: 2\.4\.0\n/, '$1');
  assert.throws(() => auditImages({ texts: new Map([['pnpm-lock.yaml', lock]]) }), /lockfile.*specifier.*@noble\/hashes/);
});
test('M1 rejects a workspace manifest copied only after install', () => {
  assert.throws(() => fixture({ main: "import '@squarehole/part/feature';", extra: workspaceFixture(),
    copy: 'COPY packages/part packages/part' }), /before.*install/);
});
test('M1 rejects an undeclared workspace import even when its manifest was installed', () => {
  const extra = workspaceFixture();
  extra['package.json'] = '{"name":"fixture"}';
  extra['pnpm-lock.yaml'] = 'importers:\n  .: {}\n  packages/part: {}\n';
  assert.throws(() => fixture({ main: "import '@squarehole/part/feature';", extra,
    install: '--filter fixture... --filter @squarehole/part...',
    beforeInstall: 'COPY packages/part/package.json packages/part/', copy: 'COPY packages/part/src packages/part/src' }), /undeclared production workspace import/);
});
test('M1 rejects imports from a package excluded by install filters', () => {
  assert.throws(() => fixture({ main: "import '@squarehole/part/feature';", extra: workspaceFixture(),
    install: '--filter @squarehole/part...', beforeInstall: 'COPY packages/part/package.json packages/part/',
    copy: 'COPY packages/part/src packages/part/src' }), /not selected.*install/);
});
test('M1 compares specifiers exactly, including extra lock entries and unselected copied manifests', () => {
  for (const specifier of ['4.6.4', '4.6.5']) {
    assert.throws(() => fixture({ main: '', beforeInstall: 'COPY packages/part/package.json packages/part/', extra: {
      'packages/part/package.json': JSON.stringify({ name: '@squarehole/part', dependencies: specifier === '4.6.4' ? { zod: '4.6.5' } : {} }),
      'pnpm-lock.yaml': `importers:\n  .: {}\n  packages/part:\n    dependencies:\n      zod:\n        specifier: ${specifier}\n        version: ${specifier}\n`,
    } }), /lockfile.*specifier.*zod/);
  }
});
test('M2 rejects the review file-then-directory COPY conflict', () => {
  const path = 'infra/server/indexer.Dockerfile';
  const text = readFileSync(path, 'utf8').replace('COPY packages/domain/src packages/domain/src',
    'COPY package.json packages/domain/src\nCOPY packages/domain/src packages/domain/src');
  assert.throws(() => auditImages({ texts: new Map([[path, text]]) }), /file\/directory conflict.*\/app\/packages\/domain\/src/);
});
test('M2 rejects COPY and WORKDIR ancestor conflicts in either order', () => {
  for (const steps of [
    'COPY a.ts /app/code\nWORKDIR /app/code/nested',
    'WORKDIR /app/code/a.ts/nested\nCOPY a.ts /app/code',
    'COPY a.ts /app/code\nCOPY b.ts /app/code/b.ts',
    'COPY b.ts /app/code/a.ts/b.ts\nCOPY a.ts /app/code',
  ]) {
    // A file copied to an existing directory uses its basename. Only that basename can collide.
    assert.throws(() => dockerImage(`FROM node\n${steps}\n`, '.', ['a.ts', 'b.ts']), /file\/directory conflict/);
  }
});
test('M2 copying a file into an existing WORKDIR uses its basename', () => {
  const image = dockerImage('FROM node\nWORKDIR /app/code\nCOPY a.ts /app/code\n', '.', ['a.ts']);
  assert.equal(image.copies.get('/app/code/a.ts'), 'a.ts');
});
test('parent 731c9f144 frozen indexer chain barrels expose four files and five missing edges', () => {
  const root = resolve('scripts/test/fixtures/image-import-parent');
  const fixtureFiles = readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.txt'))
    .map(e => resolve(e.parentPath, e.name).slice(root.length + 1));
  const texts = new Map(fixtureFiles.map(file => [file.slice(0, -4), readFileSync(resolve(root, file), 'utf8')]));
  const { results: [indexer] } = auditImages({ root, files: [...texts.keys()], texts, smoke: [] });
  assert.deepEqual([...new Set(indexer.missing.map(m => m.path))].sort(), [
    '/app/packages/artwork/src/box-commitment.ts', '/app/packages/artwork/src/hash.ts',
    '/app/packages/artwork/src/manifest.ts', '/app/packages/artwork/src/misfits-commitment.ts',
  ]);
  assert.deepEqual([...new Set(indexer.missing.map(m => `${m.importer}:${m.line} -> ${m.path}`))].sort(), [
    'packages/artwork/src/box-commitment.ts:17 -> /app/packages/artwork/src/misfits-commitment.ts',
    'packages/artwork/src/manifest.ts:14 -> /app/packages/artwork/src/hash.ts',
    'packages/chain/src/core/v2/open-reveal-batches-v2.ts:13 -> /app/packages/artwork/src/box-commitment.ts',
    'packages/chain/src/core/v2/open-reveal-spec-v2.ts:5 -> /app/packages/artwork/src/box-commitment.ts',
    'packages/chain/src/core/v2/open-reveal-spec-v2.ts:6 -> /app/packages/artwork/src/manifest.ts',
  ]);
  for (const path of ['packages/indexer/src/core/core-main.ts', 'packages/chain/src/index.ts',
    'packages/chain/src/core/v2/index.ts', 'packages/chain/src/core/v2/open-reveal-batches-v2.ts']) assert.ok(indexer.reached.has(path), path);
  assert.ok(indexer.missing.every(m => m.when === 'startup' && m.entry.includes('src/core/core-main.ts')));
});
test('gate header states the install, build, computed import and runtime file limits in five lines', () => {
  const header = readFileSync('scripts/gates/image-import-closure.mjs', 'utf8').split('\n').slice(0, 5).join('\n');
  assert.match(header, /does not run an install or a build/);
  assert.match(header, /computed imports/);
  assert.match(header, /files read at run time/);
  assert.match(header, /not a substitute for building and starting the images/);
});
test('checks Compose command and entrypoint overrides even for services without build', () => {
  const a = fixture({ main: '', middle: '', compose: '  two:\n    image: local:test\n    entrypoint: ["node"]\n    command: ["src/missing.ts"]\n  three:\n    image: local:test\n    command: ["node", "src/missing.ts"]\n' });
  assert.deepEqual(new Set(a.results[0].missing.map(m => m.entry.split(' ')[0])), new Set(['two', 'three']));
});
test('checks image health, Compose health and inline Node imports', () => {
  const a = fixture({ main: '', middle: '', copy: 'HEALTHCHECK CMD ["node", "src/missing.ts"]',
    compose: '    healthcheck:\n      test: ["CMD", "node", "-e", "import(\'./src/missing.ts\')"]\n' });
  assert.ok(a.results[0].missing.some(m => m.entry.startsWith('image health')));
  assert.ok(a.results[0].missing.some(m => m.entry.startsWith('one health')));
});
test('checks files reachable only from the smoke command at the image workdir', () => {
  const a = fixture({ main: '', middle: '', smoke: [{ service: 'one', args: ['node', 'src/missing.ts'] }] });
  assert.equal(a.results[0].missing.length, 1);
  assert.match(a.results[0].missing[0].entry, /^one smoke:/);
  assert.equal(a.results[0].missing[0].path, '/app/src/missing.ts');
});
test('COPY uses destinations, directory contents, JSON syntax, multiple sources and the final stage', () => {
  const image = dockerImage('FROM node AS build\nWORKDIR /wrong\nCOPY a.ts ./\nFROM node\nWORKDIR /app\nCOPY ["lib", "renamed"]\nCOPY a.ts b.ts code/\n', '.', ['a.ts', 'b.ts', 'lib/nested/c.ts']);
  assert.deepEqual([...image.copies], [['/app/renamed/nested/c.ts', 'lib/nested/c.ts'], ['/app/code/a.ts', 'a.ts'], ['/app/code/b.ts', 'b.ts']]);
  assert.ok(!image.copies.has('/wrong/a.ts'));
});
test('unsupported syntax fails instead of dropping build/command coverage', () => {
  assert.throws(() => composeServices('services:\n  one:\n    build: .\n'), /unsupported build/);
  assert.throws(() => composeServices('services:\n  one: {build: .}\n'), /unsupported inline/);
  assert.throws(() => composeServices('services:\n  one:\n    build:\n      context: .\n'), /build needs/);
  assert.throws(() => composeServices('services:\n  one:\n    command: |\n      node x.mjs\n'), /unsupported command/);
  assert.throws(() => dockerImage('FROM node\nCOPY src/*.ts /app/\n', '.', []), /unsupported COPY/);
  assert.throws(() => fixture({ extra: { 'register.mjs': '' } }), /unrecognised preload/);
});
test('does not apply TypeScript bundler substitutions to an explicit .js import', () => {
  const a = fixture({ main: "import './middle.js';", copy: 'COPY src/missing.ts src/' });
  assert.ok(a.results[0].missing.length);
  assert.ok(a.results[0].missing.every(m => m.path === '/app/src/middle.js'));
});
test('reports a literal deferred dependency even when the importing function is never called at startup', () => {
  const a = fixture({ main: "export const request = () => import('./missing.ts');" });
  assert.ok(a.results[0].missing.length);
  assert.ok(a.results[0].missing.every(m => m.when.startsWith('deferred')));
});
test('lists computed imports and filesystem reads with locations', () => {
  const scan = importsOf('example.mjs', "import { readFile as load } from 'node:fs/promises';\nimport(name);\nfs.readFile(path);\nload(path);\n");
  assert.deepEqual(scan.blind.map(b => [b.line, b.kind]), [[2, 'computed import'], [3, 'runtime file access'], [4, 'runtime file access']]);
});
test('the package escape inventory includes imports, reexports, dynamic imports and type-only imports', () => {
  const a = fixture({ main: '', middle: '', extra: { 'packages/part/src/test.ts': "import type { X } from '../../else/src/a'; export * from '../../else/src/b'; import('../../else/src/c');" } });
  assert.deepEqual(a.escapes.map(e => [e.kind, e.images]), [['type', []], ['static', []], ['dynamic', []]]);
});


test('SH-217 operator entry points and image rehearsal are traversed in their deployed images', () => {
  const keeper = real.results.find(r => r.services.includes('keeper'));
  for (const file of ['forget-tester.mjs', 'forget-image-check.mjs', 'release-float.mjs']) {
    assert.ok(keeper.entries.some(e => e.includes(`infra/server/services/alpha/${file}`)));
    assert.ok(keeper.reached.has(`infra/server/services/alpha/${file}`));
  }
  const api = real.results.find(r => r.services.includes('alpha-api'));
  for (const file of ['purge.mjs', 'backup.mjs']) assert.ok(api.reached.has(`infra/server/services/alpha/${file}`));
  const path = 'infra/server/services/alpha/forget-tester.mjs';
  const changed = readFileSync(path, 'utf8') + "\nimport './missing-forget-helper.mjs';\n";
  const bad = auditImages({ texts: new Map([[path, changed]]) });
  assert.ok(bad.results.find(r => r.services.includes('keeper')).missing.some(m => m.path.endsWith('/missing-forget-helper.mjs')));
});
