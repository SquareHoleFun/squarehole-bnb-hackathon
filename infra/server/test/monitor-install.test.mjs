import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

test('loads the monitor entry from exactly the runbook installation files, without running it', async () => {
  const runbook = readFileSync(new URL('../../../docs/runbooks/monitoring.md', import.meta.url), 'utf8');
  const section = runbook.split('## Install and rehearse (founder)')[1];
  const block = section.match(/```sh\n([\s\S]*?)```/)[1];
  const sources = [...block.matchAll(/^sudo install -m \d+ \/srv\/squarehole\/current\/infra\/server\/monitor\/(\S+) \/opt\/squarehole-monitor\/[^\n]*$/gm)]
    .map(match => match[1]);
  assert.ok(sources.length > 0);
  const files = sources.flatMap(source => {
    const group = source.match(/^\{([a-z,-]+)\}(\.mjs)$/);
    if (group) return group[1].split(',').map(name => name + group[2]);
    assert.match(source, /^[a-z-]+\.(?:mjs|sh)$/);
    return [source];
  });
  const target = mkdtempSync(join(tmpdir(), 'monitor-install-'));
  for (const file of files) copyFileSync(new URL(`../monitor/${file}`, import.meta.url), join(target, file));
  assert.deepEqual(readdirSync(target).sort(), files.sort());
  // Only the copied entry is imported. No main(), configuration, checks, delivery or heartbeat.
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden in installation load test'); };
  try {
    const entry = await import(pathToFileURL(join(target, 'main.mjs')).href);
    assert.equal(typeof entry.main, 'function');
  } finally { globalThis.fetch = fetch; }
});
