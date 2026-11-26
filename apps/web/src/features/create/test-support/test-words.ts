/**
 * SH-AI-PLAN test support: deterministic stand-ins for this browser's crypto.getRandomValues, so a test can repeat a
 * deal of the numbers (art-plan.ts `dealItems`). Never used by the page.
 */
import { sha256Hex } from '@squarehole/artwork';

/** A deterministic stream of 32-bit words: the SHA-256 of `<label>:<counter>`, eight words a block. */
export function testWords(label: string): () => number {
  let counter = 0;
  let block: number[] = [];
  return () => {
    if (block.length === 0) {
      const hex = sha256Hex(new TextEncoder().encode(`${label}:${counter}`)).slice(2);
      counter += 1;
      block = Array.from({ length: 8 }, (_, i) => Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16));
    }
    return block.shift() as number;
  };
}

/** The same stream as an ArtEnvironment's `randomWords` (fills the array it is given). */
export function testRandomWords(label: string): (words: Uint32Array<ArrayBuffer>) => void {
  const next = testWords(label);
  return (words) => {
    for (let i = 0; i < words.length; i += 1) words[i] = next();
  };
}
