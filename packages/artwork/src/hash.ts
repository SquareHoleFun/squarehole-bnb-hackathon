/**
 * Keccak-256 (the EVM hash, not NIST SHA3-256) from @noble/hashes, pinned exactly at 2.4.0 (audited, dependency-free,
 * MIT). Used for image content hashes and the metadata manifest hash (SH-009 Step 3).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type Hex32 = `0x${string}`;

export function keccak256Hex(bytes: Uint8Array): Hex32 {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}
