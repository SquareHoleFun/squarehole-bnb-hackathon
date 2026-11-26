import { moduleSnapshotsV21 } from './fee-modules-provenance-v21';
import { hasRewardDestV21 } from './pay-in-t-provenance-v21';
/** CQ11 discovery: current pool identity and surviving clones, authenticated at creation. */
import { drandSourceOf, ROLE_V2_NAMES, type RoleNameV2 } from '@squarehole/chain';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import { feeChoiceV2 } from './views-v2';
import { m3WiringProblem } from './m3-provenance-v2';
import { m2WiringProblem } from './m2-provenance-v2';
import type { CoreReader } from '../core-reader';
import {
  decodeBoxSpecV2,
  decodeBoxCreatedV2,
  decodeBoxSpecLogV2,
  decodeBoxTokenV2Runtime,
  isReceivingCloneOf,
  isStandardCloneOf,
  releaseOfRegistry,
  rolesOfV2,
  type BoxRecordV2,
  type BoxSpecV2,
  type BoxTokenV2Args,
  type DeployedCoreManifestV2,
  type ImplementationNameV2,
  type PlugInRef,
  type ReleaseV2,
} from './chain-v2';

export type DiscoveryReaderV2 = Pick<CoreReader, 'codeAt'>;

export interface ReviewedPlugIn {
  readonly implementation: Address;
  readonly codeHash: Hex;
}

export interface BoxCandidateV2 {
  /** The registry that emitted `BoxCreated`. */
  readonly registry: Address;
  readonly record: BoxRecordV2;
  readonly encodedSpec: Hex;
}

export type PlugInMarkKind = 'unreviewed' | 'code_removed' | 'code_replaced';

export interface PlugInMark extends PlugInRef {
  readonly mark: PlugInMarkKind;
}

export interface BoxVerdictV2 {
  readonly feeModules?: readonly { readonly module: Address; readonly codeHash: Hex }[];
  readonly classification: 'shown' | 'refused';
  /** Why the box is refused; null when shown. */
  readonly reason: string | null;
  /** Shown boxes only: what the page marks (never a reason to hide). */
  readonly marks: readonly PlugInMark[];
  readonly release: ReleaseV2 | null;
  readonly spec: BoxSpecV2 | null;
  readonly token: BoxTokenV2Args | null;
}

/** Each role a release implementation clones, and the form of the clone. */
const CLONES: readonly (readonly [RoleNameV2, ImplementationNameV2, 'standard' | 'receiving'])[] = [
  ['coordinator', 'coordinator', 'standard'],
  ['hook', 'hook', 'standard'],
  ['vault', 'vault', 'standard'],
  ['collection', 'collection', 'standard'],
  ['receiver', 'receiver', 'standard'],
  ['launchRouter', 'launchRouter', 'standard'],
  ['tickets', 'tickets', 'standard'],
  ['royaltyRouter', 'royaltyRouter', 'receiving'],
  ['itemLedger', 'itemLedger', 'standard'],
  ['holderLedger', 'holderLedger', 'standard'],
  ['starterSetLoader', 'starterSetLoader', 'standard'],
];

/** Roles offered by this release; retired and future roles cannot discover contracts. */
const CHECKED: ReadonlySet<RoleNameV2> = new Set<RoleNameV2>([...CLONES.map(([role]) => role), 'token']);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const ZERO = '0x0000000000000000000000000000000000000000';

function refused(reason: string, release: ReleaseV2 | null = null, spec: BoxSpecV2 | null = null): BoxVerdictV2 {
  return { classification: 'refused', reason, marks: [], release, spec, token: null };
}

