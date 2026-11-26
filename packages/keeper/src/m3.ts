import { itemTResidueV21, T_ITEM_SYNC_STEPS } from './pay-in-t-v21';
import type { Address } from 'viem';
import { boxRegistryAbi, coordinatorAbi, itemAbi, itemFundingAbi, itemLifecycleAbi, pileAbi, pileFactoryAbi, receiverV2Abi } from './abi';
import type { Candidate } from './types';

/** No owner inputs, payout recipients, approvals or native value belong to maintenance. */
export type M3Work = Pick<Candidate, 'job' | 'to' | 'fn' | 'args' | 'key' | 'syncSources' | 'ordinary' | 'minAmountRaw'>;
type Call = <T>(address: Address, abi: readonly unknown[], fn: string, args?: readonly unknown[]) => Promise<T>;
type Guard = <T>(source: string, read: () => Promise<T>, fallback: () => T) => Promise<T>;
interface Context {
  readonly registry: Address;
  readonly id: bigint;
  readonly receiver: Address;
  readonly coordinator: Address;
  readonly failed: boolean;
  readonly graduated: boolean;
  readonly gateOpen: boolean;
  readonly call: Call;
  readonly guard: Guard;
}
const nonzero = (a: Address) => !/^0x0{40}$/i.test(a);
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
/** S4's maximum page: 32 receipts AND 32 operations, within the usual estimated-gas/daily budgets.
 * Progress is on chain; partial pages stay eligible and no local cursor records completion. */
export const ITEM_SYNC_STEPS = 32n;

/** Compare both journals in the same block; an inconsistent snapshot never authorizes a send. */
export async function itemSyncPending(call: Call, ledger: Address, receiver: Address, vault: Address): Promise<boolean> {
  const [funding, lifecycle, f, l] = await Promise.all([
    call<bigint>(receiver, itemFundingAbi, 'itemFundingCount'),
    call<bigint>(vault, itemLifecycleAbi, 'itemLifecycleCount'),
    call<bigint>(ledger, itemAbi, 'fundingCursor'), call<bigint>(ledger, itemAbi, 'lifecycleCursor'),
  ]);
  if (f > funding || l > lifecycle) throw new Error('inconsistent item cursors');
  return f < funding || l < lifecycle;
}

/** Canonical discovery. Events cannot establish completion, claim rights, residue or pile identity. */
export async function readM3(c: Context): Promise<readonly M3Work[]> {
  const { call, guard } = c;
  const role = (n: bigint) => call<Address>(c.registry, boxRegistryAbi, 'roleOf', [c.id, n]);
  const work = (job: M3Work['job'], to: Address, fn: string, args: readonly unknown[] = []): M3Work =>
    ({ job, to, fn, args, key: `${job}:2:${to.toLowerCase()}` });
  const items = await guard(`${c.receiver}:items`, async () => {
    const ledger = await role(16n);
    if (!nonzero(ledger)) return [];
    const [wired, vault] = await Promise.all([call<Address>(c.receiver, receiverV2Abi, 'itemLedger'), role(3n)]);
    if (!same(wired, ledger) || !nonzero(vault)) throw new Error('inconsistent item wiring');
    const pending = await guard(`${ledger}:journals`, () => itemSyncPending(call, ledger, c.receiver, vault), () => false);
    const tokenResidue = await itemTResidueV21(ledger, call, guard);
    const syncSteps = tokenResidue.length ? T_ITEM_SYNC_STEPS : ITEM_SYNC_STEPS;
    const out: M3Work[] = pending ? [{ ...work('itemSync', ledger, 'sync', [syncSteps]),
      syncSources: [c.receiver, vault] }] : [];
    // No residue view exists. Pending simulation admits only a positive proved transfer; backlog is not residue.
    out.push(work('itemResidue', ledger, 'flushResidue'));
    out.push(...tokenResidue);
    return out;
  }, () => []);
  const pile = await guard(`${c.coordinator}:pile`, async () => {
    if (c.graduated || (!c.failed && c.gateOpen)) return [];
    const vault = await role(3n);
    if (!nonzero(vault)) return [];
    const [factory, ownerFactory] = await Promise.all([
      call<Address>(c.registry, boxRegistryAbi, 'factory'), call<Address>(c.coordinator, coordinatorAbi, 'factory'),
    ]);
    if (!nonzero(factory) || !same(factory, ownerFactory)) throw new Error('inconsistent pile factory');
    // S5 authenticates the complete release-pinned clone. Never infer PILE from counts or a loader alias.
    if (await call<boolean>(factory, pileFactoryAbi, 'isPileVault', [vault]) !== true) return [];
    if (await call<bigint>(vault, pileAbi, 'seedAmount') === 0n) return [];
    if (c.failed) return [work('pileReturnSeed', vault, 'returnSeed')];
    const [asset, loader, pending] = await Promise.all([
      call<Address>(vault, pileAbi, 'asset'), role(19n), call<boolean>(c.coordinator, coordinatorAbi, 'starterSetPending'),
    ]);
    // Native loading requires the seeder's own value. ERC-20 loading pulls only its preapproved exact seed.
    return nonzero(asset) && same(loader, vault) && pending === true ? [work('pileLoadSeed', vault, 'loadSeed')] : [];
  }, () => []);
  return [...new Map([...items, ...pile].map((w) => [w.key, w])).values()];
}
