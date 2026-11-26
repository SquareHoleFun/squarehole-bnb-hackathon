import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { parseArgs, prepareBuy, RELEASE, stringify } from './buy-v2.mjs';

const addr = n => getAddress(toHex(BigInt(n), { size: 20 }));
const box = addr(100), token = addr(200), hook = addr(300), router = addr(400), buyer = addr(500);
const buyAbi = parseAbi(['function buy(uint256 qIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns (uint256)']);
const swapAbi = parseAbi(['function swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes) payable returns (int256)']);
const poolRouter = getAddress('0x9b6b46e2c869aa39918db7f52f5557fe577b6eee');
const Q96 = 1n << 96n;
const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const options = { chainId: '11155111', mode: 'launch', box, amountIn: '10000000000000001', minOut: '900719925474099312345',
  from: buyer, deadline: '1200', rpc: 'https://rpc.invalid', keyFile: 'founder-key.env', maxFeeWei: '10000000000', priorityFeeWei: '2000000000' };

function reader(overrides = {}) {
  const state = { chain: 11155111, timestamp: 1000n, q: zeroAddress, graduated: false, gateOpen: true,
    failed: false, effectiveOpenAt: 950n, closed: false, allowance: 0n,
    sqrtPriceX96: 2n * Q96, poolFee: 10000, protocolFee: 0n, lpFee: 10000n, ...overrides };
  const calls = [];
  return { calls, async getChainId() { calls.push('chain'); return state.chain; },
    async getBlock({ blockNumber } = {}) { calls.push('block'); return { number: blockNumber ?? 42n, timestamp: state.timestamp, hash: toHex(42n, { size: 32 }) }; },
    async getCode(q) { calls.push(q); return '0x6000'; },
    async readContract(q) {
      encodeFunctionData(q); // Check every read can actually be ABI-encoded.
      calls.push(q);
      if (q.functionName === 'factory') return RELEASE.factory;
      if (q.functionName === 'boxIdOf') return [q.args[0].toLowerCase() === box, 7n];
      if (q.functionName === 'initialHolder') return box;
      if (q.functionName === 'registry') return RELEASE.registry;
      if (q.functionName === 'coordinator') return box;
      if (q.functionName === 'token') return token;
      if (q.functionName === 'hook') return hook;
      if (q.functionName === 'launchRouter') return router;
      if (q.functionName === 'poolManager' || q.functionName === 'manager') return RELEASE.poolManager;
      if (q.functionName === 'poolKey') return [state.q, token, state.poolFee, 60, hook];
      if (q.functionName === 'extsload') return toHex(state.sqrtPriceX96 | (123n << 160n) | (state.protocolFee << 184n) | (state.lpFee << 208n), { size: 32 });
      if (q.functionName === 'windowEndsAt') return state.effectiveOpenAt + 384n;
      if (q.functionName in state) return state[q.functionName];
      throw new Error(`unexpected read: ${q.functionName}`);
    } };
}

test('release pins match the reviewed rc8 deployment plan', () => {
  const plan = JSON.parse(readFileSync(new URL('../../../docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json', import.meta.url)));
  for (const field of ['factory', 'registry', 'poolManager']) assert.equal(RELEASE[field].toLowerCase(), plan[field].toLowerCase());
});

test('native launch buy encodes exact raw amounts, recipient, deadline and value at one block', async () => {
  const client = reader();
  const plan = await prepareBuy(options, client);
  const decoded = decodeFunctionData({ abi: buyAbi, data: plan.transaction.data });
  assert.equal(plan.status, 'ready');
  assert.equal(decoded.functionName, 'buy');
  assert.deepEqual(decoded.args, [BigInt(options.amountIn), BigInt(options.minOut), buyer, 1200n]);
  assert.equal(plan.transaction.target, router);
  assert.equal(plan.transaction.value, options.amountIn);
  assert.equal(plan.transaction.chainId, '11155111');
  assert.deepEqual(plan.approvals, []);
  assert.ok(client.calls.filter(c => typeof c === 'object').every(c => c.blockNumber === 42n));
  const data = JSON.parse(stringify(plan));
  assert.equal(data.minimumOut, options.minOut);
  assert.match(plan.transaction.command, /--private-key "\$\(key 'founder-key.env'\)"/);
  assert.match(plan.transaction.command, /--chain 11155111/);
  assert.match(plan.transaction.command, /--gas-price 10000000000wei --priority-gas-price 2000000000wei/);
});

