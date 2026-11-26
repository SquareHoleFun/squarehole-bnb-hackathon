import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Refusal, need, privyVerifier, accessVerifier, sessionCookies, SESSION_MS } from './alpha/auth.mjs';
import { assertNoForget } from './alpha/forget-maintenance.mjs';
import { openStore } from './alpha/store.mjs';
import { publishClaim, receipt, claimProgress, boundedFile, uuid } from './alpha/files.mjs';
import { ADDRESS_REFUSALS, claimMessage, xIdPattern } from './alpha/message.mjs';
import { alphaChain } from './alpha/chains.mjs';

// Reuse the workspace's locked viem; no SDK, signer, RPC or added dependency.
const { getAddress, verifyMessage } = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url))('viem');
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
} });
async function bodyOf(request) {
  const type = request.headers.get('content-type') ?? '';
  need(!type || /^application\/json(?:\s*;|$)/i.test(type), 403, 'JSON required');
  const reader = request.body?.getReader(); if (!reader) return {};
  let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; need(size <= 16384, 413, 'body too large'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel(); }
  need(size === 0 || type, 403, 'JSON required');
  try { const value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); need(value && typeof value === 'object' && !Array.isArray(value)); return value; }
  catch { throw new Refusal(400, 'invalid JSON'); }
}
const addressOf = input => { try { need(typeof input === 'string' && /^0x[0-9a-fA-F]{40}$/.test(input)); const address = getAddress(input); need(input === input.toLowerCase() || input === address); return address; } catch { throw new Refusal(400, 'invalid address'); } };

