import { describe, expect, it } from 'vitest';
import type { Eip1193Request } from '@squarehole/chain/write';
import type { V2Source } from '../core/v2/indexer-v2';
import { alphaCoinRecordOf, coinsOf, coinTargetOf } from './coin-target';

const MANAGER = '0x00000000000000000000000000000000000000a1';
const TETH = '0x00000000000000000000000000000000000000e1';
const USDC = '0x00000000000000000000000000000000000000e2';
const NVDA = '0x00000000000000000000000000000000000000e3';
const HASH = `0x${'ab'.repeat(32)}`;

const sourceOf = (network: 'local' | 'sepolia', chainId: number, rpc = 'http://127.0.0.1:8592') => ({ network, rpc, origin: '', manifest: {
  chainId, chain: { poolManager: { address: MANAGER } }, releases: [] } }) as unknown as V2Source;
const pair = (coin: string, symbol: string, decimals: number) => ({ coin, symbol, decimals, fee: '3000', tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', tickLower: -887220, tickUpper: 887220 });
const record = (patch: Record<string, unknown> = {}) => ({ chainId: 31337, status: 'deployed', teth: { address: TETH, codeHash: HASH }, pairHelper: { address: '0x00000000000000000000000000000000000000f1', codeHash: HASH },
  poolManager: MANAGER, poolSwapTest: '0x00000000000000000000000000000000000000f2', poolSwapTestCodeHash: HASH, pairs: [pair(USDC, 'tUSDC', 6), pair(NVDA, 'tNVDA', 18)], ...patch });
const alpha = (coinDeployment: unknown = record(), patch: Record<string, unknown> = {}) => ({ schema: 'square-hole-alpha-local/1', chainId: 31337, coinDeployment, ...patch });

/** Records which URL the target's RPC was made from: it must be the site's read RPC, never anything else. */
function rpcFactory() {
  const urls: string[] = [];
  const make = (url: string): Eip1193Request => { urls.push(url); return async () => null; };
  return { urls, make };
}

describe('coinTargetOf: the build target’s chain, the site’s read RPC, the record’s coins', () => {
  it('Sepolia: the pinned record, deployed (sh-177): the site’s read RPC, tETH and the four pairs; the alpha manifest is not read', () => {
    const rpc = rpcFactory();
    const read = coinTargetOf(sourceOf('sepolia', 11155111, 'https://ethereum-sepolia-rpc.publicnode.com'), alpha(), rpc.make);
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.chainId).toBe(11155111);
    expect(rpc.urls).toEqual(['https://ethereum-sepolia-rpc.publicnode.com']);
    expect(read.target.localDeployment).toBeUndefined();
    expect(read.target.teth).toEqual({ address: '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E', symbol: 'tETH', decimals: 18 });
    expect(read.target.pairs).toEqual([
      { address: '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', symbol: 'tUSDC', decimals: 6 },
      { address: '0x2cbBAD2607fCCFEe778d959d386997862099f33B', symbol: 'tNVDA', decimals: 18 },
      { address: '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', symbol: 'tGOLD', decimals: 18 },
      { address: '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7', symbol: 'tPEPE', decimals: 18 },
    ]);
    expect(read.target.explorer(HASH)).toBe(`https://sepolia.etherscan.io/tx/${HASH}`);
  });

  it('the local alpha: chain 31337, the source’s RPC, the manifest’s coin record as the coin calls’ local deployment', () => {
    const rpc = rpcFactory();
    const read = coinTargetOf(sourceOf('local', 31337), alpha(), rpc.make);
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.chainId).toBe(31337);
    expect(rpc.urls).toEqual(['http://127.0.0.1:8592']);
    expect(read.target.localDeployment).toEqual(record());
    expect(read.target.teth).toEqual({ address: TETH, symbol: 'tETH', decimals: 18 });
    // The pairs are the record's, in its order: the founder may seed two pools or four.
    expect(read.target.pairs).toEqual([{ address: USDC, symbol: 'tUSDC', decimals: 6 }, { address: NVDA, symbol: 'tNVDA', decimals: 18 }]);
    expect(read.target.explorer(HASH)).toBeNull();
  });

  it('refuses the Sepolia twin, a missing source, a record that is not the alpha’s, and a malformed one', () => {
    const rpc = rpcFactory();
    expect(coinTargetOf(sourceOf('local', 11155111), alpha(), rpc.make)).toEqual({ ok: false, reason: 'chain_not_allowed' });
    expect(coinTargetOf(null, alpha(), rpc.make)).toEqual({ ok: false, reason: 'source_unavailable' });
    for (const input of [null, alpha(null), alpha(record(), { schema: 'other' }), alpha(record(), { chainId: 1 }), alpha(record({ chainId: 11155111 })),
      alpha(record({ status: 'predicted' })), alpha(record({ poolManager: '0x00000000000000000000000000000000000000a2' }))]) {
      expect(coinTargetOf(sourceOf('local', 31337), input, rpc.make)).toEqual({ ok: false, reason: 'deployment_required' });
    }
    for (const pairs of [[pair(USDC, 'tUSDC', 6.5)], [pair('0x0000000000000000000000000000000000000000', 'tUSDC', 6)], [pair(USDC, '', 6)], 'tUSDC']) {
      expect(coinTargetOf(sourceOf('local', 31337), alpha(record({ pairs })), rpc.make)).toEqual({ ok: false, reason: 'invalid_deployment' });
    }
    expect(rpc.urls).toEqual([]);
  });
});

describe('coinsOf and alphaCoinRecordOf', () => {
  it('shows tETH first, then each pair coin as recorded; nothing for a record without tETH', () => {
    expect(coinsOf(record({ pairs: [pair(NVDA, 'tNVDA', 18)] }))).toEqual({ teth: { address: TETH, symbol: 'tETH', decimals: 18 }, pairs: [{ address: NVDA, symbol: 'tNVDA', decimals: 18 }] });
    expect(coinsOf(record({ teth: { address: 'not an address' } }))).toBeNull();
    expect(coinsOf(record({ pairs: [] }))?.pairs).toEqual([]);
  });
  it('takes the alpha manifest’s record only with the same PoolManager as the site’s deployment', () => {
    expect(alphaCoinRecordOf(alpha(), sourceOf('local', 31337))).toEqual(record());
    expect(alphaCoinRecordOf(alpha(record({ poolManager: MANAGER.toUpperCase().replace('0X', '0x') })), sourceOf('local', 31337))).not.toBeNull();
    expect(alphaCoinRecordOf(alpha(record({ poolManager: '0x00000000000000000000000000000000000000a2' })), sourceOf('local', 31337))).toBeNull();
  });
});
