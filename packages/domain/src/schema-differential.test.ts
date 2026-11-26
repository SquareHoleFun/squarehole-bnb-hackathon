/**
 * Differential test: the handoff JSON Schema (ajv 8.20.0, draft 2020-12, ajv-formats 3.0.1) versus the runtime
 * zod validator on the same inputs. Every mutation is classified up front:
 *   both_reject   – structural errors both validators must catch;
 *   zod_stricter  – guards JSON Schema cannot express; ajv accepts, zod rejects (reason documented);
 *   both_accept   – valid edge cases zod must not over-reject.
 */
import { Ajv2020 } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { safeParseFeedFixture, type FeedFixture, type PairRecord } from './index';
import { deleteAt, handoffFixture, readHandoffJson, setAt } from './test-support/handoff';

// strictRequired is Ajv's own lint (not JSON Schema): the handoff's `if/then` lists `required` fields defined in the
// parent `properties`, which is valid 2020-12. The handoff is immutable, so only that lint is relaxed.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const ajvValidate = ajv.compile(readHandoffJson('schemas/feed.schema.json') as object);

type Expected = 'both_reject' | 'zod_stricter' | 'both_accept';
interface Mutation {
  name: string;
  expected: Expected;
  apply: (fixture: FeedFixture) => void;
  /** Required for zod_stricter: why the runtime guard is intentionally stricter than the JSON Schema. */
  reason?: string;
}

const set = (path: (string | number)[], value: unknown) => (fixture: FeedFixture) => setAt(fixture, path, value);
const del = (path: (string | number)[]) => (fixture: FeedFixture) => deleteAt(fixture, path);
const item = (field: string | (string | number)[], index = 1): (string | number)[] => ['items', index, ...(Array.isArray(field) ? field : [field])];
const reject = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_reject', apply });
const accept = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_accept', apply });
const stricter = (name: string, reason: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'zod_stricter', reason, apply });

const ADDRESS = '0x0000000000000000000000000000000000000066';
const duplicateOf = (index: number, pairId?: string) => (fixture: FeedFixture) => {
  const copy = structuredClone(fixture.items[index] as PairRecord);
  fixture.items.push(pairId ? { ...copy, pairId: pairId as PairRecord['pairId'] } : copy);
};

