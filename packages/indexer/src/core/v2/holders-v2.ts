import type { BoxRowV2 } from '../core-row';
import type { AsOf } from '../core-views';
import type { LiveStateV2 } from './views-v2';

export interface HoldersPageV2 {
  readonly schema: 'sh.core-holders.v2';
  readonly chainId: number;
  readonly token: string;
  readonly asOf: AsOf;
  readonly totalSupplyT: string;
  readonly holderCount: string;
  readonly holders: readonly { readonly address: string; readonly balanceT: string; readonly role: string | null }[];
  readonly next: string | null;
}
export interface HoldersOptionsV2 { readonly limit: number; readonly after: string | null }
export class HoldersPageError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}
const CURSOR = /^1:[1-9][0-9]{0,9}:0x[0-9a-f]{40}:0x[0-9a-f]{64}:[1-9][0-9]{0,77}:0x[0-9a-f]{40}$/;
const ZERO = /^0x0{40}$/;

/** A cursor is scoped to this chain, token and snapshot hash; a moving/replaced head requires a fresh first page. */
export function holdersPageV2(row: BoxRowV2, state: LiveStateV2, asOf: AsOf, options: HoldersOptionsV2): HoldersPageV2 {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new HoldersPageError(400, 'limit is 1-200');
  const token = row.contracts.token?.toLowerCase();
  if (!token) throw new Error('v2 row has no token');
  let after: { balance: bigint; address: string } | null = null;
  if (options.after !== null) {
    if (!CURSOR.test(options.after)) throw new HoldersPageError(400, 'bad holder cursor');
    const [, chain, cursorToken, hash, balance, address] = options.after.split(':') as [string, string, string, string, string, string];
    if (chain !== String(row.chainId) || cursorToken !== token) throw new HoldersPageError(400, 'holder cursor belongs to another box');
    if (hash !== asOf.hash.toLowerCase()) throw new HoldersPageError(409, 'holder snapshot changed; restart without after');
    after = { balance: BigInt(balance), address };
  }
  const roles = new Map<string, string>();
  for (const [role, address] of Object.entries(row.contracts)) if (address) roles.set(address.toLowerCase(), role);
  roles.set(row.record.poolManager.toLowerCase(), 'pool');
  const balances = [...state.balances].filter(([address, balance]) => balance > 0n && !ZERO.test(address));
  balances.sort(([a, x], [b, y]) => x === y ? (a < b ? -1 : a > b ? 1 : 0) : x > y ? -1 : 1);
  const remaining = after === null ? balances : balances.filter(([address, balance]) => balance < after.balance || (balance === after.balance && address > after.address));
  const page = remaining.slice(0, options.limit);
  const last = page.at(-1);
  return { schema: 'sh.core-holders.v2', chainId: row.chainId, token, asOf, totalSupplyT: state.supply.toString(),
    holderCount: BigInt(balances.length).toString(),
    holders: page.map(([address, balance]) => ({ address, balanceT: balance.toString(), role: roles.get(address) ?? null })),
    next: remaining.length > options.limit && last ? `1:${row.chainId}:${token}:${asOf.hash.toLowerCase()}:${last[1]}:${last[0]}` : null };
}