test('token lookup is reciprocal; ERC20 value is zero with exact approval, reset and revoke', async () => {
  const plan = await prepareBuy({ ...options, box: token }, reader({ q: addr(50), allowance: 12n }));
  assert.equal(plan.coordinator, box);
  assert.equal(plan.transaction.value, '0');
  assert.deepEqual(plan.approvals.map(a => decodeFunctionData({ abi: approvalAbi, data: a.data }).args), [[router, 0n], [router, BigInt(options.amountIn)]]);
  assert.equal(plan.revoke.target, addr(50));
  assert.deepEqual(decodeFunctionData({ abi: approvalAbi, data: plan.revoke.data }).args, [router, 0n]);
  await assert.rejects(prepareBuy({ ...options, box: addr(999) }, reader()), /box.*token|token.*box/i);
});

test('slippage uses bigint floor on output, including values above 2^53', async () => {
  const plan = await prepareBuy({ ...options, minOut: undefined, quoteOut: '900719925474099312345', slippageBps: '37', quoteBlock: '42' }, reader());
  assert.equal(plan.minimumOut, (900719925474099312345n * 9963n / 10000n).toString());
  assert.equal(decodeFunctionData({ abi: buyAbi, data: plan.transaction.data }).args[1], BigInt(plan.minimumOut));
});

test('quote mode prints a buy simulation returning T, never mistakes tax/swapIn for output', async () => {
  const plan = await prepareBuy({ ...options, minOut: undefined, quoteOnly: true }, reader());
  assert.equal(plan.status, 'quote-only');
  assert.equal(plan.transaction, null);
  assert.match(plan.quote.command, /cast call/);
  assert.match(plan.quote.command, /buy\(uint256,uint256,address,uint256\)\(uint256\)/);
  assert.match(plan.quote.command, /--block 42/);
  assert.doesNotMatch(plan.quote.command, /private-key|cast send|quote\(uint256\)/);
  assert.equal(decodeFunctionData({ abi: buyAbi, data: plan.quote.data }).args[1], 1n);
});

test('chain 1 and every other chain are refused before contract reads, including RPC mismatch', async () => {
  for (const mode of ['launch', 'pool']) for (const chainId of ['1', '10', '8453', '42161', '31337', '11155112']) {
    const client = reader();
    await assert.rejects(prepareBuy({ ...options, mode, chainId }, client), /11155111/);
    assert.deepEqual(client.calls, []);
  }
  const client = reader({ chain: 1 });
  await assert.rejects(prepareBuy(options, client), /11155111/);
  assert.deepEqual(client.calls, ['chain']);
});

test('zero minima, rounding to zero, ambiguous limits and malformed raw quantities are refused', async () => {
  for (const patch of [
    { minOut: '0' }, { minOut: undefined }, { minOut: 1 }, { amountIn: '0' }, { amountIn: '1e18' },
    { amountIn: (1n << 127n).toString() }, { minOut: (1n << 256n).toString() },
    { minOut: undefined, quoteOut: '1', slippageBps: '1', quoteBlock: '42' },
    { minOut: undefined, quoteOut: '100', slippageBps: '10000', quoteBlock: '42' },
    { minOut: undefined, quoteOut: '100', slippageBps: '-1', quoteBlock: '42' },
    { minOut: undefined, quoteOut: '100', slippageBps: '1' },
    { quoteOut: '100', slippageBps: '1', quoteBlock: '42' },
    { maxFeeWei: '1', priorityFeeWei: '2' }, { priorityFeeWei: '0' },
  ]) await assert.rejects(prepareBuy({ ...options, ...patch }, reader()));
});

test('phase gates, expired deadlines, stale quotes and untrusted wiring refuse preparation', async () => {
  for (const patch of [{ failed: true }, { gateOpen: false }, { graduated: true }, { closed: true }, { effectiveOpenAt: 1001n }, { effectiveOpenAt: 600n }]) {
    await assert.rejects(prepareBuy(options, reader(patch)));
  }
  await assert.rejects(prepareBuy({ ...options, deadline: '1000' }, reader()), /deadline/);
  await assert.rejects(prepareBuy({ ...options, deadline: '2000' }, reader()), /deadline/);
  const stale = reader();
  stale.getBlock = async ({ blockNumber } = {}) => ({ number: blockNumber ?? 60n, timestamp: blockNumber ? 800n : 1000n, hash: toHex(42n, { size: 32 }) });
  await assert.rejects(prepareBuy({ ...options, minOut: undefined, quoteOut: '100', slippageBps: '1', quoteBlock: '42' }, stale), /stale/);
  const wrong = reader(); const read = wrong.readContract;
  wrong.readContract = q => q.functionName === 'factory' ? addr(999) : read(q);
  await assert.rejects(prepareBuy(options, wrong), /factory/);
});

