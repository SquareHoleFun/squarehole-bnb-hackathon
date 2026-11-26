import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  archiveGaps, archivePaths, carried, composeRepositoryPaths, contextSources, logicalLines, reportGaps, repository, scriptReleasePaths,
} from '../gates/ship-archive-covers-images.mjs';

const SHIP = readFileSync('infra/server/ship.sh', 'utf8');
const service = (name, context, dockerfile, extra = '') => `  ${name}:\n    image: local:${name}\n    build:\n      context: ${context}\n      dockerfile: ${dockerfile}\n${extra}`;
const COMPOSE = `services:\n${service('one', '../..', 'Service.Dockerfile')}`;
const DOCKER = 'FROM node:fixture AS build\nWORKDIR /app\nCOPY package.json pnpm-lock.yaml ./\nCOPY src src\nCOPY tools/check.ts tools/\n'
  + 'FROM node:fixture\nCOPY --from=build /app/src /app/src\nCOPY --chown=node:node notes /app/notes\n';
const ship = (paths, more = '') => `set -e\npaths=(\n  ${paths.join(' ')}\n)\narchive=(git archive)\n${more}`;
const WHOLE = ['package.json', 'pnpm-lock.yaml', 'src', 'tools/check.ts', 'notes', 'Service.Dockerfile', 'infra/server'];
function fixture(paths, { docker = DOCKER, compose = COMPOSE, install = '', shipMore = '', untracked = [], attributes = {}, files = {} } = {}) {
  const texts = { 'infra/server/ship.sh': ship(paths, shipMore), 'infra/server/compose.yaml': compose, 'infra/server/install.sh': install,
    'Service.Dockerfile': docker, ...attributes, ...files };
  return archiveGaps({
    read: file => { if (!(file in texts)) throw new Error(`fixture has no ${file}`); return texts[file]; },
    repo: { tracked: path => !untracked.includes(path), attributeFiles: () => Object.keys(attributes) },
  });
}
const real = change => archiveGaps({ read: file => change(file, readFileSync(file, 'utf8')) });
const gapPaths = gaps => gaps.map(gap => gap.path);

test('the stack archive carries every path the server needs (the real files)', () => {
  const gaps = archiveGaps();
  assert.deepEqual(gaps, [], reportGaps(gaps));
});

test('the three paths that stopped stack ship 20 are in the archive list', () => {
  const paths = archivePaths(SHIP);
  for (const path of ['vitest.timeouts.mjs', 'packages/cards/scripts/check-webp.ts', 'packages/cards/notices']) {
    assert.ok(carried(paths, path), path);
    const without = SHIP.replace(new RegExp(`(^|\\s)${path.replaceAll('.', '\\.')}(?=\\s)`, 'm'), '$1');
    assert.notEqual(without, SHIP, path);
    const gaps = real((file, text) => file === 'infra/server/ship.sh' ? without : text);
    assert.deepEqual(gaps.map(gap => [gap.who, gap.path]), [['infra/server/cards.Dockerfile', path]]);
  }
});

test('the real list also carries what the installer, Compose and the outside check read', () => {
  const drop = path => real((file, text) => {
    if (file !== 'infra/server/ship.sh') return text;
    const without = text.replace(new RegExp(`(^|\\s)${path.replaceAll('.', '\\.')}(?=\\s)`, 'm'), '$1');
    assert.notEqual(without, text, path);
    return without;
  });
  assert.ok(gapPaths(drop('apps/landing/public')).includes('apps/landing/public'));
  assert.ok(gapPaths(drop('packages/contracts/deployments/core-v1')).includes('packages/contracts/deployments/core-v1/11155111.json'));
  const narrowed = real((file, text) => file === 'infra/server/ship.sh'
    ? text.replace(/^ {2}infra\/server$/m, '  infra/server/cards.Dockerfile infra/server/indexer.Dockerfile infra/server/services') : text);
  assert.ok(gapPaths(narrowed).includes('infra/server'), reportGaps(narrowed));
  assert.deepEqual(scriptReleasePaths('', SHIP).map(entry => entry.path), ['infra/server/smoke-landing.sh', 'apps/landing/public']);
  const compose = composeRepositoryPaths(readFileSync('infra/server/compose.yaml', 'utf8')).map(entry => entry.path);
  for (const path of ['infra/server/indexer.env', 'infra/server/cards.env', 'infra/server/Caddyfile', 'apps/landing/public', 'packages/indexer/src/withheld']) {
    assert.ok(compose.includes(path), path);
  }
});

