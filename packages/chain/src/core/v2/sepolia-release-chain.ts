/**
 * SH-SEP-MANIFEST: read-only chain check of a Sepolia v2 release before its manifest is committed. Every read is at the
 * v1 manifest's evidence block (the finalized block write-core-manifest.mjs pinned, after the v2 receipts), so the file
 * describes one consistent chain state: code hashes of every named contract, the factory's role map and version hash,
 * the hook's extension, the receiver's two Safes, and each Safe's owners, threshold, version, singleton, modules,
 * guard and fallback handler (CoreV2SafeChecks.sol's rules). Control-transfer transactions, when given, must have
 * succeeded, and the outgoing one must carry the Safe's ExecutionSuccess. No signing, no sending.
 */
import { getAddress, keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient } from 'viem';
import type { DeployedCoreManifestV2, ReleaseV2 } from './manifest-v2';
import { IMPLEMENTATION_SLOTS_V2, SEPOLIA_CHAIN_ID, type ControlProof } from './sepolia-release';

export const EMPTY_CODE_HASH_V2: Hex = keccak256('0x');
const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';
export const SAFE_GUARD_SLOT: Hex = keccak256(toBytes('guard_manager.guard.address'));
export const SAFE_HANDLER_SLOT: Hex = keccak256(toBytes('fallback_manager.handler.address'));
export const SAFE_EXECUTION_SUCCESS_TOPIC: Hex = keccak256(toBytes('ExecutionSuccess(bytes32,uint256)'));

/** The views read, as human-readable signatures (one ABI fragment each). */
export const RELEASE_VIEWS = Object.freeze({
  registry: 'function registry() view returns (address)',
  listingRegistry: 'function listingRegistry() view returns (address)',
  versionCodeHash: 'function versionCodeHash() view returns (bytes32)',
  implementation: 'function implementation(uint256 role) view returns (address)',
  extension: 'function extension() view returns (address)',
  FIT_SAFE: 'function FIT_SAFE() view returns (address)',
  PLATFORM_SAFE: 'function PLATFORM_SAFE() view returns (address)',
  getOwners: 'function getOwners() view returns (address[])',
  getThreshold: 'function getThreshold() view returns (uint256)',
  VERSION: 'function VERSION() view returns (string)',
  getModulesPaginated: 'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
});
export type ReleaseView = keyof typeof RELEASE_VIEWS;

export interface ReleaseChainReads {
  chainId(): Promise<number>;
  blockHash(blockNumber: bigint): Promise<Hex>;
  /** keccak256 of the runtime code (EMPTY_CODE_HASH_V2 when there is none). */
  codeHash(address: Address, blockNumber: bigint): Promise<Hex>;
  call(address: Address, view: ReleaseView, args: readonly unknown[], blockNumber: bigint): Promise<unknown>;
  storage(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex>;
  receipt(hash: Hex): Promise<{ readonly status: 'success' | 'reverted'; readonly to: Address | null; readonly blockNumber: bigint; readonly logs: readonly { readonly address: Address; readonly topics: readonly Hex[] }[] } | null>;
}

/** A viem public client as `ReleaseChainReads`. */
export function viemReleaseReads(client: PublicClient): ReleaseChainReads {
  return {
    chainId: () => client.getChainId(),
    async blockHash(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      if (!block.hash) throw new Error(`block ${blockNumber} has no hash`);
      return block.hash;
    },
    codeHash: async (address, blockNumber) => keccak256((await client.getCode({ address, blockNumber })) ?? '0x'),
    call: (address, view, args, blockNumber) => client.readContract({ address, abi: parseAbi([RELEASE_VIEWS[view]]) as never, functionName: view as never, args: args as never, blockNumber }) as Promise<unknown>,
    storage: async (address, slot, blockNumber) => (await client.getStorageAt({ address, slot, blockNumber })) ?? '0x',
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, to: r.to, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics })) };
      } catch {
        return null;
      }
    },
  };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** The low 20 bytes of a storage word (an address slot). */
const slotAddress = (word: Hex): Address => getAddress(`0x${word.slice(2).padStart(64, '0').slice(-40)}`);

