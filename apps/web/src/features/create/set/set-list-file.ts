/**
 * SH-EXISTING-NFTS-E08C: the set's list file, saved before Create sends anything (design § 1: "The full list is
 * reconstructible from creation input plus loading events; it must be made available before users fund the box").
 *
 * The file is E-08A's strict `squarehole.set-list/1` (`createSetListFile`: collection, count, set hash and every id in
 * committed order, as decimal strings). Before the page counts it as saved, the very text it saves is parsed back with
 * `parseSetListFile` against the commitment the spec sends. The acknowledgement is bound to that set hash (the
 * reveal-file pattern, core/v2/reveal-file.ts and SH-AI-PLAN's acknowledgement): any other list, order or collection
 * needs its own file before Create.
 */
import { SET_LIST_SCHEMA, createSetListFile, parseSetListFile, type SetCommitment } from '@squarehole/box-spec';
import type { SetItems } from './set-create-model';
import type { ListAck } from './set-draft';

export interface SetListFileOut {
  readonly name: string;
  readonly text: string;
  readonly ack: ListAck;
}

/** The file for these items, checked by parsing it back; throws when the round trip does not give this commitment. */
export function setListFile(items: SetItems, ticker: string): SetListFileOut {
  const file = createSetListFile(items.collection, items.ids);
  const text = `${JSON.stringify(file, null, 1)}\n`;
  const parsed = parseSetListFile(JSON.parse(text), items.commitment);
  if (parsed.ids.length !== items.ids.length || parsed.ids.some((id, i) => id !== items.ids[i])) throw new Error('The list file does not read back.');
  const stem = ticker.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'set';
  return { name: `${stem}-list-${items.commitment.setHash.slice(2, 10)}.json`, text, ack: listAckFor(items.commitment) };
}

export const listAckFor = (commitment: Pick<SetCommitment, 'setHash'>): ListAck => ({ schema: SET_LIST_SCHEMA, setHash: commitment.setHash.toLowerCase() as ListAck['setHash'] });

/** Whether the saved file (`ack`) is this commitment's: the same schema and the same set hash. */
export function listSavedFor(ack: ListAck | null, commitment: Pick<SetCommitment, 'setHash'> | null): boolean {
  return ack !== null && commitment !== null && ack.schema === SET_LIST_SCHEMA && ack.setHash.toLowerCase() === commitment.setHash.toLowerCase();
}

/** Saves a file through a temporary link; false where the browser cannot. */
export function saveFile(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  } catch {
    return false;
  }
}
