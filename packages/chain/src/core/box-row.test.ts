/**
 * The box row decoder (S10a § 2.2; BC-086's decoder part, BC-083's decimals and order): rows from the registry's logs,
 * the same row from `recordOf` and from JSON, and every refusal.
 */
import { BOX_0_MISFITS, BOX_0_MISFITS_SPEC_HASH, boxCurve, encodeBoxSpecV1, ISSUANCE } from '@squarehole/box-spec';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { BOX_CREATED_TOPIC, BOX_SPEC_TOPIC, boxRowFromJson, boxRowFromRecord, boxRowToJson, BoxRowError, rowAddresses, rowsFromRegistryLogs, ZERO_ADDRESS } from './box-row';
import { labelAddress, labelHash, registryLogs, specWithQ, syntheticBox, syntheticTimeOf, TEST_Q, testQList, tokenOnlySpec, type TestQName } from './test-support';

const CHAIN = 11_155_111;
const REGISTRY = labelAddress('registry-v1');
const BLOCK_HASH = labelHash('block-100');
const options = { chainId: CHAIN, registry: REGISTRY, box0Registry: REGISTRY } as const;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BoxRowError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('box 0 from its registry logs (BoxCreated + BoxSpec, BC-086 decoder part)', () => {
  const box = syntheticBox();
  const logs = registryLogs(box, { registry: REGISTRY, blockNumber: 100n, blockHash: BLOCK_HASH, logIndex: 7 });
  const { rows, refused } = rowsFromRegistryLogs(logs, options);
  const row = rows[0];

  it('BC-086: decodes one row, with the spec checked against the record (the fixture hash) and the topics as generated', () => {
    expect(refused).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(logs[0].topics[0]).toBe(BOX_CREATED_TOPIC);
    expect(logs[1].topics[0]).toBe(BOX_SPEC_TOPIC);
    expect(row?.specHash).toBe(BOX_0_MISFITS_SPEC_HASH);
    expect(row?.spec.tokenSymbol).toBe('FIT');
    expect(row?.spec.n).toBe(4269);
  });

  it('BC-086: takes every field from the row: Q, decimals, order, curve, window, roles, box 0 by registry and id', () => {
    if (!row) throw new Error('no row');
    expect(row.isBox0).toBe(true);
    expect(row.qAsset).toEqual({ token: ZERO_ADDRESS, decimals: 18, qClass: 'NATIVE_ETH', symbol: 'ETH' });
    // Native ETH (the zero address) is always currency0, so box 0's T is currency1.
    expect(row.tIsCurrency0).toBe(false);
    expect(row.curve).toEqual(boxCurve(BOX_0_MISFITS.raise, false));
    expect(row.curve.curveT + row.curve.poolShare).toBe(ISSUANCE);
    // The fixture opens Now (openAt 0): the creation block's time + 1, so the block after it; the window is 384 s.
    expect(BOX_0_MISFITS.openAt).toBe(0);
    expect(row.openAt).toBe(syntheticTimeOf(100n) + 1n);
    expect(row.windowEndsAt).toBe(row.openAt + 384n);
    // Box 0's roles: tickets (placeholders), per-item stream and royalty router present; no swap module (version 1).
    expect(row.contracts.tickets).not.toBeNull();
    expect(row.contracts.itemStream).not.toBeNull();
    expect(row.contracts.royaltyRouter).not.toBeNull();
    expect(row.contracts.swapModule).toBeNull();
    expect(row.codeHashes.swapModule).toBeNull();
    expect(row.origin).toEqual({ blockHash: BLOCK_HASH, txHash: logs[0].transactionHash, logIndex: 7 });
    expect([...rowAddresses(row).values()]).toEqual(['coordinator', 'token', 'hook', 'vault', 'collection', 'receiver', 'launchRouter', 'tickets', 'royaltyRouter', 'executor', 'itemStream', 'metadataTable']);
  });

  it('is the same row from recordOf plus the BoxSpec bytes, and from its JSON form', () => {
    if (!row) throw new Error('no row');
    const fromRecord = boxRowFromRecord(box.record, box.encodedSpec, { ...options, origin: row.origin });
    expect(fromRecord).toEqual(row);
    const json = JSON.parse(JSON.stringify(boxRowToJson(row))) as unknown;
    expect(boxRowFromJson(json, { box0Registry: REGISTRY, chainId: CHAIN })).toEqual(row);
  });

  it('box 0 only on the manifest\'s version-1 registry: the same id elsewhere is not box 0, never by its name', () => {
    const other = rowsFromRegistryLogs(registryLogs(box, { registry: labelAddress('registry-v2'), blockNumber: 100n, blockHash: BLOCK_HASH }), { ...options, registry: labelAddress('registry-v2') });
    expect(other.rows[0]?.isBox0).toBe(false);
    expect(other.rows[0]?.spec.collectionName).toBe('The Misfits');
    const json = { ...boxRowToJson(row as NonNullable<typeof row>), isBox0: true };
    expect(boxRowFromJson(json, { box0Registry: null }).isBox0).toBe(false);
  });
});

