#!/usr/bin/env node
// Offline command stand-in. No command here can open a connection or run an installer.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.SHIP_FIXTURE_ROOT || process.cwd();
const trace = `${root}-trace`;
const commit = 'a'.repeat(40);
if (tool === 'git') {
  appendFileSync(join(trace, 'git-calls'), JSON.stringify(args) + '\n');
  if (args[0] === '-c') args.splice(0, 2);
  if (args[0] === 'status') {
    if (process.env.SHIP_FIXTURE_STATUS_FAIL) process.exit(128);
    appendFileSync(join(trace, 'git-status-locks'), `${process.env.GIT_OPTIONAL_LOCKS}\n`);
    if (existsSync(join(root, 'leftover'))) writeSync(1, '?? leftover\n');
  } else if (args[0] === 'rev-parse') {
    writeSync(1, args.includes('--show-toplevel') ? root : commit);
  } else if (args[0] === 'cat-file') writeSync(1, args[1] === '-t' ? 'blob' : '10');
  else if (args[0] === 'ls-tree') {
    if (args.at(-1) === '.env.example') writeSync(1, `100644 blob ${commit}\t.env.example\n`);
    else if (args.includes('--name-only')) writeSync(1, 'apps/landing/public/index.html\napps/landing/public/404.html\napps/landing/public/_headers\napps/landing/public/styles.css\n');
    // The full listing names the same four landing files as --name-only: ship-alpha.sh reads it for its missing-file check.
    else writeSync(1, ['index.html', '404.html', '_headers', 'styles.css'].map(file => `100644 blob ${commit}\tapps/landing/public/${file}\n`).join(''));
  } else if (args[0] === 'show') {
    writeSync(1, args[1].endsWith('/_headers') ? readFileSync(join(root, '.cache/headers')) : '{"status":"awaiting-broadcast"}\n');
  } else if (args[0] === 'archive') {
    writeSync(1, readFileSync(join(root, '.cache/payload.tar')));
    if (process.env.SHIP_FIXTURE_ARCHIVE_FAIL) process.exit(47);
  }
  else if (args[0] === 'hash-object') writeSync(1, commit);
  else process.exit(91);
  // Emit the normal successful bytes first, then fail this exact probe occurrence.
  const probe = JSON.parse(process.env.SHIP_FIXTURE_GIT_FAIL || 'null');
  const matches = call => probe?.every((value, i) => call[i] === value);
  const calls = readFileSync(join(trace, 'git-calls'), 'utf8').trim().split('\n').map(JSON.parse)
    .map(call => call[0] === '-c' ? call.slice(2) : call);
  if (matches(args) && calls.filter(matches).length === +(process.env.SHIP_FIXTURE_GIT_FAIL_N || 1)) {
    writeFileSync(join(trace, 'git-fault'), JSON.stringify(args));
    process.exit(49);
  }
  process.exit(0);
}

const input = tool === 'ssh' ? readFileSync(0, 'utf8') : '';
if (['ssh', 'scp', 'rsync', 'curl'].includes(tool)) appendFileSync(join(trace, 'effects'), JSON.stringify({ tool, args, input }) + '\n');
appendFileSync(join(trace, 'transport-calls'), JSON.stringify({ tool, args, input }) + '\n');
if (tool === 'docker' && args[0] === 'compose' && args[1] === 'version' && process.env.SHIP_FIXTURE_COMPOSE_MISSING) process.exit(1);
if (['ssh', 'rsync', 'curl'].includes(tool)) process.exit(78);
if (tool === 'pnpm' && args.includes('vite')) {
  const out = args[args.indexOf('--outDir') + 1];
  mkdirSync(join(out, 'assets'), { recursive: true });
  writeFileSync(join(out, 'index.html'), '<html>offline fixture</html>');
  writeFileSync(join(out, 'assets/app-abcdefgh.js'), '/* offline fixture */');
}
// scp, pnpm, shellcheck and docker are recorded no-ops. A real-run test stops at ssh before activation/smoke.
