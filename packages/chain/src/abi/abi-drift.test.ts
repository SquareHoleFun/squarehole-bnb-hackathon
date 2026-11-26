/**
 * ABI drift guard: every exported ABI must equal the compiled artifact of the pinned contracts, byte for byte as
 * JSON. A contract change without `pnpm --filter @squarehole/chain abi:export` fails here.
 *
 * The artifacts live in packages/contracts/out (gitignored; `forge build`). When they are absent (a checkout without
 * Foundry) the artifact comparison is reported as skipped, never as passed; the lens ABIs need `forge` on PATH.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { CORE_EVENTS, type EventSource } from '../core/roles';
import * as abis from './index';

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts');
const OUT = join(CONTRACTS, 'out');
const hasOut = existsSync(join(OUT, 'SquareHoleRegistry.sol/SquareHoleRegistry.json'));
const hasForge = spawnSync('forge', ['--version'], { encoding: 'utf8' }).status === 0;

const exported = abis as unknown as Record<string, unknown>;
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('ABI exports', () => {
  it('every ABI_SOURCES entry is exported and its recorded digest matches the embedded ABI', () => {
    expect(abis.ABI_SOURCES.length).toBe(28);
    for (const source of abis.ABI_SOURCES) {
      const abi = exported[source.name];
      expect(Array.isArray(abi), source.name).toBe(true);
      expect(sha256(abi), source.name).toBe(source.sha256);
    }
  });

  it('exposes the read surface the providers rely on', () => {
    const names = (abi: readonly { type: string; name?: string }[]) => new Set(abi.map((item) => `${item.type}:${item.name ?? ''}`));
    expect(names(abis.squareHoleRegistryAbi)).toContain('event:PairCreated');
    expect(names(abis.squareHoleRegistryAbi)).toContain('function:pairIds');
    expect(names(abis.rewardLedgerAbi)).toContain('function:claimable');
    expect(names(abis.rewardLedgerAbi)).toContain('event:Claimed');
    expect(names(abis.feeCollectorAbi)).toContain('event:FeeTBurned');
    expect(names(abis.poolManagerAbi)).toContain('event:Swap');
    expect(names(abis.poolManagerAbi)).toContain('function:extsload');
    expect(names(abis.stateViewAbi)).toContain('function:getSlot0');
    expect(names(abis.v4QuoterAbi)).toContain('function:quoteExactInputSingle');
    expect(names(abis.squareHoleClaimConverterAbi)).toContain('event:ClaimConverted');
  });
});

/** S10a § 2.1: the core v1 artifact each event source's events are decoded with. */
const CORE_ABI_BY_SOURCE: Readonly<Record<EventSource, readonly { type: string; name?: string }[] | null>> = {
  registry: abis.boxRegistryAbi,
  poolManager: abis.poolManagerAbi,
  hook: abis.boxHookAbi,
  launchRouter: abis.boxLaunchRouterAbi,
  coordinator: abis.boxCoordinatorAbi,
  receiver: abis.boxReceiverAbi,
  vault: abis.boxVaultAbi,
  collection: abis.boxCollectionAbi,
  tickets: abis.boxTicketsAbi,
  itemStream: abis.boxItemStreamAbi,
  executor: abis.fitBuybackExecutorAbi,
  randomness: abis.drandSourceAbi,
  backedSource: abis.backedSourceAbi,
  royaltyRouter: abis.boxRoyaltyRouterAbi,
  token: abis.boxTokenAbi,
  swapModule: null,
  metadataTable: null,
};

describe('core v1 ABIs (S10a § 2.1, § 3.3)', () => {
  it('every event the indexer decodes is in the generated ABI of the contract that emits it', () => {
    const missing: string[] = [];
    for (const [source, events] of Object.entries(CORE_EVENTS) as [EventSource, readonly string[]][]) {
      const abi = CORE_ABI_BY_SOURCE[source];
      if (events.length === 0) continue;
      if (abi === null) {
        missing.push(`${source}: no ABI`);
        continue;
      }
      const names = new Set(abi.filter((item) => item.type === 'event').map((item) => item.name));
      for (const event of events) if (!names.has(event)) missing.push(`${source}.${event}`);
    }
    expect(missing).toEqual([]);
  });

  it('exposes the registry and factory reads the box row and the manifest writer use', () => {
    const fns = (abi: readonly { type: string; name?: string }[]) => new Set(abi.filter((i) => i.type === 'function').map((i) => i.name));
    for (const name of ['recordOf', 'entry', 'boxCount', 'factory', 'ROLE_COUNT']) expect(fns(abis.boxRegistryAbi), name).toContain(name);
    for (const name of ['registry', 'poolManager', 'weth', 'randomness', 'platformSafe', 'implementations', 'versionCodeHash', 'hookExtension', 'receiverExtension', 'VERSION', 'templateIdOf']) {
      expect(fns(abis.boxFactoryV1Abi), name).toContain(name);
    }
    for (const name of ['phase', 'depthBudget', 'pairedLiquidity', 'reserveMinted', 'graduatedLayout', 'openAt', 'windowEndsAt', 'WINDOW_SECONDS', 'closedAtBlock', 'migratedAtBlock']) expect(fns(abis.boxHookAbi), name).toContain(name);
  });
});

describe.skipIf(!hasOut)('ABI drift against packages/contracts/out (forge build)', () => {
  for (const source of abis.ABI_SOURCES) {
    if (!('artifact' in source)) continue;
    it(`${source.name} equals out/${source.artifact}`, () => {
      const artifact = JSON.parse(readFileSync(join(OUT, source.artifact), 'utf8')) as { abi: unknown };
      expect(exported[source.name]).toEqual(artifact.abi);
    });
  }
});

describe('revert error table (write side)', () => {
  it('lists each error signature once and includes the errors a write must explain', () => {
    const names = abis.revertErrorsAbi.map((error) => error.name);
    for (const name of ['CollectionTooLarge', 'NothingToClaim', 'InsufficientOutput', 'Expired', 'WrappedError', 'PoolOutflowAtFeeEvent']) {
      expect(names, name).toContain(name);
    }
    const signatures = abis.revertErrorsAbi.map((error) => `${error.name}(${error.inputs.map((input) => input.type).join(',')})`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe.skipIf(!hasOut)('revert error table against packages/contracts/out (forge build)', () => {
  for (const source of abis.REVERT_ERROR_SOURCES) {
    it(`source out/${source.artifact} is unchanged`, () => {
      const artifact = JSON.parse(readFileSync(join(OUT, source.artifact), 'utf8')) as { abi: unknown };
      expect(sha256(artifact.abi)).toBe(source.sha256);
    });
  }
});

describe.skipIf(!hasForge)('ABI drift against the pinned v4-periphery lens sources (forge inspect)', () => {
  for (const source of abis.ABI_SOURCES) {
    if (!('lens' in source)) continue;
    it(`${source.name} equals forge inspect ${source.lens}`, () => {
      const result = spawnSync('forge', ['inspect', source.lens, 'abi', '--json'], { cwd: CONTRACTS, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      expect(result.status, result.stderr).toBe(0);
      expect(exported[source.name]).toEqual(JSON.parse(result.stdout));
    }, shLimit(120_000));
  }
});
