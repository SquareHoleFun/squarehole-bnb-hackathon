/**
 * SH-EXISTING-NFTS-E08C: a set box's identity, read at one block and checked with E-08A's routing rule plus the release
 * code checks the helper leaves to its callers. The vault and collection a call names come from here only.
 */
import { keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { readSetIdentity, SetIdentityError } from './set-identity';
import { COLLECTION, CREATOR, FakeSetChain, VAULT_CODE, label, sparseIds, specFor } from './test-support/set-chain';
import type { SetReads } from './set-reads';

const ids = sparseIds(12);

function rig() {
  const chain = new FakeSetChain({ ids });
  const box = chain.seed(specFor(chain, ids), ids, {});
  return { chain, box };
}

/** The chain with one read changed. */
function patched(chain: FakeSetChain, patch: Partial<Pick<SetReads, 'read' | 'code' | 'chainId'>>): SetReads {
  const reads: SetReads = chain;
  return { ...reads, read: patch.read ?? reads.read, code: patch.code ?? reads.code, chainId: patch.chainId ?? reads.chainId };
}
/** The fake's reads through the interface (an optional block is passed along and ignored). */
const via = (chain: FakeSetChain): SetReads => chain;

describe('a set box’s identity', () => {
  it('reads the record, the vault clone and the loader, and names the vault and the collection from the vault’s arguments', async () => {
    const { chain, box } = rig();
    const identity = await readSetIdentity(chain, chain.source, box.coordinator, box.encoded);
    expect(identity).toMatchObject({ boxId: 0n, coordinator: box.coordinator, creator: CREATOR, specHash: keccak256(box.encoded), block: chain.block });
    expect(identity.vault.toLowerCase()).toBe(box.vault.toLowerCase());
    expect(identity.collection.toLowerCase()).toBe(COLLECTION.toLowerCase());
    expect(identity.loader.toLowerCase()).toBe(box.loader.toLowerCase());
    expect(identity.spec.count).toBe(12);
  });

  it('refuses a coordinator the add-on’s registry does not record, a wrong chain, and spec bytes the record does not hash', async () => {
    const { chain, box } = rig();
    await expect(readSetIdentity(chain, chain.source, label('stranger') as Address, box.encoded)).rejects.toThrow('This box is not in the add-on’s registry.');
    await expect(readSetIdentity(patched(chain, { chainId: async () => 1 }), chain.source, box.coordinator, box.encoded)).rejects.toThrow('The chain this page reads is not the box’s.');
    const other = specFor(chain, ids, { tokenName: 'Not This' });
    const otherBytes = (await import('@squarehole/box-spec')).encodeSetSpecV2(other);
    await expect(readSetIdentity(chain, chain.source, box.coordinator, otherBytes)).rejects.toThrow(/spec hash/);
  });

  it('refuses a vault that is not an exact clone of the pinned SetVault, a role 4 collection, and implementation code that is not the release’s', async () => {
    const { chain, box } = rig();
    chain.badVault = true;
    await expect(readSetIdentity(chain, chain.source, box.coordinator, box.encoded)).rejects.toThrow(/vault runtime/);
    chain.badVault = false;
    const roles = [...box.roles];
    roles[4] = COLLECTION;
    const withRole4 = patched(chain, { read: async (address, abi, fn, args, block) => {
      const value = await via(chain).read(address, abi, fn, args, block);
      return fn === 'recordOf' ? { ...(value as object), contracts: roles } : value;
    } });
    await expect(readSetIdentity(withRole4, chain.source, box.coordinator, box.encoded)).rejects.toThrow(/role 4/);
    const otherCode = patched(chain, { code: async (address, block) => (address.toLowerCase() === chain.release.implementations.vault.address ? `${VAULT_CODE}00` as Hex : via(chain).code(address, block)) });
    await expect(readSetIdentity(otherCode, chain.source, box.coordinator, box.encoded)).rejects.toThrow('The vault code is not the release’s.');
    const otherLoader = patched(chain, { code: async (address, block) => (address.toLowerCase() === box.loader.toLowerCase() ? '0x6080' : via(chain).code(address, block)) });
    await expect(readSetIdentity(otherLoader, chain.source, box.coordinator, box.encoded)).rejects.toThrow('The loader is not this box’s.');
    const noRecord = patched(chain, { read: async (address, abi, fn, args, block) => (fn === 'boxIdOf' ? [false, 0n] : via(chain).read(address, abi, fn, args, block)) });
    await expect(readSetIdentity(noRecord, chain.source, box.coordinator, box.encoded)).rejects.toBeInstanceOf(SetIdentityError);
    expect(zeroAddress).toBe('0x0000000000000000000000000000000000000000');
  });
});
