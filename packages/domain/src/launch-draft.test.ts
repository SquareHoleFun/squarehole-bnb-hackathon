/**
 * Launch draft (SH-009): the zod validator mirrors square-hole-handoff/schemas/launch.schema.json plus demo guards.
 * The ajv differential classifies every mutation: both_reject, zod_stricter (guard the JSON Schema cannot express)
 * or zod_looser (a documented ADR-0008 deviation from the handoff schema).
 */
import { Ajv2020 } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DataValidationError,
  launchDraftSchema,
  parseLaunchDraft,
  safeParseLaunchDraft,
  type LaunchDraft,
} from './index';
import { deleteAt, readHandoffJson, setAt } from './test-support/handoff';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const ajvValidate = ajv.compile(readHandoffJson('schemas/launch.schema.json') as object);

/** A fresh copy of the handoff's fixtures/orchard-launch.json (safe to mutate). */
const orchard = (): LaunchDraft => readHandoffJson('fixtures/orchard-launch.json') as LaunchDraft;

/** A token draft without nftUnitRaw (ADR-0008 deviation: the handoff schema requires the field for every draft). */
function tokenDraft(): LaunchDraft {
  const draft = orchard();
  deleteAt(draft, ['nftUnitRaw']);
  return { ...draft, assetType: 'token', name: 'ROUND TRIP', symbol: 'ROUND' };
}

