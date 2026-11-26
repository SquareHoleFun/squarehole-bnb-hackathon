import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SEPOLIA, STARTER_GAS_CAP, MAX_FEE_CEILING, getAddress, recoverMessageAddress } from './chain.mjs';
import { openStore, atomicWrite, readBounded, uuid, journalNonceFloor } from './store.mjs';
import { ADDRESS_REFUSALS, matchesClaimMessage, xIdPattern } from '../message.mjs';
import { writeProgress } from './progress.mjs';
import { FLOAT_REASON, floatThreshold, validateFloatThreshold } from './settings.mjs';
import { alphaChain } from '../chains.mjs';

const fields = ['v', 'id', 'xId', 'privyDid', 'address', 'message', 'signature', 'requestedAt'];
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
export async function validateClaim(c, id, chainId = SEPOLIA) {
  try {
    if (!c || Object.keys(c).length !== fields.length + (Object.hasOwn(c, 'acceptedAt') ? 1 : 0)
      || !fields.every(k => Object.hasOwn(c, k)) || c.v !== 1
      || !uuid.test(c.id) || c.id !== id || typeof c.xId !== 'string' || !xIdPattern.test(c.xId)
      || typeof c.privyDid !== 'string' || !/^did:privy:[a-zA-Z0-9_-]{1,200}$/.test(c.privyDid)
      || typeof c.address !== 'string' || getAddress(c.address) !== c.address
      || !utc(c.requestedAt) || (Object.hasOwn(c, 'acceptedAt') && (!utc(c.acceptedAt) || Date.parse(c.acceptedAt) < Date.parse(c.requestedAt)))
      || typeof c.message !== 'string' || c.message.length > 8192
      || typeof c.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(c.signature)) return 'invalid claim schema';
  } catch { return 'invalid claim schema'; }
  try {
    if ((await recoverMessageAddress({ message: c.message, signature: c.signature })).toLowerCase() !== c.address.toLowerCase()) return 'invalid wallet signature';
  } catch { return 'invalid wallet signature'; }
  if (!matchesClaimMessage(c, chainId)) return 'signed message does not name this claim';
  return null;
}

