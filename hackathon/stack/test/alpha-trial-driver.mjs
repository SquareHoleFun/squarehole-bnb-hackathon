// SH-275's trial driver (test/alpha-trial.sh): through the trial's Caddy at https://trial.example.org, as a visitor
// would: the desk is 404, sign-ins with the stand-in's identity token (a fixture key whose public half is the trial's
// SH_ALPHA_PRIVY_VERIFICATION_KEY) are approved at once, each claim is signed by a fixture wallet, and the sender pays
// it on the trial's local chain 97. Prints one JSON summary; exits 1 on any difference.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url));
const viem = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const site = 'https://trial.example.org', claims = Number(process.env.SH_TRIAL_CLAIMS ?? 3);
const key = readFileSync('/fixture/privy-private.pem', 'utf8');
const pub = viem.createPublicClient({ transport: viem.http(process.env.SH_TRIAL_RPC), cacheTime: 0 });
const wallet = n => privateKeyToAccount(`0x${BigInt(n).toString(16).padStart(64, '0')}`);
const token = xId => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'privy.io', aud: 'fixture-app', sub: `did:privy:trial${xId}`, iat: now, exp: now + 3600,
    linked_accounts: JSON.stringify([{ type: 'twitter_oauth', subject: xId, username: `trial_${xId}`, name: `Trial ${xId}` }]) };
  const input = [{ alg: 'ES256' }, payload].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const call = async (path, { method = 'GET', cookie, idToken, body } = {}) => {
  const response = await fetch(`${site}${path}`, { method, redirect: 'manual', headers: { ...(method === 'POST' ? { origin: site, 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}), ...(idToken ? { 'privy-id-token': idToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, cookies: response.headers.getSetCookie() };
};
const out = { site, claims, checks: [], paid: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) out.failed = true; };
try {
  // The sender's float: 1 tBNB for its fixture key (the sender retries until it has it).
  for (let i = 0; i < 30; i++) { try { await pub.getChainId(); break; } catch { await delay(1000); } }
  check('the trial chain is chain 97', await pub.getChainId() === 97);
  await pub.request({ method: 'anvil_setBalance', params: [process.env.SH_TRIAL_DESK, '0xde0b6b3a7640000'] });
  let health;
  for (let i = 0; i < 60 && health?.status !== 200; i++) { health = await call('/alpha/health').catch(() => null); if (health?.status !== 200) await delay(2000); }
  check('/alpha/health answers ok through Caddy', health?.status === 200 && health.json?.ok === true, health?.status);
  for (const path of ['/desk/api/signups', '/desk/', '/desk']) { const r = await call(path); check(`${path} is 404`, r.status === 404, r.status); }
  const intake = await call('/alpha/intake'); check('/alpha/intake is open', intake.json?.open === true, intake.json);
  const join = await call('/join'); check('/join serves the join page', join.status === 200 && join.text.includes('trial join page'), join.status);
  const ids = [];
  for (let n = 1; n <= claims; n++) {
    const xId = String(1000 + n), session = await call('/alpha/session', { method: 'POST', idToken: token(xId) });
    check(`sign-in ${n} approved at once`, session.status === 200 && session.json?.status === 'approved', session.json);
    const cookie = session.cookies.find(c => c.startsWith('__Host-alpha_session='))?.split(';')[0];
    const w = wallet(500 + n), challenge = await call(`/alpha/claim/message?address=${w.address}`, { cookie });
    check(`claim ${n} text names chain 97`, challenge.json?.message?.includes('I request starter tBNB on BNB Chain Testnet (chain 97).'), challenge.status);
    const claimed = await call('/alpha/claim', { method: 'POST', cookie, body: { address: w.address, message: challenge.json.message,
      signature: await w.signMessage({ message: challenge.json.message }) } });
    check(`claim ${n} accepted`, claimed.status === 202, claimed.json);
    ids.push({ n, cookie, id: challenge.json.id, address: w.address });
  }
  const deadline = Date.now() + 15 * 60000;
  for (const c of ids) {
    let r;
    while (Date.now() < deadline) { r = await call(`/alpha/claim/${c.id}`, { cookie: c.cookie }); if (['sent', 'failed', 'refused'].includes(r.json?.status)) break; await delay(3000); }
    const balance = await pub.getBalance({ address: c.address });
    const tx = r.json?.sendTx ? await pub.getTransaction({ hash: r.json.sendTx }) : null;
    out.paid.push({ claim: c.n, status: r.json?.status, admitTx: r.json?.admitTx, sendTx: r.json?.sendTx, balanceWei: String(balance), chainId: tx?.chainId, valueWei: tx ? String(tx.value) : null });
    check(`claim ${c.n} sent, no admission, exactly 0.015 tBNB on chain 97`, r.json?.status === 'sent' && r.json.admitTx === null
      && balance === 15n * 10n ** 15n && tx?.chainId === 97 && tx.value === 15n * 10n ** 15n);
  }
  // SH-299: an account already paid gets nothing more: the first account claims again, to its paid wallet and to a new
  // one; whatever the answers, after half a minute neither wallet has received anything more.
  if (ids[0]) {
    const c = ids[0], other = wallet(700), again = [];
    for (const w of [wallet(500 + c.n), other]) {
      const challenge = await call(`/alpha/claim/message?address=${w.address}`, { cookie: c.cookie });
      const r = challenge.json?.message ? await call('/alpha/claim', { method: 'POST', cookie: c.cookie, body: { address: w.address,
        message: challenge.json.message, signature: await w.signMessage({ message: challenge.json.message }) } }) : challenge;
      again.push({ to: w.address, status: r.status, answer: r.json?.status ?? r.json?.error ?? null });
    }
    await delay(30000);
    const paidAgain = await pub.getBalance({ address: c.address }), otherBalance = await pub.getBalance({ address: other.address });
    out.again = { attempts: again, paidWalletWei: String(paidAgain), otherWalletWei: String(otherBalance) };
    check('an account already paid gets nothing more (its wallet stays at 0.015, another wallet at 0)',
      paidAgain === 15n * 10n ** 15n && otherBalance === 0n, out.again);
  }
} catch (error) { check('driver ran', false, String(error?.message ?? error)); }
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
process.exitCode = out.failed ? 1 : 0;
