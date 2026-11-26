import { expect, it } from 'vitest';
import { applySetBlock } from '../../../src/core/set-v2/state';
import { membersFixture } from './members-fixture';

it('E09C-COUNT validates pinned counts without traversing membership on empty blocks', async () => {
  const f = membersFixture(10);
  f.reads.loaded = 10;
  f.reads.inside = 10n;
  const initial = (await applySetBlock(undefined, f.header(51n), f.loads(0, 10, f.header(51n)), f.row, f.reader)).state;
  // A length-only read is allowed; any member enumeration would restore the per-head O(N) cost.
  const members = new Proxy(initial.membership.members, {
    get(target, key, receiver) {
      if (key !== 'length') throw new Error(`unexpected member traversal: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  const previous = { ...initial, membership: { ...initial.membership, members } };
  const next = (await applySetBlock(previous, f.header(52n), [], f.row, f.reader)).state;
  expect(next.membership).toBe(previous.membership);
  expect(next.block).toBe(52n);
  expect(next.money?.hash).toBe(f.header(52n).hash);
  f.reads.inside = 9n;
  await expect(applySetBlock(previous, f.header(53n), [], f.row, f.reader)).rejects.toThrow('set membership/read mismatch');
  f.reads.inside = 10n;
  f.reads.loaded = 9;
  await expect(applySetBlock(previous, f.header(53n), [], f.row, f.reader)).rejects.toThrow('set membership/read mismatch');
});

it('E09C-COUNT reconciles Deferred as inside and rejects other-vault events', async () => {
  const f = membersFixture(10);
  f.reads.loaded = 10;
  f.reads.inside = 10n;
  const initial = (await applySetBlock(undefined, f.header(51n), f.loads(0, 10, f.header(51n)), f.row, f.reader)).state;
  const deferredLog = f.log('ReleaseDeferred', { collection: f.row.spec.collection, id: 0n }, f.header(52n));
  const other = (await applySetBlock(initial, f.header(52n), [{ ...deferredLog, address: f.row.creator }], f.row, f.reader)).state;
  expect(other.membership).toBe(initial.membership);
  const deferred = (await applySetBlock(initial, f.header(52n), [deferredLog], f.row, f.reader)).state;
  expect(deferred.membership.inside).toBe(10n);
  expect(deferred.membership.members[0]?.state).toBe('Deferred');
  f.reads.inside = 9n;
  const released = (await applySetBlock(deferred, f.header(53n), [f.log('ReleaseSucceeded', { collection: f.row.spec.collection, id: 0n, creator: f.row.creator }, f.header(53n))], f.row, f.reader)).state;
  expect(released.membership.inside).toBe(9n);
  expect(deferred.membership.inside).toBe(10n);
});
