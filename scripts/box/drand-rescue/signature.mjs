import { createHash } from 'node:crypto';

// Port of script-py/drand_vectors.py g1_decompress/g1_compress, not the keeper's relay decoder.
export const P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const HALF = (P - 1n) / 2n;
const reject = () => { throw new Error('invalid quicknet signature'); };
function pow(base, exponent) {
  let result = 1n;
  for (; exponent > 0n; exponent >>= 1n, base = base * base % P) {
    if (exponent & 1n) result = result * base % P;
  }
  return result;
}
export function decompress(data) {
  if (typeof data !== 'string' || !/^[\da-f]{96}$/i.test(data)) reject();
  const raw = BigInt(`0x${data}`);
  const flags = raw >> 381n;
  if (!(flags & 4n) || (flags & 2n)) reject();
  const x = raw & ((1n << 381n) - 1n);
  if (x >= P) reject();
  const rhs = (x * x * x + 4n) % P;
  let y = pow(rhs, (P + 1n) / 4n);
  if (y * y % P !== rhs) reject();
  if ((y > HALF) !== Boolean(flags & 1n)) y = P - y;
  return [x, y];
}
export function compress(x, y) {
  return (x | (1n << 383n) | (y > HALF ? 1n << 381n : 0n)).toString(16).padStart(96, '0');
}
export function signatureXY(data, round) {
  const reported = typeof data?.round === 'string' && /^\d+$/.test(data.round) ? BigInt(data.round)
    : typeof data?.round === 'number' && Number.isSafeInteger(data.round) ? BigInt(data.round) : 0n;
  if (reported !== round || round < 1n || round >= 1n << 64n
    || typeof data?.randomness !== 'string' || !/^[\da-f]{64}$/i.test(data.randomness)) reject();
  const [x, y] = decompress(data.signature);
  const compressed = compress(x, y);
  if (compressed !== data.signature.toLowerCase()) reject();
  if (createHash('sha256').update(Buffer.from(compressed, 'hex')).digest('hex') !== data.randomness.toLowerCase()) reject();
  return `0x${x.toString(16).padStart(96, '0')}${y.toString(16).padStart(96, '0')}`;
}
