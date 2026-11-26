import { describe, expect, it } from 'vitest';
import type { Eip1193Request } from '@squarehole/chain/write';
import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';
import type { ReleaseV2 } from '../../../../../packages/chain/src/core/v2';
import { alphaDeploymentOf, tradeTargetOf } from './trade-target';

const COORDINATOR = '0x00000000000000000000000000000000000000c0';
const MANAGER = '0x00000000000000000000000000000000000000a1';
const REGISTRY = '0x00000000000000000000000000000000000000b2';
const HELPER = '0x00000000000000000000000000000000000000d3';
const HASH = `0x${'ab'.repeat(32)}`;

const record = { contracts: [COORDINATOR, ...Array.from({ length: 23 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)], codeHashes: Array.from({ length: 24 }, () => HASH) } as unknown as V2Snapshot['record'];
const release = { registry: { address: REGISTRY, codeHash: HASH } } as unknown as Pick<ReleaseV2, 'registry'>;
const sourceOf = (network: 'local' | 'sepolia', chainId: number, rpc = 'http://127.0.0.1:8592') => ({ network, rpc, origin: '', manifest: {
  chainId, chain: { poolManager: { address: MANAGER } }, releases: [{ registry: { address: REGISTRY } }] } }) as unknown as V2Source;
const alpha = (patch: Record<string, unknown> = {}, local: Record<string, unknown> = {}) => ({ schema: 'square-hole-alpha-local/1', chainId: 31337,
  registry: { address: REGISTRY, codeHash: HASH }, localDeployment: { poolSwapTest: HELPER, poolManager: MANAGER, poolSwapTestCodeHash: HASH, ...local }, ...patch });

/** Records which URL the target's RPC was made from: it must be the site's read RPC, never anything else. */
function rpcFactory() {
  const urls: string[] = [];
  const make = (url: string): Eip1193Request => { urls.push(url); return async () => null; };
  return { urls, make };
}

describe('tradeTargetOf: the build target’s chain and the site’s read RPC', () => {
  it('Sepolia: chain 11155111, the source’s keyless RPC, the explorer, no local deployment', () => {
    const rpc = rpcFactory();
    const read = tradeTargetOf(sourceOf('sepolia', 11155111, 'https://ethereum-sepolia-rpc.publicnode.com'), { record, release }, alpha(), rpc.make);
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.chainId).toBe(11155111);
    expect(read.target.coordinator).toBe(COORDINATOR);
    // A local manifest in the build is never honoured on Sepolia: the trade calls use their own pins there.
    expect(read.target.localDeployment).toBeUndefined();
    expect(rpc.urls).toEqual(['https://ethereum-sepolia-rpc.publicnode.com']);
    expect(read.target.explorer(`0x${'12'.repeat(32)}`)).toBe(`https://sepolia.etherscan.io/tx/0x${'12'.repeat(32)}`);
  });

  it('the local alpha: chain 31337 and its own PoolSwapTest, no explorer', () => {
    const rpc = rpcFactory();
    const read = tradeTargetOf(sourceOf('local', 31337), { record, release }, alpha(), rpc.make);
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.chainId).toBe(31337);
    expect(read.target.localDeployment).toEqual({ poolSwapTest: HELPER, poolManager: MANAGER, poolSwapTestCodeHash: HASH });
    expect(rpc.urls).toEqual(['http://127.0.0.1:8592']);
    expect(read.target.explorer(`0x${'12'.repeat(32)}`)).toBeNull();
  });

  it('the local twin with Sepolia’s chain id gets no trading, and no RPC is made for it', () => {
    const rpc = rpcFactory();
    expect(tradeTargetOf(sourceOf('local', 11155111), { record, release }, alpha(), rpc.make)).toEqual({ ok: false, reason: 'chain_not_allowed' });
    expect(tradeTargetOf(sourceOf('sepolia', 31337), { record, release }, alpha(), rpc.make)).toEqual({ ok: false, reason: 'chain_not_allowed' });
    expect(rpc.urls).toEqual([]);
  });

  it('the local alpha without its manifest, or with one for another deployment, gets no trading', () => {
    const rpc = rpcFactory();
    expect(tradeTargetOf(sourceOf('local', 31337), { record, release }, null, rpc.make)).toEqual({ ok: false, reason: 'deployment_required' });
    expect(tradeTargetOf(sourceOf('local', 31337), { record, release }, alpha({}, { poolManager: HELPER }), rpc.make)).toEqual({ ok: false, reason: 'deployment_required' });
  });
});

describe('alphaDeploymentOf: the alpha manifest’s localDeployment, checked, never guessed', () => {
  const source = sourceOf('local', 31337);
  it('takes a well-formed manifest of this deployment', () => {
    expect(alphaDeploymentOf(alpha(), source)).toEqual({ poolSwapTest: HELPER, poolManager: MANAGER, poolSwapTestCodeHash: HASH });
    expect(Object.isFrozen(alphaDeploymentOf(alpha(), source))).toBe(true);
  });
  it('refuses another schema, chain, registry or manager, and malformed values', () => {
    for (const [what, input] of [
      ['no manifest', null], ['a string', 'x'],
      ['another schema', alpha({ schema: 'square-hole-alpha-local/2' })], ['another chain', alpha({ chainId: 11155111 })],
      ['a registry this source does not have', alpha({ registry: { address: HELPER } })], ['no registry', alpha({ registry: undefined })],
      ['another manager', alpha({}, { poolManager: COORDINATOR })], ['a bad helper', alpha({}, { poolSwapTest: '0x1234' })],
      ['a bad hash', alpha({}, { poolSwapTestCodeHash: '0x12' })], ['no deployment', alpha({ localDeployment: undefined })],
    ] as const) expect(alphaDeploymentOf(input, source), what).toBeNull();
  });
});
