import { describe, expect, it } from 'vitest';
import { configure } from '../config.mjs';
import { collect } from '../collect.mjs';
import { fixture, rpcFixture, configInput, env, AT, hex } from './drand-fixture.mjs';
import * as d from '../drand.mjs';
const setup = (over = {}) => {
  const h = rpcFixture(), c = configure({ ...configInput(h.f), ...over }, {});
  h.read = () => d.readDrand(c, env, h.f.rpc, { request: h.request, clock: () => h.elapsed });
  h.rows = async () => d.ladder(await h.read(), c, AT + 21600n);
  return h;
};
describe('bounded finalized RPC discovery and reads', () => {
  it('discovers box 0 then registry, skips zero roles, and matches reversed ids', async () => {
    const h = setup(), out = await h.read();
    expect(out.consumers.map(t => [t.name, t.address])).toEqual(h.f.consumers.map(t => [t.name, t.address]));
    expect(out.consumers[0].keys[0]).toMatchObject(h.f.consumers[0].keys[0]);
    const calls = h.calls.filter(c => c.method === 'eth_call');
    expect(calls.filter(c => c.params[1] !== 'latest').every(c => c.params[1] === hex(h.f.rpc.block))).toBe(true);
    expect(calls.filter(c => c.params[1] === 'latest').every(c => c.params[0].data.startsWith(d.SELECTORS.wordOf))).toBe(true);
    expect(out.timestamp).toBe(h.f.rpc.timestamp);
    expect(out.block).toBe(h.f.rpc.block);
    expect(out.consumers[0].drand).toBe(h.f.consumers[0].drand.toLowerCase());
    expect(out.consumers[0].backups).toEqual(h.f.consumers[0].backups);
    expect(d.ladder(out, configure(configInput(h.f), {}), AT).some(r => r.reason === 'source-mismatch')).toBe(false);
    expect(h.posts.every(p => !Array.isArray(p.payload) || p.payload.length <= 50)).toBe(true);
    expect(h.calls.every(c => ['eth_call', 'eth_getCode', 'eth_estimateGas'].includes(c.method))).toBe(true);
    expect(h.calls).toHaveLength(18); expect(h.posts).toHaveLength(8);
  });
  it('batches only to the limit, caps oldest keys per tickets and reports omissions', async () => {
    const h = setup({ drandMaxKeys: '2', rpcBatchSize: '2' }), t = h.f.consumers[0];
    t.status.slots = '1'; t.status.wordRequestedAt = String(AT); t.status.drawsSettled = '0'; t.status.drawsRequested = '5';
    t.keys = Array.from({ length: 6 }, (_, i) => ({ ...t.keys[0], key: String(i) }));
    const out = await h.read();
    expect(out.consumers[0].keys.map(k => k.key)).toEqual(['0', '1']);
    expect(out.consumers[0].skipped).toBe('4');
    expect(d.ladder(out, configure({ ...configInput(h.f), drandMaxKeys: '2', rpcBatchSize: '2' }, {}), AT).find(r => r.reason === 'keys-not-read').detail).toContain('4 keys not read');
    expect(h.posts.every(p => Array.isArray(p.payload) && p.payload.length <= 2)).toBe(true);
  });
  it('batch size one sends plain objects', async () => {
    const h = setup({ rpcBatchSize: '1' }); await h.read();
    expect(h.posts.length).toBeGreaterThan(5); expect(h.posts.every(p => !Array.isArray(p.payload))).toBe(true);
  });
  for (const fault of ['transport', 'http', 'missing-id', 'wrong-id', 'error', 'short-word', 'long-word', 'bad-hex', 'overflow', 'zero-request', 'wrong-graduation-clock']) {
    it(`isolates ${fault} to its tickets, with no partial rows or secret errors`, async () => {
      const h = setup({ rpcBatchSize: '2' });
      const request = h.request; h.request = (...args) => { h.status = 200; return request(...args); };
      h.fault = ({ call, name, args, result }) => {
        const target = fault === 'wrong-graduation-clock' ? h.f.consumers[1] : h.f.consumers[0];
        if (name !== 'requestOf' || args[0].toLowerCase() !== target.address) return;
        if (fault === 'transport') throw new Error('FAKE_RPC_SECRET');
        if (fault === 'missing-id') return 'omit';
        if (fault === 'wrong-id') return { jsonrpc: '2.0', id: call.id + 100, result };
        if (fault === 'error') return { jsonrpc: '2.0', id: call.id, error: { message: 'FAKE_RPC_SECRET' } };
        if (fault === 'http') { h.status = 503; return; }
        const bad = { 'short-word': '0x00', 'long-word': result + '0'.repeat(64), 'bad-hex': '0xzz',
          overflow: '0x' + 'f'.repeat(128), 'zero-request': '0x' + '0'.repeat(128),
          'wrong-graduation-clock': '0x' + (AT + 1n).toString(16).padStart(64, '0') + result.slice(66) }[fault];
        return { jsonrpc: '2.0', id: call.id, result: bad };
      };
      const out = await h.rows(), unknown = out.filter(r => r.status === 'unknown');
      expect(unknown).toMatchObject([{ reason: 'read-failed', subject: h.f.consumers[fault === 'wrong-graduation-clock' ? 1 : 0].address }]);
      expect(out.filter(r => r.reason === '6h')).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain('FAKE_RPC_SECRET');
    });
  }
  for (const discovery of ['tickets', 'boxCount', 'roleOf']) it(`discovery failure in ${discovery} makes the whole check unknown`, async () => {
    const h = setup(); h.fault = ({ name, call }) => name === discovery ? { id: call.id, error: {} } : undefined;
    expect(await h.rows()).toMatchObject([{ status: 'unknown', reason: 'read-failed' }]);
  });
  it('reads a mismatched consumer on its own source and produces the critical row', async () => {
    const h = setup(); h.f.consumers[0].source = '0x' + 'ab'.repeat(20);
    expect((await h.rows()).find(r => r.reason === 'source-mismatch')).toMatchObject({ level: 'critical', subject: h.f.consumers[0].address });
  });
  it('malformed latest and finalized word replies invalidate only their tickets', async () => {
    for (const at of ['latest', hex(fixture().rpc.block)]) {
      const h = setup({ rpcBatchSize: '1' }); h.fault = ({ name, call, args }) => name === 'wordOf' && call.params[1] === at && args[0].toLowerCase() === h.f.consumers[0].address
        ? { jsonrpc: '2.0', id: call.id, result: '0x1234' } : undefined;
      expect((await h.rows()).filter(r => r.status === 'unknown')).toMatchObject([{ subject: h.f.consumers[0].address, reason: 'read-failed' }]);
    }
  });
  it('skips a zero box 0 address', async () => {
    const h = setup(); h.f.box0 = '0x' + '0'.repeat(40);
    expect((await h.read()).consumers.map(t => t.name)).toEqual(['registry box 0']);
  });
  it('stops new POSTs at 40 seconds and marks unfinished tickets unknown', async () => {
    const h = setup(); h.step = 7000;
    const out = await h.rows();
    expect(h.posts.every(p => p.at < 40000)).toBe(true);
    expect(out.some(r => r.status === 'unknown' && r.reason === 'read-time-limit')).toBe(true);
    expect(out.filter(r => r.reason === 'read-time-limit').every(r => /^0x/.test(r.subject))).toBe(true);
  });
  it('collect runs independently of failed keeper files and only after successful rpc', async () => {
    const h = setup(); const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, async () => { throw new Error('offline'); }]));
    const ports = { files, request: async (url, init) => init.method === 'POST' ? h.request(url, init) : { status: 200, body: '{}' } };
    const c = configure(configInput(h.f), {}), out = await collect(c, env, AT + 21600n, ports);
    expect(out.drand.consumers).toHaveLength(2); expect(out.view).toBeUndefined();
    h.fault = () => { throw new Error('failed'); }; h.calls = [];
    const failed = await collect(c, env, AT, ports);
    expect(failed.rpc).toBeUndefined(); expect(failed.drand).toBeUndefined();
    expect(h.calls.map(c => c.method)).toEqual(['eth_chainId']);
  });
});
describe('wordOf gas canary', () => {
  for (const [record, difference, status] of [['osaka', '10480', 'ok'], ['amsterdam', '10880', 'ok'], ['below', '24999', 'ok'], ['threshold', '25000', 'alert']]) {
    it(`${record}: ${difference} execution gas gives ${status}`, async () => {
      const h = setup(); h.f.consumers[0].status.wordAcceptedAt = String(AT); h.estimate = h.f.estimates[record];
      const out = await h.read(); expect(out.canary.status).toBe(status);
      expect(out.canary.detail).toContain(`${difference} gas`);
      if (status === 'alert') expect(out.canary).toMatchObject({ reason: 'wordof-gas-high', level: 'alert' });
      const estimates = h.calls.filter(c => c.method === 'eth_estimateGas');
      expect(h.calls).toHaveLength(21); expect(h.posts).toHaveLength(10);
      expect(estimates).toHaveLength(2); expect(estimates[0].params[0].data).toBe(estimates[1].params[0].data);
      expect(estimates.every(c => c.params[1] === 'latest')).toBe(true);
      expect(h.calls.find(c => c.method === 'eth_getCode').params).toEqual(['0x000000000000000000000000000000000000dEaD', 'latest']);
    });
  }
  for (const issue of ['code', 'estimate', 'zero', 'negative']) it(`${issue} is unknown`, async () => {
    const h = setup(); h.f.consumers[0].status.wordAcceptedAt = String(AT);
    if (issue === 'code') h.f.code = '0x00';
    if (issue === 'estimate') h.fault = ({ call }) => call.method === 'eth_estimateGas' ? { id: call.id, error: {} } : undefined;
    if (issue === 'zero') h.estimate = h.f.estimates.baseline;
    if (issue === 'negative') h.estimate = '1';
    expect((await h.read()).canary.status).toBe('unknown');
  });
  it('chooses an accepted graduation before an earlier usable draw, then falls back to that draw', async () => {
    const h = setup(); h.f.consumers[0].keys[0].word = '1'; h.f.consumers[0].keys[0].readyAt = String(AT + 20n);
    h.f.consumers[1].status.wordAcceptedAt = String(AT + 30n);
    expect((await h.read()).canary.detail).toContain('registry box 0 tickets');
    h.f.consumers[1].status.wordAcceptedAt = '0';
    expect((await h.read()).canary.detail).toContain('key 3');
  });
  it('no posted word gives ok without gas calls', async () => {
    const h = setup(); expect((await h.read()).canary).toEqual({ status: 'ok', reason: 'no-posted-word' });
    expect(h.calls.every(c => c.method === 'eth_call')).toBe(true);
  });
  it('canary shares the read time budget', async () => {
    const h = setup(); h.f.consumers[0].status.wordAcceptedAt = String(AT);
    h.f.consumers[1].status.wordRequestedAt = '0'; h.f.consumers[1].keys = [];
    h.fault = ({ name }) => { if (name === 'failureWindowEnds') h.elapsed = 40000; };
    expect((await h.read()).canary).toMatchObject({ status: 'unknown', reason: 'read-time-limit' });
    expect(h.posts.every(p => p.at < 40000)).toBe(true);
  });
});

