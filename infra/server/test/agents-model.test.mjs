import { describe, it, expect, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { createServer } from 'node:http';
import { messagesClient, payloadFor } from '../services/agents/model.mjs';
import { createAgents } from '../services/agents/engine.mjs';
import { config, prompts, guest, expense, response, pay, scratch, fakeChain } from './fixtures/agents/helpers.mjs';

describe('Messages fetch transport without external requests', () => {
  it('sends the fixed model, bounded output and API key header; never tools or retries', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(response(pay))));
    const call = messagesClient('fixture-key', { fetch: request });
    await call(payloadFor(config(), prompts, guest()));
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('fixture-key'); expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048 });
    expect(init.body).not.toContain('fixture-key'); expect(JSON.parse(init.body).tools).toBeUndefined();
    request.mockResolvedValue(new Response('fixture upstream secret', { status: 429 }));
    await expect(call({})).rejects.toThrow('model request refused'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('refuses oversized replies and cancels requests', async () => {
    const call = messagesClient('fixture-key', { fetch: async () => new Response('x'.repeat(65537)) });
    await expect(call({})).rejects.toThrow('too large');
    const controller = new AbortController(); controller.abort();
    const abort = messagesClient('fixture-key', { fetch: async (_url, init) => { init.signal.throwIfAborted(); } });
    await expect(abort({}, controller.signal)).rejects.toThrow();
  });
});

describe('local HTTP stand-in model (loopback only)', () => {
  it('delivers fixed valid, malformed, over-cap, off-list and refused outputs over plain fetch', async () => {
    const answers = [response(pay), response('not json'), response({ ...pay, amountRaw: '300000001' }),
      response({ ...pay, payee: 'outsider' }), { ...response('I cannot help'), stop_reason: 'refusal' }];
    let calls = 0;
    const server = createServer((req, res) => {
      expect(req.url).toBe('/v1/messages'); expect(req.headers['x-api-key']).toBe('fixture-key');
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        expect(JSON.parse(body).model).toBe('claude-haiku-4-5-20251001');
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answers[calls++]));
      });
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const call = messagesClient('fixture-key', { endpoint: `http://127.0.0.1:${server.address().port}/v1/messages` });
      for (let i = 0; i < answers.length; i++) {
        const disk = scratch(), chain = fakeChain();
        const agent = await createAgents({ ...disk, config: config(), prompts, mode: 'dry-run', chain, model: call, jobs: () => [expense()] });
        try {
          await agent.cycle(); expect(disk.journal().actions[0].status).toBe(i === 0 ? 'dry-run' : 'refused');
          expect(chain.broadcast).not.toHaveBeenCalled();
        } finally { agent.close(); }
      }
      expect(calls).toBe(5);
    } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }, shLimit(30000));
});
