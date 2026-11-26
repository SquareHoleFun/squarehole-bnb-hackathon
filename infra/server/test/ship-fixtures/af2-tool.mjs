#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

const tool = basename(process.argv[1]), args = process.argv.slice(2);
const root = process.env.SHIP_FIXTURE_ROOT || process.cwd(), trace = `${root}-trace`;
const real = JSON.parse(readFileSync(join(trace, 'real-tools.json'), 'utf8'));
const dryRead = tool === 'node' && args[0]?.endsWith('/build.mjs') && args.includes('--dry-run');
const input = tool === 'ssh' ? readFileSync(0, 'utf8') : '';
// Effects are independent of the entrypoint-only trace: helpers must never hide a connection attempt.
if (['ssh', 'scp', 'rsync', 'curl'].includes(tool)) appendFileSync(join(trace, 'effects'), JSON.stringify({ tool, args, input }) + '\n');
if (process.env.SH_AF2_DEPTH === '0' && !dryRead) appendFileSync(join(trace, 'commands'), JSON.stringify({ tool, args, input }) + '\n');
if (process.env.SH_AF2_RECORD_ONLY) process.exit(0);
const failure = process.env.SH_AF2_FAILURE;
if (tool === 'git' && args[0] === 'status' && failure === 'status') process.exit(128);
if (tool === 'git' && args.includes('archive') && failure === 'archive') {
  const result = spawnSync(real.git, [...args, '__missing_fixture_archive_member__'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (tool === 'node' && args[0]?.endsWith('/archive.mjs') && failure === 'compressor') {
  writeSync(2, 'fixture compressor failure\n');
  process.exit(48);
}
if (tool === 'node' && args[0]?.endsWith('/archive.mjs') && failure === 'disk') {
  // Real compressor, a write-stream stand-in reporting ENOSPC.
  args.unshift('--import', join(trace, 'fault.mjs'));
}
if (tool === 'bash' && args[0]?.endsWith('/pack.sh') && ['check', 'interrupt', 'disk', 'rewrite', 'replace', 'symlink'].includes(failure)) {
  process.env.NODE_OPTIONS = `--import=${join(trace, 'fault.mjs')}`;
}
// All connections, Docker and builds terminate here. The smoke command itself is recorded after SSH.
if (['ssh', 'scp', 'rsync', 'docker', 'curl', 'shellcheck'].includes(tool)) process.exit(0);
if (tool === 'bash' && /smoke-(app|alpha|landing)\.sh$/.test(args[0])) process.exit(0);
if (tool === 'pnpm') {
  if (args.includes('vite')) {
    const out = args[args.indexOf('--outDir') + 1];
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html>offline fixture</html>');
    writeFileSync(join(out, 'assets/app-abcdefgh.js'), '/* offline fixture */');
  }
  process.exit(0);
}
const result = spawnSync(real[tool], args, { stdio: 'inherit', env: { ...process.env, SH_AF2_DEPTH: '1' } });
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