describe('backed source reads share the serial budget', () => {
  it('reads DRAND once and backupOf once per unsettled round, including a fixed usable word', async () => {
    const h = setup({ rpcBatchSize: '2' }), t = h.f.consumers[0], k = t.keys[0];
    t.status.drawsRequested = '5';
    t.keys.push({ ...k, key: '4' }, { ...k, key: '5', round: String(BigInt(k.round) + 1n), word: '123', readyAt: String(AT + 100n) });
    t.backups[t.keys[2].round] = { startedAt: String(AT + 10n), targetBlock: '1000', fixedAt: String(AT + 100n), mix: '12' };
    const out = await h.read();
    expect(out.consumers[0].backups).toEqual(t.backups);
    for (const [name, count] of [['DRAND', 1], ['backupOf', 2]]) {
      const calls = h.calls.filter(c => c.params[0]?.data?.startsWith(d.SELECTORS[name]));
      expect(calls).toHaveLength(count);
      expect(calls.every(c => c.params[0].to === t.source.toLowerCase() && c.params[1] === hex(h.f.rpc.block))).toBe(true);
    }
    expect(h.posts.every(p => p.payload.length <= 2)).toBe(true);
  });
  for (const name of ['DRAND', 'backupOf']) it(`failed ${name} makes only box 0 unknown`, async () => {
    const h = setup(); h.fault = ({ name: fn, call }) => fn === name ? { jsonrpc: '2.0', id: call.id, error: {} } : undefined;
    const rows = await h.rows();
    expect(rows.filter(r => r.subject === h.f.consumers[0].address)).toEqual([
      expect.objectContaining({ status: 'unknown', reason: 'read-failed' })]);
    expect(rows.some(r => r.status === 'ok' || r.reason.startsWith('backup-'))).toBe(false);
    expect(rows.some(r => r.reason === '6h' && r.subject.startsWith(h.f.consumers[1].address))).toBe(true);
  });
  it('reads the backed source DRAND at finalized before applying the source rule', async () => {
    const h = setup(); h.f.consumers[0].drand = '0x' + 'ab'.repeat(20);
    expect((await h.rows()).find(r => r.reason === 'source-mismatch')).toMatchObject({ level: 'critical' });
  });
  it('backupOf uses the same 40 second budget and no POSTs overlap', async () => {
    const h = setup({ rpcBatchSize: '1' }), t = h.f.consumers[0], k = t.keys[0];
    t.status.drawsRequested = '4'; t.keys.push({ ...k, key: '4', round: String(BigInt(k.round) + 1n) });
    t.backups[t.keys[1].round] = { ...t.backups[k.round] };
    h.fault = ({ name }) => { if (name === 'backupOf') h.elapsed = 40000; };
    let active = false; const request = h.request;
    h.request = async (...args) => { expect(active).toBe(false); active = true; try { return await request(...args); } finally { active = false; } };
    const rows = await h.rows();
    expect(h.calls.some(c => c.params[0]?.data?.startsWith(d.SELECTORS.backupOf))).toBe(true);
    expect(h.posts.every(p => p.at < 40000)).toBe(true);
    expect(rows.some(r => r.status === 'unknown' && r.reason === 'read-time-limit')).toBe(true);
  });
});

