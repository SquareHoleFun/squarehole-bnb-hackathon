import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { parseSetManifest, checkSetFactoryIdentity, type SetReleaseManifest } from '../../chain/src/core/set-v2/manifest-set-v2';
import { isStandardCloneOf } from '../../chain/src/core/v2/clones-v2';
import { loadConfig, type KeeperConfig } from './config';
import { boxRegistryAbi, coordinatorAbi } from './abi';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const active = [[0,'coordinator'],[1,'token'],[2,'hook'],[3,'vault'],[5,'receiver'],[6,'launchRouter'],[19,'starterSetLoader']] as const;

/** A separate instance leaves the existing keeper's registry, signer and budget untouched. */
export function setKeeperConfig(cfg: KeeperConfig, core: unknown, input: unknown): KeeperConfig {
  const release = parseSetManifest(input,core);
  if (cfg.chainId !== release.chainId || !cfg.boxRegistry || !same(cfg.boxRegistry,release.registry.address)) {
    throw new Error('set keeper chain/registry differs from manifest');
  }
  if (cfg.box0) throw new Error('set keeper must not watch Box 0');
  if (cfg.stateFile === '.cache/keeper-state.json') throw new Error('set keeper requires a separate explicit state file');
  return {...cfg,setRelease:release};
}

/** No flags preserves the existing entry point. Manifests are public JSON; no secret-file loading. */
export function loadProcessConfig(env: Record<string,string|undefined>, args: string[], read = (path: string) => readFileSync(path,'utf8')): KeeperConfig {
  const cfg = loadConfig(env);
  const {values} = parseArgs({args,options:{'core-manifest':{type:'string'},'set-manifest':{type:'string'}},strict:true});
  const core = values['core-manifest'], set = values['set-manifest'];
  if (!core && !set) return cfg;
  if (!core || !set) throw new Error('set keeper requires both --core-manifest and --set-manifest');
  return setKeeperConfig(cfg,JSON.parse(read(core)),JSON.parse(read(set)));
}

/** Recheck pins at each discovery snapshot so neither changed code nor a reorg leaves cached send targets. */
export async function verifySetRelease(pub: PublicClient, release: SetReleaseManifest, blockNumber: bigint): Promise<void> {
  for (const pin of [release.factory,release.registry,release.listingRegistry,...Object.values(release.implementations)]) {
    const code = await pub.getBytecode({address:pin.address,blockNumber});
    if (!code || code === '0x' || !same(keccak256(code),pin.codeHash)) throw new Error('set keeper release code mismatch');
  }
  const factory = await pub.readContract({address:release.registry.address,abi:boxRegistryAbi,functionName:'factory',blockNumber});
  if (!same(factory,release.factory.address)) throw new Error('set keeper registry factory mismatch');
  await checkSetFactoryIdentity(release,req => pub.readContract({...req,blockNumber}));
}

/** Only the seven set roles exist. No optional-module probing, draw reader, item ledger or holder ledger. */
export async function readSetRoles(pub: PublicClient, release: SetReleaseManifest, id: bigint, blockNumber: bigint): Promise<readonly Address[]> {
  const registry = release.registry.address;
  const entry = await pub.readContract({address:registry,abi:boxRegistryAbi,functionName:'entry',args:[id],blockNumber});
  if (!same(entry[2],release.templateId)) throw new Error('set keeper template mismatch');
  const roles = await Promise.all(Array.from({length:24},(_,i) => pub.readContract({
    address:registry,abi:boxRegistryAbi,functionName:'roleOf',args:[id,BigInt(i)],blockNumber})));
  for (const [i,role] of roles.entries()) {
    if (active.some(([index]) => index === i) ? same(role,zeroAddress) : !same(role,zeroAddress)) throw new Error('set keeper role map mismatch');
  }
  if (new Set(active.map(([i]) => roles[i]?.toLowerCase())).size !== active.length) throw new Error('set keeper aliased roles');
  const coordinator = roles[0];
  if (!coordinator || !same(coordinator,entry[0])) throw new Error('set keeper coordinator mismatch');
  for (const [i,name] of active) {
    const code = await pub.getBytecode({address:roles[i] as Address,blockNumber});
    if (!code || !isStandardCloneOf(code as Hex,release.implementations[name].address)) throw new Error('set keeper clone mismatch');
  }
  const [ownRegistry,ownId] = await Promise.all([
    pub.readContract({address:coordinator,abi:coordinatorAbi,functionName:'registry',blockNumber}),
    pub.readContract({address:coordinator,abi:coordinatorAbi,functionName:'boxId',blockNumber}),
  ]);
  if (!same(ownRegistry,registry) || ownId !== id) throw new Error('set keeper coordinator binding mismatch');
  return roles;
}
