import type {} from '../../../chain/src/core/v2/m2-63/web-types';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbiItem, type Abi, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem';
import { CORE_TOPIC0_V2, EVENT_ABI_V2, coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, receiverV2Abi } from '../../../chain/src/core/v2';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { jsonV2 } from '../../src/core/core-row';
import { m2RpcReaderV2, readHolderClaimV2 } from '../../src/core/v2/m2-reads-v2';
import { A, H, logM2, m2Fixture } from '../../src/core/v2/m2-fixture.test-support';
import { parseM2 } from '../../../../apps/web/src/features/core/v2/m2-data';

const huge = 2n ** 120n + 1n;
const header = (number: bigint, hash: Hex, parentHash: Hex) => ({ number, hash, parentHash, timestamp: 1700000000n });
const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)');
const paid = parseAbiItem('event HolderPaid(uint256 indexed batchId,address indexed holder,address indexed to,uint256 grossP,uint256 tipP)');

describe('M263-EVENTS: implementation bytes, authenticated routes, exact history', () => {
  it('M263-OC04 retains the exact coordinator forward as activity, never as a second claim payment', () => {
    const f = m2Fixture(), route = routeV2(f.release, f.manifest, [], [f.record]);
    // Implementation-only event: do not add it to the frozen coordinator interface ABI.
    const event = parseAbiItem('event ClaimsForwarded(address indexed to,uint256 amount)');
    const args = { to: f.at(5), amount: 2n ** 200n + 7n };
    const raw = logM2(event, f.at(0), args, 3, 100n, H(100));
    expect(CORE_TOPIC0_V2.coordinator).toContain(raw.topics[0]);
    const decoded = decodeV2Logs([raw, raw], route);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ source: 'coordinator', name: 'ClaimsForwarded', args, boxId: f.record.boxId,
      ref: { blockHash: raw.blockHash, logIndex: raw.logIndex, txHash: raw.transactionHash } });
    expect(decodeV2Log({ ...raw, address: f.at(5) }, route)).toBeNull();
    expect(decodeV2Log({ ...raw, removed: true }, route)).toBeNull();
    const block = header(100n, H(100), H(99));
    const applied = applyV2Block(undefined, block, decoded, f.row);
    expect(applied.activity).toHaveLength(1);
    expect(JSON.stringify(jsonV2(applied.activity))).toContain(`"amount":"${args.amount}"`);
    expect(applied.state.claimPayments).toEqual([]);
    expect(applyV2Block(applied.state, block, decoded, f.row).activity).toEqual([]);
  });

  it.each([
    ['HolderLedgerV2', 17, 'holderLedger'], ['BoxTokenV2Ledger', 1, 'token'], ['ShopVaultV2', 3, 'vault'], ['BoxHookV2', 2, 'hook'],
    ['StarterSetLoaderV2', 19, 'starterSetLoader'], ['BoxReceiverV2', 5, 'receiver'], ['BoxCoordinatorV2', 0, 'coordinator'],
  ] as const)('decodes every money/lifecycle event of %s at role %s', (contract, role, source) => {
    const f = m2Fixture(), route = routeV2(f.release, f.manifest, [], [f.record]);
    const artifact = JSON.parse(readFileSync(new URL(`../../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url), 'utf8')) as { abi: Abi };
    for (const event of artifact.abi.filter((e): e is AbiEvent => e.type === 'event' && e.name !== 'Approval')) {
      const args = Object.fromEntries(event.inputs.map(p => [p.name, p.type === 'address' ? A : p.type === 'bytes32' ? H(42) : p.type === 'bytes4' ? '0x12345678' : p.type === 'bool' ? true : /^(u?int)(8|16|24|32)$/.test(p.type) ? 1 : huge]));
      if ('poolId' in args) args.poolId = f.row.poolId;
      const raw = logM2(event, f.at(role), args, 1);
      expect.soft(EVENT_ABI_V2[source]?.some(e => e.type === 'event' && e.name === event.name), event.name).toBe(true);
      expect.soft(decodeV2Log(raw, route), event.name).toMatchObject({ boxId: f.row.boxId, source, name: event.name, args });
      expect(decodeV2Log({ ...raw, address: A }, route)).toBeNull();
      expect(decodeV2Log({ ...raw, removed: true }, route)).toBeNull();
    }
  });

  it.each([6, 8, 18])('round-trips %s-decimal P exactly through replay, published strings and the site, including reorg', decimals => {
    const f = m2Fixture(false), route = routeV2(f.release, f.manifest, [], [f.record]);
    const unit = huge * 10n ** BigInt(decimals);
    const logs = [logM2(funded, f.at(5), { batchId: 1n, netP: unit + 3n }, 1, 100n, H(100)),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: unit + 3n, holderP: unit, residueP: 3n }, 2, 100n, H(100))];
    const events = decodeV2Logs([...logs].reverse().concat(logs), route);
    const parent = applyV2Block(undefined, header(100n, H(100), H(99)), events, f.row).state;
    const payment = decodeV2Logs([logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: unit, tipP: 0n }, 1)], route);
    const orphan = applyV2Block(parent, header(101n, H(101), H(100)), payment, f.row).state;
    expect(applyV2Block(orphan, header(101n, H(101), H(100)), payment, f.row).activity).toEqual([]);
    const wire = jsonV2(orphan.view.m2);
    expect(JSON.stringify(wire)).toContain(`"grossP":"${unit}"`);
    expect(parseM2(wire, null, H(101)).history?.batches['1']?.payments[A.toLowerCase()]).toEqual({ to: A, grossP: unit, tipP: 0n, receivedP: unit });
    const replacement = applyV2Block(parent, header(101n, H(201), H(100)), [], f.row).state;
    expect(replacement.view.m2?.batches['1']?.paidP).toBe(0n);
    expect(parent.view.m2?.batches['1']?.paidP).toBe(0n);
    expect(() => applyV2Block(orphan, header(101n, H(201), H(100)), [], f.row)).toThrow();
    expect(() => parseM2({ ...wire as object, batches: { '1': { ...parent.view.m2?.batches['1'], fundingP: 123 } } }, null, H(101))).toThrow();
  });
});

describe('M263-READ: immutable batch funding and availability are separate', () => {
  it('keeps every state and failure credit exact, pins one canonical hash, and uses only eth_call', async () => {
    const f = m2Fixture(false); let closed = false, final = false, complete = false;
    let claimable = 0n, mode = 'available'; const seen: unknown[] = [];
    const client = { request: async (r: { method: string; params: [{ to: Address; from?: Address; data: Hex }, unknown] }) => {
      expect(r.method).toBe('eth_call'); expect(r.params[1]).toEqual({ blockHash: H(101), requireCanonical: true }); seen.push(r);
      const { to, data, from } = r.params[0];
      const abi: Abi = to === f.at(17) ? holderLedgerV2Abi : to === f.at(5) ? receiverV2Abi : to === f.at(2) ? hookV2Abi : coordinatorV2Abi;
      const { functionName: fn, args } = decodeFunctionData({ abi, data });
      if (fn === 'claim') {
        expect([from, to, args]).toEqual([A, f.at(17), [1n, A]]);
        if (mode === 'paused') throw Object.assign(new Error('revert'), { code: 3 });
        if (mode === 'offline') throw new Error('timeout');
      }
      const result = ({ tradeBatch: { closed, netP: huge + 3n, tradeUnits: huge, protocolUnits: 0n }, holderBatchClosed: final,
        holderBatchPaid: final ? huge : 0n, batchState: [complete, complete ? 1n : 0n, 0n, 0n], claimable, failed: true, claim: claimable } as Record<string, unknown>)[fn];
      return encodeFunctionResult({ abi, functionName: fn, result });
    } } as unknown as Pick<PublicClient, 'request'>;
    const read = () => readHolderClaimV2(m2RpcReaderV2(client), f.row, { batchId: 1n, holder: A }, H(101));
    expect(await read()).toMatchObject({ status: 'open', claimableP: null, fundingP: null });
    closed = true; expect(await read()).toMatchObject({ status: 'awaiting_funding', claimableP: null });
    final = true; expect(await read()).toMatchObject({ status: 'settling', claimableP: null, fundingP: huge });
    complete = true; claimable = huge;
    expect(await read()).toMatchObject({ status: 'settled', claimableP: huge, payout: 'available', failedBox: true });
    mode = 'paused'; expect(await read()).toMatchObject({ claimableP: huge, payout: 'unavailable' });
    mode = 'offline'; expect(await read()).toMatchObject({ claimableP: huge, payout: 'unverified' });
    claimable = 0n; expect(await read()).toMatchObject({ claimableP: 0n, payout: 'empty' });
    expect(seen).toHaveLength(45); // Six canonical reads per state, three owner simulations.
  });
});