const poolOptions = { ...options, mode: 'pool', minOut: undefined, slippageBps: '100' };

test('pool buy encodes the rc8 key, exact input, conservative price limit and settlement settings', async () => {
  const client = reader({ graduated: true });
  const plan = await prepareBuy(poolOptions, client);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.minimumOut, null);
  assert.equal(plan.protection, 'price-limit-only');
  const decoded = decodeFunctionData({ abi: swapAbi, data: plan.transaction.data });
  const limit = BigInt(plan.pool.sqrtPriceLimitX96);
  assert.equal(decoded.functionName, 'swap');
  assert.deepEqual(decoded.args, [[zeroAddress, token, 10000, 60, hook], [true, -BigInt(options.amountIn), limit], [false, false], '0x']);
  assert.equal(plan.transaction.target, poolRouter);
  assert.equal(plan.transaction.value, options.amountIn);
  assert.equal(plan.quote.data, plan.transaction.data);
  assert.match(plan.transaction.command, /cast send/);
  assert.match(plan.transaction.command, /--chain 11155111/);
  assert.match(plan.transaction.command, /--private-key "\$\(key 'founder-key.env'\)"/);
  assert.match(plan.transaction.command, /--gas-price 10000000000wei --priority-gas-price 2000000000wei/);
  assert.match(plan.notes.join(' '), /bounds the price, not the amount/);
  assert.match(plan.notes.join(' '), /unused ETH/);
  assert.match(plan.notes.join(' '), /no on-chain deadline/);
  assert.ok(client.calls.filter(c => typeof c === 'object').every(c => c.blockNumber === 42n));
  const id = keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
  ], [zeroAddress, token, 10000, 60, hook]));
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  assert.equal(plan.pool.poolId, id);
  assert.deepEqual(decodeFunctionData({ abi: parseAbi(['function extsload(bytes32) view returns (bytes32)']), data: plan.priceRead.data }).args, [slot]);
  assert.equal(plan.priceRead.target, RELEASE.poolManager);
  assert.match(plan.priceRead.command, /cast call.*extsload\(bytes32\)\(bytes32\).*--block 42/);
  assert.doesNotMatch(plan.priceRead.command, /private-key|cast send/);
  assert.ok(client.calls.some(c => c.functionName === 'extsload' && c.args[0] === slot));
  assert.equal(plan.pool.sqrtPriceX96, (2n * Q96).toString());
  assert.equal(plan.pool.expectedOutputAtCurrentPrice, (BigInt(options.amountIn) * 990000n / 1000000n * 4n).toString());
  assert.deepEqual(plan.pool.currentPrice, { numerator: (Q96 * Q96).toString(), denominator: (4n * Q96 * Q96).toString() });
  assert.deepEqual(plan.pool.worstPrice, { numerator: (Q96 * Q96).toString(), denominator: (limit * limit).toString() });
});

test('pool price limit rounds toward safety over small, large and boundary slippages', async () => {
  for (const sqrtPriceX96 of [4296128739n, Q96, 2n * Q96 + 1n, (1n << 159n) - 1n]) {
    for (const slippageBps of ['1', '37', '100', '2000']) {
      const plan = await prepareBuy({ ...poolOptions, slippageBps }, reader({ graduated: true, sqrtPriceX96 }));
      const limit = BigInt(plan.pool.sqrtPriceLimitX96);
      const denominator = 10000n + BigInt(slippageBps);
      assert.ok(limit < sqrtPriceX96 && limit > 4295128739n);
      assert.ok(limit * limit * denominator >= sqrtPriceX96 * sqrtPriceX96 * 10000n);
      // Minimal safe integer unless the TickMath boundary makes the limit stricter.
      if (limit > 4295128740n) assert.ok((limit - 1n) ** 2n * denominator < sqrtPriceX96 ** 2n * 10000n);
    }
  }
});

