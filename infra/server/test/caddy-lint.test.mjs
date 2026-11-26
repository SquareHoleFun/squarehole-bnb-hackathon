import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { caddyTokens, lintCaddyfile } from './caddy-lint.mjs';
import { configOf, policyOf, renderSites } from '../app/config.mjs';

// SH-ALPHA-LOCK-REDIRECT: Caddy reads a first argument `*`, `/...` or `@...` as the directive's request matcher, so the
// page lock's `redir /join 303` redirected only /join (to a location named 303) and every other app path fell through to
// the files. `caddy validate` accepts that line; this lint refuses it, for the Caddyfile and the app's generated sites.
const CADDYFILE = 'infra/server/Caddyfile';
const LOCK_LINE = '\t\t\tredir * /join 303';
const site = (body) => `example.test {\n${body}\n}\n`;
const lines = (findings) => findings.map((f) => `${f.line} ${f.text}`);

test('the Caddyfile has no redir, rewrite or root whose location Caddy would take as the matcher', () => {
  assert.deepEqual(lines(lintCaddyfile(readFileSync(CADDYFILE, 'utf8'), CADDYFILE)), []);
});

test('the page lock: the old line is refused at its own line, the fix is accepted', () => {
  const text = readFileSync(CADDYFILE, 'utf8');
  const at = text.split('\n').indexOf(LOCK_LINE) + 1;
  assert.ok(at > 0, 'the page lock redirects with `redir * /join 303`');
  const findings = lintCaddyfile(text.replace(LOCK_LINE, '\t\t\tredir /join 303'), CADDYFILE);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, at);
  assert.equal(findings[0].matcher, '/join');
  assert.equal(findings[0].location, '303');
  assert.match(findings[0].message, /Caddy reads \/join as the request matcher, so the location is the bare status code 303/);
});

test('the lint reaches every redir, rewrite and root line of the Caddyfile', () => {
  const text = readFileSync(CADDYFILE, 'utf8').split('\n');
  const targets = text.map((l, i) => [i, /^(\s*)(redir|rewrite|root)\s/.exec(l)]).filter(([, m]) => m);
  assert.ok(targets.length >= 9, `${targets.length} location directives`);
  for (const [i, m] of targets) {
    const mutated = text.map((l, k) => (k === i ? `${m[1]}${m[2]} /moved 303` : l)).join('\n');
    assert.deepEqual(lines(lintCaddyfile(mutated)), [`${i + 1} ${m[2]} /moved 303`], `line ${i + 1}`);
  }
});

test('the app\'s generated site files pass the lint, with the alpha switch off and on', async () => {
  for (const input of ['', 'SH_APP_ALPHA_ACCESS=1']) {
    const config = configOf(input, 'sepolia');
    const rendered = renderSites({ id: 'c'.repeat(64), headers: await policyOf(process.cwd(), config), ...config });
    assert.deepEqual(lines(lintCaddyfile(rendered.site, 'app.site.caddy')), [], input || 'switch absent');
    assert.deepEqual(lines(lintCaddyfile(rendered.cors, 'app.cors.caddy')), [], input || 'switch absent');
    // The generated test-host block is a directive position: the same trap there is found.
    const trapped = rendered.site.replace('\timport app_security\n\t', '\timport app_security\n\tredir /join 303\n\t');
    assert.equal(lintCaddyfile(trapped, 'app.site.caddy').length, 1, input || 'switch absent');
  }
  assert.deepEqual(lintCaddyfile(readFileSync('infra/server/test/fixtures/alpha/access-off.site.caddy', 'utf8')), []);
});

test('Caddy\'s argument order: refused and accepted forms', () => {
  const refused = ['redir /join 303', 'redir /join', 'redir @lock 303', 'redir * 303', 'redir 303', 'redir * permanent',
    'redir "/join" 303', 'rewrite * 404', 'rewrite /join 404', 'root * 404', 'root /srv 404'];
  for (const form of refused) assert.equal(lintCaddyfile(site(`\t${form}`)).length, 1, form);
  const accepted = ['redir * /join 303', 'redir @lock /join 303', 'redir /old /new 301', 'redir https://squarehole.fun{uri} 301',
    'redir * {http.request.uri}', 'rewrite * /404.html', 'rewrite @join_entry /join/index.html', 'rewrite /index.html',
    'rewrite * ?{query}&page=1', 'root * /srv/landing', 'root /srv/landing', 'respond /join 303', 'error /join 404'];
  for (const form of accepted) assert.deepEqual(lintCaddyfile(site(`\t${form}`)), [], form);
});

test('only directive positions are linted', () => {
  const checked = [
    '\troute {\n\t\tredir /join 303\n\t}',
    '\thandle @x {\n\t\tredir /join 303\n\t}',
    '\thandle_errors 404 {\n\t\tredir /join 303\n\t}',
    '\tforward_auth up:1 {\n\t\turi /check\n\t\t@denied status 401\n\t\thandle_response @denied {\n\t\t\tredir /join 303\n\t\t}\n\t}',
  ];
  for (const body of checked) assert.equal(lintCaddyfile(site(body)).length, 1, body);
  assert.equal(lintCaddyfile('(lock) {\n\tredir /join 303\n}\n').length, 1, 'a snippet');
  const skipped = [
    '\treverse_proxy up:1 {\n\t\trewrite /api\n\t}',
    '\t@hashed {\n\t\tfile {\n\t\t\troot /srv/app/immutable\n\t\t\ttry_files {path}\n\t\t}\n\t}',
    '\t# redir /join 303',
    '\trespond <<TEXT\n\t\tredir /join 303\n\t\tTEXT 200',
    '\theader X-Note "redir /join 303"',
    '\t@m expression `{path}.startsWith(\n\t\t\'/join\')`',
  ];
  for (const body of skipped) assert.deepEqual(lintCaddyfile(site(body)), [], body);
  assert.deepEqual(lintCaddyfile('{\n\tservers {\n\t\troot /srv\n\t}\n}\n'), [], 'global options');
});

test('tokens: quotes, backticks and heredocs keep their lines; a continuation keeps the statement', () => {
  const tokens = caddyTokens('a "b\nc" d\n`e\nf` g\nrespond <<END\n  x\n  END 200\nh \\\n i\n');
  assert.deepEqual(tokens.map((t) => `${t.line}${t.newline ? '+' : ''}:${t.text}`), ['1+:a', '1:b\nc', '2:d', '3+:e\nf', '4:g', '5+:respond', '5:  x\n  ', '7:200', '8+:h', '9:i']);
});
