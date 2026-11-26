import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { collectFloor, EIP7825_GAS_CAP, feesFor, zeroBasePrice, V2_GAS_FLOORS } from '../src/gas';
import { bump } from '../src/sent';

// SH-259 Part 3: the keeper settings of the BNB Chain testnet stack (hackathon/stack/keeper.env.example) parse as they
// are, once the one placeholder is filled and ship.sh's derived values are added, and mean what their comments say.
const text = readFileSync(new URL('../../../hackathon/stack/keeper.env.example', import.meta.url), 'utf8');
const lines = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
const file = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const filled: Record<string, string> = { SH_KEEPER_ADDRESS: '0x9797979797979797979797979797979797970003' };
// What compose gives the keeper from the release's .derived.env (ship.sh step 3: from the approved manifest and the
// approved fee file, hackathon/stack/keeper-fees-97.json).
const fees = JSON.parse(readFileSync(new URL('../../../hackathon/stack/keeper-fees-97.json', import.meta.url), 'utf8')) as { floorWei: string; ceilingWei: string };
const derived: Record<string, string> = {
  SH_KEEPER_CHAIN_ID: '97',
  SH_KEEPER_BOX_REGISTRY: '0x9797979797979797979797979797979797970004',
  SH_KEEPER_FROM_BLOCK: '75000000',
  SH_KEEPER_PRIORITY_FEE_WEI: fees.floorWei,
  SH_KEEPER_MAX_FEE_WEI: fees.ceilingWei,
};
const compose = readFileSync(new URL('../../../hackathon/stack/compose.yaml', import.meta.url), 'utf8');
// What infra/server/services/runtime.mjs keeperEnvironment hands the package in a dry run.
function environment(): Record<string, string> {
  const service = new Set(['SH_SERVICE_ENABLED', 'SH_SERVICE_MODE', 'SH_SERVICE_ALLOW_MAINNET', 'SH_KEEPER_KEY_FILE']);
  const kept = Object.entries({ ...file, ...filled, ...derived }).filter(([name]) => !service.has(name));
  return { ...Object.fromEntries(kept), SH_KEEPER_DRY_RUN: '1', SH_KEEPER_ALLOW_MAINNET: '0' };
}
const tBNB = 10n ** 18n; // wei of tBNB
const gwei = 10n ** 9n;

