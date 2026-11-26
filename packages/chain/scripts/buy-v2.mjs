#!/usr/bin/env node
/** Founder-only Sepolia preparation. Read-only RPC; no files, keys, subprocesses or broadcasts. */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseAbi, zeroAddress } from 'viem';

// docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json (core-v21-rc8).
export const RELEASE = Object.freeze({
  factory: '0xFAe1E6CFF43CAdcBE01885BdD0AA6218263de393',
  registry: '0x5D2866EF084d801aE734D3A2A6E4F7179898737C',
  poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
});
const POOL_SWAP_TEST = '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe';
const CHAIN = '11155111';
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_INT128 = (1n << 127n) - 1n;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const Q192 = 1n << 192n;
const BUY = 'buy(uint256,uint256,address,uint256)(uint256)';
const SWAP = 'swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)(int256)';
const ABI = parseAbi([
  'function buy(uint256,uint256,address,uint256) payable returns (uint256)',
  'function swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes) payable returns (int256)',
  'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)',
  'function boxIdOf(address) view returns (bool,uint256)',
  ...['factory', 'registry', 'initialHolder', 'coordinator', 'token', 'q', 'hook', 'launchRouter', 'poolManager', 'manager'].map(name => `function ${name}() view returns (address)`),
  ...['failed', 'graduated', 'gateOpen', 'closed'].map(name => `function ${name}() view returns (bool)`),
  ...['effectiveOpenAt', 'windowEndsAt'].map(name => `function ${name}() view returns (uint256)`),
  'function extsload(bytes32) view returns (bytes32)',
  'function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))',
]);
export const stringify = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const shell = value => `'${value.replaceAll("'", "'\\''")}'`;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function raw(value, name, max = MAX_UINT256, allowZero = false) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `${name}: use a raw decimal string`);
  const n = BigInt(value);
  requireThat(n <= max && (allowZero || n > 0n), `${name}: out of range or zero`);
  return n;
}
function address(value, name, allowZero = false) {
  let a;
  try { a = getAddress(value); } catch { throw new Error(`${name}: invalid address`); }
  requireThat(allowZero || a !== zeroAddress, `${name}: zero address`);
  return a;
}

