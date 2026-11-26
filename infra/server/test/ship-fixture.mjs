import { execFileSync, spawnSync } from './local-command.mjs';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function shipFixture() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/ship-portable-'));
  for (const path of ['infra/server/ship.sh', 'infra/server/ship-alpha.sh', 'infra/server/install.sh', 'infra/server/install-alpha.sh', 'infra/server/smoke-alpha.sh', 'infra/server/smoke-landing.sh', 'infra/server/test/alpha-offline-check.sh', 'infra/server/smoke-app.sh', 'infra/server/heal/check.sh', 'infra/server/app', 'infra/server/Caddyfile', 'apps/web/src/share/share-headers.ts', 'packages/chain/src/config/networks.ts', 'packages/chain/src/config/testnet-profile.ts']) {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    cpSync(path, join(root, path), { recursive: true });
  }
  const trace = `${root}-trace`;
  mkdirSync(trace);
  const bin = join(root, '.cache/bin');
  mkdirSync(bin, { recursive: true });
  const headers = readFileSync('infra/server/Caddyfile', 'utf8').split('(alpha_headers) {')[1].split('\n}')[0];
  writeFileSync(join(root, '.cache/headers'), '/*\n' + [...headers.matchAll(/^\s*([\w-]+) "([^"\n]+)"$/gm)]
    .filter(([, name]) => name !== 'X-Robots-Tag').map(([, name, value]) => `  ${name}: ${value}\n`).join(''));
  // git archive's stream is a small plain tar fixture. Real Git's normalization is checked separately.
  execFileSync('tar', ['-cf', join(root, '.cache/payload.tar'), '-C', root, 'infra/server/Caddyfile']);
  for (const name of ['git', 'ssh', 'scp', 'rsync', 'curl', 'docker', 'pnpm', 'shellcheck']) {
    cpSync('infra/server/test/ship-fixtures/tool.mjs', join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(root, '.cache/public-config.txt');
  writeFileSync(config, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIP_FIXTURE_ROOT: root, GIT_OPTIONAL_LOCKS: '1', SH_ACCESS_HEADERS: '', SH_SERVER: 'fixture@offline.invalid', SH_SERVER_KEY: '/offline/key with space' };
  const runScript = (script, args, options = {}) => spawnSync('bash', [join(root, 'infra/server', script), ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000, ...options });
  const calls = () => existsSync(join(trace, 'transport-calls')) ? readFileSync(join(trace, 'transport-calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, trace, bin, config, commit: 'a'.repeat(40), env, runScript, run: (...args) => runScript('ship.sh', args), calls };
}
