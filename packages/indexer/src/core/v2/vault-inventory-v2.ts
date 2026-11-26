import type { BoxSpecV2 } from './chain-v2';
import type { CoreEventV2 } from './events-v2';

/** Same entries as parsed M3 known history; sequence here orders ordinary vault logs, not ledger operations. */
export interface VaultInventoryV2 {
  readonly firstId: bigint;
  readonly n: bigint;
  readonly known: readonly { readonly id: bigint; readonly inside: boolean; readonly sequence: bigint }[];
  readonly owners: Readonly<Record<string, string | null>>;
}

const zero = /^0x0{40}$/i;

/** Matches the page's vaultRolesOf, without depending on the web or on fee destinations. */
export function hasCollectionVaultV2(spec: BoxSpecV2, vault?: string, collection?: string): boolean {
  return spec.boxType !== 4 && spec.boxType !== 5 && Number.isSafeInteger(spec.n) && spec.n > 0
    && !!vault && !zero.test(vault) && !!collection && !zero.test(collection);
}

function movementOrder(e: CoreEventV2): bigint {
  const { blockNumber, txIndex, logIndex } = e.ref;
  if (blockNumber < 0n || ![txIndex, logIndex].every(n => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32)) {
    throw new Error('vault inventory: invalid event order');
  }
  return (blockNumber << 64n) | (BigInt(txIndex) << 32n) | BigInt(logIndex);
}

/** Receives canonical, deduplicated events from applyV2Block. Never mutates the parent snapshot. */
export function vaultInventoryV2(events: readonly CoreEventV2[], boxId: bigint, spec: BoxSpecV2, previous?: VaultInventoryV2): VaultInventoryV2 {
  const n = BigInt(spec.n);
  const valid = (id: bigint) => {
    if (id < spec.firstId || id >= spec.firstId + n) throw new Error('vault inventory: item outside collection');
  };
  const known = new Map(previous?.known.map(item => [String(item.id), item]));
  const owners = { ...previous?.owners };
  // Establish the touched IDs first: Transfer precedes Withdrawn, and a safe-transfer callback can
  // pass the item on before that movement event is emitted. Placement never supplies ownership.
  for (const e of events) {
    if (e.boxId !== boxId || e.source !== 'vault') continue;
    const inside = e.name === 'Returned';
    const ids = e.name === 'TicketDelivered' ? [e.args.id as bigint]
      : e.name === 'Withdrawn' || inside || e.name === 'ReleasedToCreator' ? e.args.ids as readonly bigint[] : [];
    for (const id of ids) {
      valid(id);
      known.set(String(id), { id, inside, sequence: movementOrder(e) });
    }
  }
  for (const e of events) {
    if (e.boxId !== boxId || e.source !== 'collection' || (e.name !== 'Transfer' && e.name !== 'ConsecutiveTransfer')) continue;
    const range = e.name === 'ConsecutiveTransfer';
    const first = (range ? e.args.fromTokenId : e.args.tokenId) as bigint;
    const last = range ? e.args.toTokenId as bigint : first;
    valid(first); valid(last);
    if (last < first) throw new Error('vault inventory: reversed collection range');
    const to = String(range ? e.args.toAddress : e.args.to).toLowerCase();
    const owner = zero.test(to) ? null : to;
    if (range) {
      // Range mints must not expand an untouched collection into thousands of feed entries.
      for (const item of known.values()) if (item.id >= first && item.id <= last) owners[String(item.id)] = owner;
    } else if (known.has(String(first))) owners[String(first)] = owner;
  }
  return { firstId: spec.firstId, n, known: [...known.values()].sort((a, b) =>
    a.sequence !== b.sequence ? a.sequence > b.sequence ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    owners: Object.fromEntries(Object.entries(owners).filter(([id]) => known.get(id)?.inside === false)) };
}
