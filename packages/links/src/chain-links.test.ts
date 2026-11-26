import type { PairRecord } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_CHAIN_LINK_REASON,
  UNISWAP_TESTNET_MODE_WARNING,
  createChainExternalLinkProvider,
  sepoliaExplorerHref,
} from './chain-links';
import { renderableHref } from './registry';
import { ROUTE_EVIDENCE_SCHEMA, loadRouteEvidence, parseRouteEvidence, passingEvidenceFor, type RouteEvidenceRecord } from './route-evidence';

const T = '0x94099942864EA81cCF197E9D71ac53310b1468D8';
const Q = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const TX = `0x${'ab'.repeat(32)}`;

function pair(chainId: number, overrides: Partial<PairRecord> = {}): PairRecord {
  return {
    pairId: `${chainId}:${T.toLowerCase()}` as PairRecord['pairId'],
    chainId,
    name: 'The Misfits',
    symbol: 'MISFITS',
    type: 'nft_collection',
    isPlatform: false,
    launchedAt: '2026-09-26T00:00:00Z',
    lifecycle: 'amm',
    token: { chainId, address: T, symbol: 'MISFITS', decimals: 18, issuerStatus: 'unverified' },
    quote: { chainId, address: Q, symbol: 'WETH', decimals: 18, issuerStatus: 'unverified' },
    mirrorAddress: '0x7Aedc1399D8D0C8C51Eb08E6A6EeC52a9256d9f0',
    nftUnitRaw: '1000000000000000000000000',
    rewardSide: 'T',
    totalSupplyRaw: '1',
    circulatingSupplyRaw: '1',
    burnedRaw: '0',
    priceUsd: null,
    marketCapUsd: null,
    turnover24hUsd: null,
    holders: null,
    routeState: 'unverified',
    provenance: { state: 'fresh', asOf: '2026-09-26T00:00:00Z', source: 'test', coverage: 'canonical_markets' },
    ...overrides,
  };
}

