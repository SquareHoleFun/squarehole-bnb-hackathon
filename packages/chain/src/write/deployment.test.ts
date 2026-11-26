/**
 * Deployment manifest parsing for writes: only a `deployed` squarehole.deployment/v1 manifest on a write chain, exact
 * addresses, templates keyed by version with their N bound, mock quotes flagged for disclosures.
 */
import { describe, expect, it } from 'vitest';
import { DeploymentManifestError, parseWriteDeployment, templateForQuote } from './deployment';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const entry = (n: number, contract: string) => ({ address: a(n), codehash: `0x${'00'.repeat(32)}`, contract, constructorArgs: '0x' });

/**
 * Shape of packages/contracts/deployments/31337.json (trimmed, plus a field the parser ignores). Parsed by the one
 * manifest parser of the package (config/manifest.ts) and projected for the writers.
 */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'squarehole.deployment/v1',
    status: 'deployed',
    chainId: 31337,
    network: 'anvil (local, chain 31337)',
    startBlock: 1,
    endBlock: 17,
    deployer: a(0xf0),
    registryAdmin: a(0xf0),
    treasury: a(0xf0),
    gitCommit: '097710ffe2e37e01bc88133f723041f165ea25a9',
    gitDirty: false,
    contracts: {
      registry: entry(1, 'SquareHoleRegistry'),
      launcher: entry(2, 'SquareHoleLauncher'),
      hook: { ...entry(3, 'SquareHoleHook'), permissionFlags: '0x2a60' },
      poolManager: entry(4, 'PoolManager (Uniswap v4-core @ pin; LOCAL, BUSL-1.1 non-production)'),
      claimConverter: entry(5, 'SquareHoleClaimConverter'),
      USDT: entry(6, 'MockTetherUSD (USDT-TEST; testnet mock)'),
      WETH: entry(7, 'LocalWETH9 (LOCAL mock)'),
    },
    templates: {
      WETH: { version: 1, quote: a(7), active: true, startFdvQ: '1000000000000000000', minStartUnitValueQ: '100000000000000', maxCollectionUnits: '10000', tickSpacing: 60, rangeTicks: 69060, shape: 1, addedAtBlock: 12 },
      USDT: { version: 3, quote: a(6), active: true, startFdvQ: '5000000000', minStartUnitValueQ: '500000', maxCollectionUnits: '10000', tickSpacing: 60, rangeTicks: 69060, shape: 1, addedAtBlock: 14 },
    },
    launches: {},
    ...overrides,
  };
}

describe('parseWriteDeployment', () => {
  it('reads exact addresses, templates by version and flags the mock USDT', () => {
    const d = parseWriteDeployment(manifest(), 31337);
    expect(d).toMatchObject({ chainId: 31337, registry: a(1), launcher: a(2), hook: a(3), poolManager: a(4), converter: a(5), testnetMockQuotes: [a(6)] });
    expect(d.templates.map((t) => [t.version, t.label, t.maxCollectionUnits])).toEqual([
      [1, 'WETH', 10_000n],
      [3, 'USDT', 10_000n],
    ]);
    expect(templateForQuote(d, a(7) as `0x${string}`)?.version).toBe(1);
    expect(templateForQuote(d, a(99) as `0x${string}`)).toBeNull();
  });

  it('refuses plans, dry runs, other chains, mainnet and inconsistent templates', () => {
    expect(() => parseWriteDeployment(manifest({ status: 'pending-broadcast' }), 31337)).toThrow(DeploymentManifestError);
    expect(() => parseWriteDeployment(manifest({ status: 'simulated' }), 31337)).toThrow(/status/);
    expect(() => parseWriteDeployment(manifest(), 11_155_111)).toThrow(/for chain 31337, expected 11155111/);
    expect(() => parseWriteDeployment(manifest({ chainId: 1 }), 1)).toThrow(/not a write chain/);
    const bad = manifest();
    bad.templates.WETH.maxCollectionUnits = '1000000000';
    expect(() => parseWriteDeployment(bad, 31337)).toThrow(/maxCollectionUnits must equal/);
    const zero = manifest();
    zero.contracts.launcher.address = a(0);
    expect(() => parseWriteDeployment(zero, 31337)).toThrow(/zero address/);
  });

  it('a deployment without a converter has converter null (R = T launches are refused)', () => {
    const m = manifest();
    delete (m.contracts as Record<string, unknown>).claimConverter;
    expect(parseWriteDeployment(m, 31337).converter).toBeNull();
  });
});
