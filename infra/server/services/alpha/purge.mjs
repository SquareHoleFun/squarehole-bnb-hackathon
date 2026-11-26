// Offline founder maintenance only. Stop BOTH alpha services first; no deletion occurs without --execute.
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { need } from './auth.mjs';
import { uuid } from './files.mjs';

export function purgePlan(root, endedAt, now = Date.now()) {
  const ended = Date.parse(endedAt);
  need(Number.isFinite(ended) && new Date(ended).toISOString() === endedAt && now >= ended + 30 * 86400000, 400, 'thirty days after alpha end required');
  need(realpathSync(root) === resolve(root), 400, 'regular alpha root required');
  const files = [];
  for (const name of ['queue', 'receipts', 'state']) {
    const directory = join(root, name); need(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 400);
    for (const file of readdirSync(directory)) {
      const path = join(directory, file), stat = lstatSync(path);
      need(stat.isFile() && !stat.isSymbolicLink(), 400, 'unexpected alpha file');
      const known = name === 'state' ? (/^(?:alpha\.sqlite(?:-wal|-shm)?|monitor\.json(?:\.new)?)$/.test(file))
        : uuid.test(file.replace(/\.json$/, '')) && file.endsWith('.json')
          || (name === 'receipts' && file === 'sender-status.json')
          || (name === 'receipts' && file.endsWith('.progress.json') && uuid.test(file.slice(0, -'.progress.json'.length)))
          || (name === 'queue' && /^\.[a-f0-9-]+\.[a-f0-9-]+\.tmp$/.test(file));
      need(known, 400, 'unknown alpha file; review retention'); files.push(path);
    }
  }
  return { root, endedAt, files };
}
export function executePurge(plan, { uid = process.getuid(), stopped = false, erase = path => rmSync(path), now = Date.now() } = {}) {
  need(uid === 0 && stopped, 403, 'root and stopped alpha services required');
  const fresh = purgePlan(plan.root, plan.endedAt, now);
  need(JSON.stringify(fresh.files) === JSON.stringify(plan.files), 409, 'alpha files changed; make a new plan');
  for (const file of fresh.files) erase(file);
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  try {
    const [flag, endedAt, mode, stopped, ...extra] = process.argv.slice(2);
    need(flag === '--ended-at' && !extra.length && [undefined, '--execute'].includes(mode) && [undefined, '--services-stopped'].includes(stopped), 400);
    const plan = purgePlan('/srv/squarehole/alpha', endedAt);
    if (mode === '--execute') executePurge(plan, { stopped: stopped === '--services-stopped' });
    process.stdout.write(`alpha retention: ${plan.files.length} files ${mode === '--execute' ? 'deleted' : 'planned; no changes'}\n`);
  } catch { process.stderr.write('alpha retention refused; check end date, stopped services, root and file inventory\n'); process.exitCode = 1; }
}
