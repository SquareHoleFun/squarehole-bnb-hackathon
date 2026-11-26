import { encodeAbiParameters, encodeFunctionData, erc20Abi, toHex, zeroAddress, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createStepsV2, type CreateSendPlanV2 } from '../core/v2/create-send-v2';
import { specOf, vectors } from '../../test/fixtures/create-v2/vectors';
import { NotSendableError } from './calls';
import { submitCreateWriteV2, WalletContextChangedError, WalletRequestError } from './executor';
import type { Eip1193RequestArguments } from './eip1193';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from './test-support/index';

/** SH-218 rail 2: no option switched off (the switches' own cases are below). */
const NO_SWITCHES = async (): Promise<void> => undefined;

const addr = (n: bigint) => toHex(n, { size: 20 });
const first = vectors[0];
if (!first) throw new Error('missing create-v2 vector');
const hash = `0x${'cd'.repeat(32)}` as Hex;
const plan: CreateSendPlanV2 = { chainId: 31337, creator: first.creator, factory: first.factory, coordinator: first.coordinator, token: addr(8n),
  vault: addr(4n), spec: { ...specOf(first), boxType: 5, contentsParams: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zeroAddress, 7n]) },
  cs: first.cs, hs: first.hs, bootstrapQ: 10n ** 15n };

function wallet(chainId = '0x7a69', accounts: readonly string[] = [plan.creator]) {
  return vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> => (method === 'eth_chainId' ? chainId : method === 'eth_accounts' ? accounts : hash));
}

