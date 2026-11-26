import { httpsUrl, requireValue, uint } from './config.mjs';
import { boundedRequest } from './collect.mjs';
import { readStages } from './drand-stages.mjs';

export const CONTRACT = Object.freeze({ silence: 604800n, unrequested: 2592000n, genesis: 1692803367n, period: 3n, ticketsRole: 7n,
  backupAfter: 432000n, latestStart: 496800n, recentBlocks: 8n, targetBlocks: 256n, historyWindow: 8191n });
export const START_INCLUSION_SECONDS = 96n;
export const SELECTORS = Object.freeze({ tickets: '0x21858521', boxCount: '0x44ff038f', roleOf: '0xfb1ae76e',
  status: '0x200d2ed2', source: '0x67e828bf', vault: '0xfbfa77cf', gateOpenedAt: '0xa9247102',
  failureWindowEnds: '0x98efb735', requestOf: '0x5a69c50b', wordOf: '0x2b3fb3a9', DRAND: '0xe323c2f2', backupOf: '0x80fc249c' });
const STATUS = ['minted', 'slots', 'wordRequestedAt', 'wordAcceptedAt', 'terminalAt', 'drawsRequested', 'drawsSettled'];
const ZERO = '0x' + '0'.repeat(40), BASELINE = '0x000000000000000000000000000000000000dEaD';
const address = value => { requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)); return value.toLowerCase(); };
const quantity = value => { requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)); return BigInt(value); };
export function encodeCall(name, args = []) {
  requireValue(Object.hasOwn(SELECTORS, name));
  return SELECTORS[name] + args.map(value => {
    const n = BigInt(value); requireValue(n >= 0n && n < 1n << 256n); return n.toString(16).padStart(64, '0');
  }).join('');
}
export function decodeReply(name, data) {
  const bits = name === 'status' ? [40, 32, 40, 40, 40, 32, 32]
    : name === 'requestOf' ? [64, 64] : name === 'wordOf' ? [256, 64] : name === 'backupOf' ? [64, 64, 64, 256] : [256];
  requireValue(typeof data === 'string' && new RegExp(`^0x[0-9a-fA-F]{${64 * bits.length}}$`).test(data));
  const words = bits.map((bits, i) => {
    const n = BigInt('0x' + data.slice(2 + i * 64, 66 + i * 64)); requireValue(n < 1n << BigInt(bits)); return String(n);
  });
  if (['tickets', 'roleOf', 'source', 'vault', 'DRAND'].includes(name)) {
    requireValue(BigInt(words[0]) < 1n << 160n); return address('0x' + data.slice(-40));
  }
  const keys = name === 'status' ? STATUS : name === 'requestOf' ? ['requestedAt', 'round']
    : name === 'backupOf' ? ['startedAt', 'targetBlock', 'fixedAt', 'mix'] : ['word', 'readyAt'];
  return bits.length === 1 ? words[0] : Object.fromEntries(keys.map((key, i) => [key, words[i]]));
}
class ReadLimit extends Error {}
const readReason = e => e instanceof ReadLimit ? 'read-time-limit' : 'read-failed';
const unknown = (reason, subject, detail = 'drand reads incomplete') => ({ status: 'unknown', reason, level: 'alert', ...(subject ? { subject } : {}), detail });
const usable = (k, timestamp) => uint(k.word) !== 0n && uint(k.readyAt) >= uint(k.requestedAt)
  && uint(k.readyAt) <= uint(timestamp) && uint(k.readyAt) <= uint(k.requestedAt) + CONTRACT.silence;
const sourceMatches = (t, c) => t.version === 1
  ? address(t.source) === c.drandBackedSource.toLowerCase() && t.drand?.toLowerCase() === c.drandSource.toLowerCase()
  : t.version === 2 && address(t.source) === c.drandSource.toLowerCase();

