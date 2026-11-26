import { address, hex, ZERO, requireValue } from './verify-sources-common.mjs';

const v1Names = { coordinator: 'BoxCoordinator', hook: 'BoxHook', hookExtension: 'BoxHookExtension',
  launchRouter: 'BoxLaunchRouter', receiver: 'BoxReceiver', receiverExtension: 'BoxReceiverExtension',
  collection: 'BoxCollection', vault: 'BoxVault', tickets: 'BoxTickets', royaltyRouter: 'BoxRoyaltyRouter', itemStream: 'BoxItemStream' };
const v2Names = { coordinator: 'BoxCoordinatorV2', hook: 'BoxHookV2', hookExtension: 'BoxHookV2Extension',
  launchRouter: 'BoxLaunchRouterV2', receiver: 'BoxReceiverV2', collection: 'BoxCollectionV2', vault: 'BoxVaultV2',
  tickets: 'BoxTicketsV2', royaltyRouter: 'BoxRoyaltyRouterV2', token: 'BoxTokenV2', itemLedger: 'ItemLedgerV2',
  pileVault: 'PileVaultV2', tokenLedger: 'BoxTokenV2Ledger', holderLedger: 'HolderLedgerV2', shopVault: 'ShopVaultV2', starterSetLoader: 'StarterSetLoaderV2' };
// F143: a v1 manifest's chain.randomness is box 0's BoxBackedSource when it carries the pinned backed code hash
// (packages/box-spec RANDOMNESS_SOURCE_CODE_HASH); rounds live on the pinned DrandSource it names (DRAND_SOURCE), which
// a site manifest does not list (packages/chain drandSourceOf). Pinned against the box spec by verify-sources.test.mjs.
const BACKED_SOURCE_CODE_HASH = '0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3';
const DRAND_SOURCE = Object.freeze({ address: '0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6',
  codeHash: '0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218' });
const slots = ['BoxCoordinatorV2', 'BoxTokenV2', 'BoxHookV2', 'BoxVaultV2', 'BoxCollectionV2', 'BoxReceiverV2',
  'BoxLaunchRouterV2', 'BoxTicketsV2', 'BoxRoyaltyRouterV2', null, null, null, null, null, null, null,
  'ItemLedgerV2', 'HolderLedgerV2', null, 'StarterSetLoaderV2', 'BoxTokenV2Ledger', 'ShopVaultV2', 'PileVaultV2', null];

