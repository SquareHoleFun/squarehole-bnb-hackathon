import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { expect } from '@playwright/test';

const TOKEN = '0x00000000000000000000000000000000000000aa';
const chain = { rpcUrl: 'http://127.0.0.1:8576/', chainId: 11155111, ports: { gatewayPort: 5411 } };

/**
 * A local chain that mines only on request and an indexer that audits at `auditAt`: the feed module runs unchanged
 * against them. `feed` may override the card per read to model listing, repairs or a lagging indexer.
 */
function stack({ auditAt = Infinity, verified = null, feed = card => card } = {}) {
  let head = 100n; let reads = 0;
  const mined = [];
  return {
    mined,
    rpc: async (url, method) => {
      assert.equal(url, chain.rpcUrl);
      if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
      if (method === 'evm_mine') { head += 1n; mined.push(head); return '0x0'; }
      throw new Error(`unexpected ${method}`);
    },
    fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:5411/v2/feed?chain=11155111');
      reads += 1;
      const card = { token: TOKEN, asOf: { block: head.toString() }, stale: false, verified: head >= auditAt ? true : verified,
        audit: verified === false ? { ok: false, mismatches: ['pot'] } : null };
      const shown = feed(card, reads);
      return { json: async () => ({ cards: shown ? [shown] : [], hidden: shown ? [] : [{ boxId: '9', reason: 'template 0x09 is not shown in this build' }] }) };
    },
  };
}

async function load(doubles) {
  const url = new URL('./feed.mjs', import.meta.url);
  const context = createContext({ fetch: doubles.fetch, AbortSignal, Date: doubles.Date ?? Date });
  const module = new SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  const bindings = {
    '@playwright/test': { expect },
    '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs': { delay: doubles.delay ?? (async () => {}), rpc: doubles.rpc },
  };
  await module.link(name => {
    assert.ok(bindings[name], `unexpected import: ${name}`);
    return new SyntheticModule(Object.keys(bindings[name]), function () {
      for (const [key, value] of Object.entries(bindings[name])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('currentCard returns an audited card at the head without mining', async () => {
  const doubles = stack({ auditAt: 0n }); const { currentCard } = await load(doubles); const evidence = {};
  assert.equal((await currentCard(chain, TOKEN.toUpperCase().replace('0X', '0x'), evidence)).verified, true);
  assert.deepEqual(doubles.mined, []); assert.equal(evidence.emptyBlocks, undefined);
});

test('a listed box awaiting its first audit gets empty blocks until the indexer audits it, recorded as evidence', async () => {
  const doubles = stack({ auditAt: 103n }); const { currentCard } = await load(doubles); const evidence = {};
  const card = await currentCard(chain, TOKEN, evidence);
  assert.equal(card.verified, true); assert.equal(card.asOf.block, '103');
  assert.deepEqual(doubles.mined, [101n, 102n, 103n]);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence.emptyBlocks)), [{ token: TOKEN, mined: 3, block: '103' }]);
});

test('a settled audit refutation fails at once; a repair in progress is waited out', async () => {
  const refuted = stack({ verified: false }); const feed = await load(refuted);
  await assert.rejects(feed.currentCard(chain, TOKEN, {}), /audit refutes box .*"mismatches":\["pot"\]/);
  assert.deepEqual(refuted.mined, []);
  const repairing = stack({ feed: (card, reads) => reads <= 2 ? { ...card, stale: true, verified: false } : { ...card, verified: true } });
  assert.equal((await (await load(repairing)).currentCard(chain, TOKEN, {})).verified, true);
  assert.deepEqual(repairing.mined, []);
});

test('the wait is bounded: no audit within maxBlocks, or an indexer that never reaches the head, fails', async () => {
  const never = stack(); const feed = await load(never);
  await assert.rejects(feed.currentCard(chain, TOKEN, {}, { maxBlocks: 4 }), /not audited within 4 empty blocks/);
  assert.equal(never.mined.length, 4);
  const behind = stack({ auditAt: 0n, feed: card => ({ ...card, asOf: { block: '99' } }) });
  await assert.rejects((await load(behind)).currentCard(chain, TOKEN, {}, { stallMs: 0 }), /stalled at block 99 \(head 100\)/);
  assert.deepEqual(behind.mined, []);
});

test('an indexer catching up keeps the wait alive while its head advances; a stuck one fails after stallMs', async () => {
  // A fake clock: every poll costs 100 ms. The indexer folds one block per poll from block 80 to the head (100).
  const clocked = (feed) => { let now = 0; const doubles = stack({ auditAt: 0n, feed });
    return Object.assign(doubles, { Date: { now: () => now }, delay: async ms => { now += ms; } }); };
  const catching = clocked((card, reads) => ({ ...card, asOf: { block: String(Math.min(80 + reads, 100)) } }));
  assert.equal((await (await load(catching)).currentCard(chain, TOKEN, {}, { stallMs: 250 })).asOf.block, '100');
  const stuck = clocked(card => ({ ...card, asOf: { block: '90' } }));
  await assert.rejects((await load(stuck)).currentCard(chain, TOKEN, {}, { stallMs: 250 }), /stalled at block 90 \(head 100\)/);
});

test('listedCard waits for the listing only, and names the not-shown reason when it never comes', async () => {
  const unaudited = stack(); const feed = await load(unaudited);
  assert.equal((await feed.listedCard(chain, TOKEN)).verified, null);
  const later = stack({ feed: (card, reads) => reads >= 3 ? card : null });
  assert.equal((await (await load(later)).listedCard(chain, TOKEN)).token, TOKEN);
  const hidden = stack({ feed: () => null });
  await assert.rejects((await load(hidden)).listedCard(chain, TOKEN, { timeout: 300 }), /does not list box .*template 0x09 is not shown in this build/);
  assert.deepEqual([...unaudited.mined, ...later.mined, ...hidden.mined], []);
});