describe('TA-22 submitCreateWriteV2', () => {
  it('sends each exact step once, with its own value (createBox and a native seed only) and the checked chain', async () => {
    for (const step of createStepsV2(plan)) {
      const request = wallet();
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call: step, from: plan.creator, gasLimit: 900_000n })).resolves.toBe(hash);
      expect(request.mock.calls.map(([r]) => r.method)).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
      expect(request).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from: plan.creator, to: step.to, data: step.data,
        value: toHex(step.value), gas: '0xdbba0', ...TEST_SEND_FEE_FIELDS, chainId: '0x7a69' }] });
    }
    expect(createStepsV2(plan).map((s) => s.value)).toEqual([plan.bootstrapQ + plan.spec.creatorBuy, 7n]);
  });
  it('refuses anything else before any wallet request', async () => {
    const [create] = createStepsV2(plan);
    if (!create) throw new Error('createBox');
    const bad = [{ ...create, value: 0n }, { ...create, to: addr(99n) }, { to: addr(6n), value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addr(99n), 1n] }) }];
    for (const call of bad) {
      const request = wallet();
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call, from: plan.creator, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
      expect(request).not.toHaveBeenCalled();
    }
    const request = wallet();
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call: create, from: addr(99n), gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call: create, from: plan.creator, gasLimit: 0n })).rejects.toBeInstanceOf(WalletRequestError);
    expect(request).not.toHaveBeenCalled();
  });
  it('a wallet on another chain or account is asked nothing more', async () => {
    const [create] = createStepsV2(plan);
    if (!create) throw new Error('createBox');
    for (const request of [wallet('0xaa36a7'), wallet('0x7a69', [addr(99n)])]) {
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call: create, from: plan.creator, gasLimit: 1n })).rejects.toBeInstanceOf(WalletContextChangedError);
      expect(request.mock.calls.map(([r]) => r.method)).toEqual(['eth_chainId', 'eth_accounts']);
    }
  });
  it('SH-192: onSendRequest runs once, after the checks and right before the send request; a refused step never calls it', async () => {
    const [create] = createStepsV2(plan);
    if (!create) throw new Error('createBox');
    const seen: string[] = [];
    const request = vi.fn(async (args: Eip1193RequestArguments) => { seen.push(args.method); return wallet()(args); });
    const onSendRequest = vi.fn(() => { seen.push('onSendRequest'); });
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: request, plan, call: create, from: plan.creator, gasLimit: 900_000n, onSendRequest })).resolves.toBe(hash);
    expect(seen).toEqual(['eth_chainId', 'eth_accounts', 'onSendRequest', 'eth_sendTransaction']);
    for (const other of [wallet('0xaa36a7'), wallet('0x7a69', [addr(99n)])]) {
      const never = vi.fn();
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: other, plan, call: create, from: plan.creator, gasLimit: 1n, onSendRequest: never })).rejects.toBeInstanceOf(WalletContextChangedError);
      expect(never).not.toHaveBeenCalled();
    }
    const never = vi.fn();
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: wallet(), plan, call: { ...create, value: 0n }, from: plan.creator, gasLimit: 1n, onSendRequest: never })).rejects.toBeInstanceOf(NotSendableError);
    expect(never).not.toHaveBeenCalled();
    const failing = wallet();
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet: failing, plan, call: create, from: plan.creator, gasLimit: 900_000n, onSendRequest: () => { throw new Error('store full'); } })).rejects.toBeInstanceOf(WalletRequestError);
    expect(failing.mock.calls.map(([r]) => r.method)).toEqual(['eth_chainId', 'eth_accounts']);
  });

  it('SH-218 rail 2: the switches are asked right before the payment approval and createBox only, after the wallet reads; a refusal sends nothing and never marks a send', async () => {
    // An ERC-20 price coin, so the plan has the factory payment approval before createBox.
    const priced: CreateSendPlanV2 = { ...plan, spec: { ...plan.spec, pricing: { ...plan.spec.pricing, token: addr(6n) } } };
    const steps = createStepsV2(priced);
    expect(steps.map((s) => s.kind)).toEqual(['approve', 'createBox', 'loadSeed']);
    for (const step of steps) {
      const seen: string[] = [];
      const request = vi.fn(async (args: Eip1193RequestArguments) => { seen.push(args.method); return wallet()(args); });
      const check = vi.fn(async (asked: CreateSendPlanV2) => { seen.push('check'); expect(asked).toBe(priced); });
      const onSendRequest = vi.fn(() => { seen.push('onSendRequest'); });
      await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: check, wallet: request, plan: priced, call: step, from: priced.creator, gasLimit: 900_000n, onSendRequest })).resolves.toBe(hash);
      const opens = step.kind === 'approve' || step.kind === 'createBox';
      expect(seen, step.kind).toEqual(opens ? ['eth_chainId', 'eth_accounts', 'check', 'onSendRequest', 'eth_sendTransaction'] : ['eth_chainId', 'eth_accounts', 'onSendRequest', 'eth_sendTransaction']);
    }
    // A refusal is thrown as it is (not a wallet error), before onSendRequest and the send request.
    class Refused extends Error {}
    for (const step of steps.filter((s) => s.kind !== 'loadSeed')) {
      const request = wallet();
      const onSendRequest = vi.fn();
      const error = await submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: async () => { throw new Refused('off'); }, wallet: request, plan: priced, call: step, from: priced.creator, gasLimit: 900_000n, onSendRequest }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Refused);
      expect(error).not.toBeInstanceOf(WalletRequestError);
      expect(onSendRequest).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([r]) => r.method)).toEqual(['eth_chainId', 'eth_accounts']);
    }
  });
  it('SH-218 rail 2: a caller without the switches check cannot send any creation step', async () => {
    for (const step of createStepsV2(plan)) {
      const request = wallet();
      const options = { feeReader: TEST_FEE_READER, wallet: request, plan, call: step, from: plan.creator, gasLimit: 900_000n } as unknown as Parameters<typeof submitCreateWriteV2>[0];
      await expect(submitCreateWriteV2(options)).rejects.toBeInstanceOf(NotSendableError);
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('SH-218 rail 2: the step is classified from the plan, so createBox bytes are checked even when presented as another kind', async () => {
    const create = createStepsV2(plan).find((s) => s.kind === 'createBox');
    if (!create) throw new Error('createBox');
    const check = vi.fn(async () => { throw new Error('off'); });
    const request = wallet();
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: check, wallet: request, plan, call: { ...create, kind: 'loadSeed' } as never, from: plan.creator, gasLimit: 900_000n })).rejects.toThrow('off');
    expect(check).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([r]) => r.method)).not.toContain('eth_sendTransaction');
  });
});
