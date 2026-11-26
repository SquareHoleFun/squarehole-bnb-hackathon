import { decimal, requireValue, uint } from './config.mjs';

export const SET_CHECKS = ['health', 'spend', 'reserve', 'queue', 'fee', 'lock', 'filled'].map(k => `keeper-set-${k}`);
const verdict = (ok, reason) => ({ status: ok ? 'ok' : 'alert', reason: ok ? 'healthy' : reason });

/** Separate identities, files, budget and incident IDs. No drand or income policy applies to set lifecycle jobs. */
export function evaluateSet(o, c, now) {
  if (!c.keeperSetEnabled) return [];
  const results = [];
  const test = (name, fn) => {
    const id = `keeper-set-${name}`;
    try { const rows = fn(); results.push(...(Array.isArray(rows) ? rows : [rows]).map(r => ({ ...r, id }))); }
    catch { results.push({ id, status: 'unknown', reason: 'missing-stale-or-invalid-data' }); }
  };
  const fresh = at => uint(at) <= now && now - uint(at) <= uint(c.maxSnapshotAgeSeconds);
  const view = () => {
    const v = o.keeperSetView;
    requireValue(v.schema === 'squarehole.monitor-keeper-set.v1' && v.chainId === c.chainId
      && v.identity === c.keeperSetIdentity && v.complete === true && fresh(v.observedAt));
    uint(v.block); return v;
  };
  const budget = () => {
    const k = o.keeperSet;
    requireValue(k.version === 1 && k.identity === c.keeperSetIdentity && fresh(k.modifiedAt));
    const b = k.state.budget, day = uint(b.day), ours = uint(b.oursWei), pokes = uint(b.pokesWei), total = uint(b.totalWei);
    requireValue(day <= now / 86400n && total >= ours + pokes);
    return day === now / 86400n ? { ours, pokes, total } : { ours: 0n, pokes: 0n, total: 0n };
  };
  test('health', () => { view(); budget(); return verdict(true); });
  test('spend', () => {
    const b = budget();
    const cap = k => uint(c[`keeperSet${k[0].toUpperCase()}${k.slice(1)}WeiPerDay`]);
    return { ...verdict(['ours', 'pokes', 'total'].every(k => b[k] * 100n < cap(k) * uint(c.spendWarnPercent)), 'daily-budget-near-or-over-limit'),
      detail: ['ours', 'pokes', 'total'].map(k => `${k} ${decimal(b[k], 18, 6)} of ${decimal(cap(k), 18, 6)} ETH today`).join(', ') };
  });
  test('reserve', () => {
    const b = budget(), rpc = o.keeperSetRpc;
    requireValue(rpc.chainId === c.chainId && uint(rpc.timestamp) <= now
      && now - uint(rpc.timestamp) <= uint(c.maxFinalizedAgeSeconds));
    const reserve = uint(c.keeperSetReserveWeiPerDay);
    return verdict(uint(rpc.balanceWei) >= reserve && uint(c.keeperSetOursWeiPerDay) - b.ours > reserve
      && uint(c.keeperSetTotalWeiPerDay) - b.total > reserve, 'protected-reserve-low');
  });
  test('queue', () => {
    const v = view(), count = uint(v.queue.count);
    requireValue(count === 0n ? v.queue.oldestBlock === null : uint(v.queue.oldestBlock) <= uint(v.block));
    return verdict(count < uint(c.queueCount) && (count === 0n || uint(v.block) - uint(v.queue.oldestBlock) < uint(c.queueAgeBlocks)), 'queue-backlog');
  });
  test('fee', () => verdict(uint(view().maxFeePerGasWei) <= uint(c.keeperSetMaxFeePerGasWei), 'fee-pause'));
  test('lock', () => {
    const l = o.keeperSetLock;
    if (l.absent === true) return verdict(true);
    const { modifiedAt, ...r } = l.record;
    requireValue(Object.keys(r).sort().join() === 'at,lockStartedAt,schema' && r.schema === 'squarehole.keeper-lock-refused.v1');
    uint(modifiedAt); uint(r.at); if (r.lockStartedAt !== null) uint(r.lockStartedAt);
    return { status: 'alert', reason: 'lock-refused', level: 'critical',
      detail: `keeper-set start refused at ${r.at}; inspect only the set instance's journal lock before restarting` };
  });
  test('filled', () => {
    const v = view(), waiting = [], seen = new Set();
    requireValue(Array.isArray(v.sets));
    for (const s of v.sets) {
      uint(s.id);
      requireValue(/^0x[0-9a-f]{40}$/.test(s.coordinator) && !seen.has(s.coordinator)); seen.add(s.coordinator);
      requireValue(['closed', 'graduated', 'failed'].every(k => typeof s[k] === 'boolean') && !(s.graduated && s.failed));
      const closedAt = uint(s.closedAt);
      requireValue(s.closed ? closedAt > 0n && closedAt <= uint(v.observedAt) : closedAt === 0n);
      if (s.closed && !s.graduated && !s.failed) {
        const age = now - closedAt, remaining = age >= 604800n ? 0n : 604800n - age;
        waiting.push({ age, subject: s.coordinator, detail: `set ${s.id} ${s.coordinator}: closedAt ${closedAt}; age ${age} s; remaining escape ${remaining} s` });
      }
    }
    if (!waiting.length) return verdict(true);
    return waiting.sort((a, b) => a.age > b.age ? -1 : a.age < b.age ? 1 : 0).map(s => ({ status: 'alert',
      reason: s.age >= 604800n ? 'escape-reached' : s.age >= 3600n ? 'filled-over-one-hour' : 'filled-ungraduated',
      level: s.age >= 604800n ? 'emergency' : s.age >= 3600n ? 'critical' : 'warn', subject: s.subject, detail: s.detail }));
  });
  return results;
}