// One serial POST at a time: discovery, batched stages and the canary share 40 seconds from the run start.
export async function readDrand(c, env, snapshot, ports = {}) {
  const clock = ports.clock ?? Date.now, started = ports.started ?? clock(), request = ports.request ?? boundedRequest;
  const url = httpsUrl(env.SH_MONITOR_RPC_URL).href, block = '0x' + uint(snapshot.block).toString(16);
  const out = { timestamp: String(uint(snapshot.timestamp)), block: String(uint(snapshot.block)), consumers: [] };
  const size = Number(uint(c.rpcBatchSize)); let id = 0;
  const rpc = async calls => {
    const results = [];
    for (let offset = 0; offset < calls.length; offset += size) {
      if (clock() - started >= 40000) throw new ReadLimit();
      const batch = calls.slice(offset, offset + size).map(call => ({ jsonrpc: '2.0', id: ++id, ...call }));
      const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(size === 1 ? batch[0] : batch) });
      requireValue(r.status === 200);
      const json = JSON.parse(r.body), replies = size === 1 ? [json] : json;
      requireValue(Array.isArray(replies) && replies.length === batch.length);
      const byId = new Map(replies.map(reply => [reply?.id, reply]));
      requireValue(byId.size === batch.length);
      for (const call of batch) {
        const reply = byId.get(call.id); requireValue(reply?.jsonrpc === '2.0' && !Object.hasOwn(reply, 'error') && Object.hasOwn(reply, 'result'));
        results.push(reply.result);
      }
    }
    return results;
  };
  const call = (to, name, args = [], at = block) => ({ method: 'eth_call', params: [{ to, data: encodeCall(name, args) }, at] });
  const read = async specs => (await rpc(specs.map(([to, name, args, at]) => call(to, name, args, at))))
    .map((value, i) => decodeReply(specs[i][1], value));
  try {
    const [, , registry, coordinator] = c.keeperIdentity.split(':');
    if (coordinator) {
      const [tickets] = await read([[coordinator, 'tickets']]);
      if (tickets !== ZERO) out.consumers.push({ name: 'box 0', address: tickets, version: 1 });
    }
    if (registry) {
      const [count] = await read([[registry, 'boxCount']]);
      for (let first = 0n; first < uint(count); first += BigInt(size)) {
        const ids = []; for (let i = first; i < uint(count) && i < first + BigInt(size); i++) ids.push(i);
        const tickets = await read(ids.map(i => [registry, 'roleOf', [i, CONTRACT.ticketsRole]]));
        tickets.forEach((tickets, i) => { if (tickets !== ZERO) out.consumers.push({ name: `registry box ${ids[i]}`, address: tickets, version: 2 }); });
      }
    }
  } catch (e) {
    return { ...out, error: readReason(e), canary: unknown(readReason(e)) };
  }
  await readStages(c, out, read, size, readReason);
  const unfixed = out.consumers.filter(t => !t.error && t.version === 1
    && Object.values(t.backups ?? {}).some(b => uint(b.startedAt) !== 0n && uint(b.fixedAt) === 0n));
  if (unfixed.length) {
    try {
      const [reply] = await rpc([{ method: 'eth_blockNumber', params: [] }]);
      if (clock() - started >= 40000) throw new ReadLimit();
      const latest = quantity(reply); requireValue(latest >= uint(out.block));
      out.latestBlock = String(latest);
    } catch (e) { for (const t of unfixed) t.error = readReason(e); }
  }
  // Acceptance proves key 0 was usable even if no unsettled keys are being read this run.
  let target = out.consumers.find(t => !t.error && uint(t.status.wordAcceptedAt) !== 0n);
  let key = '0';
  if (!target) for (const t of out.consumers) {
    const k = !t.error && t.keys.find(k => usable(k, out.timestamp));
    if (k) { target = t; key = k.key; break; }
  }
  if (!target) {
    out.canary = out.consumers.some(t => t.error) ? unknown(out.consumers.find(t => t.error).error)
      : { status: 'ok', reason: 'no-posted-word' };
    return out;
  }
  try {
    const [code] = await rpc([{ method: 'eth_getCode', params: [BASELINE, 'latest'] }]); requireValue(code === '0x');
    const data = encodeCall('wordOf', [target.address, key]);
    const estimates = await rpc([target.source, BASELINE].map(to => ({ method: 'eth_estimateGas', params: [{ to, data }, 'latest'] })));
    const gas = quantity(estimates[0]) - quantity(estimates[1]); requireValue(gas > 0n);
    const high = gas >= uint(c.wordOfGasAlert);
    out.canary = { status: high ? 'alert' : 'ok', reason: high ? 'wordof-gas-high' : 'healthy', ...(high ? { level: 'alert' } : {}),
      detail: `${target.name} tickets ${target.address} key ${key} wordOf execution ${gas} gas` };
  } catch (e) { out.canary = unknown(readReason(e)); }
  return out;
}
const utc = seconds => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
const remaining = (end, now) => {
  const minutes = (end > now ? end - now : 0n) / 60n;
  return `${minutes / 1440n} d ${minutes / 60n % 24n} h ${minutes % 60n} min left (deadline ${utc(end)})`;
};
// Read keys are unsettled. One fix serves a round, so a later request cannot extend its deadline.
const roundDeadline = (t, k) => t.keys.filter(other => other.round === k.round)
  .reduce((at, other) => uint(other.requestedAt) < at ? uint(other.requestedAt) : at, uint(k.requestedAt)) + CONTRACT.silence;
