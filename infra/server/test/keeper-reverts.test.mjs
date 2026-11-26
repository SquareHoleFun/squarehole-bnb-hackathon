import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../services/runtime.mjs';

// SH-109. The service built its RPC client from viem's CommonJS build (keeper.mjs:13-15 at 4237496b8) while the keeper
// package tells a revert from a node failure with instanceof against its own ESM viem (packages/keeper/src/read-failure.ts).
// Two copies of viem: on Sepolia every reverted simulation was logged as "simulation error" and queued as waiting work.
const captured = vi.hoisted(() => ({ port: null }));
vi.mock('../../../packages/keeper/src/state.ts', () => ({ StateStore: class { load() { return {}; } save() {} close() {} } }));
vi.mock('../../../packages/keeper/src/chain.ts', async (original) => {
  const real = await original();
  return { ...real, ViemChain: class extends real.ViemChain { constructor(...args) { super(...args); captured.port = this; } } };
});

import { createDriver } from '../services/keeper.mjs';
import { isRevert, readFailed } from '../../../packages/keeper/src/read-failure.ts';
import { launchRouterV2Abi } from '../../../packages/chain/src/core/v2/abi-v2.ts';

// Recorded on Sepolia at block 12,004,164 (2026-10-27) through https://ethereum-sepolia-rpc.publicnode.com, the
// keeper's fallback: GPU Poor (v2 box 0) has nothing to sweep, so its launch router's sweep() reverts NothingToSweep().
const ROUTER = '0xC8Ca6a9F894D308578d4012EBcd20a0AF705b751';
const HOOK = '0x422B25f3f8bD2D41544c1CD0c646eCece55c2aE0';
const SWEEP = '0x35faa416';
const NOTHING_TO_SWEEP = { code: 3, message: 'execution reverted', data: '0x351261fc' };

const env = { SH_SERVICE_ENABLED: '1', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only', SH_KEEPER_CHAIN_ID: '11155111',
  SH_KEEPER_ADDRESS: '0xdd5633D3B9c17831c0d675cf81dE98F513426A59', SH_KEEPER_BOX_REGISTRY: '0x5D2866EF084d801aE734D3A2A6E4F7179898737C',
  SH_KEEPER_DESTINATION_FORK: 'amsterdam', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };

function chain() {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const input = JSON.parse(options.body);
    const answer = (r) => {
      calls.push(r.method);
      if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0xaa36a7' };
      if (r.method === 'eth_call' && r.params[0].to.toLowerCase() === ROUTER.toLowerCase() && r.params[0].data === SWEEP) {
        return { jsonrpc: '2.0', id: r.id, error: NOTHING_TO_SWEEP };
      }
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `no fixture for ${r.method}` } };
    };
    return new Response(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)), { headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); captured.port = null; });

describe('the keeper service recognizes reverts from its own RPC client', () => {
  it('simulates a v2 router sweep with nothing to sweep as no work, not as a node failure', async () => {
    const calls = chain();
    const driver = await createDriver(env, settings('keeper', env));
    try {
      const sweep = { job: 'routerSweep', key: `routerSweep:2:${HOOK.toLowerCase()}`, to: ROUTER, fn: 'sweep', args: [],
        version: 2, boxId: 0n, pool: HOOK, retryAfterBlocks: 25n };
      const fees = { baseFeePerGas: 18n, maxPriorityFeePerGas: 50_000_000n, maxFeePerGas: 50_000_036n };
      await expect(captured.port.simulate(sweep, fees)).resolves.toEqual({ ok: false, tipWei: null, estimate: 0n });
      expect(calls).toContain('eth_call');
    } finally { driver.close(); }
  });

  it('counts a reverted read as the chain\'s answer, not a failed read', async () => {
    chain();
    const driver = await createDriver(env, settings('keeper', env));
    try {
      const error = await captured.port.pub.readContract({ address: ROUTER, abi: launchRouterV2Abi, functionName: 'sweep', batch: false })
        .then(() => null, (e) => e);
      expect(error?.walk((e) => e.data?.errorName === 'NothingToSweep')).toBeTruthy();
      expect(isRevert(error)).toBe(true);
      expect(readFailed(error)).toBe(false);
    } finally { driver.close(); }
  });
});
