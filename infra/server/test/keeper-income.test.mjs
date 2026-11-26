import { afterEach, expect, it, vi } from 'vitest';
import { settings } from '../services/runtime.mjs';
import { shLimit } from '../../../vitest.timeouts.mjs';

// SH-247 (finding N4), at the entry the server starts (run.mjs keeper -> keeper.mjs createDriver): its own transport,
// JSON-RPC batching, multicall and adapter read every box's income through a flood of more than 20,000 Safe deposits
// in one page exactly as without it. The fixture chain is packages/keeper/test/support/income-chain.ts.
const captured = vi.hoisted(() => ({ port: null }));
vi.mock('../../../packages/keeper/src/state.ts', () => ({ StateStore: class { load() { return {}; } save() {} close() {} } }));
vi.mock('../../../packages/keeper/src/chain.ts', async (original) => {
  const real = await original();
  return { ...real, ViemChain: class extends real.ViemChain { constructor(...args) { super(...args); captured.port = this; } } };
});

import { createDriver } from '../services/keeper.mjs';
import { incomeChain } from '../../../packages/keeper/test/support/income-chain.ts';
import { incomeRpc } from '../../../packages/keeper/test/support/income-rpc.ts';
import { keeper } from '../../../packages/keeper/test/support/v2.ts';

const env = { SH_SERVICE_ENABLED: '1', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only', SH_KEEPER_CHAIN_ID: '11155111',
  SH_KEEPER_ADDRESS: keeper, SH_KEEPER_BOX_REGISTRY: '0x5D2866EF084d801aE734D3A2A6E4F7179898737C',
  SH_KEEPER_DESTINATION_FORK: 'amsterdam', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };

afterEach(() => { vi.unstubAllGlobals(); captured.port = null; });

async function income(flood) {
  const f = incomeChain();
  // Empty collections are split over two receivers, one of them a token box this test does not read: 25,000 on box a.
  if (flood) f.flood(flood, flood === 'empty collections' ? 50_000 : 25_000);
  const rpc = incomeRpc(f);
  vi.stubGlobal('fetch', vi.fn(rpc.fetch));
  const driver = await createDriver(env, settings('keeper', env));
  try {
    // The ETH boxes the server reads (the token boxes need a test-only coin pin, covered in the keeper package).
    captured.port.last = { block: { number: f.state.final + 3n, timestamp: f.now(), baseFeePerGas: 1n }, fitGraduated: false,
      boxes: [f.a, f.b, f.failing, f.graduating] };
    // SH-247 fifth round (halving last): a box whose page must be halved waits for it in the first round
    // (INCOME_CAPACITY) and counts from the kept pieces in the next round at the same head.
    const first = await captured.port.readIncome([]);
    return { f, rpc, first, income: await captured.port.readIncome([]) };
  } finally { driver.close(); }
}

// Safe deposits are never read; empty collections are, and past viem's 10 MiB answer limit their page is read in pieces.
it.each(['safe deposits', 'empty collections'])('reads every ETH box income through more than 20,000 %s in one page as without them', async flood => {
  const quiet = await income(null);
  expect(quiet.income.boxes[quiet.f.a.receiver]).toEqual({ shareWei: 10n ** 15n, tipsWei: 7n * 10n ** 12n });
  expect(quiet.income.boxes[quiet.f.b.receiver]).toEqual({ shareWei: 2n * 10n ** 15n, tipsWei: 0n });
  const busy = await income(flood);
  expect(busy.f.noise.reduce((n, x) => n + x.count, 0)).toBeGreaterThan(20_000);
  expect(busy.income).toEqual(quiet.income);
  expect(quiet.first).toEqual(quiet.income);
  // Safe deposits are never read: the first round is complete. Empty collections on box a's receiver are halved last.
  if (flood === 'safe deposits') expect(busy.first).toEqual(quiet.income);
  else expect(busy.first.valuationFailures).toEqual([{ boxId: busy.f.a.id, code: 'INCOME_CAPACITY' }]);
  if (flood === 'safe deposits') expect(busy.rpc.calls.filter(m => m === 'eth_getLogs')).toEqual(quiet.rpc.calls.filter(m => m === 'eth_getLogs'));
  else expect(busy.rpc.calls.filter(m => m === 'eth_getLogs').length).toBeGreaterThan(quiet.rpc.calls.filter(m => m === 'eth_getLogs').length);
}, shLimit(180_000));
