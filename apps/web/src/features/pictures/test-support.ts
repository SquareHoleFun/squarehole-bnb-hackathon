/** Test support (never imported by the app): the Avro tag array back to name/value pairs. */
import type { Tag } from './ans104-eth';

function readLong(bytes: Uint8Array, at: number): [number, number] {
  let value = 0n; let shift = 0n; let next = at;
  for (;;) {
    const byte = bytes[next++] ?? 0;
    value |= BigInt(byte & 127) << shift;
    if ((byte & 128) === 0) break;
    shift += 7n;
  }
  return [Number((value >> 1n) ^ -(value & 1n)), next];
}

export function decodeTagsForTests(bytes: Uint8Array): Tag[] {
  const tags: Tag[] = [];
  let [count, at] = readLong(bytes, 0);
  const text = (): string => { const [length, start] = readLong(bytes, at); at = start + length; return new TextDecoder().decode(bytes.subarray(start, start + length)); };
  while (count > 0) {
    for (let i = 0; i < count; i += 1) { const name = text(); tags.push({ name, value: text() }); }
    [count, at] = readLong(bytes, at);
  }
  return tags;
}