describe('SH-259: the keeper settings for BNB Chain testnet', () => {
  it('has one placeholder (the signer) and no value with a comment or quotes', () => {
    expect(Object.entries(file).filter(([, value]) => value.startsWith('<')).map(([name]) => name)).toEqual(['SH_KEEPER_ADDRESS']);
    for (const [name, value] of Object.entries(file)) expect(value, name).not.toMatch(/^\S*\s+#|["']/);
    expect(file.SH_SERVICE_ENABLED).toBe('0');
    expect(file.SH_SERVICE_MODE).toBe('dry-run');
  });

  it('never sets the chain, the registry, the start block or the fees: compose requires them from the ship\'s derived file', () => {
    for (const name of Object.keys(derived)) expect(file[name], name).toBeUndefined();
    expect(compose).toContain('SH_KEEPER_CHAIN_ID: ${SH_BNB_KEEPER_CHAIN_ID:?');
    expect(compose).toContain('SH_KEEPER_BOX_REGISTRY: ${SH_BNB_KEEPER_REGISTRY:?');
    expect(compose).toContain('SH_KEEPER_FROM_BLOCK: ${SH_BNB_KEEPER_FROM_BLOCK:?');
    // The fee floor and ceiling are required too: never the package's defaults (0.05 gwei, 3 gwei).
    expect(compose).toContain('SH_KEEPER_PRIORITY_FEE_WEI: ${SH_BNB_KEEPER_PRIORITY_FEE_WEI:?');
    expect(compose).toContain('SH_KEEPER_MAX_FEE_WEI: ${SH_BNB_KEEPER_MAX_FEE_WEI:?');
  });

  it('parses for chain 97 with Osaka rules and the 2^24 gas cap', () => {
    const cfg = loadConfig(environment());
    expect(cfg.chainId).toBe(97);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.destinationGas).toEqual({ fork: 'osaka', transactionCap: EIP7825_GAS_CAP });
    expect(new URL(cfg.rpcUrl).host).toBe('bsc-testnet-rpc.publicnode.com');
    expect(cfg.box0).toBeNull();
  });

  it('prices every send at no less than the network\'s 0.1 gwei, and waits above 0.2 gwei', () => {
    const cfg = loadConfig(environment());
    expect(cfg.priorityFeeWei).toBe(gwei / 10n);
    expect(cfg.limits.maxFeePerGas).toBe(gwei / 5n);
    // The fees every job of a tick is signed with (run.ts: feesFor(the pending block's base fee, priorityFeeWei)); chain
    // 97's base fee is 0 and eth_gasPrice answered 100,000,000 wei (probe of 25 November).
    const fees = feesFor(0n, cfg.priorityFeeWei);
    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
    // A replacement of a hanging send raises both fields by an eighth, up to the ceiling (sent.ts bump, chain.ts).
    expect(bump(fees.maxFeePerGas)).toBe(112_500_000n);
  });

  it('signs at the tick\'s eth_gasPrice plus a quarter on a chain without a base fee, at most the ceiling, else waits', () => {
    const cfg = loadConfig(environment());
    const ceiling = cfg.limits.maxFeePerGas ?? 0n;
    // run.ts and chain.ts (rule A): both fee fields at this price; null signs and broadcasts nothing that tick.
    expect(zeroBasePrice(100_000_000n, cfg.priorityFeeWei, ceiling)).toBe(125_000_000n);
    expect(zeroBasePrice(120_000_000n, cfg.priorityFeeWei, ceiling)).toBe(150_000_000n);
    expect(zeroBasePrice(180_000_000n, cfg.priorityFeeWei, ceiling)).toBe(200_000_000n);
    expect(zeroBasePrice(200_000_000n, cfg.priorityFeeWei, ceiling)).toBe(200_000_000n);
    expect(zeroBasePrice(200_000_001n, cfg.priorityFeeWei, ceiling)).toBeNull();
    expect(zeroBasePrice(250_000_000n, cfg.priorityFeeWei, ceiling)).toBeNull();
    expect(zeroBasePrice(null, cfg.priorityFeeWei, ceiling)).toBeNull();
    expect(zeroBasePrice(0n, cfg.priorityFeeWei, ceiling)).toBeNull();
    // Under the configured floor the floor is the price; a quarter rounds up.
    expect(zeroBasePrice(10_000_000n, cfg.priorityFeeWei, ceiling)).toBe(100_000_000n);
    expect(zeroBasePrice(100_000_001n, cfg.priorityFeeWei, ceiling)).toBe(125_000_002n);
    expect(feesFor(0n, 150_000_000n)).toEqual({ baseFeePerGas: 0n, maxPriorityFeePerGas: 150_000_000n, maxFeePerGas: 150_000_000n });
  });

  it('budgets a day inside a float of 0.005 tBNB at the usual signed price, 0.125 gwei (a 0.1 gwei quote plus a quarter)', () => {
    const { limits } = loadConfig(environment());
    const price = zeroBasePrice(100_000_000n, BigInt(fees.floorWei), BigInt(fees.ceilingWei)) ?? 0n;
    expect(price).toBe(125_000_000n);
    const reserve = (job: keyof typeof V2_GAS_FLOORS) => V2_GAS_FLOORS[job] * price;
    expect(reserve('graduate')).toBe(1_687_500_000_000_000n); // 0.0016875 tBNB
    expect(collectFloor('osaka') * price).toBe(625_000_000_000_000n); // 0.000625
    expect(reserve('deepen')).toBe(1_000_000_000_000_000n); // 0.001
    expect(reserve('fail')).toBe(1_875_000_000_000_000n); // 0.001875
    expect(limits.totalWeiPerDay).toBe(4n * tBNB / 1000n);
    expect(limits.totalWeiPerDay).toBeLessThan(5n * tBNB / 1000n);
    expect(limits.oursWeiPerDay).toBeLessThanOrEqual(limits.totalWeiPerDay);
    // The recovery room (0.0015) holds neither a closing nor a graduation at this price (the template says so); the
    // day holds one of each together.
    expect(limits.reserveWeiPerDay).toBe(1_500_000_000_000_000n);
    expect(limits.reserveWeiPerDay).toBeLessThan(reserve('graduate'));
    expect(reserve('fail') + reserve('graduate')).toBeLessThanOrEqual(limits.totalWeiPerDay);
    expect(limits.pokesWeiPerDay).toBe(0n);
    expect(limits.drandRescueWeiPerDay).toBe(0n);
  });

  it('paces in blocks of 0.45 s: retries after about 30 s, the buy alert after about an hour', () => {
    const cfg = loadConfig(environment());
    expect(cfg.retryBlocks * 450n / 1000n).toBe(29n);
    expect(cfg.buyBackAlertBlocks * 450n / 1000n).toBe(3_600n);
    expect(cfg.pollMs).toBe(2_000);
  });
});