describe('refusals (never guessed)', () => {
  const box = syntheticBox();

  it('a spec whose hash is not the record\'s', () => {
    const other = encodeBoxSpecV1({ ...BOX_0_MISFITS, openAt: 1_791_309_600 });
    expect(refusal(() => boxRowFromRecord(box.record, other, options))).toBe('spec_hash_mismatch');
    expect(refusal(() => boxRowFromRecord(box.record, '0x1234' as Hex, options))).toBe('spec_undecodable');
  });

  it('a Q not on the version\'s Q list', () => {
    const erc20 = syntheticBox({ spec: specWithQ(TEST_Q.ERC20_18.token) });
    expect(refusal(() => boxRowFromRecord(erc20.record, erc20.encodedSpec, options))).toBe('unknown_q');
  });

  it('a role the spec needs that is absent, one it excludes that is present, an address without its code hash', () => {
    const noTickets = syntheticBox({ contracts: { tickets: null } });
    expect(refusal(() => boxRowFromRecord(noTickets.record, noTickets.encodedSpec, options))).toBe('role_missing');
    const noStream = syntheticBox({ contracts: { itemStream: null } });
    expect(refusal(() => boxRowFromRecord(noStream.record, noStream.encodedSpec, options))).toBe('role_missing');
    const withModule = syntheticBox({ contracts: { swapModule: labelAddress('module') } });
    expect(refusal(() => boxRowFromRecord(withModule.record, withModule.encodedSpec, options))).toBe('role_unexpected');
    const hashless = { ...box.record, codeHashes: box.record.codeHashes.map((h, i) => (i === 1 ? (`0x${'0'.repeat(64)}` as Hex) : h)) };
    expect(refusal(() => boxRowFromRecord(hashless, box.encodedSpec, options))).toBe('code_hash_mismatch');
    const short = { ...box.record, contracts: box.record.contracts.slice(0, 12) };
    expect(refusal(() => boxRowFromRecord(short, box.encodedSpec, options))).toBe('malformed');
  });

  it('logs: another address ignored, a BoxSpec without its BoxCreated, duplicates and split transactions refused', () => {
    const [created, spec] = registryLogs(box, { registry: REGISTRY, blockNumber: 100n, blockHash: BLOCK_HASH });
    const foreign = registryLogs(syntheticBox({ boxId: 1n }), { registry: labelAddress('look-alike'), blockNumber: 100n, blockHash: BLOCK_HASH });
    expect(rowsFromRegistryLogs([created, spec, ...foreign], options).rows).toHaveLength(1);
    expect(rowsFromRegistryLogs([spec], options).refused.map((r) => r.error.reason)).toEqual(['spec_without_record']);
    expect(rowsFromRegistryLogs([created], options).refused.map((r) => r.error.reason)).toEqual(['record_without_spec']);
    expect(rowsFromRegistryLogs([created, spec, { ...created, logIndex: 9 }], options).refused.map((r) => r.error.reason)).toEqual(['duplicate']);
    expect(rowsFromRegistryLogs([created, { ...spec, transactionHash: labelHash('other-tx') }], options).refused.map((r) => r.error.reason)).toEqual(['malformed']);
    expect(rowsFromRegistryLogs([{ ...created, removed: true }, spec], options).refused.map((r) => r.error.reason)).toEqual(['spec_without_record']);
  });

  it('JSON that is not a row', () => {
    expect(refusal(() => boxRowFromJson(null, { box0Registry: REGISTRY }))).toBe('malformed');
    const json = boxRowToJson(boxRowFromRecord(box.record, box.encodedSpec, options));
    expect(refusal(() => boxRowFromJson({ ...json, record: { ...json.record, raise: '4.2' } }, { box0Registry: REGISTRY }))).toBe('malformed');
    expect(refusal(() => boxRowFromJson(json, { box0Registry: REGISTRY, chainId: 31_337 }))).toBe('malformed');
  });
});

describe('every Q class and both token orders from synthetic records (BC-083, BC-086)', () => {
  const qList = testQList();
  const cases: { q: TestQName; token: Address; tIsC0: boolean }[] = [];
  for (const q of Object.keys(TEST_Q) as TestQName[]) {
    // A token below 0x8000… sorts before every non-native test Q; one above it after (native ETH is always currency0).
    cases.push({ q, token: '0x1000000000000000000000000000000000000001' as Address, tIsC0: q !== 'NATIVE_ETH' });
    if (q !== 'NATIVE_ETH') cases.push({ q, token: '0xf000000000000000000000000000000000000001' as Address, tIsC0: false });
  }
  for (const c of cases) {
    it(`BC-083, BC-086 ${c.q}, T ${c.tIsC0 ? 'currency0' : 'currency1'}`, () => {
      const box = syntheticBox({ spec: specWithQ(TEST_Q[c.q].token), contracts: { token: c.token } });
      const row = boxRowFromRecord(box.record, box.encodedSpec, { ...options, qList, qSymbols: { [TEST_Q.ERC20_6.token.toLowerCase()]: 'USDC' } });
      expect(row.tIsCurrency0).toBe(c.tIsC0);
      expect(row.qAsset.decimals).toBe(TEST_Q[c.q].decimals);
      expect(row.qAsset.qClass).toBe(c.q.startsWith('ERC20') ? 'ERC20' : c.q);
      expect(row.qAsset.symbol).toBe(c.q === 'NATIVE_ETH' ? 'ETH' : c.q === 'ERC20_6' ? 'USDC' : null);
      expect(row.curve.tIsCurrency0).toBe(c.tIsC0);
      // The curve starts at P0 (cheap T) and ends at P1 in the pool's own order.
      expect(row.curve.tickStart).toBe(c.tIsC0 ? row.curve.tickLower : row.curve.tickUpper);
    });
  }

  it('a token-only box has no vault, collection or table, and needs none', () => {
    const box = syntheticBox({ spec: tokenOnlySpec() });
    const row = boxRowFromRecord(box.record, box.encodedSpec, options);
    expect([row.contracts.vault, row.contracts.collection, row.contracts.metadataTable, row.contracts.tickets]).toEqual([null, null, null, null]);
  });
});
