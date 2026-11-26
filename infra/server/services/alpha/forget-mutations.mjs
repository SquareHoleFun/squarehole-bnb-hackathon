// af3: ten single-line mutations. Scratch modules only; no daemon or network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { shLimit } from '../../../../vitest.timeouts.mjs';
const original = new URL('./forget-tester.mjs', import.meta.url);
const mutants = [
  ["F1", "remove API startup refusal", "api", "  assertNoForget(config.receiptsDir);", "  // startup refusal removed", "both service cores refuse"],
  ["F2", "stop a service before the plan", "wrapper", "plan=$(docker run \"${flags[@]}\" \"$image\" \"${command[@]}\")", "docker compose stop --timeout 60 alpha-api alpha-sender; plan=$(docker run \"${flags[@]}\" \"$image\" \"${command[@]}\")", "wrapper plan failure"],
  ["F3", "put absent-target exit after the stops", "wrapper", "if [[ $plan == '{\"absent\":true}' && ! -e /var/backups/squarehole/alpha-forget.restore ]]; then", "if [[ $plan == '{\"absent\":true}' && ! -e /var/backups/squarehole/alpha-forget.restore ]]; then systemctl stop squarehole-pg-backup.timer; docker compose stop --timeout 60 alpha-api alpha-sender", "wrapper absent target"],
  ["F4", "accept execution without the wrapper record", "command", "  guard(!execute || (opts.operation && opts.completion && existsSync(opts.completion)), 'execution requires alpha-forget.sh and its operation record');", "  // wrapper record guard removed", "direct execution without"],
  ["F5", "hash original-case wrapper handle (U5)", "wrapper", "selector=$(printf '%s\\n%s\\n' \"$x_id\" \"${handle,,}\" | sha256sum)", "selector=$(printf '%s\\n%s\\n' \"$x_id\" \"$handle\" | sha256sum)", "mixed-case handle"],
  ["F6", "require stopped services for a read-only plan", "command", "guard(!execute || servicesStopped, 'stop alpha-api", "guard(servicesStopped, 'stop alpha-api", "plan reads live WAL"],
  ["F7", "omit plan fingerprint", "command", " [${selectorDigest(m.xId, m.handle).slice(0, 8)}]", "", "similar masked handles"],
  ["F8", "omit confirmation fingerprint", "wrapper", "printf 'Type the handle again to execute %s [%s]: ' \"$masked\" \"${selector:0:8}\" >&2", "printf 'Type the handle again to execute %s: ' \"$masked\" >&2", "mixed-case handle"],
  ["F9", "trust the saved digest instead of computing the supplied selector", "command", "const selector = selectorDigest(xId, handle);", "const selector = restore[4];", "wrapper receipt requires its exact operation"],
  ["F10", "ignore the live WAL during plan", "command", "const planPath = existsSync(`${dbPath}-wal`) ? dbPath :", "const planPath =", "plan reads live WAL"],
];
const urls = { command: original, senderStore: new URL('./sender/store.mjs', original), maintenance: new URL('./forget-maintenance.mjs', original),
  api: new URL('../alpha-api.mjs', original), apiStore: new URL('./store.mjs', original), engine: new URL('./sender/engine.mjs', original), wrapper: new URL('../../alpha-forget.sh', original) };
const sources = Object.fromEntries(Object.entries(urls).map(([k, url]) => [k, readFileSync(url, 'utf8')]));
mkdirSync('.cache/lane/sh217-af3', { recursive: true });
const scratch = mkdtempSync(resolve('.cache/lane/sh217-af3/mutations-'));
let killed = 0, survived = 0; const began = performance.now();
for (const [id, description, kind, before, after, name] of mutants) {
  assert.ok(sources[kind].includes(before), `${id}: mutation no longer matches`);
  assert.ok(!before.includes('\n') && !after.includes('\n'), `${id}: must change one line`);
  const folder = join(scratch, id); mkdirSync(folder);
  const paths = Object.fromEntries(Object.keys(urls).map(k => [k, join(folder, k === 'wrapper' ? 'alpha-forget.sh' : `${k}.mjs`)]));
  const replacements = new Map(Object.keys(urls).map(k => [urls[k].href, pathToFileURL(paths[k]).href]));
  for (const key of Object.keys(urls)) {
    let text = key === kind ? sources[key].replace(before, after) : sources[key];
    if (key !== 'wrapper') text = text.replace(/from '(\.[^']+)'/g, (_, path) => {
      const url = new URL(path, urls[key]).href; return `from '${replacements.get(url) ?? url}'`;
    });
    if (key === 'api') text = text.replaceAll('import.meta.url', JSON.stringify(urls[key].href));
    writeFileSync(paths[key], text);
  }
  const log = join(folder, 'test.log'), fd = openSync(log, 'wx'); let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, '--test', '--test-isolation=none', '--test-concurrency=1', '--test-reporter=tap',
        `--test-name-pattern=${name}`, kind === 'wrapper' && !name.startsWith('mixed-case') ? 'scripts/test/alpha-forget.test.mjs' : 'infra/server/services/alpha/forget-tester.test.mjs'], {
        stdio: ['ignore', fd, fd], timeout: shLimit(30000), env: { ...process.env,
          SH_FORGET_MODULE: pathToFileURL(paths.command).href, SH_FORGET_SENDER_STORE: pathToFileURL(paths.senderStore).href,
          SH_FORGET_API_MODULE: pathToFileURL(paths.api).href, SH_FORGET_SENDER_ENGINE: pathToFileURL(paths.engine).href, SH_FORGET_WRAPPER: paths.wrapper },
      });
      child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal }));
    });
  } finally { closeSync(fd); }
  const report = readFileSync(log, 'utf8');
  assert.equal(result.signal, null, `${id}: signal ${result.signal}`);
  assert.ok([0, 1].includes(result.status), `${id}: unexpected status ${result.status}; ${log}`);
  const expected = result.status === 1 ? 'killed' : 'survives';
  if (result.status === 1) killed++; else survived++;
  assert.doesNotMatch(report, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_MODULE_LINK_MISMATCH/);
  assert.match(report, expected === 'survives' ? /# pass [1-9]/ : /# fail [1-9]/);
  assert.match(report, new RegExp(`# Subtest: .*${name}`));
  process.stdout.write(`${id}: ${expected} — ${description} — ${name}\n`);
}
process.stdout.write(`${killed} killed; ${survived} survivors; ${(performance.now() - began) / 1000} s; logs ${scratch}\n`);