const issuePaths = (input: unknown): string[] => {
  const result = safeParseLaunchDraft(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

describe('LaunchDraft validator', () => {
  it('accepts fixtures/orchard-launch.json unchanged, and ajv accepts it against launch.schema.json', () => {
    const input = orchard();
    expect(ajvValidate(input), JSON.stringify(ajvValidate.errors)).toBe(true);
    expect(parseLaunchDraft(input)).toEqual(orchard());
  });

  it('infers the LaunchDraft type', () => {
    expectTypeOf<z.output<typeof launchDraftSchema>>().toEqualTypeOf<LaunchDraft>();
    expectTypeOf(parseLaunchDraft).returns.toEqualTypeOf<LaunchDraft>();
  });

  it('accepts a token draft without nftUnitRaw and with a description', () => {
    expect(issuePaths({ ...tokenDraft(), description: 'A round token that fits the square hole anyway.' })).toEqual([]);
  });

  it('throws a typed DataValidationError listing every issue', () => {
    const input = { ...orchard(), chainId: 1, productionAuthorized: true };
    expect(() => parseLaunchDraft(input)).toThrow(DataValidationError);
    try {
      parseLaunchDraft(input);
    } catch (error) {
      expect((error as DataValidationError).code).toBe('invalid_data');
      expect((error as DataValidationError).issues.map((issue) => issue.path)).toEqual(['chainId', 'productionAuthorized']);
    }
  });

  describe('demo guards (D07; mode demo or chain 31337)', () => {
    it.each([
      ['chainId', 1],
      ['feePolicyStatus', 'approved'],
      ['externalRouteState', 'available'],
      ['externalRouteState', 'unavailable'],
      ['productionAuthorized', true],
      ['rootTokenAddress', '0x00000000000000000000000000000000000003e9'],
      ['rootNFTAddress', '0x00000000000000000000000000000000000007d2'],
    ] as const)('rejects %s = %j', (field, value) => {
      const input = orchard();
      setAt(input, [field], value);
      expect(issuePaths(input)).toEqual([field]);
    });

    it('treats chain 31337 as demo even when the draft claims live mode', () => {
      const input = { ...orchard(), mode: 'live', feePolicyStatus: 'approved' };
      expect(issuePaths(input)).toEqual(['mode', 'feePolicyStatus']);
    });
  });

  describe('policy constants (BURN_NATIVE_T_ROUTE_Q_V1)', () => {
    it.each([
      ['headlineFeeTargetBps', 250],
      ['qProtocolShareNumerator', 2],
      ['qProtocolShareDenominator', 4],
    ] as const)('rejects %s = %s', (field, value) => {
      const input = orchard();
      setAt(input, [field], value);
      expect(issuePaths(input)).toEqual([field]);
    });

    it('rejects a protocol share numerator above the denominator', () => {
      const input = { ...orchard(), qProtocolShareNumerator: 4 };
      expect(issuePaths(input)).toContain('qProtocolShareNumerator');
    });
  });

  describe('NFT unit (nft_collection only)', () => {
    it('requires a positive nftUnitRaw for nft_collection', () => {
      const missing = orchard();
      deleteAt(missing, ['nftUnitRaw']);
      expect(issuePaths(missing)).toEqual(['nftUnitRaw']);
      expect(issuePaths({ ...orchard(), nftUnitRaw: '0' })).toEqual(['nftUnitRaw']);
    });

    it('rejects nftUnitRaw on a token draft', () => {
      expect(issuePaths({ ...tokenDraft(), nftUnitRaw: '1000000000000000000' })).toEqual(['nftUnitRaw']);
    });
  });

  describe('F08 ratio tiers and collection size (ADR-0009; ADR-0008 addendum)', () => {
    const E18 = 10n ** 18n;
    const nft = (size: string | undefined, fractionsPerNft: bigint): LaunchDraft => {
      const draft: LaunchDraft = { ...orchard(), nftUnitRaw: (fractionsPerNft * E18).toString() };
      if (size !== undefined) draft.collectionSize = size;
      return draft;
    };

    it('accepts every tier r = 10^k (k = 0…9) with N × r at the 10^9 maximum', () => {
      for (let k = 0; k <= 9; k += 1) {
        const r = 10n ** BigInt(k);
        expect(issuePaths(nft((1_000_000_000n / r).toString(), r)), `k=${k}`).toEqual([]);
      }
    });

    it('rejects N × r above 10^9 for the full collection', () => {
      expect(issuePaths(nft('1000000001', 1n))).toEqual(['collectionSize']);
      expect(issuePaths(nft('1001', 1_000_000n))).toEqual(['collectionSize']);
      expect(issuePaths(nft('2', 1_000_000_000n))).toEqual(['collectionSize']);
    });

    it('rejects a unit that is not a tier, even without a size', () => {
      for (const unit of ['1', '999999999999999999', '2000000000000000000', '5000000000000000000', (10n ** 28n).toString()]) {
        expect(issuePaths({ ...orchard(), nftUnitRaw: unit }), unit).toEqual(['nftUnitRaw']);
      }
    });

    it('rejects a zero or malformed collection size', () => {
      expect(issuePaths(nft('0', 1000n))).toEqual(['collectionSize']);
      for (const size of ['01', '-1', '1.5', ' 10', '1e3', '']) expect(issuePaths(nft(size, 1000n)), size).toContain('collectionSize');
    });

    it('keeps pre-F08 drafts without a size valid (the handoff fixture)', () => {
      expect(issuePaths(nft(undefined, 1n))).toEqual([]);
    });

    it('rejects a collection size on a token draft', () => {
      expect(issuePaths({ ...tokenDraft(), collectionSize: '100' })).toEqual(['collectionSize']);
    });
  });

  describe('zero address is rejected everywhere', () => {
    const ZERO = '0x0000000000000000000000000000000000000000';
    it.each(['quoteAddress', 'rootTokenAddress', 'rootNFTAddress'] as const)('%s', (field) => {
      const input = { ...orchard(), mode: 'live', chainId: 1, [field]: ZERO };
      expect(issuePaths(input)).toContain(field);
    });
  });

  describe('identity text limits (code points) and hostile text', () => {
    it.each([
      ['name', '', 'name'],
      ['name', 'N'.repeat(65), 'name'],
      ['name', '   ', 'name'],
      ['name', ' ORCHARD', 'name'],
      ['name', 'ORCH\u0000ARD', 'name'],
      ['name', 'ORCH\u202EARD', 'name'],
      ['symbol', '', 'symbol'],
      ['symbol', 'S'.repeat(33), 'symbol'],
      ['symbol', 'OR CH', 'symbol'],
      ['symbol', 'ORCH\u2066', 'symbol'],
      ['description', 'd'.repeat(501), 'description'],
      ['description', 'tab\tseparated', 'description'],
    ] as const)('rejects %s = %j', (field, value, path) => {
      expect(issuePaths({ ...orchard(), [field]: value })).toEqual([path]);
    });

    it.each([
      ['name', '🍎'.repeat(64)],
      ['symbol', 'S'.repeat(32)],
      ['description', 'd'.repeat(500)],
      ['description', 'Two lines\nare fine.'],
      ['description', ''],
    ] as const)('accepts %s at the limit (%#)', (field, value) => {
      expect(issuePaths({ ...orchard(), [field]: value })).toEqual([]);
    });
  });

  it('is total: hostile values never throw from safeParse', () => {
    const original = orchard() as unknown as Record<string, unknown>;
    for (const value of [null, undefined, 0, -1, 1.5, 2 ** 60, '', '0x', true, [], {}]) {
      for (const field of Object.keys(original)) {
        const input: unknown = { ...original, [field]: value };
        expect(() => safeParseLaunchDraft(input)).not.toThrow();
        // `null` is the fixture's own (valid) value for the nullable hash and root addresses; '0x' is a valid name.
        const mayBeValid = value === original[field] || (value === '0x' && (field === 'name' || field === 'symbol'));
        if (!mayBeValid) expect(safeParseLaunchDraft(input).ok, `${field}=${String(value)}`).toBe(false);
      }
      expect(safeParseLaunchDraft(value).ok).toBe(false);
    }
  });
});

type Expected = 'both_reject' | 'zod_stricter' | 'zod_looser' | 'both_accept';
interface Mutation {
  name: string;
  expected: Expected;
  base?: () => LaunchDraft;
  apply: (draft: LaunchDraft) => void;
  reason?: string;
}
const set = (field: string, value: unknown) => (draft: LaunchDraft) => setAt(draft, [field], value);
const del = (field: string) => (draft: LaunchDraft) => deleteAt(draft, [field]);
const reject = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_reject', apply });
const accept = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_accept', apply });
const stricter = (name: string, reason: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'zod_stricter', reason, apply });
const looser = (name: string, reason: string, apply: Mutation['apply'], base?: () => LaunchDraft): Mutation => ({
  name,
  expected: 'zod_looser',
  reason,
  apply,
  base,
});

const MUTATIONS: readonly Mutation[] = [
  reject('schemaVersion 2.0', set('schemaVersion', '2.0')),
  reject('unknown mode', set('mode', 'prod')),
  reject('chainId 0', set('chainId', 0)),
  reject('chainId as string', set('chainId', '31337')),
  reject('unknown assetType', set('assetType', 'nft')),
  reject('empty name', set('name', '')),
  reject('name of 65 code points', set('name', '🍎'.repeat(65))),
  reject('symbol of 33 characters', set('symbol', 'S'.repeat(33))),
  reject('short quoteAddress', set('quoteAddress', '0x2329')),
  reject('unknown rewardSide', set('rewardSide', 'R')),
  reject('another fee policy id', set('feePolicyId', 'BURN_ALL_V2')),
  reject('unknown feePolicyStatus', set('feePolicyStatus', 'final')),
  reject('headline fee above 10000 bps', set('headlineFeeTargetBps', 10_001)),
  reject('negative numerator', set('qProtocolShareNumerator', -1)),
  reject('zero denominator', set('qProtocolShareDenominator', 0)),
  reject('nftUnitRaw with decimals', set('nftUnitRaw', '1.0')),
  reject('nftUnitRaw as number', set('nftUnitRaw', 1e18)),
  reject('short metadata hash', set('metadataManifestHash', '0x1234')),
  reject('bad root token address', set('rootTokenAddress', '0x03e9')),
  reject('unknown externalRouteState', set('externalRouteState', 'executable')),
  reject('demo draft production authorized', set('productionAuthorized', true)),
  reject('extra property', set('creatorFeeBps', 250)),
  reject('missing quoteAddress', del('quoteAddress')),
  reject('missing productionAuthorized', del('productionAuthorized')),

  stricter('demo draft on chain 1', 'D07: demo drafts are on chain 31337', set('chainId', 1)),
  stricter('demo draft approved policy', 'G05: the policy is draft until economics approval', set('feePolicyStatus', 'approved')),
  stricter('demo draft route available', 'EXT-08: no route is verified in demo mode', set('externalRouteState', 'available')),
  stricter('demo draft root token set', 'D06/13: root identities are unset in demo', set('rootTokenAddress', '0x00000000000000000000000000000000000003e9')),
  stricter('live mode on the demo chain', 'chain 31337 is always demo (FEED-09 rule)', set('mode', 'live')),
  stricter('headline target 250 bps', 'must equal the BURN_NATIVE_T_ROUTE_Q_V1 constant', set('headlineFeeTargetBps', 250)),
  stricter('protocol share 2/6', 'must equal the policy constants exactly (1/3)', (d) => {
    setAt(d, ['qProtocolShareNumerator'], 2);
    setAt(d, ['qProtocolShareDenominator'], 6);
  }),
  stricter('protocol share numerator above denominator', 'a share cannot exceed 100%', set('qProtocolShareNumerator', 4)),
  stricter('zero nftUnitRaw', 'NFT unit must be positive (no division by zero)', set('nftUnitRaw', '0')),
  stricter('nftUnitRaw not a ratio tier', 'ADR-0009 (F08): the unit is 10^k × 10^18 with k = 0…9', set('nftUnitRaw', '2000000000000000000')),
  stricter('zero quote address', 'zero address is never an asset identity', set('quoteAddress', '0x0000000000000000000000000000000000000000')),
  stricter('whitespace-only name', 'identity text must be visible', set('name', '   ')),
  stricter('bidi override in name', 'no direction-override spoofing in identity text', set('name', 'ORCH\u202EARD')),
  stricter('space in symbol', 'tickers carry no whitespace', set('symbol', 'OR CH')),
  stricter('unsafe integer chainId', 'integers beyond 2^53 are not exact in JS', set('chainId', 2 ** 53 + 2)),

  looser('token draft without nftUnitRaw', 'ADR-0008: a token has no NFT unit; the handoff schema requires the field', (d) => {
    deleteAt(d, ['nftUnitRaw']);
    setAt(d, ['assetType'], 'token');
  }),
  looser('description present', 'ADR-0008: 01-PRODUCT Step 2 asks for a description; the handoff schema has no field for it', set('description', 'Orchard trees.')),
  looser('collectionSize present', 'ADR-0008 addendum: F08 needs the collection size N; the handoff schema has no field for it', set('collectionSize', '1000')),

  accept('R = T', set('rewardSide', 'T')),
  accept('metadata hash present', set('metadataManifestHash', `0x${'ab'.repeat(32)}`)),
  accept('name of 64 astral code points', set('name', '🍎'.repeat(64))),
  accept('mixed-case quote address', set('quoteAddress', '0x000000000000000000000000000000000000232A')),
];

function run(mutation: Mutation): { ajv: boolean; zod: boolean } {
  const draft = (mutation.base ?? orchard)();
  mutation.apply(draft);
  return { ajv: ajvValidate(draft), zod: safeParseLaunchDraft(draft).ok };
}

const EXPECTED_RESULT: Record<Expected, { ajv: boolean; zod: boolean }> = {
  both_reject: { ajv: false, zod: false },
  zod_stricter: { ajv: true, zod: false },
  zod_looser: { ajv: false, zod: true },
  both_accept: { ajv: true, zod: true },
};

describe('launch.schema.json (ajv) vs LaunchDraft validator (zod)', () => {
  it('every stricter or looser case documents its reason', () => {
    for (const mutation of MUTATIONS) {
      const documented = mutation.expected === 'both_reject' || mutation.expected === 'both_accept' || Boolean(mutation.reason);
      expect(documented, mutation.name).toBe(true);
    }
  });

  it.each(MUTATIONS.map((m) => [`${m.expected}: ${m.name}`, m] as const))('%s', (_name, mutation) => {
    expect(run(mutation)).toEqual(EXPECTED_RESULT[mutation.expected]);
  });
});
