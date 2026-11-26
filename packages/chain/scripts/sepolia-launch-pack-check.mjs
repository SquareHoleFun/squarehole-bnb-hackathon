#!/usr/bin/env node
/** Public post-launch reads plus a copied keeper status view. Never signs or sends. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, isAddress, parseAbi } from 'viem';
const ABI = parseAbi([
  ...['creator', 'factory', 'registry', 'token', 'q'].map(n => `function ${n}() view returns (address)`),
  ...['gateOpen', 'failed', 'graduated'].map(n => `function ${n}() view returns (bool)`),
  'function specHash() view returns (bytes32)', 'function roleAddress(uint256) view returns (address)',
]);
const raw = (v, name) => { assert.ok(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v), `${name}: decimal string required`); return BigInt(v); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export async function checkLaunch(expected, client, keeper) {
  assert.equal(expected.chainId, '11155111', 'Sepolia only');
  assert.equal(await client.getChainId(), 11155111, 'RPC chain mismatch');
  const block = await client.getBlock();
  assert.ok(block.number !== null && block.timestamp > 0n, 'mined block required');
  const coordinator = expected.roles.coordinator;
  assert.ok(isAddress(coordinator), 'coordinator required');
  const read = (address, functionName, args = []) => client.readContract({ address, abi: ABI, functionName, args, blockNumber: block.number });
  for (const a of [expected.factory, ...Object.values(expected.roles)]) {
    assert.ok(isAddress(a), 'invalid role');
    assert.ok((await client.getCode({ address: a, blockNumber: block.number }))?.length > 2, 'role not deployed');
  }
  for (const [name, value] of Object.entries({ creator: expected.creator, factory: expected.factory,
    token: expected.roles.token, q: expected.priceCoin, specHash: expected.specHash })) {
    assert.ok(same(await read(coordinator, name), value), `${name} mismatch`);
  }
  for (const [role, n] of Object.entries(expected.roleNumbers)) if (expected.roles[role]) {
    assert.ok(same(await read(coordinator, 'roleAddress', [BigInt(n)]), expected.roles[role]), `${role} wiring mismatch`);
  }
  const registry = await read(expected.factory, 'registry');
  assert.ok(same(await read(coordinator, 'registry'), registry), 'registry mismatch');
  assert.equal(await read(coordinator, 'gateOpen'), true, 'gate is closed');
  assert.equal(await read(coordinator, 'failed'), false, 'box failed');
  assert.equal(await read(coordinator, 'graduated'), true, 'box has not graduated');
  assert.equal(keeper.schema, 'squarehole.monitor-keeper.v1', 'keeper schema');
  assert.equal(keeper.chainId, '11155111', 'keeper chain');
  const identity = keeper.identity?.split(':');
  assert.ok(identity?.length === 4 && identity[0] === '11155111' && isAddress(identity[1]) && same(identity[2], registry), 'keeper identity/registry mismatch');
  assert.equal(keeper.complete, true, 'keeper discovery/reads incomplete');
  const observed = raw(keeper.observedAt, 'keeper timestamp');
  const height = raw(keeper.block, 'keeper block');
  assert.ok(observed <= block.timestamp && height <= block.number, 'future keeper snapshot');
  assert.ok(block.timestamp - observed <= 300n && block.number - height <= 64n, 'stale keeper snapshot');
  if (expected.keeper.requireDrandComplete) assert.equal(keeper.drand?.complete, true, 'keeper drand reads incomplete');
  raw(keeper.queue?.count, 'keeper queue count');
  return { status: 'graduated', chainId: '11155111', id: expected.id, coordinator, block: block.number.toString(),
    keeper: { complete: true, observedAt: keeper.observedAt, block: keeper.block, queueCount: keeper.queue.count } };
}
function isEntry() { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }
if (isEntry()) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 6 && args[0] === '--verify' && args[2] === '--keeper-view' && args[4] === '--rpc', 'usage');
    const url = new URL(args[5]);
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'public RPC required');
    const report = await checkLaunch(JSON.parse(readFileSync(args[1], 'utf8')),
      createPublicClient({ transport: http(args[5], { retryCount: 0 }), ccipRead: false }), JSON.parse(readFileSync(args[3], 'utf8')));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch { process.stderr.write('Launch check refused or incomplete. Verify Sepolia bindings, graduation and the current keeper view.\n'); process.exitCode = 1; }
}