export const MUTATIONS: readonly Mutation[] = [
  // Top level
  reject('schemaVersion 2.0', set(['schemaVersion'], '2.0')),
  reject('unknown mode', set(['mode'], 'prod')),
  reject('chainId 0', set(['chainId'], 0)),
  reject('chainId fractional', set(['chainId'], 1.5)),
  reject('chainId as string', set(['chainId'], '31337')),
  reject('missing snapshotId', del(['snapshotId'])),
  reject('missing items', del(['items'])),
  reject('extra top-level property', set(['extra'], true)),
  reject('asOf not a date', set(['asOf'], 'not-a-date')),
  reject('asOf month 13', set(['asOf'], '2026-13-01T00:00:00Z')),
  reject('asOf without time zone', set(['asOf'], '2026-09-25T12:00:00')),
  // Pair record
  reject('missing pairId', del(item('pairId'))),
  reject('pairId wrong separator', set(item('pairId'), `31337-${ADDRESS}`)),
  reject('pairId short address', set(item('pairId'), '31337:0x123')),
  reject('extra item property', set(item('extra'), 1)),
  reject('item chainId 0', set(item('chainId'), 0)),
  reject('empty name', set(item('name'), '')),
  reject('name of 65 code points', set(item('name'), '🍎'.repeat(65))),
  reject('symbol of 33 characters', set(item('symbol'), 'S'.repeat(33))),
  reject('unknown type', set(item('type'), 'nft')),
  reject('isPlatform as string', set(item('isPlatform'), 'false')),
  reject('unknown lifecycle', set(item('lifecycle'), 'launched')),
  reject('unknown rewardSide', set(item('rewardSide'), 'R')),
  reject('unknown routeState', set(item('routeState'), 'executable')),
  reject('negative holders', set(item('holders'), -1)),
  reject('fractional holders', set(item('holders'), 1.5)),
  reject('holders as string', set(item('holders'), '105')),
  // Asset identities
  reject('token address too short', set(item(['token', 'address']), '0x3ea')),
  reject('token address non-hex', set(item(['token', 'address']), '0x00000000000000000000000000000000000003eg')),
  reject('token address without 0x', set(item(['token', 'address']), '00000000000000000000000000000000000003ea')),
  reject('empty token symbol', set(item(['token', 'symbol']), '')),
  reject('decimals 37', set(item(['token', 'decimals']), 37)),
  reject('negative decimals', set(item(['token', 'decimals']), -1)),
  reject('fractional decimals', set(item(['quote', 'decimals']), 1.5)),
  reject('unknown issuerStatus', set(item(['quote', 'issuerStatus']), 'official')),
  reject('extra token property', set(item(['token', 'logo']), 'x')),
  reject('bad underlyingAddress', set(item(['quote', 'underlyingAddress']), '0x238d')),
  // Raw amounts
  ...['+1', ' 1', '1e21', '-1', '0x10', '', '01', '1.0'].map((value) => reject(`totalSupplyRaw ${JSON.stringify(value)}`, set(item('totalSupplyRaw'), value))),
  reject('totalSupplyRaw as number', set(item('totalSupplyRaw'), 1000)),
  reject('circulatingSupplyRaw as number', set(item('circulatingSupplyRaw'), 1)),
  reject('nftUnitRaw with decimals', set(item('nftUnitRaw'), '1.0')),
  // Decimal amounts
  ...['.5', '1.', '1e3', '-1.0', '1,5', ' 2.40'].map((value) => reject(`priceUsd ${JSON.stringify(value)}`, set(item('priceUsd'), value))),
  reject('priceUsd as number', set(item('priceUsd'), 2.4)),
  reject('marketCapUsd as number', set(item('marketCapUsd'), 600000)),
  // NFT mapping (JSON Schema if/then)
  reject('nft without mirrorAddress', del(item('mirrorAddress'))),
  reject('nft without nftUnitRaw', del(item('nftUnitRaw'))),
  reject('bad mirrorAddress', set(item('mirrorAddress'), '0x7d2')),
  // Provenance
  reject('provenance without source', del(item(['provenance', 'source']))),
  reject('unknown provenance state', set(item(['provenance', 'state']), 'live')),
  reject('unknown coverage', set(item(['provenance', 'coverage']), 'global')),
  reject('short blockHash', set(item(['provenance', 'blockHash']), '0x1234')),
  reject('negative blockNumber', set(item(['provenance', 'blockNumber']), '-1')),
  reject('extra provenance property', set(item(['provenance', 'extra']), 1)),
  reject('launchedAt not a date', set(item('launchedAt'), 'yesterday')),

  // Intentionally stricter runtime guards
  stricter('demo token claims verified issuer', 'FEED-09 demo guard', set(item(['token', 'issuerStatus']), 'verified')),
  stricter('demo quote claims verified issuer', 'FEED-09 demo guard', set(item(['quote', 'issuerStatus']), 'verified')),
  stricter('demo route available', 'FEED-09 demo guard', set(item('routeState'), 'available')),
  stricter('circulating above total supply', 'supply invariant (FEED-07)', set(item('circulatingSupplyRaw'), '260000000000000000000001')),
  stricter('zero NFT unit', 'NFT unit mapping must be positive (no division by zero)', set(item('nftUnitRaw'), '0')),
  stricter('duplicate pair (exact)', 'dedupe by chain + canonical pair id (03-FEED)', duplicateOf(2)),
  stricter('duplicate pair (address case only)', 'canonical pair id is lowercase (ADR-0003)', duplicateOf(5, '31337:0x000000000000000000000000000000000000006A')),
  stricter('two platform items', 'platform pinned once (FEED-01)', set(item('isPlatform', 4), true)),
  stricter('pairId chain differs from chainId', 'exact chain + address identity', set(item('pairId'), `1:${ADDRESS}`)),
  stricter('pairId chain 0', 'chain ids are positive (schema pattern allows 0)', set(item('pairId'), `0:${ADDRESS}`)),
  stricter('pairId chain with leading zero', 'one canonical spelling per pair id', set(item('pairId'), `031337:${ADDRESS}`)),
  stricter('token on another chain', 'exact chain + address identity', set(item(['token', 'chainId']), 1)),
  stricter('item on another chain than the file', 'single-chain snapshot (C08)', (f) => {
    for (const path of [['chainId'], ['token', 'chainId'], ['quote', 'chainId']]) setAt(f, item(path), 31338);
    setAt(f, item('pairId'), `31338:${ADDRESS}`);
  }),
  stricter('launch after snapshot asOf', 'a snapshot cannot contain future launches', set(item('launchedAt'), '2026-09-25T12:00:01Z')),
  stricter('lowercase t/z timestamp', 'one timestamp spelling (uppercase T/Z)', set(item('launchedAt'), '2026-09-22t12:00:00z')),
  stricter('space-separated timestamp', 'one timestamp spelling (uppercase T/Z)', set(item('launchedAt'), '2026-09-22 12:00:00Z')),
  stricter('microsecond timestamp', 'millisecond precision keeps JS sort keys exact', set(item('launchedAt'), '2026-09-22T12:00:00.123456Z')),
  stricter('unsafe integer chainId', 'integers beyond 2^53 are not exact in JS', (f) => setAt(f, ['chainId'], 2 ** 53 + 2)),
  stricter('unsafe integer holders', 'integers beyond 2^53 are not exact in JS', set(item('holders'), 2 ** 53 + 2)),

  // Valid edge cases
  accept('empty pair symbol (schema has no minLength)', set(item('symbol'), '')),
  accept('no slug', del(item('slug'))),
  accept('blockNumber and blockHash present', (f) => {
    setAt(f, item(['provenance', 'blockNumber']), '12345');
    setAt(f, item(['provenance', 'blockHash']), `0x${'ab'.repeat(32)}`);
  }),
  accept('unknown circulation and prices', (f) => {
    for (const field of ['circulatingSupplyRaw', 'priceUsd', 'marketCapUsd', 'turnover24hUsd', 'holders']) setAt(f, item(field), null);
  }),
  accept('name of 64 astral code points', set(item('name'), '🍎'.repeat(64))),
  accept('decimals 0 and 36', (f) => {
    setAt(f, item(['token', 'decimals']), 0);
    setAt(f, item(['quote', 'decimals']), 36);
  }),
  accept('offset and millisecond timestamp', set(item('launchedAt'), '2026-09-22T13:00:00.123+01:00')),
  accept('live mode on the demo chain without verified claims', set(['mode'], 'live')),
];

