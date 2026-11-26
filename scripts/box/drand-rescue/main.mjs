import { ABI } from './abi.mjs';
import { viem } from './deps.mjs';
import { options, USAGE } from './options.mjs';
import { PINS } from './quicknet.mjs';
import { Failure, connection, discover, snapshot } from './chain.mjs';
import { plan, describe, wordId } from './plan.mjs';
import { signer, affordable } from './signer.mjs';
import { prepare, receipt, confirmed } from './execution.mjs';
import { deliver } from './mailer.mjs';
import { checkedHeader } from './header.mjs';
import { waitForRound } from './wait.mjs';

const reason = error => error instanceof Failure ? error.message : 'RPC or action failed';
const heartbeatHour = (now, cfg) => now !== null && (now / 3600n) % 24n === cfg.heartbeatHour;
function observations(report, state, io) {
  report.pending = 0n;
  report.nearest = null;
  for (const ticket of state.tickets) {
    const deadlines = ticket.keys.map(k => k.deadline);
    if (ticket.requestDeadline !== null) deadlines.push(ticket.requestDeadline);
    report.pending += ticket.pending + (ticket.requestDeadline !== null ? 1n : 0n);
    if (ticket.pending > BigInt(ticket.keys.length) && !report.capped.has(ticket.address)) {
      io.stdout.write(`tickets=${ticket.address} keys read ${ticket.keys.length} of ${ticket.pending}\n`);
      report.capped.add(ticket.address);
    }
    for (const deadline of deadlines) if (report.nearest === null || deadline < report.nearest) report.nearest = deadline;
  }
  if (state.notices.length) report.exit = 1;
  for (const notice of state.notices) {
    if (!report.notices.has(notice)) io.stderr.write(`${notice}\n`);
    report.notices.add(notice);
  }
}
async function notify(io, cfg, report) {
  if (!cfg.mailer) return;
  const heartbeat = heartbeatHour(report.now, cfg);
  if (!heartbeat && report.sent === 0n && report.exit !== 1) return;
  const text = `${heartbeat ? `drand-rescue alive\n${report.header}\n` : ''}drand-rescue exit=${report.exit} sent=${report.sent} `
    + `pending=${report.pending} nearestDeadline=${report.nearest ?? 'none'} waitingFees=${report.waiting.size}`
    + [...report.notices].filter(n => !heartbeat || n !== report.header).map(n => `\n${n}`).join('');
  await deliver(io, cfg.mailer, {
    source: 'rescue', level: report.exit === 1 ? 'ALERT' : 'INFO',
    subject: heartbeat ? 'drand-rescue alive' : 'drand-rescue result', text,
  });
}
async function run(io, cfg, report) {
  const conn = connection(io, cfg.rpc);
  const chainId = BigInt(await conn.rpc('eth_chainId'));
  if (!Object.hasOwn(PINS, String(chainId))) throw new Failure('unsupported chain');
  const block = await conn.block();
  report.now = block.now;
  if (heartbeatHour(block.now, cfg)) {
    try { report.header = `header ${(await checkedHeader(conn, block.number - 1n)).path} ok`; }
    catch {
      report.header = 'backup header refused';
      report.exit = 1;
      report.notices.add(report.header);
      io.stderr.write(`${report.header}\n`);
    }
  }
  const discovery = await discover(conn, cfg, chainId, block);
  if (discovery.message) io.stdout.write(`${discovery.message}\n`);
  if (!discovery.tickets.length) return;
  let state = await snapshot(conn, chainId, discovery.tickets, block);
  observations(report, state, io);
  const wallet = await signer(io, cfg);
  const sender = wallet?.address ?? '0x000000000000000000000000000000000000dEaD';
  const handled = new Set(), prepared = new Map(), ownWords = new Set();
  let total = 0n, spent = 0n;
  const prepareAndReport = async (action, current) => {
    try {
      const ready = await prepare(io, conn, cfg, sender, current.block, action, prepared.get(action.id));
      prepared.set(action.id, ready);
      if (ready.skip) { handled.add(action.id); return ready; }
      describe(io, action, ready.quote, current.block);
      if (ready.quote?.waiting) {
        report.waiting.add(action.id);
        handled.add(action.id);
        if (ready.quote.urgent) report.exit = 1;
      }
      return ready;
    } catch (error) {
      report.exit = 1;
      const message = `${action.kind} ${reason(error)}`;
      io.stderr.write(`${message}\n`);
      report.notices.add(message);
      handled.add(action.id);
      return null;
    }
  };
  const initial = plan(state, cfg);
  for (const action of initial) {
    const ready = await prepareAndReport(action, state);
    if (ready?.quote && !ready.skip && !ready.quote.waiting) total += ready.quote.cost;
  }
  io.stdout.write(`plan totalWei=${total}; conditional accepts priced after posting or fixing; runLimitWei=${cfg.maxRun}\n`);
  if (!wallet) { io.stdout.write('plan only; no signer\n'); return; }
  if (!initial.some(a => !a.conditional && !handled.has(a.id))) return;
  if (!cfg.yes && !await confirmed(io)) throw new Failure('confirmation declined; nothing sent');
  for (;;) {
    // Fresh single-block read before each send, including after the operator's confirmation and every receipt.
    if (BigInt(await conn.rpc('eth_chainId')) !== chainId) throw new Failure('chain changed');
    state = await snapshot(conn, chainId, discovery.tickets, await conn.block());
    observations(report, state, io);
    const action = plan(state, cfg, ownWords).find(a => !a.conditional && !handled.has(a.id));
    if (!action) break;
    const ready = await prepareAndReport(action, state);
    if (!ready || handled.has(action.id)) continue;
    await affordable(conn, sender, state.block, ready.quote, spent, cfg);
    // Reserve worst-case cost for this run, even if its receipt is lost.
    spent += ready.quote.cost;
    const hash = await wallet.send(conn, chainId, action, ready.quote, ready.data);
    report.sent++;
    if (!viem.isHash(hash)) throw new Failure('transaction hash unavailable');
    const mined = await receipt(conn, hash, action);
    handled.add(action.id);
    if (action.kind === 'post' || action.kind === 'fix') for (const ref of action.refs) ownWords.add(wordId(ref));
    if (action.kind === 'start' || action.kind === 'fix') {
      let target;
      if (action.kind === 'start') {
        for (const log of mined.logs) {
          if (log.address.toLowerCase() !== action.to.toLowerCase()) continue;
          try {
            const event = viem.decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true });
            if (event.eventName === 'BackupStarted' && event.args.round === action.args[0]) target = event.args.targetBlock;
          } catch { /* other event */ }
        }
      }
      for (const ref of action.refs) {
        const notice = `tickets=${ref.tickets} key=${ref.key} round=${ref.round} backup `
          + (action.kind === 'start' ? `started target=${target}` : 'fixed');
        report.notices.add(notice);
        io.stdout.write(`${notice}\n`);
      }
    }
    io.stdout.write(`${action.kind} confirmed; runTotalWei=${spent}\n`);
    if (cfg.now && action.kind === 'request' && !await waitForRound(io, conn, action, state)) return;
  }
}
/** All external communication and operator output is injected. No process globals, journal or event discovery. */
export async function main(argv, io) {
  let cfg;
  try { cfg = options(argv, io.env); }
  catch { io.stderr.write(`${USAGE}\n`); return 2; }
  const report = { exit: 0, sent: 0n, now: null, pending: 0n, nearest: null, waiting: new Set(), notices: new Set(), capped: new Set(), header: null };
  try { await run(io, cfg, report); }
  catch (error) {
    report.exit = 1;
    const message = reason(error);
    report.notices.add(message);
    io.stderr.write(`${message}\n`);
  }
  try { await notify(io, cfg, report); }
  catch { io.stderr.write('mailer delivery failed\n'); }
  return report.exit;
}
