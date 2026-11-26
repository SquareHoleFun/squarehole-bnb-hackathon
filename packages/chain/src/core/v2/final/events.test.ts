import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type AbiParameter } from 'viem';
import * as generatedV2 from '../abi-v2';
import { EVENT_ABI_V2, type EventSourceV2 } from '../events-v2';
import { synthBoxV2, synthManifestV2 } from '../test-support/synth-v2';
import { m2Fixture, logM2, A, H } from '../../../../../indexer/src/core/v2/m2-fixture.test-support';
import { m3Fixture } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../../../../indexer/src/core/v2/events-v2';
import { applyV2Block } from '../../../../../indexer/src/core/v2/views-v2';
import { jsonV2 } from '../../../../../indexer/src/core/core-row';

const artifacts = new URL('../../../../../contracts/out/', import.meta.url);
const artifactAbi = (name: string): Abi => (JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, artifacts), 'utf8')) as { abi: Abi }).abi;
function value(p: AbiParameter): unknown {
  if (p.type === 'address') return A;
  if (p.type === 'bool') return true;
  if (p.type === 'string') return 'review';
  if (p.type.endsWith('[]')) return [];
  if (p.type === 'bytes') return '0x1234';
  if (p.type.startsWith('bytes')) return `0x${'11'.repeat(Number(p.type.slice(5)))}`;
  if (p.type === 'tuple' && 'components' in p) return p.components.map(value);
  if (/^(u?int)(8|16|24|32|40|48)$/.test(p.type)) return 1;
  const width = /^(?:u?int)(\d+)$/.exec(p.type)?.[1];
  if (width && Number(width) < 128) return 1n;
  return 2n ** 120n + 7n;
}
// These events do not move money or change a claim/lifecycle. Collection identity is
// checked during discovery; metadata refresh is outside this money/lifecycle property.
const outsideMoneyScope = new Set(['Approval', 'ApprovalForAll', 'CollectionInitialized', 'ContractURIUpdated', 'MetadataUpdate']);
const inventory: readonly [string, number, EventSourceV2, 'base' | 'shop' | 'item' | 'pile'][] = [
  ['BoxCoordinatorV2', 0, 'coordinator', 'base'], ['BoxHookV2', 2, 'hook', 'base'],
  ['BoxReceiverV2', 5, 'receiver', 'base'], ['BoxLaunchRouterV2', 6, 'launchRouter', 'base'],
  ['BoxRoyaltyRouterV2', 8, 'royaltyRouter', 'base'], ['BoxTokenV2', 1, 'token', 'base'],
  ['BoxTokenV2Ledger', 1, 'token', 'shop'], ['HolderLedgerV2', 17, 'holderLedger', 'shop'],
  ['ShopVaultV2', 3, 'vault', 'shop'], ['StarterSetLoaderV2', 19, 'starterSetLoader', 'shop'],
  ['BoxCollectionV2', 4, 'collection', 'base'], ['BoxTicketsV2', 7, 'tickets', 'base'],
  ['BoxVaultV2', 3, 'vault', 'base'], ['ItemLedgerV2', 16, 'itemLedger', 'item'], ['PileVaultV2', 3, 'vault', 'pile'],
];

// SH-229: the check reads every compiled contract in a child process: 34 to 48 s on the Linux laptop of 2026-11-10 when
// the suite runs alone, over the earlier 55 s beside other work (two gates of November 2026). The child gets the
// test's limit less 10 s, so a child that hangs is still reported as its own error and not as the test's timeout.
const ABI_CHECK_MS = shLimit(180_000);

