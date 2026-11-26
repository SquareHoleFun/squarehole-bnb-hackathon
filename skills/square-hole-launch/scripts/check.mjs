#!/usr/bin/env node
/**
 * The launch skill's checker: runs the Square Hole repository's `packages/box-spec/scripts/check-spec.mjs` (the same
 * check the box factory runs) on a BoxSpec draft, or prints today's choices.
 *
 *   node scripts/check.mjs <draft.json> [--json]      (from this skill's folder; the draft's path as usual)
 *   node scripts/check.mjs --menu | --field <name> <text> | --numbers [...]
 *
 * Finds the BoxSpec package from this file's place first (skills/square-hole-launch/scripts in the repository or the
 * builder kit it ships in), then SQUAREHOLE_REPO (for a copy of the skill on its own), then the current directory
 * upwards. Its own folder wins, so a variable set for another checkout never redirects it. A relative draft path is read from the current directory:
 * a leftover INIT_CWD from an outer pnpm run is dropped. Needs Node 22.18+ or 24 and the repository's dependencies
 * (`pnpm install`). Reads files only: no keys, no network, no transactions. Exit codes are the checker's: 0 valid,
 * 1 refused, 2 usage error, 3 not a readable BoxSpec, 4 looks like a private key or recovery phrase.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = 'packages/box-spec/scripts/check-spec.mjs';

function findRepo() {
  const candidates = [resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), process.env.SQUAREHOLE_REPO];
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    candidates.push(dir);
    if (dirname(dir) === dir) break;
  }
  return candidates.find((dir) => dir && existsSync(join(dir, CLI)));
}

const repo = findRepo();
if (!repo) {
  console.error(`Cannot find the Square Hole BoxSpec checker (${CLI}) in the folder this skill ships in. A copy of the skill on its own needs SQUAREHOLE_REPO set to a folder that holds it; otherwise write the draft by hand from references/fields.md, say it is not checked, and let the launch flow check it.`);
  process.exit(2);
}
const env = { ...process.env };
delete env.INIT_CWD;
delete env.npm_lifecycle_event;
const args = process.argv.slice(2);
if (args.includes('--format') && args[args.indexOf('--format') + 1] === '2' && !args.includes('--numbers') && !args.includes('--field')) {
  const { runLaunchCheckV2 } = await import(pathToFileURL(join(repo, 'packages/box-spec/scripts/lib/spec-cli-v2.mjs')).href);
  process.exit(await runLaunchCheckV2(args));
}
const run = spawnSync(process.execPath, [join(repo, CLI), ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd(), env });
process.exit(run.status ?? 2);