test('a complete list has no gap, and a copy from an earlier stage needs no archive path', () => {
  assert.deepEqual(fixture(WHOLE), []);
});

test('a missing file, a missing folder, a missing Dockerfile and a missing infra/server are each named', () => {
  for (const missing of WHOLE) {
    const gaps = fixture(WHOLE.filter(path => path !== missing));
    assert.deepEqual(gapPaths(gaps), [missing]);
    assert.match(gaps[0].why, /not in the archive list/);
    assert.match(reportGaps(gaps), new RegExp(missing.replaceAll('.', '\\.')));
  }
  assert.deepEqual(gapPaths(fixture([...WHOLE.filter(path => path !== 'infra/server'), 'infra/server/compose.yaml', 'infra/server/install.sh'])), ['infra/server']);
});

test('one listed file of a folder does not carry the folder, and a listed folder carries its files', () => {
  assert.deepEqual(gapPaths(fixture([...WHOLE.filter(path => path !== 'src'), 'src/main.ts'])), ['src']);
  assert.deepEqual(fixture([...WHOLE.filter(path => path !== 'tools/check.ts'), 'tools']), []);
  assert.equal(carried(['packages/cards/scripts/register-ts.mjs'], 'packages/cards/scripts/check-webp.ts'), false);
  assert.equal(carried(['packages/cards/src'], 'packages/cards/srcs'), false);
  assert.equal(carried(['a/b'], 'a/b/c'), true);
});

test('a listed path that git does not track is a gap, and the real lookup tells tracked from untracked', () => {
  const gaps = fixture(WHOLE, { untracked: ['notes'] });
  assert.deepEqual(gaps.map(gap => [gap.path, /not tracked/.test(gap.why)]), [['notes', true]]);
  const repo = repository();
  assert.equal(repo.tracked('infra/server/ship.sh'), true);
  assert.equal(repo.tracked('packages/cards/notices'), true);
  assert.equal(repo.tracked('node_modules'), false);
  assert.equal(repo.tracked('packages/cards/notice'), false);
  assert.ok(repo.attributeFiles().includes('.gitattributes'));
});

test('an export attribute would let git archive drop a tracked file: the gate refuses it until it is taught', () => {
  assert.throws(() => fixture(WHOLE, { attributes: { '.gitattributes': 'docs export-ignore\n' } }), /export attributes/);
  assert.throws(() => fixture(WHOLE, { attributes: { 'src/.gitattributes': '*.ts export-subst\n' } }), /export attributes/);
  assert.deepEqual(fixture(WHOLE, { attributes: { '.gitattributes': '*.png binary\n' } }), []);
  for (const file of repository().attributeFiles()) assert.doesNotMatch(readFileSync(file, 'utf8'), /\bexport-(?:ignore|subst)\b/, file);
});

