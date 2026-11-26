import type { Address, Hex } from 'viem';
import { boxRegistryAbi, holderAbi, holderBatchAbi, holderFundingAbi, shopAbi } from './abi';
import { holderTSidesV21, holderTWorkV21 } from './pay-in-t-v21';
import type { Candidate } from './types';

/** Permissionless calls only; amounts and destinations are fixed by the contracts, never operator inputs. */
export type M2Work = Pick<Candidate, 'job' | 'to' | 'fn' | 'args' | 'key' | 'ordinary' | 'minAmountRaw'>;
/** Next read offsets only, never completion evidence. Persist with the keeper's existing journal. */
export type M2Scan = Record<string, bigint>;
type Call = <T>(address: Address, abi: readonly unknown[], fn: string, args?: readonly unknown[]) => Promise<T>;
type Guard = <T>(source: string, read: () => Promise<T>, fallback: () => T) => Promise<T>;
interface Context {
  readonly registry: Address;
  readonly id: bigint;
  readonly hook: Address;
  readonly receiver: Address;
  readonly coordinator: Address;
  readonly code: (address: Address) => Promise<Hex | undefined>;
  readonly failed: boolean;
  readonly scan: M2Scan;
  readonly call: Call;
  readonly guard: Guard;
}
const nonzero = (a: Address) => !/^0x0{40}$/i.test(a);
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
const READ_PAGE = 8n;
/** Below the frozen 64-pair maximum; limits cold credit writes before M2-60's full backlog measurements. */
export const SETTLE_STEPS = 16n;
const pages = (count: bigint) => (count + READ_PAGE - 1n) / READ_PAGE;
function page(count: bigint, scan: M2Scan, key: string): bigint[] {
  if (count === 0n) {
    scan[key] = 0n;
    return [];
  }
  // Normalize against this snapshot: a reorg may shrink a list, and new entries may extend its last page.
  const start = (((scan[key] ?? 0n) / READ_PAGE) % pages(count)) * READ_PAGE;
  const out: bigint[] = [];
  for (let i = start; i < count && i < start + READ_PAGE; i++) out.push(i);
  // Advance by a visited page, independent of head strides, sends, backoff or the daily gas budget.
  // Keep the next offset even at the end so appended pages can be visited before wrapping.
  scan[key] = start + READ_PAGE;
  return out;
}

/** Canonical, bounded reads. No remembered completion or event can suppress a reorged/retryable exit. */
export async function readM2(c: Context): Promise<readonly M2Work[]> {
  const { call, guard } = c;
  const role = (n: bigint) => call<Address>(c.registry, boxRegistryAbi, 'roleOf', [c.id, n]);
  const work = (job: M2Work['job'], to: Address, fn: string, args: readonly unknown[], suffix = ''): M2Work =>
    ({ job, to, fn, args, key: `${job}:2:${to.toLowerCase()}${suffix}` });
  const holders = await guard(`${c.hook}:holders`, async () => {
    const ledger = await role(17n);
    if (!nonzero(ledger)) return [];
    const [token, rcLedger, hkLedger, active] = await Promise.all([
      role(1n), call<Address>(c.receiver, holderFundingAbi, 'holderLedger'),
      call<Address>(c.hook, holderBatchAbi, 'holderLedger'), call<bigint>(c.hook, holderBatchAbi, 'currentTradeBatch', [true]),
    ]);
    if (!nonzero(token) || !same(ledger, rcLedger) || !same(ledger, hkLedger) || active < 1n || active % 2n !== 1n) {
      throw new Error('inconsistent holder wiring/batch');
    }
    const inT = await holderTSidesV21(c.receiver, ledger, token, call);
    const count = active - 1n;
    const batches = await Promise.all(page(count, c.scan, `batches:${ledger.toLowerCase()}`).map((index) => guard(`${ledger}:batch:${index + 1n}`, async () => {
      const id = index + 1n;
      const t = inT[id % 2n === 1n ? 0 : 1];
      const [source, funded, state, paid] = await Promise.all([
        call<{ closed: boolean }>(c.hook, holderBatchAbi, 'tradeBatch', [id]),
        call<boolean>(c.receiver, holderFundingAbi, 'holderBatchClosed', [id]),
        call<readonly [boolean, bigint, bigint, bigint]>(ledger, holderAbi, 'batchState', [id]),
        call<bigint>(c.receiver, holderFundingAbi, 'holderBatchPaid', [id]),
      ]);
      if (!source.closed || !funded) return [];
      const [complete, , , residue] = state;
      const settle = work('holderSettle', ledger, 'settleBatch', [id, SETTLE_STEPS], `:${id}`);
      const flush = work('holderResidue', ledger, 'flushResidue', [id], `:${id}`);
      if (t) return holderTWorkV21(settle, flush, complete, paid, residue);
      // P batches settle once, before any claim or residue (claimable is zero and claim reverts until complete).
      if (!complete) return paid > 0n ? [settle] : [];
      return residue > 0n ? [flush] : [];
    }, () => [])));
    return batches.flat();
  }, () => []);
  const shop = c.failed ? await guard(`${c.hook}:shop`, async () => {
    // Frozen coordinator args: 45-byte standard proxy + 234-byte prefix + optional SHOP=4 byte.
    const code = (await c.code(c.coordinator))?.toLowerCase();
    if (!code || !code.startsWith('0x363d3d373d3d3d363d73')
      || code.slice(62, 92) !== '5af43d82803e903d91602b57fd5bf3'
      || code.slice(2 + (45 + 234) * 2, 2 + (45 + 235) * 2) !== '04') return [];
    const vault = await role(3n);
    if (!nonzero(vault)) return [];
    const frozen = await guard(`${vault}:failedT`, () => call<bigint>(vault, shopAbi, 'failedT'), () => null);
    const out = frozen === null || frozen > 0n ? [work('shopBurn', vault, 'burnFailedT', [])] : [];
    const returns = await guard(`${vault}:starters`, async () => {
      const count = await call<bigint>(vault, shopAbi, 'collectionSize');
      // Failure excludes graduation: gives/picks never ran, so cumulative accepted items are starter indexes.
      if (count > 10_000n) throw new Error('invalid failed starter count');
      return page(count, c.scan, `starters:${vault.toLowerCase()}`).map((i) => work('shopReturn', vault, 'returnStarter', [[i]], `:${i}`));
    }, () => []);
    return [...out, ...returns];
  }, () => []) : [];
  return [...new Map([...holders, ...shop].map((w) => [w.key, w])).values()];
}
