import { describe, expect, it } from 'vitest';
import { createReadOnlyRpc, smoke } from '../../../scripts/keeper/amsterdam-estimate-smoke.mjs';

function fixture({ override = true, estimate = '0x32a1f' } = {}) {
  const calls = [], sleeps = [];
  const sender = `0x${'12'.repeat(20)}`, recipient = `0x${'34'.repeat(20)}`;
  const header = { slotNumber: '0x123', blockAccessListHash: `0x${'ab'.repeat(32)}`,
    gasLimit: '0x1c9c380', baseFeePerGas: '0x1' };
  const config = { current: { activationTime: 1791294816 } };
  const rpc = createReadOnlyRpc('https://fake.invalid', {
    sleep: async ms => { sleeps.push(ms); },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      const { method, params } = request;
      let result;
      if (method === 'eth_chainId') result = '0xaa36a7';
      else if (method === 'eth_config') result = config;
      else if (method === 'eth_getBlockByNumber') result = header;
      else if (method === 'eth_getCode') result = '0x';
      else if (method === 'eth_getTransactionCount' || method === 'eth_getBalance') result = '0x0';
      else if (method === 'eth_estimateGas') {
        if (!override && params.length === 3) return Response.json({ jsonrpc: '2.0', id: request.id,
          error: { code: -32602, message: 'state override unsupported' } });
        result = estimate;
      } else throw new Error(`unexpected ${method}`);
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  });
  return { rpc, sender, recipient, header, config, calls, sleeps };
}

describe('AMST-05 offline checks of the manual smoke (never live in gates)', () => {
  it('checks fork, header, override-funded transfer and local over-cap refusal with paced read-only RPC', async () => {
    const h = fixture();
    expect(await smoke(h)).toEqual({ estimate: '207391', funding: 'state override', aboveCap: 'refused' });
    expect(h.sleeps).toEqual(h.calls.slice(1).map(() => 2100));
    const estimate = h.calls.find(c => c.method === 'eth_estimateGas');
    expect(estimate.params[0]).toMatchObject({ from: h.sender, to: h.recipient, value: '0x1' });
    expect(estimate.params[1]).toBe('pending');
    expect(estimate.params[2][h.sender].balance).toBeDefined();
    await expect(h.rpc('eth_sendRawTransaction', ['0x'])).rejects.toThrow('read-only');
    expect(h.calls).toHaveLength(7);
  });
  it('falls back only to an explicitly supplied funded sender when overrides are unsupported', async () => {
    const h = fixture({ override: false, estimate: '0x31f38' });
    expect(await smoke({ ...h, fundedSender: true })).toMatchObject({ funding: 'existing balance', estimate: '204600' });
    expect(h.calls.filter(c => c.method === 'eth_estimateGas').map(c => c.params.length)).toEqual([3, 2]);
    expect(h.sleeps).toEqual(h.calls.slice(1).map(() => 2100));
    await expect(smoke(fixture({ override: false }))).rejects.toThrow('funded public sender');
  });
  it.each(['fork', 'header', 'low estimate', 'high estimate'])('refuses a wrong %s', async failure => {
    const h = fixture({ estimate: failure === 'low estimate' ? '0x5208' : failure === 'high estimate' ? '0x152c67c' : '0x32a1f' });
    if (failure === 'fork') h.config.current.activationTime = 1;
    if (failure === 'header') h.header.slotNumber = undefined;
    await expect(smoke(h)).rejects.toThrow();
  });
});
