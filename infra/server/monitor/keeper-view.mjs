import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configure, decimal, uint } from './config.mjs';
import { files, keeperLock } from './collect.mjs';
import { evaluate } from './policy.mjs';
import { realpathSync } from 'node:fs';
import { evaluateSet, SET_CHECKS } from './keeper-set.mjs';
export { decimal };

// Read-only operator view of the keeper: its published view and spend journal, judged by the monitor's own checks.
// No RPC, HTTP, notification, lock or state write. The reserve check needs the RPC balance: see the monitor run.
export const KEEPER_CHECKS = ['keeper-queue', 'keeper-fee', 'keeper-spend', 'keeper-rescue-spend', 'keeper-income', 'drand', 'keeper-lock'];

const eth = w => `${decimal(w, 18, 6)} ETH`;
const gwei = w => `${decimal(w, 9, 3)} gwei`;
const span = s => s >= 86400n ? `${s / 86400n} d ${(s % 86400n) / 3600n} h` : s >= 3600n ? `${s / 3600n} h` : `${s / 60n} min`;
const safe = fn => { try { return fn(); } catch { return 'unreadable'; } };

export function summarize(o, c, now) {
  const verdict = new Map(evaluate(o, c, now).filter(r => KEEPER_CHECKS.includes(r.id)).map(r => [r.id, r]));
  const v = o.view, k = o.keeper;
  const line = (id, label, detail) => {
    const r = verdict.get(id);
    return `${label.padEnd(8)} ${r.status.padEnd(7)} ${r.status === 'ok' ? '' : `${r.reason}; `}${safe(detail)}`;
  };
  const head = !v ? 'keeper view missing or unreadable'
    : safe(() => `keeper view block ${uint(v.block)}, ${now - uint(v.observedAt)} s old, ${v.complete === true ? 'complete' : 'INCOMPLETE'}`
      + (v.failedReads && v.failedReads !== '0' ? `, ${uint(v.failedReads)} failed reads` : ''));
  return [head,
    line('keeper-queue', 'queue', () => {
      const count = uint(v.queue.count);
      return count === 0n ? 'no waiting work' : `${count} waiting, oldest ${uint(v.block) - uint(v.queue.oldestBlock)} blocks`;
    }),
    line('keeper-fee', 'fee', () => `${gwei(uint(v.maxFeePerGasWei))} max fee (pause above ${gwei(uint(c.maxFeePerGasWei))}; `
      + `drand jobs inside their last ${uint(c.drandRescueWindowSeconds) / 3600n} h up to ${gwei(uint(c.drandRescueMaxFeeWei))})`),
    line('keeper-spend', 'spend', () => {
      const b = k.state.budget, today = uint(b.day) === now / 86400n;
      const used = n => today ? uint(b[`${n}Wei`]) : 0n;
      return ['ours', 'pokes', 'total'].map(n => `${n} ${eth(used(n))} of ${eth(uint(c[`${n}WeiPerDay`]))}`).join(', ') + ' today';
    }),
    line('keeper-rescue-spend', 'rescue', () => {
      const b = k.state.budget, used = uint(b.day) === now / 86400n && b.drandRescueWei !== undefined ? uint(b.drandRescueWei) : 0n;
      return `drand rescue ${eth(used)} of ${eth(uint(c.drandRescueWeiPerDay))} today`;
    }),
    line('keeper-income', 'income', () => {
      const i = v.income, over = i.boxes.filter(b => uint(b.spentWei) + uint(i.unattributedWei) > uint(b.shareWei) + uint(b.tipsWei));
      return `${i.boxes.length} boxes, platform ${eth(uint(i.platformWei))}, unattributed ${eth(uint(i.unattributedWei))}`
        + (over.length ? `, over own room: ${over.map(b => b.box).join(' ')}` : '');
    }),
    line('drand', 'drand', () => {
      const open = v.drand.requests.filter(r => !r.usable);
      if (open.length === 0) return 'no request waiting for a word';
      const silent = open.filter(r => r.silent || now > uint(r.deadline)).length;
      const next = open.map(r => uint(r.deadline)).filter(d => d >= now).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[0];
      return `${open.length} waiting for a word` + (silent ? `, ${silent} silent` : '') + (next === undefined ? '' : `, next silent in ${span(next - now)}`);
    }),
    line('keeper-lock', 'lock', () => o.keeperLock.absent === true ? 'no refused keeper start'
      : 'start refused: see docs/ops/drand-poster.md, Leftover lock'),
    'reserve  needs the RPC balance: see the monitor run',
  ].join('\n') + '\n';
}

export function summarizeSet(o, c, now) {
  if (!c.keeperSetEnabled) return 'keeper-set: disabled\n';
  return `keeper-set ${c.keeperSetIdentity}\n` + evaluateSet(o, c, now)
    .map(r => `${r.id} ${r.status} ${r.reason}${r.detail ? `; ${r.detail}` : ''}`).join('\n') + '\n';
}

export async function main(args = process.argv.slice(2), env = process.env, ports = {}) {
  let c;
  const set = args[0] === '--set';
  if (set) args = args.slice(1);
  try {
    if (!(args.length === 0 || (args.length === 2 && args[0] === '--config'))) throw new Error('usage');
    c = configure(JSON.parse(await readFile(args[1] ?? env.SH_MONITOR_CONFIG ?? '/etc/squarehole/monitor.json', 'utf8')), env);
  } catch {
    process.stderr.write('keeper view: usage keeper-view.mjs [--set] [--config file]; configuration invalid or unreadable\n'); return 2;
  }
  const now = ports.now ?? BigInt(Math.floor(Date.now() / 1000)), f = ports.files ?? files, o = {};
  const inputs = set ? c.keeperSetEnabled ? [['keeperSetView', c.keeperSetViewFile], ['keeperSet', c.keeperSetFile]] : []
    : [['view', c.keeperViewFile], ['keeper', c.keeperFile]];
  for (const [id, path] of inputs) {
    try { o[id] = await f.json(path); } catch { /* Missing reads stay unknown. */ }
  }
  if (!set || c.keeperSetEnabled) {
    try { o[set ? 'keeperSetLock' : 'keeperLock'] = await keeperLock(`${set ? c.keeperSetFile : c.keeperFile}.lock-refused.json`, f.json); }
    catch { /* Unknown, as above. */ }
  }
  const text = set ? summarizeSet(o, c, now) + (c.keeperSetEnabled ? 'reserve needs the RPC balance: see the monitor run\n' : '') : summarize(o, c, now);
  (ports.write ?? (s => process.stdout.write(s)))(text);
  const checks = set ? SET_CHECKS.filter(id => id !== 'keeper-set-reserve') : KEEPER_CHECKS;
  return evaluate(o, c, now).filter(r => checks.includes(r.id)).every(r => r.status === 'ok') ? 0 : 1;
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await main();
