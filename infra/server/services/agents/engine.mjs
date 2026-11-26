import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateConfig, validateJobs, validateDecision, callCost, usd, requireThat, AI_DISCLOSURE, MAX_OUTPUT_TOKENS, SEPOLIA } from './policy.mjs';
import { openStore, writeAtomic } from './store.mjs';
import { payloadFor } from './model.mjs';
import { proposal } from './chain.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;

export async function createAgents({ root, config, prompts, mode, chain, model, jobs = () => [], dailyBudgetUsd = '2', now = Date.now }) {
  validateConfig(config); requireThat(['dry-run', 'live'].includes(mode));
  for (const name of ['manager', 'bookkeeper']) requireThat(typeof prompts[name] === 'string' && Buffer.byteLength(prompts[name]) > 0 && Buffer.byteLength(prompts[name]) <= 16384);
  const budget = usd(dailyBudgetUsd); requireThat(budget > 0n);
  requireThat(await chain.chainId() === SEPOLIA, 'Sepolia required');
  // Bind the one durable journal to chain authority; prompt and price edits preserve all historical reservations.
  const identity = hash([config.chainId, config.safe.toLowerCase(), config.module.toLowerCase(), config.token.toLowerCase(), config.manager.address.toLowerCase()]);
  const store = openStore(root, identity), s = store.state;
  let running = false, reason = 'ready';
  const setReason = value => { reason = value; return true; };
  const health = () => ({ reason, day: new Date(now()).toISOString().slice(0, 10),
    budgetNanoUsd: String(budget), ...(s.days[new Date(now()).toISOString().slice(0, 10)] ?? { cost: '0', inputTokens: '0', outputTokens: '0', halted: false }) });
  const pay = async (action, signal) => {
    const decision = action.decision;
    // A retained decision must still satisfy the current policy, without another model call or charge.
    try { validateDecision(decision, { kind: 'expense' }, config); }
    catch { return setReason('decision-policy-hold'); }
    let remaining, prepared;
    try { remaining = await chain.remaining(); }
    catch { return setReason('payment-preparation-pending'); }
    if (remaining < BigInt(decision.amountRaw)) {
      action.status = 'allowance-low'; store.save(); return setReason('allowance-low');
    }
    if (mode === 'dry-run') { action.status = 'dry-run'; store.save(); return setReason('dry-run'); }
    if (signal?.aborted) return setReason('stopping');
    try { prepared = await chain.prepare(decision); }
    catch { return setReason('payment-preparation-pending'); }
    if (signal?.aborted) return setReason('stopping');
    const tx = { ...prepared, key: action.key, at: now(), status: 'broadcast-unknown' };
    s.sends.push(tx); action.status = 'payment-pending'; store.save();
    // A failed journal write must escape; after this reservation only receipt reconciliation is allowed.
    try { requireThat(await chain.broadcast(tx) === tx.hash, 'broadcast hash mismatch'); tx.status = 'submitted'; }
    catch { store.save(); return setReason('payment-pending'); }
    store.save(); return setReason('submitted');
  };
  return { close: () => store.close(), health,
    async cycle({ signal } = {}) {
      requireThat(!running, 'agents cycle already running'); store.assertUsable(); running = true;
      try {
        requireThat(await chain.chainId() === SEPOLIA, 'Sepolia required');
        if (signal?.aborted) return setReason('stopping');
        for (const a of s.actions.filter(a => ['model-pending', 'model-unknown'].includes(a.status))) {
          const call = s.calls.find(c => c.actionKey === a.key);
          // Recover the old runner's accepted checkpoint, including one it already mislabeled unknown.
          if (call.status === 'answered' && a.decision && !s.sends.some(tx => tx.key === a.key)) a.status = 'decision-accepted';
          else if (a.status === 'model-pending') {
            a.status = 'model-unknown'; call.status = 'unknown';
          }
        }
        store.save();
        const pending = s.sends.find(tx => !['confirmed', 'reverted'].includes(tx.status));
        if (pending) {
          // Even dry-run can observe a prior live receipt. It can never re-broadcast or discard the reservation.
          const receipt = await chain.receipt(pending.hash);
          if (receipt?.confirmed) {
            pending.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
            s.actions.find(a => a.key === pending.key).status = receipt.status === 'success' ? 'complete' : 'payment-failed';
            store.save(); return setReason(pending.status);
          }
          return setReason('payment-pending');
        }
        // Accepted effects take priority even if their feed entry disappeared or the model budget is exhausted.
        const accepted = s.actions.find(a => a.status === 'decision-accepted');
        if (accepted) {
          if (accepted.mode !== mode) return setReason('decision-mode-hold');
          if (accepted.decision.action !== 'pay') return setReason('output-pending');
          return await pay(accepted, signal);
        }
        if (s.actions.some(a => a.status === 'allowance-low')) return setReason('allowance-low');
        const feed = validateJobs(await jobs());
        const job = feed.find(j => !s.actions.some(a => a.key === `${mode}:${j.id}`
          || (j.kind === 'month' && a.mode === mode && a.month === j.month)));
        if (!job) return setReason('idle');
        const at = now(), day = new Date(at).toISOString().slice(0, 10), role = job.kind === 'month' ? 'bookkeeper' : 'manager';
        const payload = payloadFor(config, prompts, job);
        // Byte count plus framing reserve bounds input for this text-only request. No tools, images or cached tokens.
        const inputCeiling = BigInt(Buffer.byteLength(JSON.stringify(payload)) + 1024);
        const reserve = callCost(config[role], inputCeiling, BigInt(MAX_OUTPUT_TOKENS));
        const daily = s.days[day] ??= { cost: '0', inputTokens: '0', outputTokens: '0', halted: false };
        if (daily.halted || BigInt(daily.cost) + reserve > budget) { store.save(); return setReason('daily-budget'); }
        const action = { key: `${mode}:${job.id}`, mode, jobHash: hash(job), month: job.kind === 'month' ? job.month : null,
          guestId: job.kind === 'guest' ? job.guestId : null, status: 'model-pending' };
        const call = { at, day, role, model: config[role].model, promptHash: hash(payload), actionKey: action.key,
          inputTokens: null, outputTokens: null, cost: String(reserve), decision: null, status: 'reserved' };
        s.actions.push(action); s.calls.push(call); daily.cost = String(BigInt(daily.cost) + reserve); store.save();
        let answer;
        try { answer = await model(payload, signal); }
        catch { action.status = 'model-unknown'; call.status = 'unknown'; store.save(); return setReason('model-unavailable'); }
        const usage = answer?.usage;
        if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)
          || (usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.cache_read_input_tokens ?? 0) !== 0) {
          action.status = 'model-unknown'; call.status = 'unknown'; store.save(); return setReason('model-usage-unknown');
        }
        const input = BigInt(usage.input_tokens), output = BigInt(usage.output_tokens);
        const cost = callCost(config[role], input, output);
        daily.inputTokens = String(BigInt(daily.inputTokens) + input); daily.outputTokens = String(BigInt(daily.outputTokens) + output);
        daily.cost = String(BigInt(daily.cost) - reserve + cost);
        Object.assign(call, { inputTokens: String(input), outputTokens: String(output), cost: String(cost), status: 'answered' });
        if (input > inputCeiling || output > BigInt(MAX_OUTPUT_TOKENS) || BigInt(daily.cost) > budget) {
          // An unexpected metering change quarantines all remaining calls for this day.
          daily.halted = true;
          action.status = 'refused'; call.status = 'usage-exceeded'; store.save(); return setReason('daily-budget');
        }
        let decision;
        try {
          requireThat(answer.stop_reason === 'end_turn' && Array.isArray(answer.content) && answer.content.length === 1
            && answer.content[0].type === 'text');
          decision = validateDecision(JSON.parse(answer.content[0].text), job, config);
        } catch { action.status = 'refused'; call.status = 'refused'; store.save(); return setReason('model-refused'); }
        call.decision = decision; action.decision = decision; action.status = 'decision-accepted';
        // Persist the accepted output before signing or publishing any file. A lost write prevents the effect.
        store.save();
        const prefix = `${mode}-`;
        if (decision.action === 'reply') {
          const disclosed = s.actions.some(a => a !== action && a.mode === mode && a.guestId === job.guestId && a.status === 'complete');
          const text = disclosed ? decision.text : `${AI_DISCLOSURE}\n\n${decision.text}`;
          writeAtomic(join(root, `replies/${prefix}${job.id}.json`), { id: job.id, guestId: job.guestId, mode, text });
          action.status = 'complete'; store.save(); return setReason('reply');
        }
        if (decision.action === 'statement') {
          writeAtomic(join(root, `statements/${prefix}${job.month}.md`), decision.markdown + '\n');
          writeAtomic(join(root, `proposals/${prefix}${job.month}.json`), { ...proposal(config, job), mode });
          action.status = 'complete'; store.save(); return setReason('statement');
        }
        return await pay(action, signal);
      } finally { running = false; }
    },
  };
}