test('Compose env files and mounts, the installer and the outside check are compared with the list too', () => {
  const compose = `services:\n${service('one', '../..', 'Service.Dockerfile',
    '    env_file:\n      # a comment\n      - path: local.env\n        required: true\n      - path: /etc/elsewhere/secret.env\n'
    + '    volumes:\n      - ./conf:/etc/conf:ro\n      - ../../data/site:/srv/site:ro\n      - type: bind\n        source: ./long/form\n        target: /x\n      - /srv/outside:/y\n'
    + '      - "../../data/quoted:/srv/quoted:ro"\n      - type: bind\n        source: "../../data/long-quoted"\n        target: /z\n      - named:/data\n      - "8080:80"\n')}`
    + `${service('two', '../..', 'Service.Dockerfile', '    env_file:\n    - same-indent.env\n    - "quoted.env"\n    ports:\n    - "9090:90"\n')}`
    + 'secrets:\n  key:\n    file: ../../secret/key.txt\n';
  const install = 'for f in a b; do [[ -s $release/site/public/$f ]] || exit 1; done\nnew=$release/manifests/one.json\nprintf x > "$release/infra/server/.env"\nmv "$release.new" "$release"\n'
    + 'cp ${release}/braced/file.txt /tmp/\ninstall "$release"/units/app-{a,b}.service /etc/\ninstall "$release"/units2/heal.{service,timer} /etc/\n';
  const shipMore = 'sh_command tar -xzf "$tarball" -C "$work" infra/server/smoke.sh site/public\n';
  const needs = ['data/site', 'site/public', 'manifests/one.json', 'data/quoted', 'data/long-quoted', 'secret/key.txt', 'braced/file.txt', 'units', 'units2'];
  const all = [...WHOLE, ...needs];
  assert.deepEqual(fixture(all, { compose, install, shipMore }), []);
  for (const missing of needs) assert.deepEqual([...new Set(gapPaths(fixture(all.filter(path => path !== missing), { compose, install, shipMore })))], [missing]);
  assert.deepEqual(composeRepositoryPaths(compose).map(entry => entry.path),
    ['infra/server/local.env', 'infra/server/conf', 'data/site', 'infra/server/long/form', 'data/quoted', 'data/long-quoted',
      'infra/server/same-indent.env', 'infra/server/quoted.env', 'secret/key.txt']);
  assert.deepEqual(scriptReleasePaths(install, ship([], shipMore)).map(entry => entry.path),
    ['site/public', 'manifests/one.json', 'braced/file.txt', 'units', 'units2', 'infra/server/smoke.sh', 'site/public']);
  assert.deepEqual(composeRepositoryPaths('services:\n  one:\n    volumes:\n      - ..:/up:ro\n      - .:/here:ro\n').map(entry => entry.path), ['infra', 'infra/server']);
  assert.ok(scriptReleasePaths(readFileSync('infra/server/install.sh', 'utf8'), SHIP).some(entry => entry.path === 'infra/server/systemd'));
  assert.throws(() => scriptReleasePaths('cp "$release"/*.sh /tmp/\n', SHIP), /root of the release/);
  assert.throws(() => composeRepositoryPaths('services:\n  one:\n    env_file: ${HOME}/x.env\n'), /variable or a quote/);
  assert.throws(() => fixture(WHOLE, { compose: `${COMPOSE}    additional_contexts:\n      other: ../elsewhere\n` }), /additional_contexts/);
});

test('two services that share a Dockerfile are judged once per build context', () => {
  const compose = `services:\n${service('one', '../..', 'Service.Dockerfile')}${service('two', '../..', 'Service.Dockerfile')}${service('three', '../../other', '../Service.Dockerfile')}`;
  const gaps = fixture(WHOLE, { compose });
  assert.deepEqual(gapPaths(gaps), ['other/package.json', 'other/pnpm-lock.yaml', 'other/src', 'other/tools/check.ts', 'other/notes']);
  assert.deepEqual(fixture([...WHOLE, 'other'], { compose }), []);
});

test('Dockerfile lines are read as Docker reads them', () => {
  assert.deepEqual(contextSources('FROM x\nCOPY a \\\n  b /app/\ncopy c /app/\n\tCOPY d/ /app/d/\nCOPY ./e /app/\n'), ['a', 'b', 'c', 'd/', './e']);
  assert.deepEqual(contextSources('FROM x\nCOPY a \\ \n  b \\\t\n#why\n\n  # a longer comment\n  c /app/\n'), ['a', 'b', 'c']);
  assert.deepEqual(contextSources('FROM x AS build\nFROM y\nCOPY --from=build /x /y\nCOPY --from=0 /x /z\nCOPY --link --chmod=644 --chown=1:1 --exclude=*.md --parents a /app/\n'), ['a']);
  assert.deepEqual(contextSources('FROM x\nRUN --mount=type=cache,target=/root/.cache --mount=type=secret,id=k true\nHEALTHCHECK --interval=30s \\\n  CMD ["node", "check.mjs"]\n'), []);
  assert.deepEqual(logicalLines('# syntax=docker/dockerfile:1\nFROM x\n\nRUN a \\\n  && b\n'), ['FROM x', 'RUN a    && b']);
  assert.deepEqual(fixture(WHOLE, { docker: 'FROM node:fixture\nCOPY src/ /app/src/\n' }), []);
  const slashed = real((file, text) => file === 'infra/server/cards.Dockerfile'
    ? text.replace('COPY packages/cards/notices /app/notices', 'COPY packages/cards/notices/ /app/notices/') : text);
  assert.deepEqual(slashed, [], reportGaps(slashed));
});

