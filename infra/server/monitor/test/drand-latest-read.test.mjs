import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configure } from '../config.mjs';
import { ladder, readDrand, rescueWork } from '../drand.mjs';
import { rpcFixture, configInput, env, hex } from './drand-fixture.mjs';
const record = JSON.parse(readFileSync(new URL('./fixtures/drand/backup.json', import.meta.url), 'utf8'));
const now = BigInt(record.roundTime) + 440000n;
function setup(state = 'start', size = '2') {
  const h = rpcFixture(), t = h.f.consumers[0];
  t.backups[record.round] = { ...record[state] };
  Object.assign(h.f.rpc, { block: '18120', latestBlock: '18184', timestamp: String(now) });
  h.cfg = configure({ ...configInput(h.f), rpcBatchSize: size }, {});
  h.read = () => readDrand(h.cfg, env, h.f.rpc, { request: h.request, clock: () => h.elapsed });
  return h;
}
for (const size of ['1', '2', '50']) it(`reads latest once for several unfixed rounds in serial batches of ${size}`, async () => {
  const h = setup('start', size), t = h.f.consumers[0], k = t.keys[0];
  t.status.drawsRequested = '5';
  t.keys.push({ ...k, key: '4' }, { ...k, key: '5', round: String(BigInt(k.round) + 1n) });
  t.backups[t.keys[2].round] = { ...record.start };
  const request = h.request; let active = false;
  h.request = async (...args) => {
    expect(active).toBe(false); active = true;
    try { return await request(...args); } finally { active = false; }
  };
  const out = await h.read();
  expect(out.latestBlock).toBe('18184');
  expect(out.consumers.some(t => t.error)).toBe(false);
  expect(h.calls.filter(c => c.method === 'eth_blockNumber')).toMatchObject([{ params: [] }]);
  expect(h.calls.findIndex(c => c.method === 'eth_blockNumber')).toBeGreaterThan(h.calls.findIndex(c => c.method === 'eth_call'));
  expect(h.calls.filter(c => c.method === 'eth_call' && c.params[1] !== 'latest').every(c => c.params[1] === hex(out.block))).toBe(true);
  expect(h.posts.every(p => size === '1' ? !Array.isArray(p.payload) : BigInt(p.payload.length) <= BigInt(size))).toBe(true);
});
for (const state of ['unstarted', 'fixed']) it(`makes no latest block call for ${state} backups and keeps the 18-call fixture`, async () => {
  const h = setup(state, '50'), out = await h.read();
  expect(out.latestBlock).toBeUndefined();
  expect(h.calls.filter(c => c.method === 'eth_blockNumber')).toHaveLength(0);
  expect(h.calls).toHaveLength(18); expect(h.posts).toHaveLength(8);
});
it('adds exactly one call and one POST only while a backup is started and unfixed', async () => {
  const h = setup('start', '50'); await h.read();
  expect(h.calls).toHaveLength(19); expect(h.posts).toHaveLength(9);
});
for (const fault of ['below-finalized', 'transport', 'http', 'error', 'missing-id', 'bad-hex', 'empty', 'number', 'null', 'overflow', 'before-limit', 'at-limit']) {
  it(`latest ${fault} gives only an unknown box 0 row and admits no fix`, async () => {
    const h = setup(), request = h.request;
    h.fault = ({ call, name }) => {
      if (fault === 'before-limit' && name === 'wordOf' && call.params[1] === 'latest'
        && call.params[0].to === h.f.consumers[1].source.toLowerCase()) h.elapsed = 40000;
      if (call.method !== 'eth_blockNumber') return;
      if (fault === 'transport') throw new Error('FAKE_RPC_SECRET');
      if (fault === 'http') { h.status = 503; return; }
      if (fault === 'error') return { jsonrpc: '2.0', id: call.id, error: { message: 'FAKE_RPC_SECRET' } };
      if (fault === 'missing-id') return 'omit';
      if (fault === 'at-limit') { h.elapsed = 40000; return; }
      const result = { 'below-finalized': hex(18119n), 'bad-hex': '0xzz', empty: '0x', number: 18184,
        null: null, overflow: '0x1' + '0'.repeat(64) }[fault];
      return { jsonrpc: '2.0', id: call.id, result };
    };
    h.request = (...args) => { h.status = 200; return request(...args); };
    const out = await h.read(), rows = ladder(out, h.cfg, now), t = out.consumers[0];
    expect(rows.filter(r => r.subject?.startsWith(t.address))).toEqual([
      expect.objectContaining({ status: 'unknown', reason: fault.endsWith('limit') ? 'read-time-limit' : 'read-failed' }),
    ]);
    expect(out.latestBlock).toBeUndefined();
    expect(rescueWork({ ...out, consumers: [t] }, h.cfg, now)).toBeNull();
    expect(rows.some(r => r.subject?.startsWith(out.consumers[1].address) && r.status === 'alert')).toBe(true);
    expect(h.posts.every(p => p.at < 40000)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('FAKE_RPC_SECRET');
  });
}
