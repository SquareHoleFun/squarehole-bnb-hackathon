/**
 * The registry and wiring reads a write needs at preparation and verification time (the read lane's providers serve
 * the feed; these are the exact, per-request reads that decide what is sent and whether a result is accepted).
 */
import type { Address } from '@squarehole/domain';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { registryPairIdOf, type RawPairRecord } from '../reads/registry-pair';
import { squareHoleClaimConverterAbi as converterAbi } from '../abi/squareHoleClaimConverter';
import { squareHoleFungibleTokenAbi as launchTokenAbi } from '../abi/squareHoleFungibleToken';
import { squareHoleLauncherAbi as launcherAbi } from '../abi/squareHoleLauncher';
import { rewardLedgerAbi as ledgerAbi } from '../abi/rewardLedger';
import { squareHoleRegistryAbi as registryAbi } from '../abi/squareHoleRegistry';
import type { WriteDeployment } from './deployment';
import type { BlockTag, ChainReader, RpcLog } from './rpc';

type Abi = typeof registryAbi | typeof launcherAbi | typeof ledgerAbi | typeof converterAbi | typeof launchTokenAbi;

/** One `eth_call` of a view function, decoded with its generated ABI. */
export async function readContract<T>(
  reader: ChainReader,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  block: BlockTag | bigint = 'latest',
  from?: Address,
): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const result = await reader.call({ to, data, from }, block);
  return decodeFunctionResult({ abi, functionName, data: result } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

/** `SquareHoleRegistry.PairRecord`, as decoded (the one definition lives in reads/registry-pair.ts). */
export type RegistryPair = RawPairRecord;

export interface RegistryTemplate {
  readonly quote: Address;
  readonly startFdvQ: bigint;
  readonly minStartUnitValueQ: bigint;
  readonly tickSpacing: number;
  readonly rangeTicks: number;
  readonly shape: number;
  readonly active: boolean;
  readonly addedAtBlock: bigint;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** The registry's canonical pair id: keccak256(abi.encode(chainId, token)) (ADR-0011 §5; reads/registry-pair.ts). */
export const registryPairId: (chainId: number, token: Address) => Hex = registryPairIdOf;

/** The app's pair id form (ADR-0003): `<chainId>:<lowercase token>`. */
export const appPairId = (chainId: number, token: Address): `${number}:${Address}` => `${chainId}:${token.toLowerCase() as Address}`;

/** `registry.pair(pairId)`; null when the registry has no such pair (a zero token). */
export async function readRegistryPair(reader: ChainReader, deployment: WriteDeployment, pairId: Hex, block: BlockTag | bigint = 'latest'): Promise<RegistryPair | null> {
  const pair = await readContract<RegistryPair>(reader, deployment.registry, registryAbi, 'pair', [pairId], block);
  return pair.token.toLowerCase() === ZERO ? null : Object.freeze({ ...pair });
}

export async function readRegistryTemplate(reader: ChainReader, deployment: WriteDeployment, version: number): Promise<RegistryTemplate | null> {
  const t = await readContract<RegistryTemplate>(reader, deployment.registry, registryAbi, 'template', [version]);
  return t.quote.toLowerCase() === ZERO ? null : Object.freeze({ ...t });
}

export class WiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WiringError';
  }
}

/**
 * The deployed contracts still point at each other the way the manifest says (launcher → registry, launcher →
 * converter, converter → registry). A mismatch means the manifest or the RPC is wrong; nothing is sent.
 */
export async function checkDeploymentWiring(reader: ChainReader, deployment: WriteDeployment): Promise<void> {
  const chainId = await reader.chainId();
  if (chainId !== deployment.chainId) throw new WiringError(`the RPC serves chain ${chainId}, the deployment is on chain ${deployment.chainId}`);
  const [registry, converter, hook] = await Promise.all([
    readContract<Address>(reader, deployment.launcher, launcherAbi, 'registry'),
    readContract<Address>(reader, deployment.launcher, launcherAbi, 'converter'),
    readContract<Address>(reader, deployment.launcher, launcherAbi, 'hook'),
  ]);
  const same = (a: string, b: string | null) => a.toLowerCase() === (b ?? ZERO).toLowerCase();
  if (!same(registry, deployment.registry)) throw new WiringError('the launcher’s registry differs from the deployment manifest');
  if (!same(converter, deployment.converter)) throw new WiringError('the launcher’s claim converter differs from the deployment manifest');
  if (!same(hook, deployment.hook)) throw new WiringError('the launcher’s hook differs from the deployment manifest');
  if (deployment.converter !== null) {
    const converterRegistry = await readContract<Address>(reader, deployment.converter, converterAbi, 'registry');
    if (!same(converterRegistry, deployment.registry)) throw new WiringError('the claim converter’s registry differs from the deployment manifest');
  }
}

/** Decoded logs of one event from one exact contract address in a receipt. */
export function eventsFrom<TArgs>(logs: readonly RpcLog[], emitter: Address, abi: Abi, eventName: string): TArgs[] {
  const out: TArgs[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== emitter.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as { eventName: string; args: TArgs };
      if (decoded.eventName === eventName) out.push(decoded.args);
    } catch {
      // Another event of the same contract.
    }
  }
  return out;
}
