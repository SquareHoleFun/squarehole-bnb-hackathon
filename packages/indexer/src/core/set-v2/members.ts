import { buildSetCommitment, type SetSpecV2 } from '@squarehole/box-spec';
import type { SetMemberState } from '@squarehole/chain/core/set-v2';
import type { Hex } from 'viem';
import type { CoreEventV2 } from '../v2/events-v2';
export interface SetMember { readonly index: bigint; readonly id: bigint; readonly state: SetMemberState }
export interface SetMembersState {
  readonly members: readonly SetMember[];
  /** Accepted-order positions never change; only a load needs a new index. */
  readonly positions: ReadonlyMap<bigint, number>;
  /** Deferred recovery attempts remain in custody, just like Inside members. */
  readonly inside: bigint;
  readonly root: Hex | null;
}

/** Copy on the first write only. Every retained ancestor owns its count and shares immutable arrays/indexes. */
export function reduceSetMembers(previous: SetMembersState | undefined, events: readonly CoreEventV2[], spec: SetSpecV2): SetMembersState {
  const base: SetMembersState = previous ?? { members: [], positions: new Map(), inside: 0n, root: null };
  let members: SetMember[] | undefined;
  let positions: Map<bigint, number> | undefined;
  let { root, inside } = base;
  for (const e of events) {
    if (e.source !== 'vault') continue;
    const a = e.args;
    if (['SetLoaded', 'ReleaseSucceeded', 'ReleaseDeferred'].includes(e.name) && String(a.collection).toLowerCase() !== spec.collection.toLowerCase()) throw new Error('set collection mismatch');
    if (e.name === 'SetLoaded') {
      const id = a.id as bigint;
      const length = (members ?? base.members).length;
      if (a.index !== BigInt(length) || length >= spec.count || (positions ?? base.positions).has(id)) throw new Error('set load index/duplicate');
      (positions ??= new Map(base.positions)).set(id, length);
      (members ??= [...base.members]).push({ index: a.index as bigint, id, state: 'Inside' });
      inside++;
      if (members.length === spec.count) {
        root = buildSetCommitment(spec.collection, members.map(m => m.id)).commitment.setHash;
        if (root !== spec.setHash.toLowerCase()) throw new Error('set event root mismatch');
      }
    } else if (['Withdrawn', 'Returned', 'ReleaseSucceeded', 'ReleaseDeferred'].includes(e.name)) {
      const ids = (e.name === 'Withdrawn' || e.name === 'Returned') ? a.ids as readonly bigint[] : [a.id as bigint];
      for (const id of ids) {
        const pos = (positions ?? base.positions).get(id);
        const member = pos === undefined ? undefined : (members ?? base.members)[pos];
        // Invalid/already-released recovery requests also defer; they cannot invent membership or restore rights.
        if (e.name === 'ReleaseDeferred' && (!member || member.state === 'Released' || member.state === 'Outside')) continue;
        if (!member || pos === undefined) throw new Error('unknown set member');
        let state: SetMemberState;
        if (e.name === 'Returned') { if (member.state !== 'Outside') throw new Error('set return requires Outside'); state = 'Inside'; }
        else if (e.name === 'Withdrawn') { if (member.state !== 'Inside') throw new Error('set pick requires Inside'); state = 'Outside'; }
        else { if (member.state !== 'Inside' && member.state !== 'Deferred') throw new Error('set recovery state'); state = e.name === 'ReleaseSucceeded' ? 'Released' : 'Deferred'; }
        if (state === member.state) continue;
        (members ??= [...base.members])[pos] = { ...member, state };
        if (e.name === 'Returned') inside++;
        else if (e.name === 'Withdrawn' || e.name === 'ReleaseSucceeded') inside--;
      }
    }
  }
  return members ? { members, positions: positions ?? base.positions, inside, root } : base;
}
