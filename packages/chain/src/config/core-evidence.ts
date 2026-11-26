/**
 * Chain/address evidence for core v2 live manifests (SH-V2-T03; v2 docs/07 "Real deployment evidence"). A live
 * manifest (`@squarehole/domain/core`) must carry, for every address it names, the keccak256 of `eth_getCode` at one
 * block. `readAddressEvidence` takes that reading from the chain, so evidence is observed rather than typed in, and
 * `verifyManifestEvidence` lets any reader re-check a manifest later (same chain, same block hash, same code).
 *
 * Read-only: no wallet, no signing, no transaction. It says nothing about audits or source verification.
 */
import { EMPTY_CODE_HASH, type LiveDeploymentManifest } from '@squarehole/domain/core';
import { keccak256, type Address, type Hex } from 'viem';
import type { ChainPublicClient } from '../client';
import { ChainDataError } from '../errors';

/** One evidence entry, in the live manifest's JSON shape. */
export interface AddressEvidence {
  readonly chainId: number;
  readonly address: Address;
  readonly method: 'eth_getCode';
  readonly codeHash: Hex;
  readonly expectedCodeHash: Hex | null;
  readonly block: { readonly number: string; readonly hash: Hex };
  readonly finality: 'confirmed' | 'finalized';
}

export interface EvidenceReadOptions {
  /** `finalized` reads at the node's finalized block; `confirmed` at the latest block. */
  readonly finality: 'confirmed' | 'finalized';
  /** The reviewed build's runtime code hash, if known (required for production manifests). */
  readonly expectedCodeHash?: Hex | null;
}

const codeHashOf = (code: Hex | undefined): Hex => keccak256(code ?? '0x');

export async function readAddressEvidence(client: ChainPublicClient, address: Address, options: EvidenceReadOptions): Promise<AddressEvidence> {
  const chainId = await client.getChainId();
  const block = await client.getBlock({ blockTag: options.finality === 'finalized' ? 'finalized' : 'latest' });
  if (block.hash === null || block.number === null) throw new ChainDataError('inconsistent_state', 'The node returned a pending block for evidence');
  const code = await client.getCode({ address, blockNumber: block.number });
  return {
    chainId,
    address: address.toLowerCase() as Address,
    method: 'eth_getCode',
    codeHash: codeHashOf(code),
    expectedCodeHash: options.expectedCodeHash ?? null,
    block: { number: block.number.toString(), hash: block.hash },
    finality: options.finality,
  };
}

export type EvidenceProblem = 'wrong_chain' | 'block_hash_changed' | 'code_changed' | 'no_code';
export type EvidenceCheck = { readonly address: Address; readonly ok: true } | { readonly address: Address; readonly ok: false; readonly reason: EvidenceProblem };

/**
 * Re-reads every evidence entry at its recorded block. `block_hash_changed` means a reorg past the evidence block or
 * a different chain; `code_changed` / `no_code` mean the address no longer holds the recorded code. Transport errors
 * propagate (a failed read is never a pass).
 */
export async function verifyManifestEvidence(client: ChainPublicClient, manifest: LiveDeploymentManifest): Promise<EvidenceCheck[]> {
  const chainId = await client.getChainId();
  const checks: EvidenceCheck[] = [];
  for (const entry of manifest.evidence) {
    const address = entry.address.toLowerCase() as Address;
    if (chainId !== manifest.chainId || entry.chainId !== manifest.chainId) {
      checks.push({ address, ok: false, reason: 'wrong_chain' });
      continue;
    }
    const blockNumber = BigInt(entry.block.number);
    const block = await client.getBlock({ blockNumber });
    if (block.hash?.toLowerCase() !== entry.block.hash.toLowerCase()) {
      checks.push({ address, ok: false, reason: 'block_hash_changed' });
      continue;
    }
    const codeHash = codeHashOf(await client.getCode({ address, blockNumber }));
    if (codeHash === EMPTY_CODE_HASH) checks.push({ address, ok: false, reason: 'no_code' });
    else if (codeHash !== entry.codeHash.toLowerCase()) checks.push({ address, ok: false, reason: 'code_changed' });
    else checks.push({ address, ok: true });
  }
  return checks;
}
