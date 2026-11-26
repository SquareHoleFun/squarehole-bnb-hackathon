import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { origin, issuer, publicKey, jwk, jwt, identity, deskToken, directories, wallet as claimant } from './fixtures/alpha/helpers.mjs';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { createChain, abi, STARTER } from '../services/alpha/sender/chain.mjs';
import { account, claim, desk, id, scratch, viem } from './fixtures/alpha-sender/helpers.mjs';
import { cycle as drainSender } from './fixtures/alpha-sender/cycle.mjs';
import { shLimit } from '../../../vitest.timeouts.mjs';

describe('alpha sender on local Anvil (no external RPC)', () => {
  let child, pub, wallet, teth, rpcUrl, snapshot, chain, at, contractAbi;
  const owner = account(800);
  // Leave room for confirmation blocks before the explicit midnight transition.
  const start = Date.parse('2026-10-29T23:00:00Z');
  beforeAll(async () => {
    // Built from the repository contracts with `cd packages/contracts && forge build` (offline).
    const artifact = JSON.parse(readFileSync('packages/contracts/out/TestETH.sol/TestETH.json', 'utf8'));
    expect(artifact.metadata.settings.compilationTarget).toEqual({ 'src/test-coins/TestETH.sol': 'TestETH' });
    contractAbi = artifact.abi;
    child = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--accounts', '0', '--chain-id', '11155111',
      '--timestamp', String(start / 1000), '--hardfork', 'cancun'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve('.cache/tmp') });
    rpcUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local Anvil listener did not start')), 8000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Listening on 127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.stderr.on('data', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('local Anvil executable unavailable')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('local Anvil exited before listening (sandbox may deny listeners)')); });
    });
    pub = viem.createPublicClient({ transport: viem.http(rpcUrl), cacheTime: 0 });
    await pub.request({ method: 'anvil_setBlockTimestampInterval', params: [1] });
    wallet = viem.createWalletClient({ account: owner, transport: viem.http(rpcUrl), chain: viem.defineChain({ id: 11155111,
      name: 'fixture', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }) });
    for (const a of [owner, desk]) await pub.request({ method: 'anvil_setBalance', params: [a.address, viem.toHex(100n * 10n ** 18n)] });
    const deploy = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
    teth = (await pub.waitForTransactionReceipt({ hash: deploy })).contractAddress;
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: teth, abi, functionName: 'setAdmitter', args: [desk.address, 20n] }) });
    snapshot = await pub.request({ method: 'evm_snapshot' });
  }, shLimit(45000));
  afterAll(async () => {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  });
  beforeEach(async () => {
    await pub.request({ method: 'evm_revert', params: [snapshot] });
    snapshot = await pub.request({ method: 'evm_snapshot' });
    await pub.request({ method: 'anvil_setBlockTimestampInterval', params: [1] });
    at = start;
    chain = createChain({ rpcUrl, address: desk.address, teth, account: desk, confirmations: 1n });
  });
  const sender = (p, extra = {}) => createSender({ ...p, chain, address: desk.address, teth, mode: 'live', now: () => at, ...extra });
  const balance = n => pub.getBalance({ address: account(n).address });
  const cycle = (s, extra = {}) => drainSender(s, { mine: () => pub.request({ method: 'anvil_mine', params: ['0xc', '0x1'] }), ...extra });
  const progress = (p, n) => JSON.parse(readFileSync(join(p.receipts, `${id(n)}.progress.json`), 'utf8'));
  const hasReceipt = (p, n) => existsSync(join(p.receipts, `${id(n)}.json`));
  it('admits and transfers exactly the starter, then refuses duplicate x ID/address', async () => {
    const p = scratch(); p.put(await claim(1)); p.put(await claim(2, { xId: '1' })); p.put(await claim(1, { id: id(3), xId: '3' }));
    const s = await sender(p);
    try {
      await cycle(s); expect(await balance(1)).toBe(STARTER); expect(await chain.admitted(account(1).address)).toBe(true);
      expect(p.receipt(1).status).toBe('sent');
      expect(p.receipt(2).reason).toBe('X account already claimed'); expect(p.receipt(3).reason).toBe('address already claimed');
    } finally { s.close(); }
  }, shLimit(60000));
  it('already admitted sends only', async () => {
    const c = await claim(1);
    const quote = await chain.quote(c, true);
    await chain.broadcast(await chain.prepare('admit', c, quote, (await chain.nonces()).latest));
    const p = scratch(); p.put(c); const s = await sender(p);
    try { await cycle(s); expect(p.receipt(1).admitTx).toBeNull(); expect(await balance(1)).toBe(STARTER); }
    finally { s.close(); }
  }, shLimit(60000));
  // SH-181 on a real EVM with the real TestETH: both transactions in the pickup cycle, one block, and the receipt only
  // at the production twelve canonical confirmations. Anvil mines only when told, as a 12-second chain would.
  it('the admission and the starter land in one block; the receipt waits for twelve confirmations', async () => {
    const p = scratch(); p.put(await claim(1));
    const final = createChain({ rpcUrl, address: desk.address, teth, account: desk });
    await pub.request({ method: 'evm_setAutomine', params: [false] });
    const s = await sender(p, { chain: final });
    try {
      expect(await s.cycle()).toBe(false);
      const [e] = JSON.parse(readFileSync(join(p.state, 'journal.json'), 'utf8')).entries;
      expect(e.send.nonce).toBe(e.admit.nonce + 1);
      expect(await final.nonces()).toEqual({ latest: e.admit.nonce, pending: e.send.nonce + 1 });
      await pub.request({ method: 'evm_mine' });
      const [admit, send] = await Promise.all([e.admit.hash, e.send.hash].map(hash => pub.getTransactionReceipt({ hash })));
      expect(send.blockNumber).toBe(admit.blockNumber); expect([admit.status, send.status]).toEqual(['success', 'success']);
      expect(await balance(1)).toBe(STARTER); expect(await final.admitted(account(1).address)).toBe(true);
      await pub.request({ method: 'anvil_mine', params: ['0xa', '0x1'] }); // eleven confirmations
      expect(await s.cycle()).toBe(false); expect(() => p.receipt(1)).toThrow();
      await pub.request({ method: 'evm_mine' }); // twelve
      expect(await pub.getBlockNumber()).toBe(admit.blockNumber + 11n);
      expect(await s.cycle()).toBe(true);
      expect(p.receipt(1)).toMatchObject({ status: 'sent', admitTx: e.admit.hash, sendTx: e.send.hash, reason: null });
    } finally { s.close(); await pub.request({ method: 'evm_setAutomine', params: [true] }); }
  }, shLimit(60000));
  // SH-181 af2 on a real node and viem: code at the claimant's address that reverts any call (as a 7702 delegation with a
  // reverting receive would) makes the starter's simulation revert. That is a refusal, not an outage, and no block.
  it('refuses a claimant whose address cannot receive the starter; the next claim is sent', async () => {
    await pub.request({ method: 'anvil_setCode', params: [account(1).address, '0x60006000fd'] }); // PUSH1 0 PUSH1 0 REVERT
    const p = scratch(); p.put(await claim(1)); p.put(await claim(2)); const s = await sender(p);
    try {
      await cycle(s);
      expect(p.receipt(1)).toMatchObject({ status: 'refused', reason: 'address cannot receive the starter', admitTx: null, sendTx: null });
      expect(await balance(1)).toBe(0n); expect(await chain.admitted(account(1).address)).toBe(false);
      expect(p.receipt(2).status).toBe('sent'); expect(await balance(2)).toBe(STARTER);
    } finally { s.close(); }
  }, shLimit(60000));
  // SH-196, SH-198: a valid claim that meets an empty float is not refused any more. It waits, visibly, and goes
  // out once the float is refilled. The malformed ones are still refused, and nothing is spent on any of them.
  it('refuses malformed/unsigned/schema/signature/message claims; a valid claim waits on low float without spending and is sent after the refill', async () => {
    const p = scratch();
    const variants = [c => { c.v = 2; }, c => { delete c.signature; }, c => { c.signature = `0x${'00'.repeat(65)}`; }, c => { c.id = id(99); }];
    for (let i = 0; i < variants.length; i++) {
      const c = await claim(i + 1); variants[i](c); writeFileSync(join(p.queue, `${id(i + 1)}.json`), JSON.stringify(c));
    }
    p.put(await claim(5, { message: 'Signed, but unrelated to this claim' }));
    writeFileSync(join(p.queue, `${id(6)}.json`), '{');
    p.put(await claim(7));
    await pub.request({ method: 'anvil_setBalance', params: [desk.address, viem.toHex(STARTER)] });
    const before = await chain.nonces(), s = await sender(p);
    const waiting = m => m.waitingClaims === 1 && m.lastError === 'insufficient float for starter and gas';
    try {
      expect(await cycle(s, { until: waiting })).toBe(false);
      for (let n = 1; n <= 6; n++) expect(p.receipt(n).status).toBe('refused');
      expect(hasReceipt(p, 7)).toBe(false);
      expect(progress(p, 7)).toMatchObject({ id: id(7), status: 'waiting', reason: 'insufficient float for starter and gas', admitTx: null, sendTx: null });
      expect(s.monitor()).toMatchObject({ queueLength: 1, waitingClaims: 1, lowFloat: true, dayCount: 0 });
      expect(await chain.nonces()).toEqual(before); expect(await balance(7)).toBe(0n);
      expect(await chain.admitted(account(7).address)).toBe(false);
      // A second look changes nothing while the float is still short.
      expect(await cycle(s, { until: waiting })).toBe(false);
      expect(await chain.nonces()).toEqual(before); expect(hasReceipt(p, 7)).toBe(false);
      // The refill: the same claim, never re-submitted, is admitted and paid.
      await pub.request({ method: 'anvil_setBalance', params: [desk.address, viem.toHex(100n * 10n ** 18n)] });
      expect(await cycle(s)).toBe(true);
      expect(p.receipt(7).status).toBe('sent'); expect(await balance(7)).toBe(STARTER);
      expect(await chain.admitted(account(7).address)).toBe(true);
      expect(s.monitor()).toMatchObject({ queueLength: 0, waitingClaims: 0, lowFloat: false, dayCount: 1 });
      for (let n = 1; n <= 6; n++) expect(await balance(n)).toBe(0n);
    } finally { s.close(); }
  }, shLimit(60000));
  // SH-196, SH-198: the day's limit is the sender's allowance, not a refusal. The 21st claim keeps its place, also
  // across a restart, and goes out first on the next UTC day.
  it('sends 20 a day; the 21st keeps its place across a restart and is sent after UTC midnight', async () => {
    const p = scratch(); for (let n = 1; n <= 21; n++) p.put(await claim(n));
    const capped = m => m.dayCount === 20 && m.lastError === 'daily claim limit reached';
    let s = await sender(p);
    try { expect(await cycle(s, { until: capped })).toBe(false); expect(s.monitor()).toMatchObject({ dayCount: 20, queueLength: 1 }); }
    finally { s.close(); }
    for (let n = 1; n <= 20; n++) {
      expect(p.receipt(n).status).toBe('sent'); expect(await balance(n)).toBe(STARTER);
    }
    expect(hasReceipt(p, 21)).toBe(false); expect(await balance(21)).toBe(0n);
    expect((await pub.getBlock()).timestamp / 86400n).toBe(BigInt(start / 1000) / 86400n);
    const sameDay = await chain.nonces();
    s = await sender(p);
    try { expect(await cycle(s, { until: capped })).toBe(false); expect(s.monitor()).toMatchObject({ dayCount: 20, queueLength: 1 }); }
    finally { s.close(); }
    expect(await chain.nonces()).toEqual(sameDay); expect(hasReceipt(p, 21)).toBe(false); expect(await balance(21)).toBe(0n);
    at = Date.parse('2026-10-30T00:00:01Z');
    await pub.request({ method: 'evm_setNextBlockTimestamp', params: [at / 1000] });
    await pub.request({ method: 'evm_mine' }); p.put(await claim(22));
    expect((await pub.getBlock()).timestamp).toBe(BigInt(at / 1000));
    s = await sender(p);
    try {
      expect(await cycle(s)).toBe(true);
      expect(p.receipt(21).status).toBe('sent'); expect(await balance(21)).toBe(STARTER);
      expect(p.receipt(22).status).toBe('sent'); expect(await balance(22)).toBe(STARTER);
      expect(s.monitor()).toMatchObject({ dayCount: 2, queueLength: 0 });
    } finally { s.close(); }
  }, shLimit(60000));
  it.each(['admit+send:journal', 'admit:broadcast', 'send:broadcast', 'receipt:journal'])('recovers %s', async point => {
    const p = scratch(); p.put(await claim(1));
    let s = await sender(p, { checkpoint: async at => { if (at === point) throw new Error('fixture crash'); } });
    await expect(cycle(s)).rejects.toThrow('fixture crash'); s.close();
    s = await sender(p);
    try { await cycle(s); await cycle(s); expect(await balance(1)).toBe(STARTER); expect(p.receipt(1).status).toBe('sent'); }
    finally { s.close(); }
  }, shLimit(60000));
  it('dry-run writes receipts with zero chain transactions', async () => {
    const p = scratch(); p.put(await claim(1)); const before = await chain.nonces(); const s = await sender(p, { mode: 'dry-run' });
    try { await cycle(s); expect(p.receipt(1)).toMatchObject({ status: 'skipped', sendTx: null, admitTx: null }); expect(await chain.nonces()).toEqual(before); }
    finally { s.close(); }
  }, shLimit(60000));
  it('a hard process exit preserves its lock and journal; operator recovery does not double send', async () => {
    const p = scratch(); p.put(await claim(1));
    // A separate process exits without close() immediately after broadcasting the starter.
    const program = `
      const [engineUrl, chainUrl, fixturesUrl, cycleUrl, config] = process.argv.slice(1);
      const { createSender } = await import(engineUrl);
      const { createChain } = await import(chainUrl);
      const { desk } = await import(fixturesUrl);
      const { cycle } = await import(cycleUrl);
      const cfg = JSON.parse(config);
      const chain = createChain({ rpcUrl: cfg.rpcUrl, address: desk.address, teth: cfg.teth, account: desk, confirmations: 1n });
      const sender = await createSender({ ...cfg, address: desk.address, mode: 'live', chain,
        checkpoint: async at => { if (at === 'send:broadcast') process.exit(77); } });
      await cycle(sender);
      sender.close(); process.exit(78);
    `;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', program,
      new URL('../services/alpha/sender/engine.mjs', import.meta.url).href,
      new URL('../services/alpha/sender/chain.mjs', import.meta.url).href,
      new URL('./fixtures/alpha-sender/helpers.mjs', import.meta.url).href,
      new URL('./fixtures/alpha-sender/cycle.mjs', import.meta.url).href,
      JSON.stringify({ queue: p.queue, receipts: p.receipts, state: p.state, rpcUrl, teth })], { stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
    expect(code).toBe(77);
    await expect(sender(p)).rejects.toThrow('lock');
    // We observed that process exit. Preserve provenance exactly as the runbook requires; never guess from age.
    renameSync(join(p.state, 'sender.lock'), join(p.state, 'sender.lock.operator-adopted'));
    const s = await sender(p);
    try { await cycle(s); expect(await balance(1)).toBe(STARTER); expect(p.receipt(1).status).toBe('sent'); }
    finally { s.close(); }
  }, shLimit(60000));
  const read = (functionName, args = []) => pub.readContract({ address: teth, abi: contractAbi, functionName, args });
  const ownerWrite = async (functionName, args) => pub.waitForTransactionReceipt({ hash:
    await wallet.writeContract({ address: teth, abi: contractAbi, functionName, args }) });
  it('W retains ownership; the desk cannot manage admission policy, mint or open the faucet', async () => {
    expect(await read('owner')).toBe(owner.address);
    expect(await read('admitter')).toBe(desk.address);
    expect(await read('admitterPerDay')).toBe(20n);
    expect(await read('open')).toBe(false);
    expect(await read('admitted', [owner.address])).toBe(false);
    for (const [functionName, args] of [['setAdmitter', [desk.address, 50n]], ['admit', [[account(1).address]]], ['setOpen', [true]]]) {
      await expect(pub.simulateContract({ account: desk.address, address: teth, abi: contractAbi, functionName, args })).rejects.toThrow();
    }
    const supply = await read('totalSupply'), p = scratch(); p.put(await claim(1));
    const s = await sender(p);
    try {
      await cycle(s); expect(await read('admitted', [account(1).address])).toBe(true);
      expect(await read('balanceOf', [account(1).address])).toBe(0n);
      expect(await read('nextDripAt', [account(1).address])).toBe(0n);
      expect(await read('totalSupply')).toBe(supply);
      expect(await read('owner')).toBe(owner.address);
    } finally { s.close(); }
  }, shLimit(60000));
  it.each(['zero cap', 'revoked'])('%s blocks a new admission without a starter or reservation', async mode => {
    await ownerWrite('setAdmitter', [mode === 'revoked' ? viem.zeroAddress : desk.address, 0n]);
    const p = scratch(); p.put(await claim(1)); const before = await chain.nonces(), s = await sender(p);
    try {
      await expect(s.cycle()).rejects.toThrow(); expect(await balance(1)).toBe(0n);
      expect(await chain.admitted(account(1).address)).toBe(false); expect(await chain.nonces()).toEqual(before);
      expect(s.monitor().dayCount).toBe(0);
      expect(() => p.receipt(1)).toThrow();
    } finally { s.close(); }
  }, shLimit(60000));
  it('a lower TestETH cap preserves usage through reconfiguration and resets only at UTC midnight', async () => {
    await ownerWrite('setAdmitter', [desk.address, 1n]);
    const p = scratch(); p.put(await claim(1)); const s = await sender(p);
    try {
      await cycle(s); expect(await balance(1)).toBe(STARTER);
      // Admitting an already admitted address costs no quota, even when paused.
      await ownerWrite('setAdmitter', [desk.address, 0n]);
      await pub.simulateContract({ account: desk.address, address: teth, abi: contractAbi, functionName: 'admitOne', args: [account(1).address] });
      await ownerWrite('setAdmitter', [desk.address, 1n]); p.put(await claim(2));
      await expect(s.cycle()).rejects.toThrow(); expect(await balance(2)).toBe(0n);
      expect(await chain.admitted(account(2).address)).toBe(false);
      at = Date.parse('2026-10-30T00:00:00Z');
      await pub.request({ method: 'evm_setNextBlockTimestamp', params: [at / 1000] }); await pub.request({ method: 'evm_mine' });
      await cycle(s); expect(await balance(2)).toBe(STARTER); expect(s.monitor().dayCount).toBe(1);
      expect(await chain.admitted(account(2).address)).toBe(true);
    } finally { s.close(); }
  }, shLimit(60000));
  it('owner removal remains in force after a sent claim; restarts never re-admit or resend it', async () => {
    const p = scratch(); p.put(await claim(1)); let s = await sender(p);
    try { await cycle(s); } finally { s.close(); }
    await ownerWrite('remove', [[account(1).address]]);
    const before = await chain.nonces(); s = await sender(p);
    try {
      await cycle(s); expect(await chain.admitted(account(1).address)).toBe(false);
      expect(await balance(1)).toBe(STARTER); expect(await chain.nonces()).toEqual(before);
    } finally { s.close(); }
  }, shLimit(60000));
  it('approved Privy claim flows API → queue → dry receipt → fresh live claim → TestETH → API receipt', async () => {
    const paths = directories(), p = scratch();
    const cfg = { ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7),
      accessIssuer: issuer, accessAudience: 'fixture-desk' };
    const options = { now: () => at, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) };
    let api = createAlphaApi(cfg, options), cookie, s;
    const request = (path, method = 'GET', body, extra = {}) => api.handle(new Request(`${origin}${path}`, {
      method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const issue = async () => {
      const r = await request(`/alpha/claim/message?address=${claimant.address}`); expect(r.status).toBe(200);
      const c = await r.json();
      expect((await request('/alpha/claim', 'POST', { address: claimant.address, message: c.message,
        signature: await claimant.signMessage({ message: c.message }) })).status).toBe(202);
      return c;
    };
    const receipt = async id => { const r = await request(`/alpha/claim/${id}`); expect(r.status).toBe(200); return r.json(); };
    const integratedSender = mode => sender({ ...p, queue: paths.queueDir, receipts: paths.receiptsDir }, { mode,
      chain: createChain({ rpcUrl, address: desk.address, teth, account: mode === 'live' ? desk : undefined }) });
    try {
      const login = await request('/alpha/session', 'POST', undefined, { 'privy-id-token': jwt(identity('12345', { iat: at / 1000, exp: at / 1000 + 3600 })) });
      expect(login.status).toBe(200); cookie = login.headers.get('set-cookie').split(';')[0];
      expect((await request('/desk/api/decide', 'POST', { xId: '12345', decision: 'approve' }, {
        'Cf-Access-Jwt-Assertion': deskToken({ exp: at / 1000 + 3600 }),
      })).status).toBe(200);
      const dry = await issue(), before = await chain.nonces();
      s = await integratedSender('dry-run'); await cycle(s); s.close(); s = undefined;
      expect(await receipt(dry.id)).toMatchObject({ status: 'skipped', admitTx: null, sendTx: null });
      expect(await chain.nonces()).toEqual(before);
      expect(await chain.admitted(claimant.address)).toBe(false);
      const dryJournal = readFileSync(join(p.state, 'journal.dry.json'), 'utf8');
      api.close(); api = createAlphaApi(cfg, options);
      const live = await issue(); expect(live.id).not.toBe(dry.id);
      s = await integratedSender('live');
      const done = await cycle(s);
      expect(done).toBe(true);
      const result = await receipt(live.id);
      expect(result).toMatchObject({ status: 'sent', reason: null });
      for (const hash of [result.admitTx, result.sendTx]) expect((await pub.getTransactionReceipt({ hash })).status).toBe('success');
      expect(await pub.getBalance({ address: claimant.address })).toBe(STARTER);
      expect(await chain.admitted(claimant.address)).toBe(true);
      expect(readFileSync(join(p.state, 'journal.dry.json'), 'utf8')).toBe(dryJournal);
      expect((await receipt(dry.id)).status).toBe('skipped');
      s.close(); s = await integratedSender('live'); await cycle(s);
      expect(await pub.getBalance({ address: claimant.address })).toBe(STARTER);
      api.close(); api = createAlphaApi(cfg, options);
      expect((await request(`/alpha/claim/message?address=${claimant.address}`)).status).toBe(409);
    } finally { s?.close(); api.close(); }
  }, shLimit(60000));
  it('refuses the RPC after its chain ID changes', async () => {
    await pub.request({ method: 'anvil_setChainId', params: [1] });
    try { await expect(sender(scratch())).rejects.toThrow('Sepolia'); }
    finally { await pub.request({ method: 'anvil_setChainId', params: [11155111] }); }
  }, shLimit(60000));
});
