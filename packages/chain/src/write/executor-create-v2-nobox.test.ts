/**
 * SH-218 rail 2 af1 (review note N3): a plan in which the executor finds no createBox step is asked, never skipped. Every
 * real plan has one (create-calls-v2.ts), so the executor's own view of the steps is replaced here; the guard still
 * reads the real steps, so the call stays an exact, sendable step of the plan.
 */
import { encodeAbiParameters, toHex, zeroAddress, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { CreateSendPlanV2 } from '../core/v2/create-send-v2';
import { specOf, vectors } from '../../test/fixtures/create-v2/vectors';
import type { Eip1193RequestArguments } from './eip1193';
import { TEST_FEE_READER } from './test-support/index';
// vi.mock is hoisted above this import: the executor sees the replaced steps.
import { submitCreateWriteV2 } from './executor';

vi.mock('../core/v2/create-send-v2', async (original) => {
  const real = await original<typeof import('../core/v2/create-send-v2')>();
  // The executor's classification sees the plan without its createBox; the guard keeps the real steps.
  return { ...real, createStepsV2: (plan: CreateSendPlanV2) => real.createStepsV2(plan).filter((step) => step.kind !== 'createBox') };
});
const { createStepsV2 } = await vi.importActual<typeof import('../core/v2/create-send-v2')>('../core/v2/create-send-v2');

const addr = (n: bigint) => toHex(n, { size: 20 });
const first = vectors[0];
if (!first) throw new Error('missing create-v2 vector');
const hash = `0x${'cd'.repeat(32)}` as Hex;
const plan: CreateSendPlanV2 = { chainId: 31337, creator: first.creator, factory: first.factory, coordinator: first.coordinator, token: addr(8n),
  vault: addr(4n), spec: { ...specOf(first), boxType: 5, contentsParams: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zeroAddress, 7n]) },
  cs: first.cs, hs: first.hs, bootstrapQ: 10n ** 15n };

describe('SH-218 rail 2 af1: no createBox found', () => {
  it('every step of such a plan asks the switches (none is skipped as a created box’s later step)', async () => {
    for (const step of createStepsV2(plan)) {
      const check = vi.fn(async () => { throw new Error('off'); });
      const wallet = vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> => (method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [plan.creator] : hash));
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: check, wallet, plan, call: step, from: plan.creator, gasLimit: 900_000n }), step.kind).rejects.toThrow('off');
      expect(check).toHaveBeenCalledTimes(1);
      expect(wallet.mock.calls.map(([r]) => r.method)).not.toContain('eth_sendTransaction');
    }
  });
});
