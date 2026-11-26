// @vitest-environment node
/**
 * SH-258 round 3 (re-read finding 10): on BNB Chain testnet (no sale list) the payee's in-kind wait refusal is told
 * apart by the inbox's own reads: none held (the contract checks the wait before the amount), the clock not started
 * (no observation recorded) and waiting since the recorded observation ("not before" its end). Sepolia keeps its words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseError, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const ROUTER = '0x00000000000000000000000000000000000000b1' as Address;
const COIN = '0x00000000000000000000000000000000000000c1' as Address;
const PAYEE = '0x00000000000000000000000000000000000000d1' as Address;
const VIEWS = parseAbi(['function heldBalance(address token) view returns (uint256)', 'function oldestUnsoldAt(address coin) view returns (uint256)']);
const waitRevert = () => {
  const error = new BaseError('execution reverted') as BaseError & { data: Hex };
  error.data = encodeErrorResult({ abi: parseAbi(['error WaitForSale()']), errorName: 'WaitForSale' });
  return error;
};

const AGG = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const WETH = '0x00000000000000000000000000000000000000f1' as Address;

/** The inbox's answers: `held` of the coin, `native` of the chain's coin, its clock; `fail`: the reads fail. */
async function answer(held: bigint, oldest: bigint, bnb = true, { coin = COIN, native = 0n, fail = false }: { coin?: Address; native?: bigint; fail?: boolean } = {}) {
  if (bnb) vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const inbox = await import('./inbox-upkeep');
  const dry = vi.fn(async (call: { to: Address; data: Hex }) => {
    const outer = (() => { try { return decodeFunctionData({ abi: AGG, data: call.data }); } catch { return null; } })();
    if (!outer) throw waitRevert();
    if (fail) throw new Error('rate limited');
    const rows = (outer.args[0] as readonly { callData: Hex }[]).map(({ callData }) => {
      const { functionName, args } = decodeFunctionData({ abi: VIEWS, data: callData });
      const value = functionName === 'oldestUnsoldAt' ? oldest : BigInt(args[0] as string) === 0n ? native : held;
      return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [value]) };
    });
    return encodeFunctionResult({ abi: AGG, functionName: 'aggregate3', result: rows });
  });
  const target = { chainId: 97, coordinator: ROUTER, receiver: ROUTER, token: ROUTER, p: '0x00000000000000000000000000000000000000e1' as Address, royaltyRouter: ROUTER };
  const result = await inbox.readInKindV2({ dry } as never, target as never, WETH, PAYEE, coin);
  return { result, words: inbox.IN_KIND_WORDS, dry };
}

describe('the in-kind wait on BNB Chain testnet', () => {
  it('none held: "The inbox holds none of this coin."', async () => {
    const { result, words } = await answer(0n, 0n);
    expect(result).toEqual({ kind: 'refused', reason: 'empty' });
    expect(words.empty).toBe('The inbox holds none of this coin.');
  });

  it('held, the clock not started: its own sentence, no date', async () => {
    const { result, words } = await answer(5n, 0n);
    expect(result).toEqual({ kind: 'refused', reason: 'wait-unstarted' });
    expect(words['wait-unstarted']).toBe('Not yet: this coin’s 30-day wait has not started.');
  });

  it('held, waiting since the recorded observation: not before its end (30 days on)', async () => {
    const { result, words } = await answer(5n, 1_000n);
    expect(result).toEqual({ kind: 'refused', reason: 'wait', notBefore: 1_000n + 30n * 86_400n });
    expect(words.wait).toBe('Not yet: a listed coin waits 30 days in the inbox before the payee can take it.');
  });

  it('round 3b: the wrapped coin counts the inbox\'s native coin (read at one block): not "none held"', async () => {
    const { result, dry } = await answer(0n, 1_000n, true, { coin: WETH, native: 7n });
    expect(result).toEqual({ kind: 'refused', reason: 'wait', notBefore: 1_000n + 30n * 86_400n });
    expect(dry).toHaveBeenCalledTimes(2);
  });

  it('round 3b: failed reads say so, never "none held"', async () => {
    const { result, words } = await answer(5n, 1_000n, true, { fail: true });
    expect(result).toEqual({ kind: 'refused', reason: 'wait-unread' });
    expect(words['wait-unread']).toBe('Not yet; the inbox could not be read just now. Try again.');
  });

  it('Sepolia: the sale list sentence, no extra reads', async () => {
    const { result, words, dry } = await answer(5n, 1_000n, false);
    expect(result).toEqual({ kind: 'refused', reason: 'wait' });
    expect(words.wait).toBe('Not yet: a coin on the sale list waits 30 days without a sale.');
    expect(dry).toHaveBeenCalledTimes(1);
  });
});