/** The code of each address at one block, read once each; a transport failure throws (the caller retries). */
async function codesAt(reader: DiscoveryReaderV2, addresses: readonly Address[], blockHash: Hex, boxId: bigint): Promise<Map<string, Hex>> {
  const out = new Map<string, Hex>();
  try {
    await Promise.all([...new Set(addresses.map((a) => a.toLowerCase()))].map(async (a) => out.set(a, await reader.codeAt(a as Address, blockHash))));
  } catch (error) {
    throw new Error(`box ${boxId}: code unavailable (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  return out;
}

export interface DiscoveryBlocksV2 {
  /** The creation block's hash (the record's `creationBlock`). */
  readonly creationHash: Hex;
  /** The head the plug-ins are re-read at. */
  readonly headHash: Hex;
  /** The reviewed plug-ins (implementation and code hash; M1-11's `plug-ins.v2.json`). */
  readonly reviewed: readonly ReviewedPlugIn[];
}

/**
 * Checks a v2 box (see the module notes). Never throws for a bad box, whatever its record or spec holds; throws only
 * when code cannot be read (the caller retries).
 */
export async function checkBoxV2(reader: DiscoveryReaderV2, manifest: DeployedCoreManifestV2, box: BoxCandidateV2, at: DiscoveryBlocksV2): Promise<BoxVerdictV2> {
  const { record } = box;
  const release = releaseOfRegistry(manifest, box.registry);
  if (!release) return refused(`registry ${box.registry} is not a v2 release's in the manifest`);
  if (!same(record.poolManager, manifest.chain.poolManager.address)) return refused(`PoolManager ${record.poolManager} is not the manifest's`, release);
  if (!same(record.randomness, drandSourceOf(manifest).address)) return refused(`drand source ${record.randomness} is not the manifest's`, release);
  let spec: BoxSpecV2;
  try {
    spec = decodeBoxSpecV2(box.encodedSpec, record);
  } catch (error) {
    return refused(message(error), release);
  }
  const roles = rolesOfV2(record);
  const present = ROLE_V2_NAMES.filter((role) => roles.contracts[role] !== null);
  for (const role of ['itemStream', 'metadataTable'] as const) if (roles.contracts[role]) return refused(`${role} is not a v2 role but is present`, release, spec);
  const unoffered = present.find((role) => !CHECKED.has(role)
    || ((role === 'itemLedger' || role === 'holderLedger' || (role === 'starterSetLoader' && spec.boxType !== 5)) && !release.implementations[role]));
  if (unoffered) return refused(`${unoffered} is present but this release offers no ${unoffered}`, release, spec);
  if (record.codeHashes[9] !== `0x${'0'.repeat(64)}`) return refused('unused executor hash must be zero', release, spec);
  const choices = [feeChoiceV2(spec.buyers), feeChoiceV2(spec.sellers)];
  const holders = hasRewardDestV21(spec, 6) || feeChoiceV2(spec.sellers) === 'shop'; const shop = spec.boxType === 4; const pile = spec.boxType === 5; const items = hasRewardDestV21(spec, 8);
  if (choices.some(c => !c) || spec.gradLayout !== 3 || spec.addOns.some(a => ![1, 3, 4, 6, ...(shop ? [7, 8] : [])].includes(a.id))) return refused('CQ11 menu, full-range layout or add-on is not offered', release, spec);
  if (items !== Boolean(roles.contracts.itemLedger) || (items && !release.implementations.itemLedger)) return refused('items require a release-pinned ledger', release, spec);
  if (pile && (!roles.contracts.vault || !release.implementations.pileVault)) return refused('pile requires its release implementation', release, spec);
  if (holders !== Boolean(roles.contracts.holderLedger) || (holders && !release.implementations.tokenLedger)) return refused('holder choice requires the ledger and ledger token implementation', release, spec);
  if (shop && (!roles.contracts.vault || !release.implementations.shopVault)) return refused('shop requires its release implementation and vault role', release, spec);
  if (!pile && Boolean(roles.contracts.starterSetLoader) !== (shop && spec.addOns.some(a => a.id === 8))) return refused('starterSetLoader does not match the spec', release, spec);
  const tokenAddress = roles.contracts.token;
  const hookAddress = roles.contracts.hook;
  if (!tokenAddress || !hookAddress || BigInt(record.q) >= BigInt(tokenAddress)) return refused('CQ11 pool must have P below T and a hook', release, spec);
  if (!same(record.poolId, poolIdV2(record.q, tokenAddress, hookAddress))) return refused('CQ11 pool id is not the dynamic-fee key', release, spec);
  const creation = await codesAt(reader, present.map((role) => roles.contracts[role] as Address), at.creationHash, record.boxId);
  const code = (address: Address): Hex => creation.get(address.toLowerCase()) ?? '0x';
  for (const role of present) {
    const runtime = code(roles.contracts[role] as Address);
    if (runtime === '0x') return refused(`${role} has no code at the creation block`, release, spec);
    if (!same(keccak256(runtime), roles.codeHashes[role] ?? '')) return refused(`${role}'s code at the creation block does not hash to the record's`, release, spec);
  }
  for (const [role, implementation, kind] of CLONES) {
    const address = roles.contracts[role];
    if (!address) continue;
    if (pile && role === 'starterSetLoader') continue; // Validated below as the exact role-3 alias.
    const pin = release.implementations[role === 'vault' && pile ? 'pileVault' : role === 'vault' && shop ? 'shopVault' : implementation];
    if (!pin) return refused(`${role} has no release implementation`, release, spec);
    const impl = pin.address;
    const ok = kind === 'standard' ? isStandardCloneOf(code(address), impl) : isReceivingCloneOf(code(address), impl);
    if (!ok) return refused(`${role} is not a clone of the release's ${implementation} implementation`, release, spec);
  }
  if (!roles.contracts.token) return refused('token is absent', release, spec);
  const tokenPin = holders ? release.implementations.tokenLedger : release.implementations.token;
  if (!tokenPin) return refused('token implementation absent', release, spec);
  const token = decodeBoxTokenV2Runtime(code(roles.contracts.token), tokenPin.address);
  if (!token) return refused("token is not a clone of the release's T implementation with 137 bytes of arguments", release, spec);
  const expected = { holder: roles.contracts.coordinator ?? ZERO, vault: roles.contracts.vault ?? ZERO, ledger: roles.contracts.holderLedger ?? ZERO };
  if (!same(token.holder, expected.holder) || !same(token.vault, expected.vault) || !same(token.ledger, expected.ledger) || token.name !== spec.tokenName || token.symbol !== spec.tokenSymbol) {
    return refused("token's arguments are not its box's (holder, vault, ledger, name or symbol)", release, spec);
  }
  let modules;
  try { modules = moduleSnapshotsV21(spec, code(roles.contracts.receiver as Address)); }
  catch (error) { return refused(message(error), release, spec); }
  if (modules.length) {
    const addresses = modules.map(m => m.module);
    const [created, current] = await Promise.all([codesAt(reader, addresses, at.creationHash, record.boxId), codesAt(reader, addresses, at.headHash, record.boxId)]);
    for (const snapshot of modules) for (const atBlock of [created, current]) {
      const runtime = atBlock.get(snapshot.module.toLowerCase()) ?? '0x';
      if (runtime === '0x' || !same(keccak256(runtime), snapshot.codeHash)) return refused('fee module code differs from immutable box snapshot', release, spec);
    }
  }
  const wiring = m2WiringProblem(record, spec, code) ?? m3WiringProblem(record, spec, code);
  if (wiring) return refused(wiring, release, spec);
  const m2Pins = [items && release.implementations.itemLedger, pile && release.implementations.pileVault, holders && release.implementations.holderLedger, holders && tokenPin, shop && release.implementations.shopVault, !pile && roles.contracts.starterSetLoader && release.implementations.starterSetLoader].filter(p => !!p);
  const implementations = await codesAt(reader, m2Pins.map(p => p.address), at.creationHash, record.boxId);
  for (const pin of m2Pins) if (!same(keccak256(implementations.get(pin.address.toLowerCase()) ?? '0x'), pin.codeHash)) return refused('M2/M3 implementation code differs from its release pin', release, spec);
  return { classification: 'shown', reason: null, marks: [], release, spec, token, feeModules: modules };
}

/** Same PoolKey hash as CQ11's factory and hook; no sorted/static-fee fallback. */
export function poolIdV2(p: Address, token: Address, hook: Address): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [p, token, 10_000, 60, hook]));
}

