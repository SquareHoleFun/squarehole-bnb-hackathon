/**
 * The TypeScript mirror of `packages/contracts/src/v2/libraries/PlaceholderShuffle.sol` (F36 a;
 * docs/design/draw-and-reveal.md § 4). Pure bigint arithmetic plus viem's keccak256; no float, no Number for values.
 *
 * - π_w on [0, N): an 8-round Feistel network over b = max(2, ⌈log₂ N⌉) bits, u = ⌊b/2⌋ high bits (A) and
 *   v = b − u low bits (B), alternating round widths; round i sets C = (A ⊕ F(i, B)) mod 2^|A|, then (A, B) ← (B, C);
 *   F(i, B) = keccak256(w ‖ uint256(i·2^128 + B)); cycle-walking keeps the result in [0, N).
 * - Placeholder slot j gets Misfit `firstId + π_w(j)`; the draw pool is the positions [q, N) of the same shuffle.
 * - A draw picks index keccak256(word ‖ uint256(ticketId)) mod R among the R remaining positions (lazy Fisher–Yates).
 *
 * The site and the salt holder use it to know every placeholder's number once the graduation word is on chain.
 * Shared vectors: `packages/contracts/test/vectors/placeholder-shuffle.json`.
 */
import { concat, hexToBigInt, keccak256, numberToHex, type Hex } from 'viem';

export const SHUFFLE_ROUNDS = 8;

const TWO_128 = 1n << 128n;

/** b = max(2, ⌈log₂ n⌉) split into u = ⌊b/2⌋ high bits and v = b − u low bits. */
export function shuffleHalves(n: bigint): { readonly u: bigint; readonly v: bigint } {
  if (n <= 0n) throw new RangeError('the shuffle needs N ≥ 1');
  let b = 2n;
  while (1n << b < n) b += 1n;
  const u = b / 2n;
  return { u, v: b - u };
}

const word32 = (value: bigint): Hex => numberToHex(value, { size: 32 });

/** F(i, B) = keccak256(key ‖ uint256(i·2^128 + B)). */
function roundFunction(key: Hex, i: bigint, b: bigint): bigint {
  return hexToBigInt(keccak256(concat([key, word32(i * TWO_128 + b)])));
}

function forward(key: Hex, x: bigint, u: bigint, v: bigint): bigint {
  let a = x >> v;
  let b = x & ((1n << v) - 1n);
  for (let i = 0n; i < BigInt(SHUFFLE_ROUNDS); i += 1n) {
    const width = i % 2n === 0n ? u : v;
    const c = (a ^ roundFunction(key, i, b)) & ((1n << width) - 1n);
    a = b;
    b = c;
  }
  return (a << v) | b;
}

function backward(key: Hex, y: bigint, u: bigint, v: bigint): bigint {
  let a = y >> v;
  let b = y & ((1n << v) - 1n);
  for (let i = BigInt(SHUFFLE_ROUNDS) - 1n; i >= 0n; i -= 1n) {
    const width = i % 2n === 0n ? u : v;
    const prevB = a;
    a = (b ^ roundFunction(key, i, prevB)) & ((1n << width) - 1n);
    b = prevB;
  }
  return (a << v) | b;
}

function checkKey(key: Hex): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new RangeError('the key is a 32-byte word');
}

/** π_key(x) for 0 ≤ x < n. */
export function permutePlaceholderShuffle(key: Hex, x: bigint, n: bigint): bigint {
  checkKey(key);
  const { u, v } = shuffleHalves(n);
  if (x < 0n || x >= n) throw new RangeError('slot outside [0, N)');
  let y = forward(key, x, u, v);
  while (y >= n) y = forward(key, y, u, v);
  return y;
}

/** π_key⁻¹(y) for 0 ≤ y < n. */
export function invertPlaceholderShuffle(key: Hex, y: bigint, n: bigint): bigint {
  checkKey(key);
  const { u, v } = shuffleHalves(n);
  if (y < 0n || y >= n) throw new RangeError('position outside [0, N)');
  let x = backward(key, y, u, v);
  while (x >= n) x = backward(key, x, u, v);
  return x;
}

/** The Misfit number of placeholder `slot`: firstId + π_w(slot). */
export function placeholderMisfitId(graduationWord: Hex, slot: bigint, n: bigint, firstId: bigint): bigint {
  return firstId + permutePlaceholderShuffle(graduationWord, slot, n);
}

/** keccak256(word ‖ uint256(ticketId)) mod remaining: the index a draw picks among the remaining positions. */
export function pickIndex(word: Hex, ticketId: bigint, remaining: bigint): bigint {
  checkKey(word);
  if (remaining <= 0n) throw new RangeError('nothing remains to pick');
  if (ticketId < 0n) throw new RangeError('ticket ids are ≥ 0');
  return hexToBigInt(keccak256(concat([word, word32(ticketId)]))) % remaining;
}