// SH-275: chainId picks the chain's row (../chains.mjs): the starter, the daily cap, whether an admission step exists.
// Sepolia's row holds the values this engine always had; chain 97 has its own and no admission step.
export async function createSender({ queue, receipts, state, chain, address, teth, mode, chainId = SEPOLIA,
  lowFloatThresholdWei = floatThreshold(process.env, alphaChain(chainId).starter), now = Date.now, checkpoint = async () => {}, log = () => {} }) {
  const { starter, dailyCap, admission } = alphaChain(chainId);
  validateFloatThreshold(lowFloatThresholdWei);
  if (!['live', 'dry-run'].includes(mode)) throw new Error('invalid mode');
  if (await chain.chainId() !== chainId) throw new Error(chainId === SEPOLIA ? 'Sepolia required' : 'chain 97 required');
  const store = openStore(state, `${chainId}:${getAddress(address)}:${getAddress(teth)}:${mode}`, mode, receipts);
  const entries = store.state.entries;
  let lastError = null, float = '0', queueLength = 0, waitingClaims = 0, running = false, floatBlocked = false;
  let pending = [];
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const count = () => entries.filter(e => e.reserved && e.days.includes(day())).length;
  const monitor = () => ({ v: 1, service: 'alpha-sender', mode, at: now(), queueLength,
    day: day(), dayCount: count(), floatWei: float, lowFloatThresholdWei,
    lowFloat: floatBlocked || BigInt(float) < BigInt(lowFloatThresholdWei), waitingClaims, lastError });
  const receiptPath = id => join(receipts, `${id}.json`);
  const progressPath = id => join(receipts, `${id}.progress.json`);
  const progress = (id, status) => writeProgress(receipts, id, status === true ? 'waiting' : status === false ? 'queued' : status, now());
  const clearPause = e => {
    // Clear public waiting status before any signature, including retries after an interrupted signature.
    if (existsSync(progressPath(e.id))) progress(e.id, false);
    delete e.pausedReason;
  };
  const pause = e => {
    floatBlocked = true; lastError = FLOAT_REASON;
    if (e) { e.pausedReason = FLOAT_REASON; store.save(); }
    return false;
  };
  const publish = e => { if (!existsSync(receiptPath(e.id))) atomicWrite(receiptPath(e.id), e.outcome, 0o640); };
  // alpha-api releases a dry-run claim at its exact skipped receipt and lets the person claim again (alpha-api.mjs
  // releaseDry). The dry journal lets go of the same claim: no X ID, address, day or simulated cost stays held, only
  // the claim ID and its outcome. Only dry-run writes 'skipped'; live reservations stay permanent.
  const release = e => { delete e.xId; delete e.address; delete e.days; delete e.needsAdmit; delete e.quote; e.reserved = false; };
  const finish = async (e, status, reason = null) => {
    delete e.pausedReason;
    e.outcome = { v: 1, id: e.id, status, admitTx: e.admit?.hash ?? null, sendTx: e.send?.hash ?? null,
      reason, at: new Date(now()).toISOString() };
    if (status === 'skipped') release(e);
    store.save(); await checkpoint('receipt:journal'); publish(e);
    if (reason) lastError = reason;
  };
  const chargeToday = e => {
    if (e.days.includes(day())) return true;
    if (count() >= dailyCap) { lastError = 'daily claim limit reached'; return false; }
    e.days.push(day()); store.save(); return true;
  };
  const [gasRefusal, revertRefusal] = ADDRESS_REFUSALS;
  const estimateNeedsFloat = Symbol('estimate needs float');
  // A starter transfer the node simulates as reverting is an answer about the address, not an outage (chain.mjs).
  const quoteFor = async (c, admit) => {
    try { return await chain.quote(c, admit); }
    catch (error) {
      if (error?.code === 'STARTER_REVERTS') return null;
      // A node can reject gas estimation for lack of funds before returning a gas ceiling. Recognize only the
      // typed funds error, never an arbitrary RPC message (an outage must remain an uncertain/error cycle).
      for (let cause = error; cause; cause = cause.cause) if (cause.name === 'InsufficientFundsError') return estimateNeedsFloat;
      throw error;
    }
  };
  const overGas = quote => BigInt(quote.sendGas) > STARTER_GAS_CAP;
  const overFee = quote => BigInt(quote.maxFeePerGas) > MAX_FEE_CEILING;
  const feeWait = 'fees above the ceiling; waiting';
  // No new transaction below a nonce this journal already used: a backend answering from behind (a load-balanced RPC)
  // can report latest == pending at a consumed nonce. Transient; nothing is signed or saved.
  const nonceFloor = () => journalNonceFloor(store.state);
  const cost = (quote, needsAdmit) => starter + (BigInt(quote.sendGas) + (needsAdmit ? BigInt(quote.admitGas) : 0n)) * BigInt(quote.maxFeePerGas);
  const receiptsOf = async txs => { const found = []; for (const tx of txs) found.push(await chain.receipt(tx.hash)); return found; };
  // Only our own unmined transactions may explain the nonce views: every earlier transaction of the claim is mined,
  // the confirmed count stands exactly at the first unmined one, and nothing is pending past the claim's last one.
  const explained = (txs, found, n) => {
    const first = found.indexOf(null);
    return !found.slice(first).some(Boolean) && n.latest === txs[first].nonce && n.pending <= txs.at(-1).nonce + 1;
  };
  // Journaled bytes only. A node that already holds them (pooled or mined) refuses the copy; that is no failure.
  const broadcast = async tx => {
    try { await chain.broadcast(tx); }
    catch (error) { if (!await chain.known(tx.hash)) throw error; }
  };
  // SH-181: a claim's unsigned transactions (the admission when needed, then the starter) are quoted, checked against
  // the float as a whole, signed at consecutive nonces and journaled in one save, then broadcast back to back. The
  // receipt still waits until every one of them has twelve canonical confirmations, and so does the next claim.
  // A journal from the engine before SH-181 may hold an admission signed alone: its starter is signed once that
  // admission is final and successful, as then.
  const advance = async e => {
    if (e.outcome) { publish(e); return true; }
    if (mode === 'dry-run') { await finish(e, 'skipped', 'dry run; no transactions'); return true; }
    const kinds = e.needsAdmit ? ['admit', 'send'] : ['send'];
    for (;;) {
      const txs = kinds.filter(kind => e[kind]).map(kind => e[kind]);
      if (txs.length) {
        progress(e.id, 'sending');
        let found = await receiptsOf(txs);
        if (found.includes(null)) {
          if (!explained(txs, found, await chain.nonces())) throw new Error('unexplained consumed nonce');
          if (!chargeToday(e)) return false;
          for (const [i, tx] of txs.entries()) {
            if (!found[i]) { await broadcast(tx); await checkpoint(`${tx.kind}:broadcast`); }
          }
          found = await receiptsOf(txs);
        }
        if (!found.every(receipt => receipt?.confirmed)) { lastError = 'awaiting transaction confirmation'; return false; }
        // A transaction may have been mined while we were down across UTC midnight. Count the resumed claim
        // today before examining any new queue file (conservative even if mining occurred yesterday).
        if (!chargeToday(e)) return false;
        const reverted = txs.find((tx, i) => found[i].status !== 'success');
        if (reverted) { await finish(e, 'failed', `${reverted.kind} transaction reverted`); return true; }
      }
      const unsigned = kinds.filter(kind => !e[kind]);
      if (!unsigned.length) { await finish(e, 'sent'); return true; }
      const n = await chain.nonces();
      if (n.latest !== n.pending) throw new Error('unexplained pending nonce');
      if (n.latest < nonceFloor()) throw new Error('stale nonce view');
      if (!chargeToday(e)) return false;
      // Queue time or downtime can outlive the acceptance quote. Refresh it for everything still unsigned; the new
      // quote and the signed bytes are saved together below before any broadcast.
      const admit = unsigned.includes('admit');
      // Estimation itself may reject an empty account. Only wholly unsigned claims may take the pause path.
      if (!txs.length && await chain.balance() <= starter) return pause(e);
      const quote = await quoteFor(e, admit);
      if (quote === estimateNeedsFloat) {
        if (!txs.length) return pause(e);
        await finish(e, 'failed', FLOAT_REASON); return true;
      }
      if (!quote) { await finish(e, 'failed', revertRefusal); return true; }
      if (overFee(quote)) { lastError = feeWait; return false; }
      e.quote = quote;
      if (overGas(e.quote)) { await finish(e, 'failed', gasRefusal); return true; }
      if (await chain.balance() < cost(e.quote, admit)) {
        if (!txs.length) return pause(e);
        // A legacy admission was already signed: retain the existing final reconciliation path.
        await finish(e, 'failed', FLOAT_REASON); return true;
      }
      clearPause(e);
      const signed = [];
      for (const kind of unsigned) signed.push(await chain.prepare(kind, e, e.quote, n.latest + signed.length));
      for (const tx of signed) e[tx.kind] = tx;
      store.save(); await checkpoint(`${unsigned.join('+')}:journal`);
    }
  };
  const queued = () => readdirSync(queue).filter(name => name.endsWith('.json') && !existsSync(join(receipts, name))).sort();
  const validated = new Map();
  const readQueue = async () => {
    const rows = [];
    for (const name of queued()) {
      const id = name.slice(0, -5);
      let c, reason;
      if (!uuid.test(id)) reason = 'invalid queue filename';
      else {
        try {
          // Still bound and re-read every file. Cache signature recovery only for exactly identical bytes, so
          // waiting for confirmations does not repeatedly recover every later tester's signature.
          const raw = readBounded(join(queue, name), 16384), prior = validated.get(id);
          if (prior?.raw === raw) ({ c, reason } = prior);
          else { c = JSON.parse(raw); reason = await validateClaim(c, id, chainId); validated.set(id, { raw, c, reason }); }
        }
        catch { reason = 'invalid claim file'; }
      }
      rows.push({ id, c, reason });
    }
    const ids = new Set(rows.map(row => row.id));
    for (const id of validated.keys()) if (!ids.has(id)) validated.delete(id);
    // acceptedAt is stamped by the API at durable acceptance, independent of wallet signing time. Legacy v1
    // files lack it; their signed requestedAt is the only durable timestamp available (never rewrite the queue).
    return rows.sort((a, b) => (a.reason ? -Infinity : Date.parse(a.c.acceptedAt ?? a.c.requestedAt))
      - (b.reason ? -Infinity : Date.parse(b.c.acceptedAt ?? b.c.requestedAt)) || a.id.localeCompare(b.id));
  };
  return {
    monitor,
    async cycle({ signal } = {}) {
      if (running) throw new Error('sender cycle already running');
      running = true;
      try {
        // A failed save leaves mutated memory that is not necessarily durable. Never reuse it for a broadcast.
        store.assertUsable();
        lastError = null; floatBlocked = false; waitingClaims = 0; pending = [];
        // A dry journal written before the release above still holds its skipped claims; let go of them in one save.
        const held = mode === 'dry-run' ? entries.filter(e => e.reserved && e.outcome?.status === 'skipped') : [];
        if (held.length) { held.forEach(release); store.save(); }
        if (await chain.chainId() !== chainId) throw new Error(chainId === SEPOLIA ? 'Sepolia required' : 'chain 97 required');
        float = String(await chain.balance()); queueLength = queued().length;
        pending = await readQueue();
        // All previously reserved work is reconciled before any new queue file, independent of queue contents.
        for (const e of entries) {
          if (signal?.aborted || !await advance(e)) return false;
        }
        for (const row of pending) {
          if (signal?.aborted) return false;
          const { id, c } = row;
          if (!uuid.test(id)) { lastError = 'invalid queue filename'; continue; }
          if (entries.some(e => e.id === id)) continue;
          let reason = row.reason;
          if (!reason && entries.some(e => e.reserved && e.xId === c.xId)) reason = 'X account already claimed';
          if (!reason && entries.some(e => e.reserved && e.address.toLowerCase() === c.address.toLowerCase())) reason = 'address already claimed';
          // Accepted claims keep their place across UTC days; the sender's allowance is not a final refusal.
          if (!reason && count() >= dailyCap) { lastError = 'daily claim limit reached'; return false; }
          let needsAdmit, quote;
          if (!reason) {
            // Dry-run claims are released at their skipped receipts, so no earlier rehearsal cost is held here.
            const available = await chain.balance();
            if (available <= starter) return pause();
            else {
              // No admission step on a chain without one (chain 97: its test coin's faucet is open).
              needsAdmit = admission && !await chain.admitted(c.address);
              // RPC errors leave the claim unhandled, never mislabel an outage as an irreversible refusal.
              quote = await quoteFor(c, needsAdmit);
              if (quote === estimateNeedsFloat) return pause();
              // A fee spike leaves the claim queued, unreserved; the address refusals come before any signature.
              if (!quote) reason = revertRefusal;
              else if (overFee(quote)) { lastError = feeWait; return false; }
              else if (overGas(quote)) reason = gasRefusal;
              else if (available < cost(quote, needsAdmit)) return pause();
            }
          }
          const e = reason ? { id, reserved: false } : { id, reserved: true, xId: c.xId, address: c.address,
            days: [day()], needsAdmit, quote };
          entries.push(e);
          if (reason) await finish(e, 'refused', reason);
          else { store.save(); if (!await advance(e)) return false; }
        }
        return lastError !== 'invalid queue filename';
      } catch (error) {
        // Our own plain stop shows as it is; anything else stays generic (never an upstream message).
        lastError = error?.message === 'stale nonce view' ? 'stale nonce view' : 'sender reconciliation failed; inspect chain and journal';
        throw error;
      }
      finally {
        running = false;
        queueLength = queued().length;
        const progressIds = new Set(pending.filter(row => !row.reason).map(row => row.id));
        for (const e of entries) if (e.pausedReason) progressIds.add(e.id);
        for (const id of progressIds) {
          const e = entries.find(entry => entry.id === id);
          if (e?.outcome || e?.admit || e?.send || existsSync(receiptPath(id))) continue;
          if (floatBlocked) { progress(id, true); waitingClaims++; }
          else if (existsSync(progressPath(id))) progress(id, false);
        }
        // Best-effort monitoring cannot turn an uncertain RPC/broadcast into healthy work.
        try { float = String(await chain.balance()); } catch { /* last observed float */ }
        atomicWrite(join(state, 'monitor.json'), monitor());
        atomicWrite(join(receipts, 'sender-status.json'), { v: 1, at: now(), lowFloat: monitor().lowFloat }, 0o640);
        log(`queue=${queueLength} dayCount=${count()} floatWei=${float} lowFloat=${monitor().lowFloat} waitingClaims=${waitingClaims} lastError=${lastError ?? 'none'}`);
      }
    },
    close: store.close,
  };
}