function evidence(overrides: Partial<RouteEvidenceRecord> = {}): RouteEvidenceRecord {
  return parseRouteEvidence({
    schema: ROUTE_EVIDENCE_SCHEMA,
    routeId: 'SEP-UNI-SWAP-BUY',
    chainId: 11_155_111,
    providerId: 'uniswap-web',
    kind: 'execution',
    token: T,
    quote: Q,
    poolId: `0x${'11'.repeat(32)}`,
    result: 'pass',
    testedAt: '2026-10-01T10:00:00Z',
    testedBy: 'founder',
    frontend: { build: 'web/5.164.0', testnetMode: true, universalRouterVersion: '2.0', routerAddress: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b' },
    transactions: [TX],
    evidenceRecord: 'docs/evidence/SH-E-route-test.md',
    ...overrides,
  });
}

describe('chain external links: local chain 31337', () => {
  it('builds no URL at all: execution and discovery unverified, explorer unavailable', () => {
    const destinations = createChainExternalLinkProvider().destinations(pair(31_337));
    expect(destinations.map((d) => [d.kind, d.state, d.href])).toEqual([
      ['execution', 'unverified', null],
      ['discovery', 'unverified', null],
      ['explorer', 'unavailable', null],
    ]);
    expect(destinations.every((d) => d.reason === LOCAL_CHAIN_LINK_REASON)).toBe(true);
  });

  it('ignores even a passing evidence record on the local chain', () => {
    const provider = createChainExternalLinkProvider({ evidence: [evidence({ chainId: 31_337 })] });
    expect(provider.destinations(pair(31_337)).every((d) => d.href === null)).toBe(true);
  });
});

describe('chain external links: Sepolia 11155111', () => {
  const provider = createChainExternalLinkProvider();
  const destinations = provider.destinations(pair(11_155_111));

  it('offers explorer pages for the exact token address on the two allowlisted explorers only', () => {
    const explorers = destinations.filter((d) => d.kind === 'explorer');
    expect(explorers.map((d) => [d.provider, d.state, d.href])).toEqual([
      ['Etherscan (Sepolia)', 'available', `https://sepolia.etherscan.io/token/${T}`],
      ['Blockscout (Sepolia)', 'available', `https://eth-sepolia.blockscout.com/token/${T}`],
    ]);
    for (const destination of explorers) expect(renderableHref(destination, pair(11_155_111))).not.toBeNull();
  });

  it('keeps Uniswap execution unverified with no href and always shows the Testnet-mode warning', () => {
    const execution = destinations.find((d) => d.kind === 'execution');
    expect(execution).toMatchObject({ provider: 'Uniswap web app', state: 'unverified', href: null });
    expect(execution?.reason).toContain(UNISWAP_TESTNET_MODE_WARNING);
    expect(execution?.reason).toContain('EXT-05');
  });

  it('keeps discovery unverified with no href (DEX Screener shows no Sepolia data)', () => {
    expect(destinations.find((d) => d.kind === 'discovery')).toMatchObject({ provider: 'DEX Screener', state: 'unverified', href: null });
  });

  it('never reads names, symbols or slugs (a hostile name changes nothing)', () => {
    const hostile = pair(11_155_111, { name: 'https://evil.example', symbol: 'javascript:alert(1)', slug: '//evil.example' });
    expect(provider.destinations(hostile)).toEqual(destinations);
  });

  it('enables execution only with a passing record for the exact chain, token and quote', () => {
    const withEvidence = createChainExternalLinkProvider({ evidence: [evidence()] }).destinations(pair(11_155_111));
    const execution = withEvidence.find((d) => d.kind === 'execution');
    expect(execution).toMatchObject({
      state: 'available',
      href: `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=${Q}&outputCurrency=${T}`,
      validatedAt: '2026-10-01T10:00:00Z',
      reason: UNISWAP_TESTNET_MODE_WARNING,
    });
    expect(renderableHref(execution as never, pair(11_155_111))).not.toBeNull();
    // Discovery has no reviewed URL shape, so evidence cannot build one.
    const discovery = createChainExternalLinkProvider({ evidence: [evidence({ routeId: 'SEP-DS', providerId: 'dexscreener', kind: 'discovery' })] })
      .destinations(pair(11_155_111))
      .find((d) => d.kind === 'discovery');
    expect(discovery).toMatchObject({ state: 'unverified', href: null });
  });

  it.each([
    ['another token', { token: '0x0000000000000000000000000000000000000abc' }],
    ['another quote', { quote: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' }],
    ['another chain', { chainId: 31_337 }],
    ['a failed test', { result: 'fail' as const }],
    ['another route template', { routeId: 'SEP-UNI-SWAP-SELL' }],
  ])('does not enable execution with evidence for %s', (_label, overrides) => {
    const execution = createChainExternalLinkProvider({ evidence: [evidence(overrides as Partial<RouteEvidenceRecord>)] })
      .destinations(pair(11_155_111))
      .find((d) => d.kind === 'execution');
    expect(execution).toMatchObject({ state: 'unverified', href: null });
  });
});

describe('chain external links: other chains and identity', () => {
  it('has no mainnet (or any other chain) routes', () => {
    const destinations = createChainExternalLinkProvider({ evidence: [evidence({ chainId: 1 })] }).destinations(pair(1));
    expect(destinations.every((d) => d.state === 'unavailable' && d.href === null)).toBe(true);
  });

  it('offers nothing when the token or quote identity is on another chain', () => {
    const mismatched = pair(11_155_111, { quote: { chainId: 1, address: Q, symbol: 'WETH', decimals: 18, issuerStatus: 'unverified' } });
    expect(createChainExternalLinkProvider().destinations(mismatched).every((d) => d.state === 'unavailable' && d.href === null)).toBe(true);
  });
});

describe('sepoliaExplorerHref', () => {
  it('links exact addresses and transaction hashes on the allowlisted explorers', () => {
    expect(sepoliaExplorerHref('etherscan-sepolia', { chainId: 11_155_111, address: T })).toBe(`https://sepolia.etherscan.io/address/${T}`);
    expect(sepoliaExplorerHref('blockscout-sepolia', { chainId: 11_155_111, txHash: TX })).toBe(`https://eth-sepolia.blockscout.com/tx/${TX}`);
  });

  it.each([
    ['another chain', { chainId: 31_337, address: T }],
    ['mainnet', { chainId: 1, address: T }],
    ['a malformed address', { chainId: 11_155_111, address: '0x1234' }],
    ['the zero address', { chainId: 11_155_111, address: '0x0000000000000000000000000000000000000000' }],
    ['a short hash', { chainId: 11_155_111, txHash: '0xabcd' }],
    ['a path injection', { chainId: 11_155_111, address: `${T}/../../evil` }],
    ['both an address and a hash', { chainId: 11_155_111, address: T, txHash: TX }],
  ])('refuses %s', (_label, target) => {
    expect(sepoliaExplorerHref('etherscan-sepolia', target)).toBeNull();
  });
});

describe('route evidence records (squarehole.route-evidence/v1)', () => {
  it('parses a complete record', () => {
    expect(evidence().routeId).toBe('SEP-UNI-SWAP-BUY');
  });

  it.each([
    ['a pass without transactions', { transactions: [] }, 'transactions'],
    ['a Sepolia Uniswap pass without Testnet mode', { frontend: { build: 'web', testnetMode: false, universalRouterVersion: null, routerAddress: null } }, 'testnetMode'],
    ['an evidence path outside docs/evidence', { evidenceRecord: 'https://evil.example/x.md' }, 'evidenceRecord'],
    ['a malformed token', { token: '0x12' }, 'token'],
    ['an unknown field', { extra: true }, 'Unrecognized'],
    ['a name as tester (control characters)', { testedBy: 'x‮' }, 'testedBy'],
  ])('rejects %s', (_label, overrides, expected) => {
    expect(() => evidence(overrides as never)).toThrow(expected);
  });

  it('loads many records and reports the invalid ones without using them', () => {
    const loaded = loadRouteEvidence([{ ...evidence() }, { schema: 'other' }]);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.rejected).toEqual([{ index: 1, reason: expect.stringContaining('Invalid route evidence record') }]);
  });

  it('picks the newest passing record for the exact route and pair', () => {
    const older = evidence({ testedAt: '2026-10-01T09:00:00Z' });
    const newer = evidence({ testedAt: '2026-10-02T09:00:00+02:00' });
    const route = { routeId: 'SEP-UNI-SWAP-BUY', chainId: 11_155_111, providerId: 'uniswap-web', kind: 'execution' };
    expect(passingEvidenceFor([older, newer], route, { token: T.toLowerCase(), quote: Q })?.testedAt).toBe(newer.testedAt);
    expect(passingEvidenceFor([older], { ...route, kind: 'discovery' }, { token: T, quote: Q })).toBeNull();
    // A pool-addressed link also needs the tested pool to be the linked one (compared in any letter case).
    expect(passingEvidenceFor([older], route, { token: T, quote: Q, poolId: older.poolId.toUpperCase().replace('0X', '0x') })).toBe(older);
    expect(passingEvidenceFor([older], route, { token: T, quote: Q, poolId: `0x${'ee'.repeat(32)}` })).toBeNull();
  });
});
