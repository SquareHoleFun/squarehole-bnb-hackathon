import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgents } from '../services/agents/engine.mjs';
import { validateConfig, validateDecision, usd, AI_DISCLOSURE } from '../services/agents/policy.mjs';
import { config, prompts, guest, expense, month, pay, response, scratch, fakeChain } from './fixtures/agents/helpers.mjs';

async function fixture({ jobs = [guest()], answer = { action: 'reply', text: 'Check-in is at 3 pm.' }, mode = 'dry-run', ...options } = {}) {
  const disk = scratch(), chain = fakeChain(), model = vi.fn(async () => response(answer));
  const agent = await createAgents({ ...disk, config: config(), prompts, mode, jobs: () => jobs, chain, model,
    now: () => Date.parse('2026-10-29T12:00:00Z'), ...options });
  return { ...disk, chain, model, agent };
}
describe('agents bounded policy', () => {
  it('uses exact decimal dollars and a fixed Sepolia role policy', () => {
    expect(usd('2')).toBe(2000000000n);
    expect(() => usd(2)).toThrow(); expect(() => usd('1e3')).toThrow();
    expect(validateConfig(config())).toMatchObject({ chainId: '11155111' });
    for (const c of [{ ...config(), chainId: '1' }, { ...config(), pricingReviewed: false },
      { ...config(), bookkeeper: { ...config().bookkeeper, key: 'forbidden' } },
      { ...config(), manager: { ...config().manager, weeklyCapRaw: '300000001' } }]) expect(() => validateConfig(c)).toThrow();
  });
  it.each([
    { ...pay, amountRaw: '300000001' }, { ...pay, amountRaw: 100 }, { ...pay, amountRaw: '1.5' },
    { ...pay, amountRaw: '0' }, { ...pay, payee: 'attacker' }, { ...pay, data: '0x' },
    { action: 'approve', amountRaw: '1' }, { action: 'refusal' }, null,
  ])('rejects invalid model action %j', decision => {
    expect(() => validateDecision(decision, expense(), config())).toThrow();
  });
  it('separates replies, expenses and statements; the model cannot select a transaction function', () => {
    expect(() => validateDecision(pay, guest(), config())).toThrow();
    expect(() => validateDecision(pay, month, config())).toThrow();
    expect(validateDecision({ action: 'statement', markdown: '# September' }, month, config()).action).toBe('statement');
  });
});
describe('agents durable runner', () => {
  it('adds an AI disclosure to the first reply to every guest, acts once per wake and persists deduplication', async () => {
    const f = await fixture({ jobs: [guest(), guest('guest-2')] });
    try {
      await f.agent.cycle(); expect(f.model).toHaveBeenCalledOnce();
      const first = JSON.parse(readFileSync(join(f.root, 'replies/dry-run-guest-1.json'), 'utf8'));
      expect(first.text.startsWith(AI_DISCLOSURE)).toBe(true);
      await f.agent.cycle(); expect(f.model).toHaveBeenCalledTimes(2);
      await f.agent.cycle(); expect(f.model).toHaveBeenCalledTimes(2);
      expect(f.journal().calls[0]).toMatchObject({ inputTokens: '100', outputTokens: '50', decision: { action: 'reply' } });
      expect(f.journal().calls[0].promptHash).toMatch(/^[a-f0-9]{64}$/);
    } finally { f.agent.close(); }
  });
  it('dry-run evaluates payments but never prepares or broadcasts a transaction', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay });
    try {
      await f.agent.cycle(); expect(f.chain.remaining).toHaveBeenCalled();
      expect(f.chain.prepare).not.toHaveBeenCalled(); expect(f.chain.broadcast).not.toHaveBeenCalled();
      expect(f.journal().actions[0]).toMatchObject({ status: 'dry-run', decision: pay });
    } finally { f.agent.close(); }
  });
  it.each(['not JSON', response(pay).content, { ...pay, amountRaw: '300000001' }, { ...pay, payee: 'elsewhere' }, { action: 'refusal' }])('journals refusal without sending: %j', async answer => {
    const f = await fixture({ jobs: [expense()], answer, mode: 'live' });
    try { await f.agent.cycle(); expect(f.journal().actions[0].status).toBe('refused'); expect(f.chain.broadcast).not.toHaveBeenCalled(); }
    finally { f.agent.close(); }
  });
  it('refuses low remaining allowance', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.remaining.mockResolvedValue(1n);
    try {
      await f.agent.cycle(); await f.agent.cycle();
      expect(f.journal().actions[0].status).toBe('allowance-low'); expect(f.chain.prepare).not.toHaveBeenCalled();
      expect(f.agent.health().reason).toBe('allowance-low');
    }
    finally { f.agent.close(); }
  });
  it.each([
    ['remaining', false], ['remaining', true], ['prepare', false], ['prepare', true],
  ])('resumes an accepted payment after transient %s failure (restart: %s)', async (method, restart) => {
    const jobs = [expense(), expense('expense-2')];
    const f = await fixture({ jobs, answer: pay, mode: 'live' });
    let agent = f.agent;
    f.chain[method].mockRejectedValueOnce(new Error('transient RPC timeout'));
    f.chain.broadcast.mockImplementation(async tx => {
      expect(f.journal().sends).toEqual([{ ...tx, status: 'broadcast-unknown' }]);
      expect(f.journal().actions[0].status).toBe('payment-pending');
      return tx.hash;
    });
    try {
      // Inspect the durable checkpoint even on the old implementation's thrown RPC failure.
      await agent.cycle().catch(() => {});
      const checkpoint = f.journal();
      expect(checkpoint.actions[0]).toMatchObject({ status: 'decision-accepted', decision: pay });
      expect(checkpoint.calls[0]).toMatchObject({ status: 'answered', decision: pay });
      expect(checkpoint.sends).toEqual([]); expect(f.chain.broadcast).not.toHaveBeenCalled();
      expect(agent.health().reason).toBe('payment-preparation-pending');
      // The accepted expense must survive removal from the feed and precede new work.
      jobs.shift();
      if (restart) {
        agent.close();
        agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'live',
          chain: f.chain, model: f.model, jobs: () => jobs, dailyBudgetUsd: '0.000000001' });
      }
      await agent.cycle();
      expect(agent.health().reason).toBe('submitted');
      expect(f.chain.remaining).toHaveBeenCalledTimes(2);
      expect(f.chain.prepare).toHaveBeenCalledTimes(method === 'prepare' ? 2 : 1);
      expect(f.chain.prepare).toHaveBeenLastCalledWith(pay);
      expect(f.chain.broadcast).toHaveBeenCalledOnce(); expect(f.model).toHaveBeenCalledOnce();
      expect(f.journal().calls).toEqual(checkpoint.calls); expect(f.journal().days).toEqual(checkpoint.days);
      // A pending transaction must not enter the preparation retry path on later wakes or restarts.
      agent.close();
      agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain,
        model: f.model, jobs: () => jobs });
      await agent.cycle(); await agent.cycle();
      expect(agent.health().reason).toBe('payment-pending'); expect(f.model).toHaveBeenCalledOnce();
      expect(f.chain.prepare).toHaveBeenCalledTimes(method === 'prepare' ? 2 : 1);
      expect(f.chain.broadcast).toHaveBeenCalledOnce();
    } finally { agent.close(); }
  });
  it.each(['remaining', 'prepare'])('keeps a visible hold through repeated %s failures and restart', async method => {
    const f = await fixture({ jobs: [expense(), expense('expense-2')], answer: pay, mode: 'live' });
    let agent = f.agent;
    f.chain[method].mockRejectedValue(new Error('fixture RPC detail must not be journaled'));
    try {
      await agent.cycle(); await agent.cycle();
      expect(agent.health().reason).toBe('payment-preparation-pending');
      agent.close();
      agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model });
      await agent.cycle();
      expect(agent.health().reason).toBe('payment-preparation-pending');
      expect(f.journal().actions[0].status).toBe('decision-accepted');
      expect(f.chain[method]).toHaveBeenCalledTimes(3); expect(f.model).toHaveBeenCalledOnce();
      expect(f.chain.broadcast).not.toHaveBeenCalled(); expect(f.journal().sends).toEqual([]);
      expect(JSON.stringify(f.journal())).not.toContain('fixture RPC detail');
    } finally { agent.close(); }
  });
  it.each(['model-pending', 'model-unknown'])('recovers a previously accepted payment left %s by the old runner', async status => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.remaining.mockRejectedValueOnce(new Error('transient RPC timeout'));
    await f.agent.cycle().catch(() => {}); f.agent.close();
    const checkpoint = f.journal(); checkpoint.actions[0].status = status;
    writeFileSync(join(f.root, 'state/journal.json'), JSON.stringify(checkpoint));
    const agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model });
    try {
      await agent.cycle();
      expect(agent.health().reason).toBe('submitted'); expect(f.model).toHaveBeenCalledOnce();
      expect(f.chain.broadcast).toHaveBeenCalledOnce(); expect(f.chain.prepare).toHaveBeenCalledWith(pay);
      expect(f.journal().calls).toEqual(checkpoint.calls);
    } finally { agent.close(); }
  });
  it('holds an accepted live decision in dry-run and resumes it only in live mode', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.remaining.mockRejectedValueOnce(new Error('transient RPC timeout'));
    await f.agent.cycle().catch(() => {}); f.agent.close();
    let agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'dry-run', chain: f.chain,
      model: f.model, jobs: () => [expense()] });
    try {
      await agent.cycle(); await agent.cycle();
      expect(agent.health().reason).toBe('decision-mode-hold');
      expect(f.chain.prepare).not.toHaveBeenCalled(); expect(f.model).toHaveBeenCalledOnce();
      expect(f.journal().actions[0].status).toBe('decision-accepted');
      agent.close();
      agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model });
      await agent.cycle(); expect(f.chain.broadcast).toHaveBeenCalledOnce();
    } finally { agent.close(); }
  });
  it('revalidates the saved decision against current policy and keeps an explicit hold', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.remaining.mockRejectedValueOnce(new Error('transient RPC timeout'));
    await f.agent.cycle().catch(() => {}); f.agent.close();
    const c = config(); c.manager.weeklyCapRaw = '50000000';
    const agent = await createAgents({ root: f.root, config: c, prompts, mode: 'live', chain: f.chain, model: f.model });
    try {
      await agent.cycle(); await agent.cycle();
      expect(agent.health().reason).toBe('decision-policy-hold');
      expect(f.chain.prepare).not.toHaveBeenCalled(); expect(f.chain.broadcast).not.toHaveBeenCalled();
      expect(f.model).toHaveBeenCalledOnce(); expect(f.journal().actions[0].status).toBe('decision-accepted');
    } finally { agent.close(); }
  });
  it('resumes a dry-run allowance check after restart without preparing or sending', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay });
    f.chain.remaining.mockRejectedValueOnce(new Error('transient RPC timeout'));
    await f.agent.cycle(); f.agent.close();
    const agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'dry-run', chain: f.chain, model: f.model });
    try {
      await agent.cycle();
      expect(agent.health().reason).toBe('dry-run'); expect(f.journal().actions[0].status).toBe('dry-run');
      expect(f.chain.remaining).toHaveBeenCalledTimes(2); expect(f.model).toHaveBeenCalledOnce();
      expect(f.chain.prepare).not.toHaveBeenCalled(); expect(f.chain.broadcast).not.toHaveBeenCalled();
    } finally { agent.close(); }
  });
  it('keeps an accepted payment when shutdown interrupts preparation', async () => {
    const controller = new AbortController();
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.prepare.mockImplementationOnce(async () => {
      controller.abort(); return { raw: '0x01', hash: '0x' + 'a'.repeat(64), nonce: 0 };
    });
    try {
      await f.agent.cycle({ signal: controller.signal });
      expect(f.agent.health().reason).toBe('stopping');
      expect(f.journal().actions[0].status).toBe('decision-accepted');
      expect(f.journal().sends).toEqual([]); expect(f.chain.broadcast).not.toHaveBeenCalled();
      await f.agent.cycle();
      expect(f.chain.broadcast).toHaveBeenCalledOnce(); expect(f.model).toHaveBeenCalledOnce();
    } finally { f.agent.close(); }
  });
  it('does not catch a failed pre-broadcast journal write as a preparation retry', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.prepare.mockImplementation(async () => {
      expect(f.journal().actions[0].status).toBe('decision-accepted');
      mkdirSync(join(f.root, 'state/journal.json.new'));
      return { raw: '0x01', hash: '0x' + 'a'.repeat(64), nonce: 0 };
    });
    try {
      await expect(f.agent.cycle()).rejects.toThrow('journal write failed');
      await expect(f.agent.cycle()).rejects.toThrow('journal unavailable');
      expect(f.chain.broadcast).not.toHaveBeenCalled(); expect(f.chain.prepare).toHaveBeenCalledOnce();
      expect(f.journal().sends).toEqual([]); expect(f.journal().actions[0].status).toBe('decision-accepted');
    } finally { f.agent.close(); }
  });
  it('holds an answered reply for output recovery instead of marking the model unknown', async () => {
    const f = await fixture();
    mkdirSync(join(f.root, 'replies/dry-run-guest-1.json.new'));
    await expect(f.agent.cycle()).rejects.toThrow(); f.agent.close();
    const agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'dry-run', chain: f.chain, model: f.model });
    try {
      await agent.cycle(); await agent.cycle();
      expect(agent.health().reason).toBe('output-pending');
      expect(f.journal().actions[0]).toMatchObject({ status: 'decision-accepted', decision: { action: 'reply' } });
      expect(f.journal().calls[0].status).toBe('answered'); expect(f.model).toHaveBeenCalledOnce();
    } finally { agent.close(); }
  });
  it.each(['unanswered', 'different-decision', 'reserved-send'])('refuses inconsistent accepted state: %s', async corruption => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.remaining.mockRejectedValueOnce(new Error('transient RPC timeout'));
    await f.agent.cycle(); f.agent.close();
    const checkpoint = f.journal();
    if (corruption === 'unanswered') checkpoint.calls[0].status = 'unknown';
    if (corruption === 'different-decision') checkpoint.calls[0].decision.amountRaw = '1';
    if (corruption === 'reserved-send') checkpoint.sends.push({ key: 'live:expense-1', raw: '0x01',
      hash: '0x' + 'a'.repeat(64), nonce: 0, status: 'broadcast-unknown' });
    writeFileSync(join(f.root, 'state/journal.json'), JSON.stringify(checkpoint));
    await expect(createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model })).rejects.toThrow('journal');
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
  it('writes a monthly statement and an unsigned exact net-income transfer to the inbox', async () => {
    const f = await fixture({ jobs: [month], answer: { action: 'statement', markdown: '# September\nMock rental.' }, mode: 'live' });
    try {
      await f.agent.cycle();
      expect(readFileSync(join(f.root, 'statements/live-2026-09.md'), 'utf8')).toContain('# September');
      const proposal = JSON.parse(readFileSync(join(f.root, 'proposals/live-2026-09.json'), 'utf8'));
      expect(proposal).toMatchObject({ chainId: '11155111', safe: config().safe, netIncomeRaw: '700000000',
        transactions: [{ to: config().token, value: '0', operation: 0 }] });
      expect(proposal.transactions[0].data).toMatch(/^0xa9059cbb/);
      expect(JSON.stringify(proposal)).not.toContain('signature'); expect(f.chain.prepare).not.toHaveBeenCalled();
    } finally { f.agent.close(); }
  });
  it('reserves cost before each call, stops the day within budget and resets only on a new UTC day', async () => {
    let now = Date.parse('2026-10-29T12:00:00Z');
    const f = await fixture({ dailyBudgetUsd: '0.02', now: () => now, jobs: [guest(), guest('guest-2')] });
    f.model.mockRejectedValue(new Error('fixture secret must not be logged'));
    try {
      await f.agent.cycle(); await f.agent.cycle();
      expect(f.model).toHaveBeenCalledOnce(); expect(f.agent.health().reason).toBe('daily-budget');
      expect(JSON.stringify(f.journal())).not.toContain('fixture secret');
      now += 86400000; await f.agent.cycle(); expect(f.model).toHaveBeenCalledTimes(2);
    } finally { f.agent.close(); }
  });
  it('journals before broadcast; crash recovery reconciles the same hash without a second send or call', async () => {
    const f = await fixture({ jobs: [expense()], answer: pay, mode: 'live' });
    f.chain.broadcast.mockImplementation(async tx => {
      expect(f.journal().sends[0]).toMatchObject({ hash: tx.hash, status: 'broadcast-unknown' });
      throw new Error('lost response after broadcast');
    });
    await f.agent.cycle(); f.agent.close();
    f.chain.receipt.mockResolvedValue({ status: 'success', confirmed: true });
    const restarted = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', jobs: () => [expense()],
      chain: f.chain, model: f.model });
    try {
      await restarted.cycle(); await restarted.cycle();
      expect(f.chain.broadcast).toHaveBeenCalledOnce(); expect(f.chain.prepare).toHaveBeenCalledOnce();
      expect(f.model).toHaveBeenCalledOnce(); expect(f.journal().sends[0].status).toBe('confirmed');
    } finally { restarted.close(); }
  });
  it('refuses a wrong chain before any model call and locks across dry/live processes', async () => {
    const chain = fakeChain(); chain.chainId.mockResolvedValue(1);
    const disk = scratch(), model = vi.fn();
    await expect(createAgents({ ...disk, config: config(), prompts, mode: 'live', chain, model })).rejects.toThrow('Sepolia');
    expect(model).not.toHaveBeenCalled();
    const f = await fixture();
    try {
      await expect(createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: fakeChain(), model })).rejects.toThrow('lock');
    } finally { f.agent.close(); }
  });
  it('fails closed on corrupted journal; budget history survives a mode change', async () => {
    const f = await fixture(); await f.agent.cycle(); f.agent.close();
    const original = f.journal();
    const live = await createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model, jobs: () => [] });
    live.close(); expect(f.journal().days).toEqual(original.days);
    writeFileSync(join(f.root, 'state/journal.json'), '{}');
    await expect(createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model })).rejects.toThrow('journal');
  });
  it('holds a missing receipt across restart and dry-run; never creates a replacement transaction', async () => {
    const f = await fixture({ jobs: [expense(), expense('expense-2')], answer: pay, mode: 'live' });
    await f.agent.cycle(); f.agent.close();
    const agent = await createAgents({ root: f.root, config: config(), prompts, mode: 'dry-run', chain: f.chain, model: f.model,
      jobs: () => [expense(), expense('expense-2')] });
    try {
      await agent.cycle(); await agent.cycle(); expect(agent.health().reason).toBe('payment-pending');
      expect(f.chain.prepare).toHaveBeenCalledOnce(); expect(f.chain.broadcast).toHaveBeenCalledOnce(); expect(f.model).toHaveBeenCalledOnce();
    } finally { agent.close(); }
  });
  it('retains an interrupted model reservation and refuses overlapping wake calls', async () => {
    let finish;
    const disk = scratch(), chain = fakeChain(), model = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const agent = await createAgents({ ...disk, config: config(), prompts, mode: 'live', chain, model, jobs: () => [guest()] });
    const cycle = agent.cycle();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(agent.cycle()).rejects.toThrow('already running');
    const interrupted = disk.journal();
    expect(interrupted.calls[0]).toMatchObject({ status: 'reserved', inputTokens: null, outputTokens: null });
    expect(BigInt(Object.values(interrupted.days)[0].cost)).toBeGreaterThan(0n);
    finish(response({ action: 'reply', text: 'Hello' })); await cycle; agent.close();
    // Restore only the recorded crash checkpoint in this fixture; never reset a service journal in operation.
    writeFileSync(join(disk.root, 'state/journal.json'), JSON.stringify(interrupted));
    const restarted = await createAgents({ ...disk, config: config(), prompts, mode: 'live', chain, model, jobs: () => [guest()] });
    try {
      await restarted.cycle(); expect(model).toHaveBeenCalledOnce(); expect(disk.journal().days).toEqual(interrupted.days);
      expect(disk.journal().actions[0].status).toBe('model-unknown');
      expect(disk.journal().calls[0].status).toBe('unknown');
    } finally { restarted.close(); }
  });
  it('does not disclose only once globally: a new guest gets the first-message disclosure too', async () => {
    const f = await fixture({ jobs: [guest(), { ...guest('guest-2'), guestId: 'bob' }] });
    try {
      await f.agent.cycle(); await f.agent.cycle();
      expect(JSON.parse(readFileSync(join(f.root, 'replies/dry-run-guest-2.json'), 'utf8')).text.startsWith(AI_DISCLOSURE)).toBe(true);
    } finally { f.agent.close(); }
  });
  it('records refusals with usage and quarantines excessive provider metering for the day', async () => {
    const f = await fixture({ jobs: [guest(), guest('guest-2')] });
    f.model.mockResolvedValue(response({ action: 'reply', text: 'hello' }, { input_tokens: 10000000, output_tokens: 500 }));
    try {
      await f.agent.cycle(); await f.agent.cycle(); expect(f.model).toHaveBeenCalledOnce();
      expect(f.agent.health().reason).toBe('daily-budget'); expect(f.journal().calls[0].inputTokens).toBe('10000000');
    } finally { f.agent.close(); }
  });
  it('keeps actual cost distinct from a metering safety hold', async () => {
    const f = await fixture({ jobs: [guest(), guest('guest-2')] });
    f.model.mockResolvedValue(response({ action: 'reply', text: 'hello' }, { input_tokens: 100000, output_tokens: 1 }));
    try {
      await f.agent.cycle(); await f.agent.cycle(); expect(f.model).toHaveBeenCalledOnce();
      expect(f.agent.health()).toMatchObject({ reason: 'daily-budget', cost: '100005000', halted: true });
    } finally { f.agent.close(); }
  });
  it('rejects a journal whose daily accounting disagrees with its call reservations', async () => {
    const f = await fixture(); await f.agent.cycle(); f.agent.close();
    const s = f.journal(); Object.values(s.days)[0].cost = '0';
    writeFileSync(join(f.root, 'state/journal.json'), JSON.stringify(s));
    await expect(createAgents({ root: f.root, config: config(), prompts, mode: 'live', chain: f.chain, model: f.model })).rejects.toThrow('journal');
  });
});