/** Pair a registry's creation and spec in the same transaction; never pair across forks or releases. */
export function rowsFromV2Logs(logs: readonly import('../../events').RawLog[], release: ReleaseV2, chainId: number): import('../core-row').BoxRowV2[] {
  const own = logs.filter((l) => !l.removed && same(l.address, release.registry.address));
  const rows: import('../core-row').BoxRowV2[] = [];
  for (const log of own) {
    try {
      const { record } = decodeBoxCreatedV2(log);
      if (record.creationBlock !== log.blockNumber) continue;
      const specs = own.filter((l) => same(l.blockHash, log.blockHash) && same(l.transactionHash, log.transactionHash)).flatMap((l) => {
        try { const s = decodeBoxSpecLogV2(l); return s.boxId === record.boxId ? [s] : []; } catch { return []; }
      });
      const paired = specs[0];
      if (specs.length !== 1 || !paired) continue;
      const encodedSpec = paired.encodedSpec;
      const spec = decodeBoxSpecV2(encodedSpec, record);
      rows.push({ ...record, ...rolesOfV2(record), protocol: 2, chainId, registry: release.registry.address, record, spec, encodedSpec, release, marks: [], pDecimals: 18, origin: { blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex } });
    } catch { /* Not a valid v2 creation/spec pair. */ }
  }
  return rows;
}