test('pool rejects zero, missing or out-of-range slippage and ambiguous minimum/quote/limit inputs before RPC', async () => {
  for (const patch of [
    { slippageBps: undefined }, { slippageBps: '0' }, { slippageBps: '2001' }, { slippageBps: '-1' },
    { slippageBps: '1.5' }, { slippageBps: 50 }, { minOut: '1' }, { quoteOut: '100' },
    { quoteBlock: '42' }, { sqrtPriceLimitX96: Q96.toString() },
  ]) {
    const client = reader({ graduated: true });
    await assert.rejects(prepareBuy({ ...poolOptions, ...patch }, client), /slippage|pool/);
    assert.deepEqual(client.calls, []);
  }
});

test('pool refuses ungraduated, failed, wrong-fee, uninitialized or exhausted price state', async () => {
  for (const patch of [{ graduated: false }, { failed: true }, { poolFee: 0 }, { sqrtPriceX96: 0n },
    { sqrtPriceX96: 4295128740n }, { sqrtPriceX96: 1461446703485210103287273052203988822378723970342n }]) {
    await assert.rejects(prepareBuy(poolOptions, reader({ graduated: true, ...patch })));
  }
});

test('pool quote-only omits send and ERC20 pool buys prepare exact approval, reset and revoke', async () => {
  const preview = await prepareBuy({ ...poolOptions, quoteOnly: true }, reader({ graduated: true }));
  assert.equal(preview.status, 'quote-only');
  assert.equal(preview.transaction, null);
  assert.match(preview.quote.command, /cast call/);
  const plan = await prepareBuy(poolOptions, reader({ graduated: true, q: addr(50), allowance: 12n, protocolFee: 1000n }));
  assert.equal(plan.transaction.value, '0');
  assert.deepEqual(plan.approvals.map(a => decodeFunctionData({ abi: approvalAbi, data: a.data }).args), [[poolRouter, 0n], [poolRouter, BigInt(options.amountIn)]]);
  assert.deepEqual(decodeFunctionData({ abi: approvalAbi, data: plan.revoke.data }).args, [poolRouter, 0n]);
  assert.equal(plan.pool.swapFeePips, '10990');
  assert.equal(plan.pool.expectedOutputAtCurrentPrice, (BigInt(options.amountIn) * 989010n / 1000000n * 4n).toString());
});

test('CLI rejects signing flags, missing values, duplicates, unknown modes and chain bypasses', () => {
  for (const args of [['--send'], ['--private-key', 'secret'], ['--chain-id', '1'], ['--allow-mainnet'], ['--box'], ['--mode', 'launch', '--mode', 'pool']]) {
    assert.throws(() => parseArgs(args));
  }
  const result = spawnSync(process.execPath, ['packages/chain/scripts/buy-v2.mjs', '--chain-id', '1'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /11155111/);
});

test('valid CLI inputs retain raw strings; positional prototype names are unknown options', () => {
  const args = ['--chain-id', '11155111', '--mode', 'launch', '--box', box, '--amount-in', options.amountIn,
    '--from', buyer, '--deadline', '1200', '--rpc', options.rpc, '--key-file', options.keyFile, '--min-out', options.minOut];
  assert.equal(parseArgs(args).amountIn, options.amountIn);
  assert.throws(() => parseArgs([...args, 'toString', 'ignored']), /unknown/);
});

test('smallest positive minimum and zero slippage remain positive; exact allowance needs no approval', async () => {
  const plan = await prepareBuy({ ...options, minOut: undefined, quoteOut: '1', slippageBps: '0', quoteBlock: '42' }, reader({ q: addr(50), allowance: BigInt(options.amountIn) }));
  assert.equal(plan.minimumOut, '1');
  assert.deepEqual(plan.approvals, []);
  assert.equal(plan.transaction.value, '0');
  assert.equal(decodeFunctionData({ abi: buyAbi, data: plan.transaction.data }).args[1], 1n);
});

test('printed command shell-quotes inputs and checks the chain before invoking key or send', async () => {
  const keyFile = "founder's $(printf INJECTED).env";
  const plan = await prepareBuy({ ...options, keyFile }, reader());
  for (const chain of ['1', '11155111']) {
    const shell = `cast() { if [ "$1" = chain-id ]; then printf '%s' '${chain}'; else printf 'SEND\\n'; fi; }\nkey() { printf '%s\\n' "$1" >&2; printf unused; }\n${plan.transaction.command}`;
    const result = spawnSync('sh', ['-c', shell], { encoding: 'utf8' });
    if (chain === '1') { assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); }
    else { assert.equal(result.status, 0); assert.equal(result.stdout, 'SEND\n'); assert.equal(result.stderr, `${keyFile}\n`); }
  }
});