export function createAlphaApi(config, { now = Date.now, fetch: fetcher = fetch, publish = publishClaim } = {}) {
  need(new URL(config.origin).origin === config.origin && config.origin.startsWith('https://'), 500);
  const verifyPrivy = privyVerifier(config.privyPublicKey, config.privyAppId);
  // SH-275: chain 97's deployment (BNB Chain Testnet) approves a new sign-up at once and has no desk (its routes answer
  // 404, no Access check is set up). Only there; Sepolia's default keeps the desk and its Access check.
  const chainId = config.chainId ?? 11155111, autoApprove = config.autoApprove ?? false, { dailyCap } = alphaChain(chainId);
  need(typeof autoApprove === 'boolean' && (!autoApprove || chainId === 97), 500);
  const verifyAccess = autoApprove ? null : accessVerifier({ issuer: config.accessIssuer, audience: config.accessAudience, fetch: fetcher, now });
  assertNoForget(config.receiptsDir);
  const cookies = sessionCookies(config.cookieKey), store = openStore(config.dbPath);
  const { get, all, run, transaction } = store;
  const returningMs = 30 * 86400000, returning = sessionCookies(config.cookieKey, '__Host-alpha_returning', returningMs);
  const recognized = request => {
    const hash = returning.read(request.headers.get('cookie'));
    return Boolean(hash && get('SELECT hash FROM returning_browsers WHERE hash = ? AND expires > ?', hash, now()));
  };
  const cap = config.signupCap ?? 100;
  need(Number.isSafeInteger(cap) && cap > 0 && typeof (config.signupsClosed ?? false) === 'boolean', 500);
  const counts = () => ({ pending: get("SELECT count(*) AS n FROM signups WHERE status = 'pending'").n,
    approved: get("SELECT count(*) AS n FROM signups WHERE status = 'approved'").n });
  const room = () => { const c = counts(); return c.pending + c.approved < cap; };
  const intakeOpen = () => !config.signupsClosed && room();
  const pendingClaims = () => all('SELECT id, acceptedAt FROM claims WHERE reserved = 1 ORDER BY acceptedAt, id')
    .map(row => ({ ...row, progress: claimProgress(config.receiptsDir, row.id) }))
    .filter(row => ['queued', 'waiting', 'sending'].includes(row.progress.status));
  const progressOf = id => {
    const p = claimProgress(config.receiptsDir, id);
    if (p.status !== 'queued') { const publicStatus = { ...p }; delete publicStatus.floatPausedMs; return publicStatus; }
    // A signed claim is reconciled before new work, even when it came from a legacy queue.
    const pending = pendingClaims().sort((a, b) => (b.progress.status === 'sending') - (a.progress.status === 'sending'));
    const position = pending.findIndex(row => row.id === id) + 1;
    if (position === 0) {
      // The sender may have published a final receipt between the two reads. Never expose position zero.
      const final = receipt(config.receiptsDir, id); need(final, 503, 'claim state changed'); return final;
    }
    return { id, status: 'queued', position };
  };
  const senderFloat = () => {
    try {
      const s = JSON.parse(boundedFile(`${config.receiptsDir}/sender-status.json`, 2048));
      need(s.v === 1 && Number.isSafeInteger(s.at) && s.at <= now() && now() - s.at <= 300000
        && typeof s.lowFloat === 'boolean', 503);
      return s.lowFloat ? 'low' : 'ready';
    } catch { return 'unknown'; }
  };
  const monitor = () => {
    const pending = pendingClaims();
    let oldestActiveWaitSeconds = 0, recentFailures = 0;
    for (const row of pending) {
      const p = row.progress;
      // Active float waits are covered by the float alert. Completed pauses are subtracted after refill.
      if (p.status === 'waiting') continue;
      const ms = now() - Date.parse(row.acceptedAt) - (p.floatPausedMs ?? 0);
      need(Number.isFinite(ms), 503);
      oldestActiveWaitSeconds = Math.max(oldestActiveWaitSeconds, Math.floor(Math.max(0, ms) / 1000));
    }
    for (const row of all('SELECT id FROM claims')) {
      const r = receipt(config.receiptsDir, row.id);
      if (r && ['failed', 'refused'].includes(r.status) && Date.parse(r.at) <= now() && now() - Date.parse(r.at) <= 3600000) recentFailures++;
    }
    return { v: 1, service: 'alpha-api', at: now(), ...counts(), cap, claimsWaiting: pending.length,
      senderFloat: senderFloat(), oldestActiveWaitSeconds, recentFailures };
  };
  const flush = () => transaction(() => {
    for (const row of all('SELECT * FROM claims WHERE published = 0 ORDER BY rowid')) {
      publish(config.queueDir, row.payload); run('UPDATE claims SET published = 1 WHERE id = ?', row.id);
    }
  });
  try { flush(); } catch (error) { store.close(); throw error; }
  const session = (request, approved = false) => {
    const hash = cookies.read(request.headers.get('cookie'));
    const row = hash && get('SELECT signups.*, sessions.hash, sessions.expires FROM sessions JOIN signups USING(xId) WHERE hash = ? AND expires > ?', hash, now());
    need(row, 401, 'sign in required'); if (approved) need(row.status === 'approved', 403, 'approval required'); return row;
  };
  const dryRunSkip = r => r?.status === 'skipped' && r.reason === 'dry run; no transactions' && r.admitTx === null && r.sendTx === null;
  // The sender's refusals about the claimant's address (too much starter gas, a transfer that reverts): exact reason,
  // no transaction. The person can claim again with another wallet; every other refusal stays final.
  const addressRefusal = r => r?.status === 'refused' && ADDRESS_REFUSALS.includes(r.reason) && r.admitTx === null && r.sendTx === null;
  const releaseDry = (xId, address) => {
    for (const row of all('SELECT id FROM claims WHERE reserved = 1 AND (xId = ? OR address = ?)', xId, address)) {
      const r = receipt(config.receiptsDir, row.id);
      if (dryRunSkip(r) || addressRefusal(r)) run('UPDATE claims SET reserved = 0 WHERE id = ?', row.id);
    }
  };
  // The account's latest claim and its receipt. A released claim (reserved = 0) other than the exact dry-run skip, which
  // the card already answers with "Claim again later", was released by an operator (docs/runbooks/alpha-sender.md): it
  // is no claim, so the card offers a fresh one. Reserved claims are reported with their receipts as they are.
  const claimState = xId => {
    const row = get('SELECT id, reserved FROM claims WHERE xId = ? ORDER BY rowid DESC LIMIT 1', xId);
    if (!row) return null;
    const r = receipt(config.receiptsDir, row.id);
    if (!row.reserved && !dryRunSkip(r)) return null;
    // An address refusal is released on the next claim request; report no claim so the card offers one.
    if (addressRefusal(r)) return null;
    return r ?? progressOf(row.id);
  };
  const statusOf = user => ({ status: user.status, handle: user.handle, claim: claimState(user.xId) });
  return {
    close: () => store.close(), monitor,
    async handle(request) {
      try {
        const url = new URL(request.url), path = url.pathname;
        if (request.method === 'POST') need(request.headers.get('origin') === config.origin && !['cross-site', 'none'].includes(request.headers.get('sec-fetch-site')), 403, 'same origin required');
        const routes = { '/alpha/intake': 'GET', '/alpha/health': 'GET', '/alpha/session': 'POST', '/alpha/signout': 'POST', '/alpha/me': 'GET', '/alpha/check': 'GET', '/alpha/claim/message': 'GET', '/alpha/claim': 'POST', '/desk/api/signups': 'GET', '/desk/api/decide': 'POST', '/desk/api/check': 'GET' };
        const claimId = path.startsWith('/alpha/claim/') ? path.slice('/alpha/claim/'.length) : '';
        const method = routes[path] ?? (uuid.test(claimId) ? 'GET' : undefined);
        need(method && !(autoApprove && path.startsWith('/desk/')), 404, 'not found'); need(method === request.method, 405, 'method refused');
        const body = request.method === 'POST' ? await bodyOf(request) : {};
        if (path === '/alpha/intake') return json({ open: intakeOpen(), returning: recognized(request) });
        if (path === '/alpha/health') { counts(); return json({ ok: true }); }
        if (path.startsWith('/desk/')) {
          const actor = await verifyAccess(request.headers.get('Cf-Access-Jwt-Assertion'));
          if (path === '/desk/api/check') return json({ status: 'approved' });
          if (path === '/desk/api/signups') return json({ load: { ...counts(), cap, claimsWaiting: pendingClaims().length, senderFloat: senderFloat() }, signups: all('SELECT * FROM signups ORDER BY signedUpAt, xId'), decisions: all('SELECT * FROM decisions ORDER BY seq') });
          need(typeof body.xId === 'string' && xIdPattern.test(body.xId) && ['approve', 'remove', 'reset'].includes(body.decision));
          transaction(() => {
            const prior = get('SELECT status FROM signups WHERE xId = ?', body.xId);
            need(prior, 404, 'signup not found');
            if (prior.status === 'removed' && body.decision !== 'remove') need(room(), 429, 'signup cap reached');
            run('UPDATE signups SET status = ? WHERE xId = ?', { approve: 'approved', remove: 'removed', reset: 'pending' }[body.decision], body.xId);
            run('DELETE FROM challenges WHERE sessionHash IN (SELECT hash FROM sessions WHERE xId = ?)', body.xId);
            run('INSERT INTO decisions(xId, decision, actor, at) VALUES(?,?,?,?)', body.xId, body.decision, actor, new Date(now()).toISOString());
          });
          return json({ status: get('SELECT status FROM signups WHERE xId = ?', body.xId).status });
        }
        if (path === '/alpha/session') {
          const user = verifyPrivy(request.headers.get('privy-id-token'), now()), token = cookies.issue(), marker = returning.issue(), at = new Date(now()).toISOString();
          transaction(() => {
            const known = get('SELECT xId FROM signups WHERE xId = ?', user.xId);
            if (!known) need(intakeOpen(), 429, 'new signups closed');
            run(`INSERT INTO signups VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(xId) DO UPDATE SET
              privyDid=excluded.privyDid, handle=excluded.handle, name=excluded.name, picture=excluded.picture, lastSignIn=excluded.lastSignIn`, user.xId, user.privyDid, user.handle, user.name, user.picture, at, at);
            // Automatic approval: a NEW sign-up only (within the cap above); a known one keeps its status.
            if (autoApprove && !known) run("UPDATE signups SET status = 'approved' WHERE xId = ?", user.xId);
            run('INSERT INTO signins(xId, at) VALUES(?,?)', user.xId, at);
            run('INSERT INTO sessions VALUES(?,?,?)', token.hash, user.xId, now() + SESSION_MS);
            run('DELETE FROM returning_browsers WHERE expires <= ?', now());
            run('INSERT INTO returning_browsers VALUES(?,?,?)', marker.hash, user.xId, now() + returningMs);
          });
          const response = json(statusOf(get('SELECT * FROM signups WHERE xId = ?', user.xId)), 200, { 'set-cookie': token.cookie });
          response.headers.append('set-cookie', marker.cookie); return response;
        }
        if (path === '/alpha/signout') {
          const hash = cookies.read(request.headers.get('cookie'));
          if (hash) transaction(() => { run('DELETE FROM challenges WHERE sessionHash = ?', hash); run('DELETE FROM sessions WHERE hash = ?', hash); });
          return json({ status: 'signed-out' }, 200, { 'set-cookie': cookies.clear() });
        }
        const user = session(request);
        if (path === '/alpha/check') { need(user.status === 'approved', 401, 'approval required'); return json({ status: 'approved' }); }
        if (path === '/alpha/me') return json(statusOf(user));
        need(user.status === 'approved', 403, 'approval required');
        if (path === '/alpha/claim/message') {
          const address = addressOf(url.searchParams.get('address'));
          need(url.searchParams.getAll('address').length === 1);
          transaction(() => {
            releaseDry(user.xId, address);
            need(!get('SELECT id FROM claims WHERE reserved = 1 AND xId = ?', user.xId), 409, 'already claimed');
          });
          const id = randomUUID(), requestedAt = new Date(now()).toISOString();
          const message = claimMessage({ handle: user.handle, xId: user.xId, address, id, requestedAt, origin: config.origin }, chainId);
          run('INSERT OR REPLACE INTO challenges VALUES(?,?,?,?,?,?)', user.hash, id, address, message, requestedAt, now() + 600000);
          return json({ id, address, message, requestedAt });
        }
        if (path === '/alpha/claim') {
          const address = addressOf(body.address);
          need(typeof body.message === 'string' && typeof body.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(body.signature));
          const challenge = get('SELECT * FROM challenges WHERE sessionHash = ?', user.hash);
          need(challenge && challenge.message === body.message && challenge.address === address && challenge.expires > now(), 400, 'claim message mismatch');
          let verified = false;
          try { verified = await verifyMessage({ address, message: body.message, signature: body.signature }); } catch { /* invalid EOA signature */ }
          need(verified, 400, 'invalid signature');
          transaction(() => {
            // Recheck after the asynchronous signature recovery: removal, signout and competing requests win immediately.
            session(request, true);
            const current = get('SELECT * FROM challenges WHERE sessionHash = ?', user.hash);
            need(current?.id === challenge.id && current.expires > now(), 400, 'claim message mismatch');
            need(!get('SELECT id FROM claims WHERE id = ?', challenge.id), 409, 'already claimed');
            releaseDry(user.xId, address);
            need(!get('SELECT id FROM claims WHERE reserved = 1 AND (xId = ? OR address = ?)', user.xId, address), 409, 'already claimed');
            const acceptedAt = new Date(now()).toISOString();
            need(get('SELECT count(*) AS count FROM claims WHERE reserved = 1 AND acceptedAt >= ?', `${acceptedAt.slice(0, 10)}T00:00:00.000Z`).count < dailyCap, 429, 'daily claim cap reached');
            const payload = { v: 1, id: challenge.id, xId: user.xId, privyDid: user.privyDid, address, message: body.message, signature: body.signature, requestedAt: challenge.requestedAt, acceptedAt };
            run('INSERT INTO claims(id,xId,address,payload,acceptedAt) VALUES(?,?,?,?,?)', challenge.id, user.xId, address, JSON.stringify(payload), acceptedAt);
          });
          flush();
          return json(progressOf(challenge.id), 202);
        }
        need(get('SELECT id FROM claims WHERE id = ? AND xId = ?', claimId, user.xId), 404, 'claim not found');
        flush();
        return json(progressOf(claimId));
      } catch (error) {
        // Never echo upstream tokens, profiles, signatures, paths or unexpected filesystem/SQLite errors.
        return json({ error: error instanceof Refusal ? error.message : 'service unavailable' }, error instanceof Refusal ? error.status : 503);
      }
    },
  };
}

if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  const { start } = await import('./alpha/server.mjs');
  await start(createAlphaApi);
}