describe('FINAL-EVENTS: compiled money/lifecycle bytes survive authenticated decoding', () => {
  it('SH-V2-OC04-ABI --check rejects stale generated output without rewriting it', () => {
    const cache = new URL('../../../../../../.cache/', import.meta.url);
    mkdirSync(cache, { recursive: true });
    const root = pathToFileURL(`${mkdtempSync(fileURLToPath(new URL('oc04-abi-check-', cache)))}/`);
    const dir = new URL('packages/chain/src/core/v2/', root);
    mkdirSync(dir, { recursive: true });
    // Keep the real compiled contracts as the oracle; isolate only the generator's output.
    symlinkSync(fileURLToPath(new URL('../../../../../contracts/', import.meta.url)), new URL('packages/contracts', root), 'dir');
    const script = new URL('regenerate-abi-v2.mjs', dir);
    const target = new URL('abi-v2.ts', dir);
    copyFileSync(new URL('../regenerate-abi-v2.mjs', import.meta.url), script);
    const current = readFileSync(new URL('../abi-v2.ts', import.meta.url), 'utf8');
    const stale = current.replace('export const registryV2Abi = [', 'export const registryV2Abi = [\n  { type: "event", name: "StaleProbe", inputs: [], anonymous: false },');
    expect(stale).not.toBe(current);
    writeFileSync(target, stale);
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--check'], { encoding: 'utf8', timeout: ABI_CHECK_MS - 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('abi-v2.ts is stale');
    expect(readFileSync(target, 'utf8')).toBe(stale);
  }, ABI_CHECK_MS);

  it('SH-V2-OC04-ABI generates only ClaimsForwarded and registers it without changing the interface ABI', () => {
    const compiled = artifactAbi('BoxCoordinatorV2').filter(e => e.type === 'event' && e.name === 'ClaimsForwarded');
    expect(compiled).toHaveLength(1);
    const supplement = (generatedV2 as unknown as Record<string, Abi>).coordinatorV2ExtraEventsAbi;
    expect(supplement).toEqual(compiled);
    expect(generatedV2.coordinatorV2Abi).toEqual(artifactAbi('IBoxCoordinatorV2'));
    expect((generatedV2.coordinatorV2Abi as Abi).some(e => e.type === 'event' && e.name === 'ClaimsForwarded')).toBe(false);
    const registered = EVENT_ABI_V2.coordinator?.filter(e => e.type === 'event' && e.name === 'ClaimsForwarded');
    expect(registered).toHaveLength(1);
    expect(registered?.[0]).toBe(supplement?.[0]);
  });

  it.each(inventory)('%s money/lifecycle events decode at the authenticated role', (name, role, source, kind) => {
    const base = synthBoxV2({ boxId: 800n }); const manifest = synthManifestV2();
    const release = manifest.releases[0]; if (!release) throw new Error('missing release fixture');
    const f = kind === 'shop' ? m2Fixture() : kind === 'item' ? m3Fixture() : kind === 'pile' ? m3Fixture(true) : { ...base, manifest, release };
    // Synthetic authenticated routing is not factory-admission evidence.
    const address = f.record.contracts[role]; if (!address || /^0x0{40}$/i.test(address)) throw new Error(`missing ${name} fixture role`);
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    for (const event of artifactAbi(name).filter((e): e is AbiEvent => e.type === 'event' && !outsideMoneyScope.has(e.name))) {
      const args = Object.fromEntries(event.inputs.map(p => [p.name, p.name === 'poolId' ? f.record.poolId : value(p)]));
      const raw = logM2(event, address, args, 1);
      expect.soft(EVENT_ABI_V2[source]?.some(e => e.type === 'event' && toEventSelector(e) === toEventSelector(event)), event.name).toBe(true);
      const decoded = decodeV2Log(raw, route);
      expect.soft(decoded, event.name).toMatchObject({ source, name: event.name, boxId: f.record.boxId });
      if (decoded) {
        // Re-encoding names may differ between inherited interfaces, so compare ABI-ordered values.
        const expected = decodeEventLog({ abi: [event], topics: raw.topics as never, data: raw.data }).args;
        expect(Object.values(decoded.args)).toEqual(Object.values(expected ?? {}));
      }
      expect(decodeV2Log({ ...raw, address: A }, route)).toBeNull();
      expect(decodeV2Log({ ...raw, removed: true }, route)).toBeNull();
    }
  });

  it('holder funding/payment/residue conserve decimal-string P across duplicate delivery and replacement blocks', () => {
    const f = m2Fixture(false), route = routeV2(f.release, f.manifest, [], [f.record]);
    const event = (contract: string, name: string): AbiEvent => {
      const found = artifactAbi(contract).find((e): e is AbiEvent => e.type === 'event' && e.name === name);
      if (!found) throw new Error(`missing artifact event ${name}`); return found;
    };
    const total = 2n ** 200n + 3n, paid = total - 2n;
    const logs = [
      logM2(event('BoxReceiverV2', 'HolderBatchFunded'), f.at(5), { batchId: 1n, netP: total }, 0, 100n, H(100)),
      logM2(event('HolderLedgerV2', 'BatchSettled'), f.at(17), { batchId: 1n, fundingP: total, holderP: paid, residueP: 2n }, 1, 100n, H(100)),
    ];
    const header = (hash = H(100), number = 100n) => ({ number, hash, parentHash: H(99), timestamp: 1000n });
    const parent = applyV2Block(undefined, header(), decodeV2Logs([...logs].reverse().concat(logs), route), f.row).state;
    const payment = logM2(event('HolderLedgerV2', 'HolderPaid'), f.at(17), { batchId: 1n, holder: A, to: A, grossP: paid, tipP: 0n }, 1, 101n, H(101));
    const child = applyV2Block(parent, { ...header(H(101), 101n), parentHash: H(100) }, decodeV2Logs([payment, payment], route), f.row).state;
    const batch = child.view.m2?.batches['1'];
    expect(batch?.paidP).toBe(paid); expect((batch?.paidP ?? 0n) + (batch?.residueP ?? 0n)).toBe(total);
    expect(child.claimPayments).toHaveLength(1);
    expect(JSON.stringify(jsonV2(child.claimPayments))).toContain(`"amountP":"${paid}"`);
    const replaced = applyV2Block(parent, { ...header(H(201), 101n), parentHash: H(100) }, [], f.row).state;
    expect(replaced.claimPayments).toHaveLength(0); expect(replaced.view.m2?.batches['1']?.paidP).toBe(0n);
    expect(parent.view.m2?.batches['1']?.paidP).toBe(0n);
  });
});
