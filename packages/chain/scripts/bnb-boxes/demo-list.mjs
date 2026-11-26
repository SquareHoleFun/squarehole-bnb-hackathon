#!/usr/bin/env node
/**
 * SH-261: the list of demo boxes that exist on BNB Chain testnet (chain 97), for the BNB build's Examples page, written
 * from the real runs' state files and checked on the chain itself (read-only):
 *
 *   node packages/chain/scripts/bnb-boxes/demo-list.mjs --rpc <url[,url]> --box stock=<state file> [--box rentfree=<state file>]
 *     [--box converter=<state file>] [--out apps/web/src/features/examples/demo-boxes-97.json]
 *
 * A box is listed only when its state file holds a GREEN read-back (and is its kit's), the chain answers, at its
 * coordinator, the same token and spec hash, the token carries the kit's name and ticker, and its createBox succeeded at
 * the release's factory with that spec hash; a box listed twice is refused. The list carries no picture and no amount: the box page shows the box as the chain has it.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, getAddress, parseEventLogs } from 'viem';
import './ts.mjs';
import { castEndpoint, readTransport, setReadEndpoints, stateStore } from './chain.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { loadProfileExamples } = await import('../../../../packages/box-spec/examples/v2/registry.mjs');
/** The demo boxes in the order the page shows them, with their kit. */
export const DEMO_KITS = Object.freeze({ stock: 'gpu-poor', rentfree: 'rent-free', converter: 'the-alchemist' });

export async function demoList({ urls, states }) {
  setReadEndpoints(urls);
  const client = createPublicClient({ transport: readTransport(urls[0]) });
  assert.equal(await client.getChainId(), 97);
  const rows = loadProfileExamples('bnb');
  const boxes = [];
  const release = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/deployments/core-v1/97.json'), 'utf8')).releases[0];
  for (const id of Object.keys(DEMO_KITS)) {
    if (!states[id]) continue;
    const memo = stateStore(states[id]).data.memo;
    const result = memo['create:result'];
    assert.ok(result?.readBack?.ok, `${id}: the state file holds no GREEN read-back`);
    // The state file must be this kit's (when it names one), and the chain's token must carry the kit's name and ticker.
    if (memo['create:kit'] !== undefined) assert.equal(memo['create:kit'], DEMO_KITS[id], `${id}: the state file is ${memo['create:kit']}'s`);
    const coordinator = getAddress(result.coordinator);
    const [token, specHash] = await Promise.all(['token', 'specHash'].map(fn => client.readContract({ address: coordinator, abi: coreV2.coordinatorV2Abi, functionName: fn })));
    assert.equal(token.toLowerCase(), result.token.toLowerCase(), `${id}: the chain's token is the state file's`);
    assert.equal(specHash.toLowerCase(), result.readBack.specHash.toLowerCase(), `${id}: the chain's spec hash is the state file's`);
    const row = rows.find(r => r.id === DEMO_KITS[id]);
    const [name, symbol] = await Promise.all(['name', 'symbol'].map(fn => client.readContract({ address: token, abi: erc20Abi, functionName: fn })));
    assert.deepEqual([name, symbol], [row.name, row.ticker], `${id}: the token at ${token} is ${name} (${symbol}), not ${row.name} (${row.ticker})`);
    // Its creation: a successful transaction to the release's factory whose receipt holds the registry's BoxCreated
    // with this spec hash.
    const receipt = await client.getTransactionReceipt({ hash: result.readBack.createTx });
    assert.equal(receipt.status, 'success', `${id}: its createBox succeeded`);
    assert.equal(receipt.to.toLowerCase(), release.factory.address.toLowerCase(), `${id}: its createBox went to the release's factory`);
    // The event binds to the listed box: emitted by the release's registry, this spec hash, and its record names this
    // coordinator (role 0) and this token (role 1).
    const events = parseEventLogs({ abi: coreV2.registryV2Abi, logs: receipt.logs, eventName: 'BoxCreated' })
      .filter(e => e.address.toLowerCase() === release.registry.address.toLowerCase() && e.args.specHash.toLowerCase() === specHash.toLowerCase()
        && e.args.record.contracts[0].toLowerCase() === coordinator.toLowerCase() && e.args.record.contracts[1].toLowerCase() === token.toLowerCase());
    assert.equal(events.length, 1, `${id}: its createBox's receipt holds the registry's BoxCreated of this spec hash, this coordinator and this token`);
    assert.ok(!boxes.some(b => b.coordinator.toLowerCase() === coordinator.toLowerCase()), `${id}: the same box twice`);
    boxes.push({ id, kit: row.id, name: row.name, ticker: row.ticker, chainId: 97, token: getAddress(token), coordinator, createTx: result.readBack.createTx });
  }
  return { schema: 'squarehole.demo-boxes/1', chainId: 97, boxes };
}

const args = process.argv.slice(2);
const flags = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const urls = [];
    for (const url of String(flags('--rpc')[0] ?? '').split(',').filter(Boolean)) urls.push(await castEndpoint(url));
    assert.ok(urls.length, '--rpc <url[,url]> is required');
    const states = Object.fromEntries(flags('--box').map(pair => { const [id, path] = pair.split('='); assert.ok(Object.hasOwn(DEMO_KITS, id), `unknown box ${id}`); return [id, resolve(path)]; }));
    const list = await demoList({ urls, states });
    const out = resolve(ROOT, flags('--out')[0] ?? 'apps/web/src/features/examples/demo-boxes-97.json');
    writeFileSync(out, `${JSON.stringify(list, null, 2)}\n`);
    process.stdout.write(`${list.boxes.length} demo boxes written to ${out}\n`);
    for (const box of list.boxes) process.stdout.write(`${box.id}: ${box.name} (${box.ticker}) token ${box.token}\n`);
  } catch (error) {
    console.error(`demo list refused: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