function validate(input) {
  requireThat(input.chainId === CHAIN, 'Only Sepolia chain 11155111 is allowed');
  requireThat(['launch', 'pool'].includes(input.mode), 'mode must be launch or pool');
  const o = { ...input, box: address(input.box, 'box'), from: address(input.from, 'from'),
    amount: raw(input.amountIn, 'amount-in', MAX_INT128), deadlineValue: raw(input.deadline, 'deadline'),
    maxFeeWei: input.maxFeeWei ?? '10000000000', priorityFeeWei: input.priorityFeeWei ?? '2000000000' };
  const maxFee = raw(o.maxFeeWei, 'max-fee-wei');
  requireThat(raw(o.priorityFeeWei, 'priority-fee-wei') <= maxFee, 'priority fee exceeds maximum fee');
  requireThat(typeof o.rpc === 'string' && /^https?:\/\//.test(o.rpc) && !/[\r\n\0]/.test(o.rpc), 'rpc: HTTP(S) URL required');
  requireThat(typeof o.keyFile === 'string' && o.keyFile.length > 0 && !/[\r\n\0]/.test(o.keyFile), 'key-file: path required (printed only, never read)');
  requireThat(o.sqrtPriceLimitX96 === undefined, 'pool price limit is derived from slippage-bps; no manual override');
  if (o.mode === 'pool') {
    o.bps = raw(o.slippageBps, 'pool slippage-bps (1-2000)', 2000n);
    requireThat(o.minOut === undefined && o.quoteOut === undefined && o.quoteBlock === undefined,
      'pool mode uses slippage-bps and current pool price only; min-out and quote inputs are unsupported');
    return o;
  }
  const hasQuote = o.quoteOut !== undefined || o.slippageBps !== undefined || o.quoteBlock !== undefined;
  if (o.quoteOnly) {
    requireThat(o.minOut === undefined && !hasQuote, 'quote-only cannot also specify an output limit');
  } else if (o.minOut !== undefined) {
    requireThat(!hasQuote, 'choose min-out OR quote-out + slippage-bps + quote-block');
    o.minimum = raw(o.minOut, 'min-out');
  } else {
    const quote = raw(o.quoteOut, 'quote-out');
    const bps = raw(o.slippageBps, 'slippage-bps', 9999n, true);
    o.quoteBlockValue = raw(o.quoteBlock, 'quote-block');
    o.minimum = quote * (10000n - bps) / 10000n;
    requireThat(o.minimum > 0n, 'minimum output rounds to zero');
  }
  return o;
}

// Floor square root without floating point; used on the full precision rational price.
function sqrt(n) {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
function poolLimit(spot, bps) {
  requireThat(spot > MIN_SQRT && spot < MAX_SQRT, 'pool price is uninitialized or outside TickMath bounds');
  // P is currency0, T is currency1: P/T = 2^192 / sqrtPriceX96^2.
  // Cap P/T at spot P/T * (1 + bps/10000). Round sqrt UP so the cap cannot widen.
  const numerator = spot * spot * 10000n;
  const denominator = 10000n + bps;
  let limit = sqrt(numerator / denominator);
  if (limit * limit * denominator < numerator) limit += 1n;
  if (limit <= MIN_SQRT) limit = MIN_SQRT + 1n;
  requireThat(limit < spot, 'pool price leaves no room for a valid buy limit');
  return limit;
}

function chainGuard(o) {
  return `test "$(cast chain-id --rpc-url ${shell(o.rpc)})" = ${CHAIN}`;
}
function transaction(o, target, data, value, gasLimit) {
  return { chainId: CHAIN, from: o.from, target, value: value.toString(), data, gasLimit,
    maxFeePerGas: o.maxFeeWei, maxPriorityFeePerGas: o.priorityFeeWei,
    command: `${chainGuard(o)} && cast send ${target} --data ${data} --value ${value}wei --rpc-url ${shell(o.rpc)} --chain ${CHAIN} --gas-limit ${gasLimit} --gas-price ${o.maxFeeWei}wei --priority-gas-price ${o.priorityFeeWei}wei --from ${o.from} --private-key "$(key ${shell(o.keyFile)})"` };
}
function quoteCall(o, target, fn, args, signature, castArgs, value, block) {
  return { target, value: value.toString(), data: encodeFunctionData({ abi: ABI, functionName: fn, args }),
    command: `${chainGuard(o)} && cast call ${target} ${shell(signature)} ${castArgs.map(shell).join(' ')} --from ${o.from} --value ${value}wei --gas-limit 8000000 --block ${block.number} --rpc-url ${shell(o.rpc)}` };
}

/** A read client is injected for offline tests; all state reads use one named evidence block. */
export async function prepareBuy(input, client) {
  const o = validate(input);
  requireThat(String(await client.getChainId()) === CHAIN, 'RPC must report Sepolia chain 11155111');
  const latest = await client.getBlock();
  const block = o.quoteBlockValue === undefined ? latest : await client.getBlock({ blockNumber: o.quoteBlockValue });
  requireThat(block.number !== null && block.hash, 'a mined evidence block is required');
  requireThat(block.number <= latest.number && block.timestamp <= latest.timestamp && latest.timestamp - block.timestamp <= 120n, 'quote block is future or stale (maximum 120 seconds)');
  requireThat(o.deadlineValue > latest.timestamp && o.deadlineValue <= latest.timestamp + 600n, 'deadline must be in the next 600 seconds');
  const read = (target, functionName, args = []) => client.readContract({ address: target, abi: ABI, functionName, args, blockNumber: block.number });
  const deployed = async target => requireThat((await client.getCode({ address: target, blockNumber: block.number }))?.length > 2, 'required contract has no code');
  requireThat(same(await read(RELEASE.registry, 'factory'), RELEASE.factory), 'registry factory differs from rc8 deployment');
  let coordinator = o.box;
  let [recorded, boxId] = await read(RELEASE.registry, 'boxIdOf', [coordinator]);
  if (!recorded) {
    coordinator = address(await read(o.box, 'initialHolder'), 'token initialHolder');
    [recorded, boxId] = await read(RELEASE.registry, 'boxIdOf', [coordinator]);
  }
  requireThat(recorded, 'box is not recorded in the rc8 registry');
  requireThat(same(await read(coordinator, 'registry'), RELEASE.registry), 'box registry mismatch');
  const token = address(await read(coordinator, 'token'), 'token');
  requireThat(same(o.box, coordinator) || same(o.box, token), 'box address is neither the coordinator nor its token');
  const hook = address(await read(coordinator, 'hook'), 'hook');
  const router = address(await read(coordinator, 'launchRouter'), 'launchRouter');
  const priceCoin = address(await read(coordinator, 'q'), 'price coin', true);
  for (const target of [coordinator, token, hook, router]) await deployed(target);
  for (const target of [hook, router]) {
    for (const [name, expected] of [['coordinator', coordinator], ['token', token], ['q', priceCoin], ['poolManager', RELEASE.poolManager]]) {
      requireThat(same(await read(target, name), expected), `${name} wiring mismatch`);
    }
  }
  requireThat(same(await read(router, 'hook'), hook), 'router hook mismatch');
  requireThat(!(await read(coordinator, 'failed')), 'box failed');
  const graduated = await read(coordinator, 'graduated');
  const value = priceCoin === zeroAddress ? o.amount : 0n;
  const plan = { status: 'ready', mode: o.mode, chainId: CHAIN, coordinator, token, priceCoin, boxId: boxId.toString(),
    blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: block.timestamp.toString(),
    amountIn: o.amountIn, minimumOut: o.minimum?.toString() ?? null,
    quoteInput: o.quoteOut === undefined ? null : { output: o.quoteOut, slippageBps: o.slippageBps, blockNumber: o.quoteBlock },
    transaction: null, approvals: [], revoke: null,
    notes: ['Nothing sent. Review the unsigned call; only the founder runs the printed commands.',
      'Amounts are raw units. Explicit fee caps are in wei. The helper never reads the key-file path.',
      'A quote is a simulation at its recorded block, not a guarantee of execution.'] };

  const prepareApprovals = async spender => {
    if (priceCoin === zeroAddress) return;
    const allowance = await read(priceCoin, 'allowance', [o.from, spender]);
    const approve = amount => transaction(o, priceCoin, encodeFunctionData({ abi: ABI, functionName: 'approve', args: [spender, amount] }), 0n, '1000000');
    if (allowance !== o.amount) {
      if (allowance !== 0n) plan.approvals.push(approve(0n));
      plan.approvals.push(approve(o.amount));
    }
    plan.revoke = approve(0n);
    plan.notes.push('ERC20: execute required exact approvals first, then rerun quote-only at a NEW block. An eth_call at a pre-approval block still lacks allowance. Revoke any unspent allowance after buying.');
  };

  if (o.mode === 'pool') {
    requireThat(graduated, 'pool mode requires graduation');
    const k = await read(hook, 'poolKey');
    const key = Array.isArray(k) ? k : [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
    requireThat(same(key[0], priceCoin) && same(key[1], token) && same(key[4], hook) && BigInt(key[2]) === 10000n && BigInt(key[3]) === 60n, 'pool key differs from rc8 box wiring');
    await deployed(POOL_SWAP_TEST);
    requireThat(same(await read(POOL_SWAP_TEST, 'manager'), RELEASE.poolManager), 'PoolSwapTest manager mismatch');
    const poolId = keccak256(encodeAbiParameters([
      { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
    ], key));
    // Same StateLibrary layout as chain/src/reads/reader.ts and BoxHookV2Base._slot0.
    const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
    const word = BigInt(await read(RELEASE.poolManager, 'extsload', [slot]));
    const spot = word & ((1n << 160n) - 1n);
    const limit = poolLimit(spot, o.bps);
    const protocolFee = (word >> 184n) & 0xfffn; // zeroForOne direction only
    const lpFee = (word >> 208n) & 0xffffffn;
    requireThat(lpFee === 10000n && protocolFee <= 1000n, 'pool fees differ from rc8/v4 bounds');
    const swapFee = protocolFee + lpFee - protocolFee * lpFee / 1000000n;
    const netInput = o.amount * (1000000n - swapFee) / 1000000n;
    plan.protection = 'price-limit-only';
    plan.pool = { poolId, slippageBps: o.slippageBps, sqrtPriceX96: spot.toString(), sqrtPriceLimitX96: limit.toString(),
      priceUnits: 'raw price coin per raw token (numerator / denominator)',
      currentPrice: { numerator: Q192.toString(), denominator: (spot * spot).toString() },
      worstPrice: { numerator: Q192.toString(), denominator: (limit * limit).toString() },
      swapFeePips: swapFee.toString(),
      expectedOutputAtCurrentPrice: (netInput * spot * spot / Q192).toString() };
    plan.priceRead = quoteCall(o, RELEASE.poolManager, 'extsload', [slot], 'extsload(bytes32)(bytes32)', [slot], 0n, block);
    const params = [true, -o.amount, limit];
    plan.quote = quoteCall(o, POOL_SWAP_TEST, 'swap', [key, params, [false, false], '0x'], SWAP,
      [`(${key.join(',')})`, `(true,-${o.amount},${limit})`, '(false,false)', '0x'], value, block);
    plan.notes.push(
      'Sepolia pool mode bounds the price, not the amount: no minimum token output is enforced. Partial fills may deliver very little T.',
      'Current/worst prices are pool marginal prices before fees. The current-price expected output deducts the recorded swap fee but ignores price impact, per-step rounding and partial fills; it is an estimate, not an execution quote.',
      'PoolSwapTest settles only actual input including fees and returns unused ETH to the buyer; unused ERC20 input stays with the buyer. Gas still costs ETH.',
      'PoolSwapTest has no on-chain deadline. The supplied deadline is a preparation freshness check only; regenerate and simulate immediately before sending.',
      'priceRead.command reads packed slot0: the low 160 bits are sqrtPriceX96. quote.command simulates this swap; its signed packed BalanceDelta has T output in the low 128 bits.'
    );
    await prepareApprovals(POOL_SWAP_TEST);
    if (o.quoteOnly) plan.status = 'quote-only';
    else plan.transaction = transaction(o, POOL_SWAP_TEST, plan.quote.data, value, '8000000');
    return plan;
  }

  requireThat(!graduated, 'box graduated: launch mode is unavailable');
  requireThat(await read(coordinator, 'gateOpen'), 'box gate is closed');
  const open = await read(coordinator, 'effectiveOpenAt');
  const end = await read(hook, 'windowEndsAt');
  requireThat(block.timestamp >= open && latest.timestamp < end, 'outside launch window');
  requireThat(!(await read(hook, 'closed')), 'launch curve is closed');
  requireThat(o.deadlineValue < end, 'deadline must precede the launch window end');
  const buyArgs = [o.amount, o.minimum ?? 1n, o.from, o.deadlineValue];
  plan.quote = quoteCall(o, router, 'buy', [o.amount, 1n, o.from, o.deadlineValue], BUY,
    [o.amountIn, '1', o.from, o.deadline], value, block);
  plan.notes.push('Use the uint256 returned by this buy eth_call as quote-out. Router quote(uint256) returns tax and swapIn, NOT T output.');
  await prepareApprovals(router);
  if (o.quoteOnly) plan.status = 'quote-only';
  else plan.transaction = transaction(o, router, encodeFunctionData({ abi: ABI, functionName: 'buy', args: buyArgs }), value, '8000000');
  return plan;
}

const FLAGS = {
  '--chain-id': 'chainId', '--mode': 'mode', '--box': 'box', '--amount-in': 'amountIn', '--min-out': 'minOut',
  '--from': 'from', '--deadline': 'deadline', '--rpc': 'rpc', '--key-file': 'keyFile', '--max-fee-wei': 'maxFeeWei',
  '--priority-fee-wei': 'priorityFeeWei', '--quote-out': 'quoteOut', '--slippage-bps': 'slippageBps',
  '--quote-block': 'quoteBlock',
};
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag === '--quote-only' ? 'quoteOnly' : Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : undefined;
    requireThat(name && o[name] === undefined, `unknown or duplicate option: ${flag}`);
    if (name === 'quoteOnly') o[name] = true;
    else {
      const value = argv[++i];
      requireThat(value !== undefined && !value.startsWith('--'), `missing value for ${flag}`);
      o[name] = value;
    }
  }
  validate(o);
  return o;
}
const HELP = `Sepolia founder purchase preparation; no keys read, nothing sent.
Required: --chain-id 11155111 --mode launch|pool --box ADDRESS --amount-in RAW
          --from ADDRESS --deadline UNIX_SECONDS --rpc URL --key-file FILE
Launch:   --min-out RAW | --quote-out RAW --slippage-bps BPS --quote-block BLOCK | --quote-only
Fees:     --max-fee-wei RAW (default 10000000000) --priority-fee-wei RAW (default 2000000000)
Pool:     --slippage-bps BPS (required, 1-2000); optional --quote-only. Price limit only, no output minimum.
          Limit derived from current slot0; partial fills refund unused input. No on-chain deadline.
Output: JSON with exact unsigned calls and quoted cast commands. key() is the founder's existing shell function.
Launch quote: cast call buy(...)(uint256) returns tokens; quote(uint256) returns tax/swapIn instead.
`;
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntry()) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(HELP);
    else {
      const o = parseArgs(process.argv.slice(2));
      const plan = await prepareBuy(o, createPublicClient({ transport: http(o.rpc, { retryCount: 0, timeout: 15000 }) }));
      process.stdout.write(`${stringify(plan)}\n`);
    }
  } catch (error) {
    // RPC errors can include private endpoint credentials. Only local validation messages are useful here.
    const message = error.constructor === Error ? error.message : 'Read or encoding failed; check public inputs and RPC.';
    process.stderr.write(`buy-v2: ${message}\n`);
    process.exitCode = 1;
  }
}
