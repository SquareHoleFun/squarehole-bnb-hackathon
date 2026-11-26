import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, GUARDS, assertFresh, buildReachMap, git, inventory, ownerOf } from './reach.mjs';

export function changedPaths(baseRef, root = ROOT) {
  if (!baseRef || baseRef.startsWith('-')) throw new Error('usage: pnpm verify:merge <base-ref> [--plan]');
  const base = git(['merge-base', '--', baseRef, 'HEAD'], root).trim();
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('Could not resolve merge base');
  // No rename detection: include both old and new paths. Include staged, unstaged and new files.
  const paths = [...git(['diff', '--name-only', '-z', '--no-renames', base, '--'], root).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0')];
  return { base, paths: [...new Set(paths.filter(Boolean))].sort() };
}

export function selectTests(map, paths, all = false, affected = []) {
  const selected = {};
  for (const [path, test] of Object.entries(map.tests)) {
    if (all || map.guards.includes(path) || paths.includes(path)
      || (test.runner === 'node' && affected.includes(test.owner))
      || test.reaches.some(reach => reach === '*' || paths.some(path => path === reach || path.startsWith(`${reach}/`)))) {
      (selected[test.runner] ??= []).push(path);
    }
  }
  return selected;
}

export function affectedPackages(packages, paths, all = false) {
  const selected = new Set(all ? packages.map(pkg => pkg.path) : paths.map(ownerOf));
  let changed;
  do {
    changed = false;
    const names = new Set(packages.filter(pkg => selected.has(pkg.path)).map(pkg => pkg.name));
    for (const pkg of packages) if (!selected.has(pkg.path) && pkg.dependencies.some(name => names.has(name))) {
      selected.add(pkg.path); changed = true;
    }
  } while (changed);
  return packages.filter(pkg => selected.has(pkg.path));
}

export function planMerge(root, map, change, files = inventory(root)) {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'))).scripts;
  const packages = files.filter(path => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)).map(path => {
    const pkg = JSON.parse(readFileSync(resolve(root, path)));
    return { path: dirname(path), name: pkg.name, typecheck: Boolean(pkg.scripts?.typecheck),
      dependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }) };
  });
  // Unknown data consumers use full lanes. Wildcard readers do not prove that all consumers
  // of a data file were found, so only an exact import edge permits narrower selection.
  const all = change.paths.some(path => !/^(?:apps|packages|docs|examples|infra|skills)\//.test(path)
    || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|(?:vite|vitest|eslint)[^/]*\.[cm]?[jt]s)$/.test(path)
    || (!/\.[cm]?[jt]sx?$/.test(path) && !Object.values(map.tests).some(test => test.reaches.includes(path)))
    || !existsSync(resolve(root, path)));
  const affected = affectedPackages(packages, change.paths, all);
  const selected = selectTests(map, change.paths, all, affected.map(pkg => pkg.path));
  for (const guard of GUARDS) if (!map.tests[guard]) throw new Error(`Whole-tree guard missing from reach map: ${guard}`);
  const commands = [];
  const add = (...args) => commands.push({ command: 'pnpm', args });
  // Inherit the ship gate's check:* steps; changes to that gate cannot silently drop them here.
  for (const match of scripts.verify.matchAll(/\bpnpm (check:[\w-]+)/g)) add(match[1]);
  if (all) { add('lint'); add('typecheck'); }
  else {
    const lintPaths = [...new Set([...affected.map(pkg => pkg.path), ...change.paths.filter(path => /\.[cm]?[jt]sx?$/.test(path) && existsSync(resolve(root, path)))])];
    if (lintPaths.length) add('exec', 'eslint', '--cache', '--cache-location', '.cache/eslint/', '--cache-strategy', 'content', ...lintPaths);
    for (const pkg of affected.filter(pkg => pkg.typecheck)) add('--filter', pkg.name, 'typecheck');
  }
  const configs = { vitest: null, listing: 'scripts/listing/vitest.config.mjs', infra: 'infra/server/test/vitest.config.mjs', 'infra-monitor': 'infra/server/monitor/vitest.config.mjs' };
  const related = change.paths.filter(path => existsSync(resolve(root, path)));
  for (const [runner, config] of Object.entries(configs)) {
    const picked = selected[runner] ?? [];
    if (!all && !picked.length && !related.length) continue;
    const args = ['exec', 'vitest', all ? 'run' : 'related', '--run', '--passWithNoTests'];
    if (config) args.push('--config', config);
    if (!all) args.push(...new Set([...related, ...picked]));
    add(...args);
  }
  const node = selected.node ?? [];
  if (node.length) commands.push({ command: process.execPath, args: ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--test', ...node] });
  // Report all browser/forge paths conservatively. They have independent setup, networks and EVM profiles.
  return { base: change.base, changed: change.paths, fullFallback: all, affectedPackages: affected.map(pkg => pkg.path),
    always: GUARDS, selected, commands, playwright: change.paths.length ? map.playwright : [], forge: change.paths.length ? map.forge : [],
    manualTests: [...(selected['manual-node'] ?? []), ...(selected['manual-vitest'] ?? [])] };
}

export function main(args = process.argv.slice(2)) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--plan')) throw new Error('usage: pnpm verify:merge <base-ref> [--plan]');
  const map = assertFresh(ROOT, buildReachMap());
  const plan = planMerge(ROOT, map, changedPaths(args[0]));
  mkdirSync(resolve(ROOT, '.cache'), { recursive: true });
  writeFileSync(resolve(ROOT, '.cache/verify-merge-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  if (args.includes('--plan')) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return; }
  process.stdout.write(`Merge base ${plan.base}; ${plan.changed.length} changed paths; full fallback: ${plan.fullFallback}\n`);
  process.stdout.write(`Playwright specs to run separately:\n${plan.playwright.join('\n')}\nForge paths to run separately:\n${plan.forge.join('\n')}\n`);
  if (plan.manualTests.length) process.stdout.write(`Tests outside the ship scripts; review their setup separately:\n${plan.manualTests.join('\n')}\n`);
  for (const step of plan.commands) {
    process.stdout.write(`\n> ${step.command} ${step.args.join(' ')}\n`);
    const result = spawnSync(step.command, step.args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, SH_TEST_CAPACITY: '0' } });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
