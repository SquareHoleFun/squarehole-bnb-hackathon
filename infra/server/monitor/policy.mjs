import { decimal, requireValue, uint } from './config.mjs';
import { ladder, rescueWork } from './drand.mjs';
import { evaluateSet } from './keeper-set.mjs';
export const LANDING_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=86400', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
});
const age = (at, now, max) => uint(at) <= now && now - uint(at) <= max;
const edge = h => h.server?.toLowerCase() === 'cloudflare' && typeof h['cf-ray'] === 'string' && h['cf-ray'].length > 0;
const matches = (h, expected) => Object.entries(expected).every(([k, v]) => h[k] === v);
const verdict = (ok, reason) => ({ status: ok ? 'ok' : 'alert', reason: ok ? 'healthy' : reason });
const eth = w => `${decimal(w, 18, 6)} ETH`, gwei = w => `${decimal(w, 9, 3)} gwei`;
const utc = s => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');
const LOCK_REFUSED = 'squarehole.keeper-lock-refused.v1';
export function evaluate(o, c, now) {
  const results = [];
  const test = (id, fn) => {
    try {
      const value = fn();
      results.push(...(Array.isArray(value) ? value : [value]).map(row => ({ ...row, id })));
    }
    catch { results.push({ id, status: 'unknown', reason: 'missing-stale-or-invalid-data' }); }
  };
  const view = () => {
    const v = o.view;
    requireValue(v.schema === 'squarehole.monitor-keeper.v1' && v.chainId === c.chainId && v.identity === c.keeperIdentity
      && v.complete === true && age(v.observedAt, now, uint(c.maxSnapshotAgeSeconds)));
    uint(v.block); return v;
  };
  const budget = () => {
    const k = o.keeper;
    requireValue(k.version === 1 && k.identity === c.keeperIdentity && age(k.modifiedAt, now, uint(c.maxSnapshotAgeSeconds)));
    const b = k.state.budget;
    const day = uint(b.day), ours = uint(b.oursWei), pokes = uint(b.pokesWei), total = uint(b.totalWei);
    requireValue(day <= now / 86400n && total >= ours + pokes);
    return day === now / 86400n ? { ours, pokes, total } : { ours: 0n, pokes: 0n, total: 0n };
  };
  // R62-FEE's own counter, outside ours, pokes and total: the same journal rules, and zero before rc8 or on a new day.
  const rescueSpent = () => {
    budget(); const raw = o.keeper.state.budget.drandRescueWei;
    const spent = raw === undefined ? 0n : uint(raw);
    return uint(o.keeper.state.budget.day) === now / 86400n ? spent : 0n;
  };
  // While R62 lets the keeper's drand jobs pay this fee (inside their window, up to the rescue maximum, with room in
  // today's rescue allowance), the fee is not a pause for them. Any unreadable part keeps the F111 pause.
  const rescueFee = fee => {
    try {
      const cap = uint(c.drandRescueWeiPerDay), spent = rescueSpent(), work = rescueWork(o.drand, c, now);
      if (cap === 0n || fee > uint(c.drandRescueMaxFeeWei) || spent >= cap || !work) return null;
      return { status: 'alert', reason: 'drand-rescue-fee', level: 'warn', detail: `max fee ${gwei(fee)} above the `
        + `${gwei(uint(c.maxFeePerGasWei))} pause: ordinary jobs wait; R62 lets the keeper ${work.what} for ${work.name} tickets `
        + `${work.address} key ${work.key} at up to ${gwei(uint(c.drandRescueMaxFeeWei))}, ${work.left}; rescue spend `
        + `${eth(spent)} of ${eth(cap)} today` };
    } catch { return null; }
  };
  test('landing', () => verdict(o.landing.status === 200 && edge(o.landing.headers)
    && matches(o.landing.headers, { ...LANDING_HEADERS, 'cache-control': 'no-cache' })
    && o.landing.headers['content-type']?.startsWith('text/html') && /<title>Square Hole/i.test(o.landing.body), 'response-or-headers'));
  test('api', () => verdict(o.api.status === 200 && edge(o.api.headers) && matches(o.api.headers, {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': c.origin,
  }) && o.api.headers.vary?.toLowerCase().split(/,\s*/).includes('origin')
    && o.api.body.ok === true && o.api.body.following === true && o.api.body.history?.ok === true, 'response-or-headers'));
  test('indexer', () => verdict(o.rpc.chainId === c.chainId && o.feed.status === 200 && String(o.feed.body.chainId) === c.chainId
    && age(o.rpc.timestamp, now, uint(c.maxFinalizedAgeSeconds))
    && age(o.api.body.asOf.timestamp, now, uint(c.maxHeadAgeSeconds))
    && uint(o.api.body.asOf.block) + uint(c.maxLagBlocks) >= uint(o.rpc.block)
    && uint(o.api.body.asOf.block) <= uint(o.rpc.block) + uint(c.maxAheadBlocks), 'chain-head-or-finality'));
  test('keeper-spend', () => {
    const b = budget();
    return verdict(['ours', 'pokes', 'total'].every(k => b[k] * 100n < uint(c[`${k}WeiPerDay`]) * uint(c.spendWarnPercent)), 'daily-budget-near-or-over-limit');
  });
  if (c.alphaApiEnabled) {
    const alpha = () => {
      const a = o.alphaApi;
      requireValue(a.v === 1 && a.service === 'alpha-api' && Number.isSafeInteger(a.at) && a.at >= 0
        && age(String(BigInt(a.at) / 1000n), now, uint(c.maxSnapshotAgeSeconds))
        && age(a.modifiedAt, now, uint(c.maxSnapshotAgeSeconds)));
      for (const k of ['pending', 'approved', 'cap', 'claimsWaiting', 'oldestActiveWaitSeconds', 'recentFailures'])
        requireValue(Number.isSafeInteger(a[k]) && a[k] >= 0);
      requireValue(a.cap > 0); return a;
    };
    test('alpha-backup', () => verdict(age(o.alphaBackup.modifiedAt, now, uint(c.maxBackupAgeSeconds)), 'alpha-backup-too-old-or-future'));
    test('alpha-api', () => {
      alpha();
      return verdict(o.alphaApiHealth.status === 200 && o.alphaApiHealth.body.ok === true
        && o.alphaApiHealth.headers['cache-control'] === 'no-store', 'alpha-api-unhealthy');
    });
    test('alpha-signups', () => {
      const a = alpha(), used = a.pending + a.approved;
      return { ...verdict(BigInt(used) * 100n < BigInt(a.cap) * 80n, 'signup-cap-near-or-reached'), level: 'warn',
        detail: `${used} accounts of ${a.cap}; ${a.pending} pending, ${a.approved} approved` };
    });
    test('alpha-queue', () => {
      const a = alpha();
      return { ...verdict(BigInt(a.oldestActiveWaitSeconds) <= uint(c.alphaQueueAgeSeconds), 'claim-wait-too-old'),
        detail: `${a.claimsWaiting} claims waiting; oldest active wait ${a.oldestActiveWaitSeconds}s (float pauses excluded)` };
    });
    test('alpha-claim-failures', () => {
      const a = alpha();
      return { ...verdict(BigInt(a.recentFailures) < uint(c.alphaFailureCount), 'repeated-claim-failures'),
        detail: `${a.recentFailures} failed or refused claims in the last hour` };
    });
  }
  if (c.alphaSenderEnabled) test('alpha-sender-float', () => {
    const s = o.alphaSender;
    requireValue(s.v === 1 && s.service === 'alpha-sender' && ['live', 'dry-run'].includes(s.mode)
      && Number.isSafeInteger(s.at) && s.at >= 0 && age(String(BigInt(s.at) / 1000n), now, uint(c.maxSnapshotAgeSeconds))
      && age(s.modifiedAt, now, uint(c.maxSnapshotAgeSeconds))
      && Number.isSafeInteger(s.waitingClaims) && s.waitingClaims >= 0);
    const balance = uint(s.floatWei), threshold = uint(s.lowFloatThresholdWei);
    requireValue(threshold > 0n && s.lowFloat === (balance < threshold || s.waitingClaims > 0));
    return { ...verdict(!s.lowFloat, 'low-float'), detail: `alpha sender ${s.mode}: ${s.waitingClaims} waiting claims; `
      + `float ${s.floatWei} wei; refill threshold ${s.lowFloatThresholdWei} wei` };
  });
  test('keeper-reserve', () => {
    const b = budget(); requireValue(o.rpc.chainId === c.chainId);
    return verdict(uint(o.rpc.balanceWei) >= uint(c.reserveWeiPerDay)
      && uint(c.oursWeiPerDay) - b.ours > uint(c.reserveWeiPerDay)
      && uint(c.totalWeiPerDay) - b.total > uint(c.reserveWeiPerDay), 'protected-reserve-low');
  });
  test('keeper-queue', () => {
    const v = view(), count = uint(v.queue.count);
    requireValue(count === 0n ? v.queue.oldestBlock === null : uint(v.queue.oldestBlock) <= uint(v.block));
    return verdict(count < uint(c.queueCount) && (count === 0n || uint(v.block) - uint(v.queue.oldestBlock) < uint(c.queueAgeBlocks)), 'queue-backlog');
  });
  test('keeper-fee', () => {
    const fee = uint(view().maxFeePerGasWei);
    return fee <= uint(c.maxFeePerGasWei) ? verdict(true) : rescueFee(fee) ?? verdict(false, 'fee-pause');
  });
  test('keeper-rescue-spend', () => {
    const spent = rescueSpent(), cap = uint(c.drandRescueWeiPerDay);
    // The keeper's own lines: 'drand rescue allowance half used' at 50%, 'mostly used' at 80% (run.ts).
    const step = spent === 0n ? null : spent * 100n >= cap * 80n ? ['drand-rescue-mostly-used', 'critical']
      : spent * 100n >= cap * 50n ? ['drand-rescue-half-used', 'alert'] : null;
    return step ? { status: 'alert', reason: step[0], level: step[1],
      detail: `keeper drand rescue spend ${eth(spent)} of ${eth(cap)} today (R62, outside the ordinary daily ceilings)` } : verdict(true);
  });
  test('keeper-lock', () => {
    const l = o.keeperLock;
    if (l.absent === true) return verdict(true);
    const { modifiedAt, ...r } = l.record;
    requireValue(Object.keys(r).sort().join() === 'at,lockStartedAt,schema' && r.schema === LOCK_REFUSED);
    const at = uint(r.at), started = r.lockStartedAt === null ? null : uint(r.lockStartedAt);
    uint(modifiedAt);
    return { status: 'alert', reason: 'lock-refused', level: 'critical', detail: `keeper start refused at ${utc(at)}: a leftover `
      + (started === null ? 'pid-only state lock (start time unknown)' : `state lock from ${utc(started)}`)
      + '; see docs/ops/drand-poster.md, Leftover lock' };
  });
  test('keeper-income', () => {
    const i = view().income; requireValue(Array.isArray(i.boxes));
    let total = uint(i.unattributedWei), tips = 0n, ownOk = true;
    const seen = new Set();
    for (const b of i.boxes) {
      requireValue(/^0x[0-9a-f]{40}$/.test(b.box) && !seen.has(b.box)); seen.add(b.box);
      const spent = uint(b.spentWei), tip = uint(b.tipsWei);
      total += spent; tips += tip;
      ownOk &&= spent + uint(i.unattributedWei) <= uint(b.shareWei) + tip;
    }
    return verdict(ownOk && uint(i.unattributedWei) === 0n && total <= uint(i.platformWei) / 4n + tips, 'income-cap-or-unattributed-liability');
  });
  test('drand', () => {
    const d = view().drand; requireValue(d.complete === true && Array.isArray(d.requests));
    let near = false, silent = false;
    for (const r of d.requests) {
      const at = uint(r.requestedAt), end = uint(r.deadline);
      requireValue(at > 0n && at <= now && end === at + 604800n && typeof r.usable === 'boolean' && typeof r.silent === 'boolean');
      requireValue(!(r.usable && r.silent));
      if (!r.usable) { near ||= now + 86400n >= end; silent ||= r.silent || now > end; }
    }
    return verdict(!near && !silent, silent ? 'silent' : 'nearing-silence');
  });
  test('burn-journal', () => {
    const j = o.journal, stamp = j.record.recordedUtc;
    requireValue(typeof stamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(stamp));
    const ms = Date.parse(stamp); requireValue(Number.isFinite(ms));
    const at = BigInt(ms) / 1000n;
    return verdict(j.record.chainId === c.chainId && at <= now && at / 86400n === now / 86400n
      && uint(j.modifiedAt) <= now && uint(j.modifiedAt) / 86400n === now / 86400n, 'journal-not-written-today');
  });
  for (const id of ['disk', 'memory']) test(id, () => {
    const total = uint(o[id].total), available = uint(o[id].available);
    requireValue(total > 0n && available <= total);
    return verdict((total - available) * 100n < total * uint(c[`${id}UsedPercent`]), 'capacity-low');
  });
  test('backup', () => verdict(age(o.backup.modifiedAt, now, uint(c.maxBackupAgeSeconds)), 'backup-too-old-or-future'));
  test('drand-words', () => ladder(o.drand, c, now));
  test('drand-canary', () => {
    const row = o.drand.canary;
    requireValue(row && ['ok', 'alert', 'unknown'].includes(row.status) && typeof row.reason === 'string');
    return row;
  });
  test('heartbeat', () => {
    const h = o.heartbeat;
    requireValue(typeof h.configured === 'boolean' && typeof h.valid === 'boolean');
    return verdict(h.configured && h.valid, h.configured ? 'heartbeat-invalid' : 'heartbeat-not-configured');
  });
  return [...results, ...evaluateSet(o, c, now)];
}
