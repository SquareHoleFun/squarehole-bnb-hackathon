/**
 * The frame between the indexer and the gateways: one text message per event in the store's stream, parsed without
 * JSON.parse on the hot path. `type|id|etag` on the first line, the SSE event's JSON on the second, the full snapshot
 * JSON (or nothing) on the third. JSON.stringify never emits a raw newline, so the split is unambiguous.
 *
 * Ids carry a sequence number that rises by exactly one per frame the indexer writes and continues across restarts
 * (the indexer reads the last one back from the stream). Gateways use it three ways: to resume a client from its
 * Last-Event-ID (every id is unique, unlike a block number: a reorg and an audit re-commit reuse blocks), to drop a
 * frame they already have, and to notice a gap (a missing number), which they answer with `resync` and a snapshot.
 */
export type FrameType = 'block' | 'reorg' | 'resync' | 'finality' | 'status' | 'traders';

export interface Frame {
  readonly type: FrameType;
  /** SSE id: `<seq>-<block>:<first 8 hex of the hash>` for block, reorg and resync events; `<seq>` otherwise. */
  readonly id: string;
  readonly etag: string;
  readonly event: string;
  readonly snapshot: string | null;
}

export interface DecodedFrame extends Frame {
  readonly seq: number;
}

const TYPES: ReadonlySet<string> = new Set(['block', 'reorg', 'resync', 'finality', 'status', 'traders']);
const ID_PATTERN = /^(\d{1,15})(?:-\d{1,20}:[0-9a-f]{8})?$/;

export function encodeFrame(frame: Frame): string {
  if (frame.event.includes('\n') || (frame.snapshot ?? '').includes('\n')) throw new Error('frame parts must be single-line JSON');
  if (frame.id.includes('|') || frame.etag.includes('|') || frame.id.includes('\n') || frame.etag.includes('\n')) throw new Error('frame id and etag must not contain | or newlines');
  return `${frame.type}|${frame.id}|${frame.etag}\n${frame.event}\n${frame.snapshot ?? ''}`;
}

export function decodeFrame(message: string): DecodedFrame {
  const first = message.indexOf('\n');
  const second = first < 0 ? -1 : message.indexOf('\n', first + 1);
  if (first < 0 || second < 0) throw new Error('malformed frame');
  const [type = '', id = '', etag = ''] = message.slice(0, first).split('|');
  if (!TYPES.has(type)) throw new Error(`unknown frame type ${type}`);
  const seq = seqOf(id);
  if (seq === null) throw new Error(`frame id without a sequence number: ${id}`);
  const snapshot = message.slice(second + 1);
  return { type: type as FrameType, id, seq, etag, event: message.slice(first + 1, second), snapshot: snapshot.length > 0 ? snapshot : null };
}

/** `<seq>-<block>:<hash8>` when a block is given, `<seq>` otherwise. */
export function eventId(seq: number, block?: bigint, hash?: string): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('sequence out of range');
  return block === undefined || hash === undefined ? String(seq) : `${seq}-${block}:${hash.slice(2, 10).toLowerCase()}`;
}

/** The sequence number of an SSE id, or null when the id is not one of ours (then a client gets a resync). */
export function seqOf(id: string): number | null {
  const match = ID_PATTERN.exec(id);
  if (!match?.[1]) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}
