/**
 * A core v1 box as the feed and the box page read it, built from its registry row alone (S10a § 5; BC-086: Q, decimals,
 * token order, layout, deadline and template id come from the row, no build-time record and no per-box code). The spec
 * facts reuse `recordFromSpec` (the creation page's Demo boxes and the factory's boxes share it, as spec-record.ts
 * promised); the row adds the addresses, the Q, and box 0 by registry and id (never a name).
 *
 * Box 0 is "Genesis" and Featured, and carries the F77 setup line; its Misfits pack attaches by its row (its collection
 * address, BC-095), never by its names.
 */
import { BoxType, TStream } from '@squarehole/box-spec';
import type { BoxRow } from '@squarehole/chain';
import type { Address } from '@squarehole/domain';
import { box0SetupLine } from '../fit-pair/box0-fees';
import { formatBoxId } from '../boxes/box-id';
import type { BoxRecord, RowRef } from '../boxes/box-model';
import { recordFromSpec } from '../boxes/spec-record';
import { picturesOf } from '../boxes/box-pictures';
import { DATA_LABELS } from '../data-source/data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const NETWORK_LABELS: Readonly<Record<RowRef['network'], string>> = Object.freeze({
  local: DEMO_BUILD ? 'Local chain (Sepolia twin)' : '',
  sepolia: DATA_LABELS.sepolia,
  demo: DEMO_BUILD ? 'Local chain 31337' : '',
});

/** A row read from a chain source (local or Sepolia); null without a row, or for the Demo's box 0 row. */
export type ChainRowRef = RowRef & { readonly network: 'local' | 'sepolia' };
export function chainRowOf(record: Pick<BoxRecord, 'row'>): ChainRowRef | null {
  const ref = record.row;
  if (ref === null || (DEMO_BUILD && ref.network === 'demo')) return null;
  return ref as ChainRowRef;
}

/** The row's Q symbol for display: ETH for native ETH; otherwise the symbol the row carries, or "Q" (never guessed). */
export function qSymbolOf(row: BoxRow): string {
  return row.qAsset.symbol ?? 'Q';
}

/** The box id of a row: `<chainId>-<token>`. */
export const rowBoxId = (row: BoxRow): string => formatBoxId(row.chainId, row.contracts.token as Address);

export function recordFromRow(ref: RowRef, options: { readonly nowMs: number; readonly networkLabel?: string; readonly artGateways?: readonly string[] }): BoxRecord {
  const { row, network } = ref;
  const token = row.contracts.token as Address;
  const base = recordFromSpec(row.spec, row.specHash, {
    chainId: row.chainId,
    networkLabel: options.networkLabel ?? NETWORK_LABELS[network],
    token,
    demo: DEMO_BUILD && network === 'demo',
    order: Number(row.boxId),
    coverUrl: null,
    thumbs: [],
    createdAtMs: null,
    nowMs: options.nowMs,
    creator: row.creator,
  });
  const box0 = row.isBox0;
  const symbol = qSymbolOf(row);
  return Object.freeze({
    ...base,
    kind: box0 ? 'genesis' : base.kind,
    pairAsset: symbol,
    pairDecimals: row.qAsset.decimals,
    vault: row.contracts.vault,
    itemNoun: box0 ? 'Misfits' : base.itemNoun,
    featured: box0,
    // A chain box's state and figures are live (the indexer or a direct read), never a Demo snapshot.
    demoState: DEMO_BUILD && network === 'demo' ? base.demoState : null,
    demoFigures: DEMO_BUILD && network === 'demo' ? base.demoFigures : null,
    setup: box0 ? box0SetupLine(row.spec.tokenSymbol) : base.setup,
    claims: row.spec.tStream === TStream.PER_ITEM_STREAM ? 'per-item' : base.claims,
    line: box0 ? null : base.line,
    // The row's committed logo (field 23) and collection cover (field 28), shown once verified (box-pictures.ts).
    pictures: picturesOf(row.spec.coverSha256, row.spec.collectionCoverSha256, options.artGateways ?? []),
    row: ref,
  });
}

/** Whether a row's box has items (a vault and a collection): a token-only box (F70) has none. */
export const hasItems = (row: BoxRow): boolean => row.spec.boxType !== BoxType.TOKEN_ONLY;