function run(mutation: Mutation): { ajv: boolean; zod: boolean } {
  const fixture = handoffFixture();
  mutation.apply(fixture);
  return { ajv: ajvValidate(fixture), zod: safeParseFeedFixture(fixture).ok };
}

describe('feed.schema.json (ajv) vs runtime validator (zod)', () => {
  it('both accept the unmodified handoff fixture', () => {
    const fixture = handoffFixture();
    expect(ajvValidate(fixture), JSON.stringify(ajvValidate.errors)).toBe(true);
    expect(safeParseFeedFixture(fixture).ok).toBe(true);
  });

  it('classifies every mutation with a reason when zod is stricter', () => {
    expect(MUTATIONS.length).toBeGreaterThan(80);
    for (const mutation of MUTATIONS) {
      expect(mutation.expected !== 'zod_stricter' || Boolean(mutation.reason), mutation.name).toBe(true);
    }
  });

  it.each(MUTATIONS.filter((m) => m.expected === 'both_reject').map((m) => [m.name, m] as const))('both reject: %s', (_name, mutation) => {
    expect(run(mutation)).toEqual({ ajv: false, zod: false });
  });

  it.each(MUTATIONS.filter((m) => m.expected === 'zod_stricter').map((m) => [m.name, m] as const))('zod stricter: %s', (_name, mutation) => {
    expect(run(mutation)).toEqual({ ajv: true, zod: false });
  });

  it.each(MUTATIONS.filter((m) => m.expected === 'both_accept').map((m) => [m.name, m] as const))('both accept: %s', (_name, mutation) => {
    expect(run(mutation)).toEqual({ ajv: true, zod: true });
  });
});