/** All problems found (empty: the chain matches the manifest at its evidence block). */
export async function checkReleaseOnChain(
  manifest: DeployedCoreManifestV2,
  release: ReleaseV2,
  reads: ReleaseChainReads,
  controlProofs: { readonly fit?: ControlProof; readonly platform?: ControlProof } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const n = BigInt(manifest.evidence.block.number);
  const chainId = await reads.chainId();
  if (chainId !== SEPOLIA_CHAIN_ID) return [`the RPC is chain ${chainId}, not Sepolia`];
  const blockHash = await reads.blockHash(n);
  if (!same(blockHash, manifest.evidence.block.hash)) return [`block ${n} is ${blockHash} on this RPC, the v1 manifest says ${manifest.evidence.block.hash} (reorg or another chain)`];
  const code = async (label: string, entry: { address: Address; codeHash: Hex }) => {
    const observed = await reads.codeHash(entry.address, n);
    if (!same(observed, entry.codeHash)) problems.push(`${label} ${entry.address}: code hash ${observed}, manifest ${entry.codeHash}`);
  };
  const view = (address: Address, name: ReleaseView, args: readonly unknown[] = []) => reads.call(address, name, args, n);
  const expectAddress = async (label: string, address: Address, name: ReleaseView, expected: string, args: readonly unknown[] = []) => {
    const observed = String(await view(address, name, args));
    if (!same(observed, expected)) problems.push(`${label}: ${observed}, manifest ${expected}`);
  };

  for (const key of ['factory', 'registry', 'listingRegistry'] as const) await code(key, release[key]);
  if (release.feeModuleDirectory) await code('feeModuleDirectory', release.feeModuleDirectory);
  for (const [name, entry] of Object.entries(release.implementations)) if (entry) await code(`implementations.${name}`, entry);
  const factory = release.factory.address;
  await expectAddress('factory.registry()', factory, 'registry', release.registry.address);
  await expectAddress('factory.listingRegistry()', factory, 'listingRegistry', release.listingRegistry.address);
  const version = String(await view(factory, 'versionCodeHash'));
  if (!same(version, release.versionCodeHash)) problems.push(`factory.versionCodeHash(): ${version}, manifest ${release.versionCodeHash}`);
  for (let slot = 0; slot < 24; slot++) {
    const name = IMPLEMENTATION_SLOTS_V2[slot];
    const expected = name ? release.implementations[name]?.address ?? ZERO : ZERO;
    await expectAddress(`factory.implementation(${slot})`, factory, 'implementation', expected, [BigInt(slot)]);
  }
  await expectAddress('hook.extension()', release.implementations.hook.address, 'extension', release.implementations.hookExtension.address);
  await expectAddress('receiver.FIT_SAFE()', release.implementations.receiver.address, 'FIT_SAFE', release.safes.fit.address);
  await expectAddress('receiver.PLATFORM_SAFE()', release.implementations.receiver.address, 'PLATFORM_SAFE', release.safes.platform.address);

  for (const role of ['fit', 'platform'] as const) {
    const pin = release.safes[role];
    const safe = getAddress(pin.address);
    const label = `safes.${role}`;
    await code(label, { address: safe, codeHash: pin.codeHash });
    await code(`${label}.singleton`, { address: pin.singleton, codeHash: pin.singletonCodeHash });
    const singleton = slotAddress(await reads.storage(safe, '0x0', n));
    if (!same(singleton, pin.singleton)) problems.push(`${label}: singleton ${singleton}, manifest ${pin.singleton}`);
    const owners = (await view(safe, 'getOwners')) as readonly string[];
    if (owners.length !== pin.owners.length || owners.some((o, i) => !same(o, pin.owners[i] as string))) problems.push(`${label}: owners ${owners.join(',')}, manifest ${pin.owners.join(',')}`);
    const threshold = String(await view(safe, 'getThreshold'));
    if (threshold !== pin.threshold) problems.push(`${label}: threshold ${threshold}, manifest ${pin.threshold}`);
    for (const [who, address] of [['', safe], ['.singleton', pin.singleton]] as const) {
      const v = String(await view(getAddress(address), 'VERSION'));
      if (v !== pin.version) problems.push(`${label}${who}: VERSION ${v}, manifest ${pin.version}`);
    }
    const [modules, next] = (await view(safe, 'getModulesPaginated', [SENTINEL, 10n])) as readonly [readonly string[], string];
    if (modules.length !== 0 || !same(next, SENTINEL)) problems.push(`${label}: modules enabled (${modules.join(',')})`);
    for (const [part, slot] of [['guard', SAFE_GUARD_SLOT], ['handler', SAFE_HANDLER_SLOT]] as const) {
      const observed = slotAddress(await reads.storage(safe, slot, n));
      if (!same(observed, pin[part])) problems.push(`${label}: ${part} ${observed}, manifest ${pin[part]}`);
      if (!same(pin[part], ZERO)) await code(`${label}.${part}`, { address: pin[part], codeHash: pin[`${part}CodeHash`] });
    }
    const proof = controlProofs[role];
    if (proof) {
      const inbound = await reads.receipt(proof.inTx);
      if (!inbound || inbound.status !== 'success' || !inbound.to || !same(inbound.to, safe)) problems.push(`${label}: control proof in ${proof.inTx} is not a successful transaction to the Safe`);
      const outbound = await reads.receipt(proof.outTx);
      const executed = outbound?.logs.some((l) => same(l.address, safe) && same(l.topics[0] ?? '', SAFE_EXECUTION_SUCCESS_TOPIC));
      if (!outbound || outbound.status !== 'success' || !executed) problems.push(`${label}: control proof out ${proof.outTx} has no ExecutionSuccess from the Safe`);
      if (outbound && outbound.blockNumber > n) problems.push(`${label}: control proof out ${proof.outTx} is after the evidence block`);
    }
  }
  return problems;
}
