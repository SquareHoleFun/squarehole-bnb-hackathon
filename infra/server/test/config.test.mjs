import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configOf } from '../app/config.mjs';

describe('server configuration', () => {
  it('SH-218 D3: production leaves Create lists in the packaged folder', () => {
    for (const file of ['infra/server/compose.yaml', 'infra/server/indexer.Dockerfile', 'infra/server/cards.Dockerfile',
      'infra/server/reveal.Dockerfile', 'infra/server/caddy.Dockerfile', 'infra/server/services/alpha/Dockerfile',
      'packages/keeper/Dockerfile', 'packages/burn-bot/Dockerfile',
      'packages/cow-poster/Dockerfile', 'infra/server/install.sh', 'infra/server/ship.sh']) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('SH_CORE_CREATE_OPTIONS_DIR');
    }
    const image = readFileSync('infra/server/indexer.Dockerfile', 'utf8');
    expect(image).toContain('COPY packages/chain/src packages/chain/src');
    const ship = readFileSync('infra/server/ship.sh', 'utf8');
    expect(ship).toContain('packages/chain/src');
    const compose = readFileSync('infra/server/compose.yaml', 'utf8');
    const indexer = compose.match(/^ {2}indexer:\n[\s\S]*?(?=^ {2}[a-z])/m)?.[0];
    expect(indexer).toBeDefined();
    expect(indexer).not.toMatch(/target:\s*\/app|:\/app(?::|\/)/);
  });
  it.each(['SH_APP_MAIN_HOST', 'SH_APP_TEST_HOST'])('reserves the alpha preview hostname against %s', (setting) => {
    expect(() => configOf(`${setting}=alpha.squarehole.fun`, 'sepolia')).toThrow(/Invalid or duplicate public app host setting/);
  });

  it('parses compose YAML, retaining hosting and adding the seven outbound workers', () => {
    const json = execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' });
    const config = JSON.parse(json);
    expect(Object.keys(config.services).sort()).toEqual(['agents', 'alpha-api', 'alpha-sender', 'burn-bot', 'caddy', 'cards', 'cow-poster', 'indexer', 'ipfs-art', 'keeper', 'keeper-set', 'kubo', 'postgres', 'reveal']);
    expect(config.services.caddy.volumes).toContain('/srv/squarehole/app:/srv/app:ro');
    expect(config.services.caddy.ports).toEqual(['0.0.0.0:80:80', '0.0.0.0:443:443']);
    expect(config.services.postgres.ports).toBeUndefined();
    // LINKS-SRV: signed links cannot be replayed from the chain, so the server must persist them in Postgres.
    expect(config.services.indexer.environment.SH_HISTORY).toBe('postgres');
    expect(config.networks.backend.internal).toBe(true);
    for (const name of ['keeper', 'keeper-set', 'burn-bot', 'reveal']) {
      const s = config.services[name];
      expect(s.image).toContain(`squarehole-${name === 'keeper-set' ? 'keeper' : name}:`);
      expect(s.ports).toBeUndefined();
      expect(s.read_only).toBe(true);
      expect(s.restart).toBe('unless-stopped');
      expect(s.cap_drop).toEqual(['ALL']);
      expect(s.security_opt).toContain('no-new-privileges:true');
      expect(s.networks).toEqual(['workers']);
      expect(s.logging).toEqual(config.services.cards.logging);
      expect(s.env_file).toContainEqual({ path: `/etc/squarehole/${name}.env`, required: false, format: 'raw' });
      expect(s.volumes.some(v => typeof v === 'object' && v.target === '/run/service-config' && v.read_only)).toBe(true);
      const build = name === 'keeper-set' ? config.services.keeper.build : s.build;
      const dockerfile = readFileSync(build.dockerfile.replace(/^\.\.\/\.\.\//, ''), 'utf8');
      expect(dockerfile).toMatch(/FROM node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}/);
      expect(dockerfile).toContain('USER node');
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).not.toContain('EXPOSE');
    }
  });
  it('isolates agents on an outbound network with private persistent outputs and no published port', () => {
    const config = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));
    const s = config.services.agents;
    expect(s.image).toBe(config.services.keeper.image); expect(s.user).toBe('0:0');
    expect(s.networks).toEqual(['agents']); expect(config.networks.agents).toEqual({});
    expect(s.ports).toBeUndefined(); expect(s.read_only).toBe(true); expect(s.cap_drop).toEqual(['ALL']);
    expect(s.cap_add).toBeUndefined(); expect(s.pull_policy).toBe('never');
    expect(s.command).toEqual(['node', 'infra/server/services/agents.mjs']);
    expect(s.healthcheck.test).toEqual(['CMD', 'node', 'infra/server/services/agents.mjs', '--healthcheck']);
    expect(s.env_file).toEqual([{ path: '/etc/squarehole/agents.env', required: false, format: 'raw' }]);
    expect(s.environment).toEqual({ SH_AGENTS_CHAIN_ID: '11155111', SH_AGENTS_SERVER: '1' });
    expect(s.volumes).toEqual([
      { type: 'bind', source: '/etc/squarehole/agents', target: '/run/service-config', read_only: true, bind: { create_host_path: false } },
      { type: 'bind', source: '/srv/squarehole/agents', target: '/srv/squarehole/agents', bind: { create_host_path: false } },
    ]);
    expect(readFileSync('infra/server/services/agents.env.example', 'utf8')).toContain('SH_SERVICE_ENABLED=0');
  });
  it('runs the CoW order poster as a keyless, read-only worker with no port, secret or other worker’s state', () => {
    const json = execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' });
    const config = JSON.parse(json);
    const s = config.services['cow-poster'];
    expect(s.image).toMatch(/^squarehole-cow-poster:\$\{SH_RELEASE:\?/);
    expect(s.pull_policy).toBe('never');
    expect(s.build).toEqual({ context: '../..', dockerfile: 'packages/cow-poster/Dockerfile' });
    expect(s.ports).toBeUndefined();
    expect(s.read_only).toBe(true);
    expect(s.restart).toBe('unless-stopped');
    expect(s.init).toBe(true);
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.security_opt).toContain('no-new-privileges:true');
    expect(s.networks).toEqual(['workers']);
    expect(s.logging).toEqual(config.services.cards.logging);
    expect(s.stop_grace_period).toBe('60s');
    // Only its own optional env file; the committed environment names paths, never an RPC URL or credential.
    expect(s.env_file).toEqual([{ path: '/etc/squarehole/cow-poster.env', required: false, format: 'raw' }]);
    expect(s.environment).toEqual({ SH_COW_MANIFEST: '/manifests/11155111.json', SH_COW_STATE_DIR: '/state', SH_COW_HEALTH_FILE: '/state/health.json' });
    // The release manifests read-only and its own state volume; no key folder, no keeper state.
    expect(s.volumes).toEqual(['/srv/squarehole/manifests:/manifests:ro', 'cow_poster_state:/state']);
    expect(Object.keys(config.volumes)).toContain('cow_poster_state');
    const dockerfile = readFileSync(s.build.dockerfile, 'utf8');
    expect(dockerfile).toMatch(/FROM node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).not.toContain('EXPOSE');
    const example = readFileSync('infra/server/services/cow-poster.env.example', 'utf8');
    expect(example).toContain('SH_SERVICE_ENABLED=0');
    expect(example).not.toMatch(/^SH_COW_RPC_URL=/m);
  });
  it('every Node image is .nvmrc\'s Node, the 2026-10-21 security release, pinned by one multi-arch index digest (SH-NODE-24-22-1)', () => {
    const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
    expect(nvmrc).toBe('24.22.1');
    const dockerfiles = ['infra/server/indexer.Dockerfile', 'infra/server/cards.Dockerfile', 'infra/server/reveal.Dockerfile',
      'packages/keeper/Dockerfile', 'packages/burn-bot/Dockerfile', 'packages/cow-poster/Dockerfile'];
    for (const file of dockerfiles) {
      const from = [...readFileSync(file, 'utf8').matchAll(/^FROM (\S+)/gm)].map(m => m[1]);
      expect(from, file).toEqual([`node:${nvmrc}-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`]);
    }
  });
  it('requires offline Caddy parse/provision and shellcheck before an app upload', () => {
    const script = readFileSync('infra/server/app/validate.sh', 'utf8');
    expect(script).toContain('shellcheck');
    expect(script).toContain('--no-env-resolution');
    expect(script).toContain('--network none');
    expect(script).toContain('caddy validate');
    expect(script).not.toMatch(/docker (pull|build)|pnpm (add|install)/);
    const ship = readFileSync('infra/server/ship.sh', 'utf8');
    expect(ship.indexOf('bash infra/server/app/validate.sh')).toBeLessThan(ship.indexOf('scp "${ssh_opts[@]}"'));
  });
});
