import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Address, type Hex } from 'viem';
import { coordinatorV2Abi } from '../../src/core/v2/chain-v2';
import { readFailureQuoteV2 } from '../../src/core/v2/claims-reads-v2';
import { m2Fixture, logM2, H } from '../../src/core/v2/m2-fixture.test-support';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2 } from '../../src/core/v2/views-v2';
import { readMoneyV2 } from '../../src/core/v2/money-v2';
import { jsonV2 } from '../../src/core/core-row';
import { serviceChainV2 } from '../core/scripted-core-chain';

const invalid = encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' });
const f = m2Fixture(false);

describe('FINAL3 canonical failure entitlement properties', () => {
  it.each([1n, (1n << 240n) + 17n])('distinguishes payable and paid forks with identical %s custody', async initial => {
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    const event = (name: string, args: Record<string, unknown>, index: number) => {
      const abi = coordinatorV2Abi.find(e => e.type === 'event' && e.name === name);
      if (!abi || abi.type !== 'event') throw new Error(name);
      return logM2(abi, f.at(0), args, index, 100n, H(100));
    };
    const failed = applyV2Block(undefined, { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n },
      decodeV2Logs([
        event('BoxFailed', { caller: f.record.creator, cause: 1, timestamp: 1000n }, 0),
        event('PotFixed', { pot: initial, tLeft: 0n, tip: 0n, closer: f.record.creator }, 1),
      ], route), f.row).state;
    const base = serviceChainV2({ headers: [], logs: [] }, [f]);
    const now = 1000n + 31_536_000n;
    const hashes = [H(201), H(202), H(203)];
    const results: string[] = [];
    // Only the canonical quote decides whether the fixed creator remainder has been consumed.
    for (const [i, refusal] of [null, invalid].entries()) {
      const hash = hashes[i];
      if (!hash) throw new Error('canonical branch hash is required');
      const next = applyV2Block(failed, { number: 101n, hash, parentHash: H(100), timestamp: now }, [], f.row).state;
      let quotes = 0;
      const reader = { callAt: async (to: Address, data: Hex, requested: Hex): Promise<Hex> => {
        expect(requested).toBe(hash);
        if (to.toLowerCase() !== f.at(0).toLowerCase()) return base.callAt(to, data, requested);
        const { functionName, args } = decodeFunctionData({ abi: coordinatorV2Abi, data });
        if (functionName === 'quoteClaim') {
          ++quotes;
          expect(args).toEqual([0n]);
          if (refusal) throw new Error('transport wrapper', { cause: { data: refusal } });
          return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result: initial });
        }
        if (functionName === 'claimState') return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result: [initial + 3n, 0n] });
        if (functionName === 'failed') return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result: true });
        return base.callAt(to, data, requested);
      } };
      const money = await readMoneyV2(reader, f.row, next.view, 101n, hash);
      const projection = jsonV2(liveViewV2({ ...next, money }, now));
      expect(quotes).toBe(1);
      expect(projection.closing).toMatchObject({ creatorEntitlement: refusal ? '0' : String(initial) });
      expect(projection.safePaid.fit).toEqual({});
      results.push(money.claim.creatorEntitlement.toString());
    }
    expect(results).toEqual([String(initial), '0']);
    expect(failed.view.claim?.initialPot).toBe(initial);
    // INBOX af2: without the canonical quote the entitlement is unavailable, never the initial pot.
    expect(liveViewV2(failed, now).closing?.creatorEntitlement).toBeNull();
  });

  it('does not reinterpret holder InvalidClaim as a completed or swept claim', async () => {
    const reader = { callAt: async () => { throw Object.assign(new Error('invalid holder hand-in'), { data: invalid }); } };
    await expect(readFailureQuoteV2(reader, f.at(0), H(100), 1n, 10n)).rejects.toThrow('invalid holder hand-in');
    await expect(readFailureQuoteV2(reader, f.at(0), H(100), 0n, 10n)).resolves.toBeNull();
  });

  it.each([0n, 1n, (1n << 240n) + 17n])('retains exact raw quote %s and rejects one unit of invented backing', async amount => {
    const reader = { callAt: async (_to: Address, _data: Hex, hash: Hex) => {
      expect(hash).toBe(H(100));
      return encodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'quoteClaim', result: amount });
    } };
    await expect(readFailureQuoteV2(reader, f.at(0), H(100), 0n, amount)).resolves.toBe(amount);
    if (amount > 0n) await expect(readFailureQuoteV2(reader, f.at(0), H(100), 0n, amount - 1n)).rejects.toThrow(/exceeds live pot/);
  });
});
