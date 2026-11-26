import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../main.mjs';
import { fixture, accounts, ticket1, r0, time } from './model.mjs';

function actionFixture(kind, options) {
  const m = fixture({ base: 1000000000n, tip: 100000000n, ...options });
  if (kind === 'request') m.tickets.get(ticket1).state.wordRequestedAt = 0n;
  if (kind === 'accept') m.posted.set(r0, time(r0));
  return m;
}

test('a keyless plan quotes every action with zero ETH on its placeholder sender', async () => {
  for (const chain of [1n, 11155111n]) for (const kind of ['post', 'request', 'accept']) {
    const m = actionFixture(kind, { chain, balance: 0n });
    const code = await main(m.args.slice(0, 4), m.io);
    m.safe();
    assert.equal(m.sent.length, 0);
    assert.equal(code, 0, `${chain} ${kind}: ${m.out}${m.err}`);
    assert.equal(m.err, '');
    const estimates = m.calls.filter(c => c.method === 'eth_estimateGas');
    assert.equal(estimates.length, 1);
    const tx = estimates[0].params[0];
    assert.equal(tx.from.toLowerCase(), '0x000000000000000000000000000000000000dead');
    for (const field of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
      assert.equal(Object.hasOwn(tx, field), false, field);
    }
    const line = m.out.split('\n').find(line => line.startsWith(`${kind} tickets=`));
    assert.ok(line, m.out);
    assert.match(line, /gas=150002 maxFee=2100000000 urgent=false totalWei=315004200000000$/);
    assert.match(m.out, /plan totalWei=315004200000000;/);
    assert.match(m.out, /plan only; no signer/);
    assert.ok(!m.calls.some(c => c.method === 'eth_sendRawTransaction'));
    assert.equal(m.cast.length, 0);
  }
});

test('signed estimation keeps the real sender and fees and refuses an unfunded sender', async () => {
  for (const mode of ['key', 'ledger']) for (const kind of ['post', 'request', 'accept']) {
    const m = actionFixture(kind, { balance: 0n });
    const args = mode === 'key' ? m.args : [...m.args.slice(0, 4), '--ledger', '--yes'];
    const code = await main(args, m.io);
    m.safe();
    assert.equal(code, 1, `${mode} ${kind}: ${m.out}${m.err}`);
    assert.match(m.err, /RPC or action failed/);
    const sender = accounts.privateKeyToAccount(m.env.RESCUE_KEY).address.toLowerCase();
    assert.ok(m.simulations.length > 0);
    assert.ok(m.simulations.every(s => s.from.toLowerCase() === sender));
    const estimates = m.calls.filter(c => c.method === 'eth_estimateGas');
    assert.equal(estimates.length, 1);
    const tx = estimates[0].params[0];
    assert.equal(tx.from.toLowerCase(), sender);
    assert.equal(BigInt(tx.maxFeePerGas), 2100000000n);
    assert.equal(BigInt(tx.maxPriorityFeePerGas), 100000000n);
    assert.equal(m.sent.length, 0);
    assert.ok(!m.calls.some(c => c.method === 'eth_sendRawTransaction'));
    assert.ok(!m.cast.some(c => c.args[0] === 'send'));
  }
});

test('signed balance admission still requires the padded gas quote after estimation succeeds', async () => {
  for (const mode of ['key', 'ledger']) {
    // Enough for the 100001-gas estimate, but less than the padded 150002-gas reservation.
    const m = actionFixture('post', { balance: 210002100000000n });
    const args = mode === 'key' ? m.args : [...m.args.slice(0, 4), '--ledger', '--yes'];
    const code = await main(args, m.io);
    m.safe();
    assert.equal(code, 1, m.out + m.err);
    assert.match(m.err, /account balance limit reached/);
    assert.match(m.out, /gas=150002 maxFee=2100000000 urgent=false totalWei=315004200000000/);
    assert.equal(m.sent.length, 0);
    assert.ok(!m.calls.some(c => c.method === 'eth_sendRawTransaction'));
    assert.ok(!m.cast.some(c => c.args[0] === 'send'));
  }
});
