/**
 * SH-255 fixtures: the six boxes live on Sepolia as api.squarehole.fun answered them on 23 November 2026, 11:51 UTC
 * (block 12,195,510; Rent Free's read one block later, 12,195,511), saved by the box-page prototype
 * (apps/web/e2e/fixtures/box-picture/, each answer less its row's role-keyed copy of the code hashes, `row.codeHashes`,
 * as the box-life fixtures drop it), on the committed Sepolia deployment. The price coins by the symbols their
 * contracts answer (BOX_PICTURE_COINS, copied from the committed Sepolia coin deployment). Public chain data only.
 */
import { BOX_PICTURE_ANSWERS, BOX_PICTURE_COINS } from './box-picture-answers';
import type { BoxRecord } from '../../../boxes/box-model';
import { parseSnapshotV2, type V2Snapshot, type V2Source } from '../indexer-v2';
import { recordV2 } from '../record-v2';
import { sepoliaLifeSourceV2 } from './life-v2';

type Json = Record<string, unknown>;

export { BOX_PICTURE_ANSWERS, BOX_PICTURE_BLOCK, BOX_PICTURE_NAMES } from './box-picture-answers';

/** A listed coin's symbol (ETH for the native coin is the record's own rule). */
export function coinSymbolOf(address: string): string | null {
  const pair = BOX_PICTURE_COINS.find((p) => p.coin.toLowerCase() === address.toLowerCase());
  return pair?.symbol ?? null;
}
export function coinDecimalsOf(address: string): number | null {
  if (/^0x0{40}$/i.test(address)) return 18;
  const pair = BOX_PICTURE_COINS.find((p) => p.coin.toLowerCase() === address.toLowerCase());
  return pair?.decimals ?? null;
}

export interface BoxPictureFixture {
  readonly answer: Json;
  readonly view: V2Snapshot;
  readonly record: BoxRecord;
  readonly source: V2Source;
}

/** One of the six as the page reads it: the snapshot through the site's parser, the record with its coin's name. */
export function boxPictureFixture(name: string, edit?: (answer: Json) => Json): BoxPictureFixture {
  const base = BOX_PICTURE_ANSWERS[name];
  if (!base) throw new Error(`no fixture ${name}`);
  const answer = edit ? edit(structuredClone(base)) : structuredClone(base);
  const source = sepoliaLifeSourceV2();
  const view = parseSnapshotV2(answer, source);
  const record = recordV2(view, source, null, coinSymbolOf(view.record.q));
  return { answer, view, record, source };
}