function rung(elapsed, times, levels, unrequested = false) {
  const steps = times.split(',').map(uint), index = steps.findLastIndex(at => elapsed >= at);
  if (index < 0) return null;
  const n = steps[index];
  // The requested ladder calls its day-one rung 24h; the graduation ladder calls it 1d.
  const label = n % 86400n === 0n && (unrequested || n > 86400n) ? `${n / 86400n}d`
    : n % 3600n === 0n ? `${n / 3600n}h` : `${n}s`;
  return { reason: (unrequested ? 'unrequested-' : '') + label, level: levels.split(',')[index] };
}
/**
 * R62-FEE as the keeper admits it (packages/keeper/src/drand-fee.ts), from finalized state and latest fix-window height: the drand work
 * whose deadline is strictly less than `drandRescueWindowSeconds` away, nearest first, or null. A post (an unposted
 * round, also not posted at latest) counts only up to its deadline; a timely word never expires, so an accept
 * waits at the ordinary fee ceiling; a missing graduation request counts after its 30 days too, since a late request still saves the box.
 * Box 0 also counts backupStart and backupFix with the keeper's 96-second inclusion margin and 8-block proof margin.
 * Like the keeper, nothing counts for terminal tickets, another source, a failed read or behind a silent head.
 */
export function rescueWork(data, c, now) {
  const window = uint(c.drandRescueWindowSeconds);
  if (window === 0n || !data || data.error || !Array.isArray(data.consumers)) return null;
  let best = null;
  const consider = (t, key, end, what) => {
    if (end - now < window && (what === 'request the word' || now <= end) && (best === null || end < best.end)) {
      best = { what, name: t.name, address: address(t.address), key, end, left: remaining(end, now) };
    }
  };
  for (const t of data.consumers) {
    if (t.error || uint(t.status.terminalAt) !== 0n || !sourceMatches(t, c)) continue;
    const s = t.status, head = t.keys[0];
    if (head && !usable(head, data.timestamp) && (now > uint(head.requestedAt) + CONTRACT.silence
      || (uint(head.word) !== 0n && uint(head.readyAt) > uint(head.requestedAt) + CONTRACT.silence))) continue;
    const gate = t.version === 2 && uint(t.failureWindowEnds) !== 0n ? uint(t.failureWindowEnds) : uint(t.gateOpenedAt);
    if (uint(s.slots) !== 0n && s.wordAcceptedAt === '0' && s.wordRequestedAt === '0' && gate !== 0n) {
      consider(t, '0', gate + CONTRACT.unrequested, 'request the word');
    }
    for (const k of t.keys) {
      const end = uint(k.requestedAt) + CONTRACT.silence;
      if (!usable(k, data.timestamp)) {
        const backup = t.version === 1 ? t.backups[k.round] : null;
        if (backup && uint(backup.startedAt) !== 0n) {
          const target = uint(backup.targetBlock), block = uint(data.block);
          const earliest = roundDeadline(t, k);
          if (uint(backup.fixedAt) === 0n && end === earliest && target <= block
            && uint(data.latestBlock) - target <= CONTRACT.historyWindow - CONTRACT.recentBlocks && now + START_INCLUSION_SECONDS <= end) {
            consider(t, k.key, end, 'fix the backup');
          }
        } else if (uint(k.word) === 0n && uint(k.latestWord ?? '0') === 0n) {
          consider(t, k.key, end, 'post');
          const roundTime = CONTRACT.genesis + (uint(k.round) - 1n) * CONTRACT.period;
          const latestStart = roundTime + CONTRACT.latestStart;
          if (backup && now <= end && roundTime + CONTRACT.backupAfter < now && now + START_INCLUSION_SECONDS <= latestStart) {
            consider(t, k.key, latestStart, 'start the backup');
          }
        }
      }
    }
  }
  return best;
}
// A round has one committed target. Emit only its most urgent current backup state for each unsettled key.
function backupRow(t, k, data, c, now) {
  if (t.version !== 1 || !sourceMatches(t, c)) return null;
  const s = t.status, key = uint(k.key);
  if (key === 0n ? s.wordAcceptedAt !== '0' : key <= uint(s.drawsSettled) || key > uint(s.drawsRequested)) return null;
  const b = t.backups[k.round], at = uint(k.requestedAt);
  const roundTime = CONTRACT.genesis + (uint(k.round) - 1n) * CONTRACT.period;
  const block = uint(data.block), target = uint(b.targetBlock), started = uint(b.startedAt), fixed = uint(b.fixedAt);
  const end = started !== 0n && fixed === 0n ? roundDeadline(t, k) : at + CONTRACT.silence;
  let reason, level = 'emergency', detail;
  if (fixed !== 0n) {
    reason = 'backup-fixed'; level = 'warn';
    detail = `backup fixed ${utc(fixed)}, word ready ${fixed <= end && fixed >= at ? 'within' : 'after'} the deadline (readyAt ${utc(fixed)})`;
  } else if (started !== 0n) {
    // Past the keeper's last fix block (8 blocks inside EIP-2935's window) or inside its 96 s before the deadline, the
    // keeper ("box 0 backup fix window closed") and the second poster send no fix, as rescueWork no longer counts one.
    if (uint(data.latestBlock) - target > CONTRACT.historyWindow - CONTRACT.recentBlocks || now + START_INCLUSION_SECONDS > end) {
      reason = 'backup-fix-window-closed';
      detail = 'backup fix window closed; the keeper and the second poster send no fix, and a drand post no longer counts for this round';
    } else if (block >= target + uint(c.drandBackupFixClosingBlocks)) {
      reason = 'backup-fix-window-closing'; detail = 'backup fix window closing; fix immediately';
    } else if (block >= target + uint(c.drandBackupFixGraceBlocks)) {
      reason = 'backup-fix-due'; detail = 'backup fix due; target is final and still not fixed';
    } else {
      reason = 'backup-started'; level = 'critical'; detail = `backup started, fix due after block ${target} is final`;
    }
  } else {
    if (uint(k.word) !== 0n || uint(k.latestWord) !== 0n || now > end || now <= roundTime + CONTRACT.backupAfter) return null;
    const latest = roundTime + CONTRACT.latestStart, left = latest - now;
    if (now > latest) {
      reason = 'backup-start-missed'; detail = `backup start missed; only a drand post before ${utc(end)} still saves the key`;
    } else {
      const step = c.drandBackupStartLadder.split(',').map(uint).findLast(seconds => left <= seconds);
      reason = step === undefined ? 'backup-can-start' : `backup-latest-start-${step % 3600n === 0n ? `${step / 3600n}h` : `${step}s`}`;
      detail = step === undefined ? `backup can start until ${utc(latest)}, ${left / 3600n} h left`
        : `latest start in ${left / 3600n} h ${left / 60n % 60n} min (until ${utc(latest)})`;
    }
  }
  return { reason, level, detail: `${t.name} tickets ${address(t.address)} key ${k.key} round ${k.round} (round time ${utc(roundTime)}), `
    + `requested ${utc(at)}, finalized block ${block}`
    + (started !== 0n && fixed === 0n ? `, latest block ${data.latestBlock}` : '') + `; ${detail}`
    + (started === 0n ? '' : `; started ${utc(started)}, target block ${target}, window last block ${target + CONTRACT.historyWindow}`)
    + `; ${remaining(end, now)}; see docs/runbooks/monitoring.md, Box 0 backup` };
}
export function ladder(data, c, now) {
  requireValue(data && Array.isArray(data.consumers));
  if (data.error) return [{ id: 'drand-words', ...unknown(data.error) }];
  uint(data.timestamp);
  const rows = [], add = (t, reason, level, detail, key) => rows.push({ id: 'drand-words', status: 'alert', reason, level,
    subject: t.address.toLowerCase() + (key === undefined ? '' : `:${key}`), detail });
  for (const t of data.consumers) {
    const prefix = `${t.name} tickets ${address(t.address)}`;
    if (t.error) { rows.push({ id: 'drand-words', ...unknown(t.error, t.address, `${prefix}: ${t.error}`) }); continue; }
    const s = t.status;
    if (uint(s.terminalAt) !== 0n) { add(t, 'terminal-mode', 'alert', `${prefix}: terminal mode since ${utc(uint(s.terminalAt))}`); continue; }
    if (!sourceMatches(t, c)) add(t, 'source-mismatch', 'critical', `${prefix}: source ${t.source}` + (t.version === 1
      ? `; expected backed source ${c.drandBackedSource} with DRAND ${c.drandSource} (read ${t.drand ?? 'not read'})` : ' differs from configured drand source'));
    if (uint(t.skipped) > 0n) add(t, 'keys-not-read', 'alert', `${prefix}: ${t.skipped} keys not read (drandMaxKeys ${c.drandMaxKeys})`);
    const gate = t.version === 2 && uint(t.failureWindowEnds) !== 0n ? uint(t.failureWindowEnds) : uint(t.gateOpenedAt);
    if (uint(s.slots) !== 0n && s.wordAcceptedAt === '0' && s.wordRequestedAt === '0' && gate !== 0n) {
      const end = gate + CONTRACT.unrequested;
      const step = now > end ? { reason: 'unrequested-past-30d', level: 'emergency' } : rung(now - gate, c.drandUnrequestedLadder, c.drandUnrequestedLevels, true);
      if (step) add(t, step.reason, step.level,
        `${prefix} key 0 round not requested (round time not requested), requested not requested, graduation clock ${utc(gate)}; ${remaining(end, now)}`
        + (now > end ? '; one requestGraduationWord() still saves the box until someone calls enterTerminal' : ''), '0');
    }
    for (const k of t.keys) {
      const backup = backupRow(t, k, data, c, now);
      if (backup) add(t, backup.reason, backup.level, backup.detail, k.key);
      if (usable(k, data.timestamp)) continue;
      const at = uint(k.requestedAt), end = at + CONTRACT.silence;
      const roundTime = CONTRACT.genesis + (uint(k.round) - 1n) * CONTRACT.period;
      const finalizing = now > end && uint(k.word) === 0n && uint(k.latestWord ?? '0') !== 0n
        && uint(k.latestReadyAt) >= at && uint(k.latestReadyAt) <= end;
      let step = finalizing ? { reason: 'posted-awaiting-finality', level: 'emergency' } : now > end || (uint(k.word) !== 0n && uint(k.readyAt) > end) ? { reason: 'past-deadline', level: 'emergency' }
        : rung(now - at, c.drandLadder, c.drandLadderLevels);
      if (!step && now >= roundTime + uint(c.drandLagSeconds) && uint(k.word) === 0n && uint(k.latestWord) === 0n) step = { reason: 'round+15m', level: 'warn' };
      if (step) add(t, step.reason, step.level,
        `${prefix} key ${k.key} round ${k.round} (round time ${utc(roundTime)}), requested ${utc(at)}, `
        + `${uint(k.word) === 0n ? 'not posted at the finalized block' : 'word not usable at the finalized block'}; `
        + (finalizing ? `latest readyAt ${utc(uint(k.latestReadyAt))}; word counts once final; ` : '') + remaining(end, now), k.key);
    }
  }
  return rows.length ? rows : [{ id: 'drand-words', status: 'ok', reason: 'healthy' }];
}
