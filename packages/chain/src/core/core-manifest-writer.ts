/**
 * Builds a `squarehole.core-deployment/v1` manifest from chain reads (S10a § 2.3, the pattern of `readAddressEvidence`,
 * config/core-evidence.ts): observed, never typed in. Read-only: views and `eth_getCode` at ONE block (the finalized
 * block on Sepolia and mainnet, the latest on a local chain) and the registry's `BoxCreated` / `BoxSpec` logs of box 0's creation
 * block. No key, no signing, no broadcast log is read.
 *
 * Reads: the factory's `registry()`, `poolManager()`, `weth()`, `randomness()`, `platformSafe()`, `implementations()`,
 * `hookExtension()`, `receiverExtension()`, `versionCodeHash()`, `VERSION()` (IBoxFactoryV1.sol:111-127); the
 * registry's `factory()`, `boxCount()`, `entry(0)`; the code hash of every address; box 0's row from its logs (decoded
 * with the site's own decoder, so a manifest the site cannot read is never written).
 */
import { PLATFORM_SAFE_MAINNET } from '@squarehole/box-spec';
import { keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { boxFactoryV1Abi } from '../abi/boxFactoryV1';
import { boxRegistryAbi } from '../abi/boxRegistry';
import { CORE_MANIFEST_SCHEMA, parseCoreManifest, type CoreImplementationName, type DeployedCoreManifest } from '../config/core-manifest';
import { REGISTRY_TOPIC0, rowsFromRegistryLogs, type RegistryLog } from './box-row';

export const EMPTY_CODE_HASH: Hex = keccak256('0x');

/** What the writer reads, at one block number. A viem client adapts to it with `viemCoreReads`. */
export interface CoreReads {
  chainId(): Promise<number>;
  block(tag: 'finalized' | 'latest'): Promise<{ readonly number: bigint; readonly hash: Hex }>;
  call(address: Address, functionName: string, abi: 'factory' | 'registry', args: readonly unknown[], blockNumber: bigint): Promise<unknown>;
  codeHash(address: Address, blockNumber: bigint): Promise<Hex>;
  registryLogs(registry: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly RegistryLog[]>;
}

/** A viem public client as `CoreReads`. */
export function viemCoreReads(client: PublicClient): CoreReads {
  return {
    chainId: () => client.getChainId(),
    async block(tag) {
      const block = await client.getBlock({ blockTag: tag });
      if (block.number === null || block.hash === null) throw new Error('the node returned a pending block');
      return { number: block.number, hash: block.hash };
    },
    call: (address, functionName, abi, args, blockNumber) =>
      client.readContract({ address, abi: abi === 'factory' ? boxFactoryV1Abi : boxRegistryAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<unknown>,
    async codeHash(address, blockNumber) {
      return keccak256((await client.getCode({ address, blockNumber })) ?? '0x');
    },
    async registryLogs(registry, fromBlock, toBlock) {
      const raw = (await client.request({
        method: 'eth_getLogs',
        params: [{ address: registry, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [[...REGISTRY_TOPIC0]] }],
      } as never)) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean }[];
      return raw.map((log) => ({ ...log, blockNumber: BigInt(log.blockNumber), logIndex: Number(log.logIndex) }));
    },
  };
}

export interface WriteOptions {
  /** `mainnet` only for chain 1 (SH-188): finalized reads, the platform Safe at `PLATFORM_SAFE_MAINNET` with code. */
  readonly network: 'mainnet' | 'sepolia' | 'local';
  /** `finalized` on Sepolia and mainnet (the default there; mainnet takes nothing else), `confirmed` (latest) on a local chain. */
  readonly finality?: 'finalized' | 'confirmed';
  /** The 40-hex commit the deployment was built from, or null. */
  readonly gitCommit: string | null;
  /**
   * `--platform-eoa` (review of sh-open-at-final, finding 2): on Sepolia the factory's platform may be an address
   * without code (the runbook's Z3: the testnet deployer, an EOA, or the mainnet Safe's address, which has no code
   * there). Taken only for an address without code that box 0's spec names as its platform (marketplaceOwner); its
   * entry then records the empty-code hash. Without it, a Sepolia platform must have code (the deployed Safe).
   */
  readonly platformEoa?: boolean;
}

export class CoreManifestWriteError extends Error {
  override readonly name = 'CoreManifestWriteError';
}

const IMPLEMENTATION_KEYS = ['coordinator', 'hook', 'launchRouter', 'receiver', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'] as const;

/** Reads the deployment of `factory` and returns a manifest the parser accepts. Throws `CoreManifestWriteError`. */
export async function readCoreManifest(reads: CoreReads, factory: Address, options: WriteOptions): Promise<DeployedCoreManifest> {
  const chainId = await reads.chainId();
  if (chainId !== 1 && chainId !== 11_155_111 && chainId !== 31_337) throw new CoreManifestWriteError(`chain ${chainId} has no core manifest (mainnet, Sepolia and local only)`);
  if (options.network === 'sepolia' && chainId !== 11_155_111) throw new CoreManifestWriteError('a Sepolia manifest needs chain 11155111');
  if ((options.network === 'mainnet') !== (chainId === 1)) throw new CoreManifestWriteError('a mainnet manifest is exactly chain 1 (--network mainnet)');
  const chain1 = options.network === 'mainnet';
  if (chain1 && options.finality === 'confirmed') throw new CoreManifestWriteError('a mainnet manifest reads the finalized block only');
  if (chain1 && options.platformEoa) throw new CoreManifestWriteError('--platform-eoa is for Sepolia only: the mainnet platform is the deployed Safe');
  const finality = options.finality ?? (options.network === 'local' ? 'confirmed' : 'finalized');
  const at = await reads.block(finality === 'finalized' ? 'finalized' : 'latest');
  const n = at.number;
  const f = (name: string, args: readonly unknown[] = []) => reads.call(factory, name, 'factory', args, n);
  const [registry, poolManager, weth, randomness, platformSafe, impls, hookExtension, receiverExtension, versionCodeHash, version] = (await Promise.all([
    f('registry'),
    f('poolManager'),
    f('weth'),
    f('randomness'),
    f('platformSafe'),
    f('implementations'),
    f('hookExtension'),
    f('receiverExtension'),
    f('versionCodeHash'),
    f('VERSION'),
  ])) as [Address, Address, Address, Address, Address, Record<string, Address>, Address, Address, Hex, number];
  if (Number(version) !== 1) throw new CoreManifestWriteError(`the factory reports version ${version}, not 1`);
  const r = (name: string, args: readonly unknown[] = []) => reads.call(registry, name, 'registry', args, n);
  const registryFactory = (await r('factory')) as Address;
  if (registryFactory.toLowerCase() !== factory.toLowerCase()) throw new CoreManifestWriteError(`the registry ${registry} names factory ${registryFactory}, not ${factory}`);
  const boxCount = (await r('boxCount')) as bigint;
  if (boxCount === 0n) throw new CoreManifestWriteError('the registry has no box yet: box 0 is created by the last step of the broadcast; write the manifest after it');
  const [, creationBlock, templateId] = (await r('entry', [0n])) as [Address, bigint, Hex, Hex, Hex];

  // Box 0's row from its creation block's logs, through the decoder the site and the indexer use.
  const logs = await reads.registryLogs(registry, creationBlock, creationBlock);
  const { rows, refused } = rowsFromRegistryLogs(logs, { chainId, registry, box0Registry: registry });
  const box0 = rows.find((row) => row.boxId === 0n);
  if (!box0) throw new CoreManifestWriteError(`box 0's BoxCreated and BoxSpec were not decoded in block ${creationBlock}${refused[0] ? `: ${refused[0].error.message}` : ''}`);
  if (box0.templateId !== templateId.toLowerCase()) throw new CoreManifestWriteError('box 0\'s logged template id differs from the registry entry');

  const entry = async (address: Address, allowEmpty = false) => {
    const codeHash = await reads.codeHash(address, n);
    if (codeHash === EMPTY_CODE_HASH && !allowEmpty) throw new CoreManifestWriteError(`${address} has no code at block ${n}`);
    return { address, codeHash: codeHash.toLowerCase() as Hex };
  };
  const platformEntry = async () => {
    if (chain1 && platformSafe.toLowerCase() !== PLATFORM_SAFE_MAINNET.toLowerCase()) {
      throw new CoreManifestWriteError(`the factory's platform ${platformSafe} is not the mainnet platform Safe ${PLATFORM_SAFE_MAINNET}`);
    }
    const codeHash = await reads.codeHash(platformSafe, n);
    const empty = codeHash === EMPTY_CODE_HASH;
    if (options.platformEoa) {
      if (!empty) throw new CoreManifestWriteError(`the platform ${platformSafe} has code at block ${n}: drop --platform-eoa`);
      if (box0.spec.marketplaceOwner.toLowerCase() !== platformSafe.toLowerCase()) {
        throw new CoreManifestWriteError(`box 0's spec names ${box0.spec.marketplaceOwner} as its platform, the factory ${platformSafe}`);
      }
    } else if (empty && options.network !== 'local') {
      // A local twin has no Safe code at the platform's address; a Sepolia platform without code needs the flag.
      throw new CoreManifestWriteError(
        `the platform ${platformSafe} has no code at block ${n}: on Sepolia a platform without code (the runbook's Z3: the testnet deployer, or the mainnet Safe's address) needs --platform-eoa`,
      );
    }
    return { address: platformSafe, codeHash: codeHash.toLowerCase() as Hex };
  };
  const implementations = {} as Record<CoreImplementationName, { address: Address; codeHash: Hex }>;
  for (const key of IMPLEMENTATION_KEYS) {
    const address = impls[key];
    if (!address) throw new CoreManifestWriteError(`implementations() has no ${key}`);
    implementations[key] = await entry(address);
  }
  implementations.hookExtension = await entry(hookExtension);
  implementations.receiverExtension = await entry(receiverExtension);

  const manifest = {
    schema: CORE_MANIFEST_SCHEMA,
    status: 'deployed' as const,
    chainId,
    network: options.network,
    chain: {
      poolManager: await entry(poolManager),
      weth: await entry(weth),
      randomness: await entry(randomness),
      // The deployed Safe; on a local twin, or on Sepolia with --platform-eoa, an address without code (platformEntry).
      platformSafe: await platformEntry(),
    },
    versions: [
      {
        version: 1,
        factory: await entry(factory),
        registry: await entry(registry),
        startBlock: creationBlock.toString(),
        implementations,
        versionCodeHash: versionCodeHash.toLowerCase() as Hex,
        supportedTemplates: [templateId.toLowerCase() as Hex],
      },
    ],
    evidence: { block: { number: n.toString(), hash: at.hash.toLowerCase() as Hex }, finality },
    gitCommit: options.gitCommit,
  };
  const parsed = parseCoreManifest(manifest);
  if (parsed.status !== 'deployed') throw new CoreManifestWriteError('the parser did not accept the manifest as deployed');
  return parsed;
}
