import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { decodeSetLogs, setRoute } from '../../../src/core/set-v2/events';
import { reduceSetMembers, type SetMembersState } from '../../../src/core/set-v2/members';
import type { CoreEventV2 } from '../../../src/core/v2/events-v2';
import { membersFixture } from './members-fixture';

const f = membersFixture(10);
const route = setRoute(f.row.record, f.row.release);
const loadEvents = decodeSetLogs(f.loads(0, 10, f.header(51n)), route);
const reduce = (previous: SetMembersState | undefined, events: readonly CoreEventV2[]) => reduceSetMembers(previous, events, f.row.spec);
const event = (name: string, args: Record<string, unknown> = {}): CoreEventV2 => ({
  source: 'vault', name, args: { collection: f.row.spec.collection, ...args },
  address: f.row.spec.collection, boxId: f.row.boxId, listingId: null,
  ref: { blockNumber: 52n, blockHash: f.header(52n).hash, txHash: f.header(52n).hash, txIndex: 0, logIndex: 0 },
});

describe('E09C-MEMBERS structural sharing and custody count', () => {
  it('shares empty, partial and full membership across irrelevant blocks', () => {
    for (const initial of [reduce(undefined, []), reduce(undefined, loadEvents.slice(0, 4)), reduce(undefined, loadEvents)]) {
      expect(reduce(initial, [])).toBe(initial);
      expect(reduce(initial, [event('GateOpened'), event('FailureEntered'), { ...event('SetLoaded'), source: 'coordinator' }])).toBe(initial);
    }
  });

  it('copies the position index only for loads, preserving alternate load branches', () => {
    const partial = reduce(undefined, loadEvents.slice(0, 4));
    const full = reduce(partial, loadEvents.slice(4));
    expect(partial.inside).toBe(4n);
    expect(full.inside).toBe(10n);
    expect(full.positions).not.toBe(partial.positions);
    expect(partial.positions.size).toBe(4);
    expect(full.positions.get((1n << 256n) - 1n)).toBe(1);
    const branch = reduce(partial, [event('SetLoaded', { id: 999n, index: 4n })]);
    expect(branch.positions.has(f.ids[4] as bigint)).toBe(false);
    expect(full.positions.has(999n)).toBe(false);
    expect(partial.root).toBeNull();
    expect(full.root).toBe(f.row.spec.setHash);
  });

  it('counts every transition, shares unchanged members/index and replays from ancestors', () => {
    const initial = reduce(undefined, loadEvents);
    const picked = reduce(initial, [event('Withdrawn', { ids: f.ids.slice(0, 2) })]);
    const returned = reduce(picked, [event('Returned', { ids: [0n] })]);
    const deferred = reduce(returned, [event('ReleaseDeferred', { id: 0n })]);
    const released = reduce(deferred, [event('ReleaseSucceeded', { id: 0n })]);
    expect([initial, picked, returned, deferred, released].map(s => s.inside)).toEqual([10n, 8n, 9n, 9n, 8n]);
    for (const state of [picked, returned, deferred, released]) {
      expect(state.members).not.toBe(initial.members);
      expect(state.members[2]).toBe(initial.members[2]);
      expect(state.positions).toBe(initial.positions);
      expect(state.root).toBe(initial.root);
    }
    expect(initial.members[0]?.state).toBe('Inside');
    expect(deferred.members[0]?.state).toBe('Deferred');
    expect(released.members[0]?.state).toBe('Released');
    const replay = reduce(initial, [event('ReleaseSucceeded', { id: 0n })]);
    expect(replay.inside).toBe(9n);
    expect(replay.members[1]?.state).toBe('Inside');
    const sameBlock = reduce(initial, [event('Withdrawn', { ids: [0n] }), event('Returned', { ids: [0n] }), event('ReleaseDeferred', { id: 0n }), event('ReleaseSucceeded', { id: 0n })]);
    expect(sameBlock).toEqual(replay);
  });

  it('keeps ignored and repeated deferrals allocation-free without changing custody', () => {
    const initial = reduce(undefined, loadEvents);
    const state = reduce(initial, [event('ReleaseDeferred', { id: 0n }), event('Withdrawn', { ids: [f.ids[1]] }), event('ReleaseSucceeded', { id: f.ids[2] })]);
    expect(state.inside).toBe(8n);
    for (const id of [0n, f.ids[1], f.ids[2], 999n]) expect(reduce(state, [event('ReleaseDeferred', { id })])).toBe(state);
  });

  it('leaves ancestors unchanged when a later event or the final root fails', () => {
    const partial = reduce(undefined, loadEvents.slice(0, 4));
    expect(() => reduce(partial, [event('SetLoaded', { index: 4n, id: 999n }), event('SetLoaded', { index: 5n, id: 999n })])).toThrow(/index\/duplicate/);
    expect(partial.members).toHaveLength(4);
    expect(partial.positions.size).toBe(4);
    expect(partial.inside).toBe(4n);
    expect(() => reduce(partial, [...loadEvents.slice(4, 9), event('SetLoaded', { index: 9n, id: 999n })])).toThrow(/root mismatch/);
    expect(reduce(partial, loadEvents.slice(4)).root).toBe(f.row.spec.setHash);
    const initial = reduce(undefined, loadEvents);
    expect(() => reduce(initial, [event('Withdrawn', { ids: [0n, 999n] })])).toThrow(/unknown/);
    expect(initial.members[0]?.state).toBe('Inside');
    expect(initial.inside).toBe(10n);
    expect(() => reduce(initial, [event('Returned', { ids: [0n] })])).toThrow(/Outside/);
    expect(() => reduce(initial, [event('ReleaseDeferred', { collection: f.row.creator, id: 0n })])).toThrow(/collection mismatch/);
  });

  it('retains one 10,000-member array and bounded heap across 129 empty blocks', () => {
    const output = execFileSync(process.execPath, [
      '--expose-gc', '--experimental-transform-types', '--no-warnings=ExperimentalWarning',
      '--import', fileURLToPath(new URL('../../../scripts/register-ts.mjs', import.meta.url)),
      fileURLToPath(new URL('./members-memory.ts', import.meta.url)),
    ], { encoding: 'utf8', timeout: 60_000 });
    const result = JSON.parse(output) as Record<string, number>;
    process.stdout.write(`E09C-MEMORY ${output}\n`);
    expect(result.count).toBe(10_000);
    expect(result.blocks).toBe(129);
    expect.soft(result.arrays).toBe(1);
    expect.soft(result.memberships).toBe(1);
    expect.soft(result.positions).toBe(1);
    // Full applySetBlock snapshots include money/views; allow 4 MiB, below the old arrays alone (~10 MiB).
    expect(result.retainedBytes).toBeLessThan(4 * 1024 * 1024);
  }, shLimit(70_000));
});
