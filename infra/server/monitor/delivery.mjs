import { requireValue, uint } from './config.mjs';
import { createHash } from 'node:crypto';
export function validateState(state) {
  requireValue(state?.version === 1 && state.channels && typeof state.channels === 'object' && !Array.isArray(state.channels));
  for (const [name, row] of Object.entries(state.channels)) {
    requireValue(/^[a-z][a-z0-9-]{0,30}$/.test(name) && typeof row.signature === 'string' && row.signature.length <= 4096);
    uint(row.notifiedAt); uint(row.lastClearDay);
  }
  return state;
}
const rank = row => Math.max(row.status === 'unknown' ? 1 : 0, ['warn', 'alert', 'critical', 'emergency'].indexOf(row.level ?? 'alert'));
const left = row => {
  const m = /(\d+) d (\d+) h (\d+) min left/.exec(row.detail ?? '');
  return m ? BigInt(m[1]) * 1440n + BigInt(m[2]) * 60n + BigInt(m[3]) : null;
};
export function render(report, event, now) {
  const rows = report.filter(x => x.status !== 'ok').sort((a, b) => {
    const severity = rank(b) - rank(a);
    if (severity) return severity;
    const x = left(a), y = left(b);
    return x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
  });
  if (event === 'ALERT' && rows.length) event = ['WARN', 'ALERT', 'CRITICAL', 'EMERGENCY'][rank(rows[0])];
  let text = `Square Hole monitor: ${event}\nUTC ${new Date(Number(now) * 1000).toISOString()}\n`;
  if (!rows.length) return text + 'All configured checks passed.';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], line = `${row.id}: ${row.status} (${row.reason})` + (row.detail ? `\n${row.detail.replace(/[\r\n]/g, ' ')}` : '');
    const suffix = i + 1 < rows.length ? `\n... and ${rows.length - i - 1} more rows` : '';
    if (text.length + line.length + suffix.length > 3800) return text + `... and ${rows.length - i} more rows`;
    text += line + (i + 1 < rows.length ? '\n' : '');
  }
  return text;
}
// Plugin contract: a stable channel id -> async send(message). Resolve only after remote acceptance.
// Persist success per channel, not per run. Ambiguous delivery/crash can duplicate; never suppress an unacknowledged alert.
export async function dispatch(report, state, senders, now, cfg, save) {
  validateState(state); requireValue(Object.keys(senders).length > 0 && report.length > 0);
  const failing = report.filter(x => x.status !== 'ok');
  const joined = failing.map(x => `${x.id}:${x.status}:${x.reason}${x.subject === undefined ? '' : ':' + x.subject}`).sort().join('|');
  const signature = joined.length > 4096 ? 'sha256:' + createHash('sha256').update(joined).digest('hex') : joined;
  const repeat = failing.reduce((min, row) => {
    const seconds = uint(row.level === 'emergency' ? cfg.emergencyRepeatSeconds : row.level === 'critical' ? cfg.criticalRepeatSeconds : cfg.repeatSeconds);
    return min === null || seconds < min ? seconds : min;
  }, null);
  const day = String(now / 86400n), failures = [];
  for (const [name, send] of Object.entries(senders)) {
    const old = state.channels[name];
    let event;
    if (signature) {
      if (!old || old.signature !== signature || now < uint(old.notifiedAt) || now - uint(old.notifiedAt) >= repeat) event = 'ALERT';
    } else if (old?.signature) event = 'RECOVERY';
    else if (!old || old.lastClearDay !== day) event = 'ALL CLEAR';
    if (!event) continue;
    try { await send(render(report, event, now)); } catch { failures.push(name); continue; }
    const next = { ...state, channels: { ...state.channels, [name]: { signature, notifiedAt: String(now), lastClearDay: signature ? old?.lastClearDay ?? '0' : day } } };
    await save(next); state.channels = next.channels;
  }
  return failures;
}