test('what the gate cannot judge is refused, not passed', () => {
  for (const [docker, message] of [
    ['FROM x\nCOPY ["a b", "/app/"]\n', /JSON form/],
    ['FROM x\nCOPY --chown=1:1 ["a", "/app/"]\n', /pattern, a variable or a quote/],
    ['FROM x\nCOPY <<EOF /app/file\nhello\nEOF\n', /heredoc/],
    ['FROM x\nRUN <<EOF\necho hello\nEOF\n', /not a Dockerfile instruction/],
    ['FROM x\nCOPY src/*.ts /app/\n', /pattern, a variable or a quote/],
    ['FROM x\nCOPY "a" /app/\n', /pattern, a variable or a quote/],
    ['FROM x\nCOPY $SRC /app/\n', /pattern, a variable or a quote/],
    ['FROM x\nCOPY ../a /app/\n', /leaves its folder/],
    ['FROM x\nCOPY a/../../b /app/\n', /leaves its folder/],
    ['FROM x\nADD src /app/src\n', /ADD is not supported/],
    ['FROM x\nONBUILD COPY a /app/\n', /ONBUILD/],
    ['FROM x\nRUN --mount=source=secrets,target=/s true\n', /RUN mount/],
    ['FROM x\nRUN --mount=type=bind,source=.,target=/src true\n', /RUN mount/],
    ['FROM x\nCOPY --from=other /x /y\n', /names no earlier stage/],
    ['FROM x AS build\nCOPY --from=build /x /y\n', /names no earlier stage/],
    ['FROM x\nCOPY --from=1 /x /y\n', /names no earlier stage/],
    ['FROM x\nCOPY --frm=build a /app/\n', /COPY flag/],
    ['FROM x\nCOPY onlyone\n', /source and a destination/],
    ['# escape=`\nFROM x\nCOPY a /app/\n', /escape character/],
    ['FROM x\nCOPY a \\\n', /continued line ends/],
    ['FROM x\nCOPY a b --link\n', /looks like a flag/],
    ['FROM x\nRUN echo a\\\\\nCOPY b /app/\n', /two backslashes/],
  ]) assert.throws(() => contextSources(docker), message, docker);
  assert.throws(() => fixture(WHOLE, { docker: 'FROM node:fixture\nCOPY . /app\n' }), /whole repository/);
  for (const [text, message] of [
    ['paths=(\n  a\n)\npaths=(\n  b\n)\n', /exactly one/],
    ['paths=(\n  a\n)\npaths+=(b)\n', /exactly one/],
    ['paths=(a b)\n', /exactly one/],
    ['paths=(\r\n  a\r\n)\r\n', /exactly one/],
    ['paths=(\n  a a\n)\n', /twice/],
    ['paths=(\n  "$HOME/x"\n)\n', /unsupported archive path/],
    ['paths=(\n  a\n  # b\n)\n', /unsupported archive path: #/],
    ['paths=(\n  a #b\n)\n', /unsupported archive path: #b/],
    ['paths=(\n  a/\n)\n', /unsupported archive path/],
    ['paths=(\n  ../a\n)\n', /unsupported archive path/],
    ['paths=(\n  {a,b}\n)\n', /unsupported archive path/],
  ]) assert.throws(() => archivePaths(text), message, text);
  assert.deepEqual(archivePaths('x=1\npaths=(\n  a b/c\n\n  .npmrc\n)\ny=2\n'), ['a', 'b/c', '.npmrc']);
});

test('the gate runs with test:scripts, without a second command to remember', () => {
  assert.match(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:scripts'], /scripts\/test\/\*\.test\.mjs/);
});
