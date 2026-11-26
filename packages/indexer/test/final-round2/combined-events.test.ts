import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toEventSelector, type Abi, type AbiEvent } from 'viem';
import { CORE_TOPIC0_V2 } from '../../../chain/src/core/v2/events-v2';
import { m3Fixture, A, H, logM3 } from '../../src/core/v2/m3-fixture.test-support';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';

function compiled(contract: string, name: string): AbiEvent {
  const path = new URL(`../../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url);
  const abi = (JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi }).abi;
  const event = abi.find((e): e is AbiEvent => e.type === 'event' && e.name === name);
  if (!event) throw new Error(`missing ${contract}.${name}`);
  return event;
}

describe('FINAL2-EVENTS: principal history and payout history stay distinct through combined fixes', () => {
  it.each([0n, 1n, (1n << 127n) - 1n, (1n << 200n) + 7n])('preserves %s raw units without inventing fees or double-paying a claim', amount => {
    const f = m3Fixture();
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1001n };
    const parent = applyV2Block(undefined, { ...header, number: 100n, hash: H(100), parentHash: H(99) }, [], f.row).state;
    const rows = [
      { event: compiled('BoxVaultV2', 'FailureItemPaid'), source: 'vault' as const, role: 3, args: { creator: A, id: 1n, principal: amount } },
      { event: compiled('BoxCoordinatorV2', 'ClaimsForwarded'), source: 'coordinator' as const, role: 0, args: { to: f.at(5), amount } },
      { event: compiled('BoxReceiverV2', 'FitPaid'), source: 'receiver' as const, role: 5, args: { safe: f.release.safes.fit.address, amount } },
    ];
    const logs = rows.map((row, i) => {
      const log = logM3(row.event, f.at(row.role), row.args, i, header.number, header.hash);
      expect(CORE_TOPIC0_V2[row.source]).toContain(toEventSelector(row.event));
      expect(decodeV2Log(log, route)).toMatchObject({ source: row.source, name: row.event.name, boxId: f.record.boxId });
      expect(decodeV2Log({ ...log, address: f.at(4) }, route)).toBeNull();
      expect(decodeV2Log({ ...log, removed: true }, route)).toBeNull();
      expect(decodeV2Log({ ...log, data: '0x' }, route)).toBeNull();
      return log;
    });
    const result = applyV2Block(parent, header, decodeV2Logs([...logs].reverse().concat(logs), route), f.row);
    expect(result.activity.map(e => e.data.event)).toEqual(['FailureItemPaid', 'ClaimsForwarded', 'FitPaid']);
    expect(result.activity[0]?.data.principal).toBe(String(amount));
    expect(result.activity[1]?.data.amount).toBe(String(amount));
    expect(result.state.view.safePaid.fit[f.row.q.toLowerCase()]).toBe(amount);
    expect(result.state.claimPayments).toEqual([]);
    expect(result.state.view.creatorClaims).toEqual([]);
    expect(result.state.view.fees).toEqual(parent.view.fees);
    expect(applyV2Block(result.state, header, [], f.row).state).toBe(result.state);
    const replacement = applyV2Block(parent, { ...header, hash: H(201) }, [], f.row);
    expect(replacement.activity).toEqual([]);
    expect(replacement.state.view.safePaid.fit).toEqual({});
    expect(parent.view.safePaid.fit).toEqual({});
  });
});
