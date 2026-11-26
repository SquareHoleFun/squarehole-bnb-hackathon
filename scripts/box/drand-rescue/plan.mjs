import { SIGNATURES } from './abi.mjs';
import { BACKUP_AFTER, LATEST_START, HISTORY_WINDOW, RECENT_BLOCKS } from './quicknet.mjs';

/** Typed actions are the extension point; each builder owns its arguments, destination and deadline. */
export function requestAction(ticket) {
  return { kind: 'request', id: `request:${ticket.address}`, to: ticket.address,
    functionName: 'requestGraduationWord', signature: SIGNATURES.request, args: [], deadline: ticket.requestDeadline,
    refs: [{ tickets: ticket.address, key: 0n, round: null, roundTime: null, deadline: ticket.requestDeadline }] };
}
export function postAction(source, refs) {
  const deadline = refs.reduce((d, r) => r.deadline < d ? r.deadline : d, refs[0].deadline);
  return { kind: 'post', id: `post:${refs[0].round}`, to: source, functionName: 'postRound',
    signature: SIGNATURES.post, args: [refs[0].round], deadline, refs };
}
export function acceptAction(ticket, word, conditional = false) {
  return { kind: 'accept', id: `accept:${ticket.address}`, to: ticket.address, functionName: 'acceptGraduationWord',
    signature: SIGNATURES.accept, args: [], deadline: null, refs: [word], conditional };
}
export function startAction(entry, refs) {
  return { kind: 'start', id: `start:${refs[0].round}`, to: entry.source, functionName: 'startBackup',
    signature: SIGNATURES.start, args: [refs[0].round], deadline: refs[0].roundTime + LATEST_START, refs };
}
export function fixAction(entry, refs) {
  return { kind: 'fix', id: `fix:${refs[0].round}`, to: entry.source, functionName: 'fixBackup',
    signature: SIGNATURES.fix, args: [refs[0].round], targetBlock: refs[0].backup.targetBlock,
    deadline: refs.reduce((d, r) => r.deadline < d ? r.deadline : d, refs[0].deadline), refs };
}
export const wordId = ref => `${ref.tickets}:${ref.key}:${ref.round}`;
export function plan(snapshot, cfg, ownWords = new Set()) {
  const actions = [], rounds = new Map(), backups = new Map(), accepts = [];
  const now = snapshot.block.now;
  for (const ticket of snapshot.tickets) {
    if (ticket.requestDeadline !== null) actions.push(requestAction(ticket));
    if (ticket.blocked) continue;
    for (const key of ticket.keys) {
      if (key.key === 0n && key.usable && (cfg.now || ownWords.has(wordId(key)) || key.readyAt + cfg.delay <= now)) {
        accepts.push(acceptAction(ticket, key));
      }
      if (key.silent || key.readyAt !== 0n) continue;
      if (ticket.backed) {
        if (!backups.has(key.round)) backups.set(key.round, { ticket, refs: [] });
        backups.get(key.round).refs.push(key);
      }
      if (!key.backup?.startedAt && key.roundTime + cfg.delay <= now) {
        if (!rounds.has(key.round)) rounds.set(key.round, { source: ticket.drand, refs: [] });
        rounds.get(key.round).refs.push(key);
        if (key.key === 0n) accepts.push(acceptAction(ticket, key, 'post'));
      }
    }
  }
  const work = [...rounds.values()].map(r => postAction(r.source, r.refs));
  for (const { ticket, refs } of backups.values()) {
    const key = refs[0], backup = key.backup;
    if (backup.startedAt === 0n) {
      const start = startAction(ticket, refs);
      if (key.roundTime + BACKUP_AFTER + cfg.delay < now && now + 96n <= start.deadline) work.push(start);
    } else if (backup.fixedAt === 0n) {
      const fix = fixAction(ticket, refs);
      if (snapshot.finalized !== null && backup.targetBlock <= snapshot.finalized
        && backup.targetBlock < snapshot.block.number
        && snapshot.block.number - backup.targetBlock <= HISTORY_WINDOW - RECENT_BLOCKS
        && now + 96n <= fix.deadline && backup.targetTime !== null
        && (cfg.now || backup.targetTime + cfg.delay <= now)) {
        work.push(fix);
        for (const ref of refs.filter(r => r.key === 0n)) {
          accepts.push(acceptAction(snapshot.tickets.find(t => t.address === ref.tickets), ref, 'fix'));
        }
      }
    }
  }
  // Each round's post precedes its start even though the start's deadline is earlier.
  // Other rounds keep earliest-request ordering; a verified receipt unlocks its own accepts first.
  const groups = new Map();
  for (const action of work) {
    const round = action.refs[0].round;
    if (!groups.has(round)) groups.set(round, []);
    groups.get(round).push(action);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const left = a[0].refs.reduce((d, r) => r.deadline < d ? r.deadline : d, a[0].refs[0].deadline);
    const right = b[0].refs.reduce((d, r) => r.deadline < d ? r.deadline : d, b[0].refs[0].deadline);
    return left < right ? -1 : left > right ? 1 : a[0].args[0] < b[0].args[0] ? -1 : 1;
  }).flat();
  const immediate = accepts.filter(a => !a.conditional && ownWords.has(wordId(a.refs[0])));
  const withAccepts = ordered.flatMap(action => [action, ...accepts.filter(a => a.conditional
    && a.conditional === action.kind && a.refs[0].round === action.args[0])]);
  return [...immediate, ...actions, ...withAccepts,
    ...accepts.filter(a => !a.conditional && !ownWords.has(wordId(a.refs[0])))];
}
export function fees(action, block, tip, estimate, cfg) {
  const padded = (estimate * 3n + 1n) / 2n;
  const gas = [padded, 16777216n, block.gasLimit].reduce((a, b) => a < b ? a : b);
  const maxFee = 2n * block.base + tip;
  const urgent = action.deadline !== null && action.deadline - block.now < 259200n;
  return { gas, tip, maxFee, urgent, cost: gas * maxFee, waiting: maxFee > (urgent ? cfg.urgentMaxFee : cfg.maxFee) };
}
export function describe(io, action, quote, block) {
  for (const ref of action.refs) io.stdout.write(
    `${action.kind}${action.conditional ? ` after own ${action.conditional}` : ''} tickets=${ref.tickets} key=${ref.key} round=${ref.round ?? '-'} `
    + `roundTime=${ref.roundTime ?? '-'} deadline=${action.deadline ?? 'none'} left=${action.deadline === null ? 'none' : action.deadline - block.now} `
    + `gas=${quote?.gas ?? `after-${action.conditional}`} maxFee=${quote?.maxFee ?? `after-${action.conditional}`} urgent=${quote?.urgent ?? false} totalWei=${quote?.cost ?? `after-${action.conditional}`}`
    + `${quote?.waiting ? ' waiting on fees' : ''}`
    + `${action.kind === 'start' ? '; device confirmation must come within about 80 seconds' : ''}\n`,
  );
}