// Expand the recorded v2 state with distinct public addresses; all replies still use the fake port.
function registry(count = 300) {
  const f = fixture(), template = f.consumers[1];
  f.box0 = '0x' + '0'.repeat(40);
  f.consumers = Array.from({ length: count }, (_, i) => ({ ...structuredClone(template),
    name: `registry box ${i}`, address: '0x' + (1000n + BigInt(i) * 2n).toString(16).padStart(40, '0'),
    vault: '0x' + (1001n + BigInt(i) * 2n).toString(16).padStart(40, '0') }));
  f.roles = f.consumers.map(t => t.address);
  const h = rpcFixture(f); h.step = 120;
  h.cfg = configure(configInput(f), {});
  h.read = () => d.readDrand(h.cfg, env, f.rpc, { request: h.request, clock: () => h.elapsed });
  return h;
}
const has = (call, name) => call.params[0]?.data?.startsWith(d.SELECTORS[name]);
const stageOf = call => {
  if (['status', 'source', 'vault'].some(n => has(call, n))) return 'A';
  if (has(call, 'DRAND')) return 'B';
  if (['gateOpenedAt', 'failureWindowEnds'].some(n => has(call, n))) return 'C';
  if (has(call, 'wordOf') && call.params[1] === 'latest') return 'E';
  if (['requestOf', 'wordOf'].some(n => has(call, n))) return 'D';
  if (has(call, 'backupOf')) return 'F';
  return 'discovery';
};
it('300 v2 boxes finish at 120 ms per POST, with each stage packed across tickets', async () => {
  const h = registry();
  // One third also need their graduation gate; each still has a pending draw.
  h.f.consumers.forEach((t, i) => {
    if (i % 3 === 0) {
      t.status.wordRequestedAt = '0'; t.status.drawsRequested = '1'; t.keys[0].key = '1';
    }
  });
  const out = await h.read();
  expect(out.consumers).toHaveLength(300);
  expect(out.consumers.filter(t => t.error)).toEqual([]);
  expect(h.elapsed).toBeLessThan(40000);
  const stages = h.posts.map(p => {
    const calls = Array.isArray(p.payload) ? p.payload : [p.payload];
    const stages = [...new Set(calls.map(stageOf))]; expect(stages).toHaveLength(1);
    return { stage: stages[0], count: calls.length };
  }).filter(p => p.stage !== 'discovery');
  expect(stages.map(p => p.stage)).toEqual(stages.map(p => p.stage).sort());
  for (const stage of ['A', 'C', 'D', 'E']) {
    const posts = stages.filter(p => p.stage === stage), calls = posts.reduce((n, p) => n + BigInt(p.count), 0n);
    expect(calls).toBeGreaterThan(0n);
    expect(BigInt(posts.length)).toBe((calls + 49n) / 50n);
  }
});
it('terminal and idle tickets make no gate or key calls; only unrequested live graduation reads the gate', async () => {
  const h = registry(4), [terminal, idle, unrequested, pending] = h.f.consumers;
  terminal.status.terminalAt = String(AT);
  idle.status.slots = '0'; idle.status.wordRequestedAt = '0'; idle.keys = [];
  unrequested.status.wordRequestedAt = '0'; unrequested.keys = [];
  const out = await h.read(); expect(out.consumers.some(t => t.error)).toBe(false);
  const gates = h.calls.filter(c => has(c, 'gateOpenedAt') || has(c, 'failureWindowEnds'));
  expect(gates).toHaveLength(2); expect(gates.every(c => c.params[0].to === unrequested.vault)).toBe(true);
  const keys = h.calls.filter(c => has(c, 'requestOf') || has(c, 'wordOf'));
  expect(keys).toHaveLength(3);
  expect(keys.every(c => c.params[0].data.includes(pending.address.slice(2)))).toBe(true);
});
for (const fault of ['transport', 'bad-reply']) it(`one ${fault} batch makes exactly its tickets unknown`, async () => {
  const h = registry(60), request = h.request; let failed;
  h.request = async (url, init) => {
    const calls = JSON.parse(init.body);
    if (!failed && calls.some(c => has(c, 'status')) && calls.some(c => c.params[0].to === h.f.consumers[20].address)) {
      failed = calls;
      if (fault === 'transport') throw new Error('FAKE_RPC_SECRET');
      return { status: 200, body: '[]' };
    }
    return request(url, init);
  };
  const out = await h.read(), affected = [...new Set(failed.map(c => c.params[0].to))];
  expect(affected.length).toBeGreaterThan(1);
  expect(out.consumers.filter(t => t.error).map(t => t.address)).toEqual(affected);
  expect(out.consumers.filter(t => t.error).every(t => t.error === 'read-failed')).toBe(true);
  expect(out.consumers.filter(t => !t.error).every(t => t.keys.length === 1 && t.keys[0].latestWord === '0')).toBe(true);
  expect(JSON.stringify(out)).not.toContain('FAKE_RPC_SECRET');
});
it('a limit between latest batches preserves every tickets whose reads completed', async () => {
  const h = registry(60);
  h.fault = ({ name, call }) => { if (name === 'wordOf' && call.params[1] === 'latest') h.elapsed = 40000; };
  const out = await h.read();
  expect(out.consumers.filter(t => !t.error)).toHaveLength(50);
  expect(out.consumers.slice(50).every(t => t.error === 'read-time-limit')).toBe(true);
  expect(h.posts.every(p => p.at < 40000)).toBe(true);
});