/** Native manifests remain immutable. Supplemental records supply build/deployment evidence they omit. */
export function inventory(manifest, supplement) {
  const records = new Map();
  const notes = [];
  function add(raw, name, kind = 'source') {
    if (!raw || raw === ZERO) return;
    const r = typeof raw === 'string' ? { address: raw } : raw;
    const at = address(r.address);
    const codeHash = r.codeHash === undefined ? undefined : hex(r.codeHash, 32);
    const old = records.get(at);
    requireValue(!old?.codeHash || !codeHash || old.codeHash === codeHash, 'conflicting manifest runtime hashes');
    requireValue(!old?.name || !name || old.kind === 'external' || kind === 'external' || old.name === name, 'conflicting manifest contract names');
    records.set(at, { ...old, ...r, address: at, codeHash: codeHash ?? old?.codeHash,
      name: old?.kind === 'source' ? old.name : name ?? old?.name,
      kind: old?.kind === 'source' ? 'source' : kind });
  }
  function safes(pins) {
    for (const pin of Object.values(pins ?? {})) {
      add(pin, 'Safe', 'external');
      for (const role of ['singleton', 'guard', 'handler']) {
        if (pin[role] && pin[role].toLowerCase() !== ZERO) add({ address: pin[role], codeHash: pin[`${role}CodeHash`] }, 'SafeDependency', 'external');
      }
    }
  }
  if (manifest.format === 'squarehole.verify-sources/1') {
    requireValue(Array.isArray(manifest.contracts) && manifest.contracts.length, 'empty contract inventory');
    for (const r of manifest.contracts) {
      requireValue(!records.has(address(r.address)), 'duplicate contract inventory address');
      add(r, r.name, r.clone ? 'clone' : r.kind ?? 'source');
    }
  } else if (manifest.schema === 'squarehole.core-deployment/v1') {
    requireValue(manifest.status === 'deployed', 'v1 manifest awaiting-broadcast or not deployed');
    requireValue(Array.isArray(manifest.versions) && manifest.versions.length, 'missing v1 versions');
    for (const key of ['poolManager', 'weth', 'randomness', 'platformSafe']) requireValue(manifest.chain?.[key], 'missing chain dependency');
    for (const [key, pin] of Object.entries(manifest.chain ?? {})) {
      if (key !== 'randomness') { add(pin, key, 'external'); continue; }
      const backed = typeof pin === 'object' && String(pin.codeHash).toLowerCase() === BACKED_SOURCE_CODE_HASH;
      add(pin, backed ? 'BoxBackedSource' : 'DrandSource', 'source');
      if (backed) add(DRAND_SOURCE, 'DrandSource', 'source');
    }
    for (const v of manifest.versions) {
      requireValue(v.version === 1 && v.factory && v.registry, 'invalid v1 version');
      for (const key of Object.keys(v1Names)) requireValue(v.implementations?.[key], 'missing v1 implementation');
      add(v.factory, 'BoxFactoryV1'); add(v.registry, 'BoxRegistry');
      for (const [key, pin] of Object.entries(v.implementations ?? {})) {
        requireValue(v1Names[key], 'unknown v1 implementation'); add(pin, v1Names[key]);
      }
    }
    for (const r of manifest.releases ?? []) {
      requireValue(r.version === 2, 'invalid v2 release');
      add(r.factory, 'BoxFactoryV2'); add(r.registry, 'BoxRegistryV2'); add(r.listingRegistry, 'ListingRegistry');
      for (const [key, pin] of Object.entries(r.implementations ?? {})) {
        requireValue(v2Names[key], 'unknown v2 implementation'); add(pin, v2Names[key]);
      }
      safes(r.safes);
    }
    notes.push('Site manifests omit planners, auxiliary deployments and per-box contracts. Add their deployment records in the supplement; this inventory cannot discover absent addresses offline.');
  } else if (['squarehole.core-v2-release/1', 'squarehole.core-v2-release/2'].includes(manifest.format)) {
    if (manifest.parts !== undefined) {
      requireValue(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length === manifest.partNames?.length
        && manifest.parts.length === manifest.partCodeHashes?.length, 'invalid release part inventory');
      for (const [i, at] of manifest.parts.entries()) {
        requireValue(!records.has(address(at)), 'duplicate release inventory address');
        requireValue(/^[A-Za-z][A-Za-z0-9_]*$/.test(manifest.partNames[i]), 'invalid release inventory name');
        add({ address: at, codeHash: manifest.partCodeHashes[i] }, manifest.partNames[i]);
      }
    } else notes.push('Legacy release manifest omits auxiliary runtime hashes: supply the full deployment supplement.');
    for (const [key, name] of Object.entries({ factory: 'BoxFactoryV2', registry: 'BoxRegistryV2', listingRegistry: 'ListingRegistry', planner: 'BoxFactoryV2Planner', checks: 'BoxFactoryV2Checks' })) add(manifest[key], name);
    if (manifest.implementations) {
      requireValue(Array.isArray(manifest.implementations) && manifest.implementations.length === manifest.implementationCodeHashes?.length, 'invalid implementation inventory');
      for (const [i, at] of manifest.implementations.entries()) {
        if (at.toLowerCase() === ZERO) continue;
        requireValue(slots[i], 'unknown implementation slot');
        add({ address: at, codeHash: manifest.implementationCodeHashes[i] }, slots[i]);
      }
    }
    for (const key of ['poolManager', 'weth', 'randomness']) add(manifest[key], key, 'external');
    for (const [key, at] of Object.entries(manifest.box0 ?? {})) add(at, `box0-${key}`, 'external');
    safes(manifest.safes);
  } else requireValue(false, 'unsupported manifest format');
  if (supplement) {
    requireValue(supplement.format === 'squarehole.verify-sources/1' && String(supplement.chainId) === String(manifest.chainId), 'supplement chain/format mismatch');
    requireValue(Array.isArray(supplement.contracts), 'invalid supplement contracts');
    const seen = new Set();
    for (const r of supplement.contracts) {
      const at = address(r.address);
      requireValue(!seen.has(at), 'duplicate supplement address'); seen.add(at);
      const old = records.get(at);
      requireValue(!old?.codeHash || !r.codeHash || old.codeHash === hex(r.codeHash, 32), 'supplement runtime hash disagrees with manifest');
      requireValue(old?.kind !== 'source' || (r.kind !== 'external' && !r.clone), 'cannot downgrade a release source contract');
      records.set(at, { ...old, ...r, address: at, codeHash: old?.codeHash ?? r.codeHash,
        name: old?.kind === 'source' ? old.name : r.name ?? (r.contract ? r.contract.split(':').at(-1) : old?.name),
        kind: r.clone ? 'clone' : r.contract || r.buildInfo || r.artifact ? 'source' : r.kind ?? old?.kind ?? 'source' });
    }
  }
  requireValue(records.size > 0, 'empty deployment inventory');
  return { chainId: manifest.chainId, contracts: [...records.values()], notes };
}
