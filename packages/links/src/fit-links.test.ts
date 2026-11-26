import { describe, expect, it } from 'vitest';
import { vetExternalHref } from './allowlist';
import { LOCAL_CHAIN_LINK_REASON, SEPOLIA_DISCOVERY_REASON, UNISWAP_TESTNET_MODE_WARNING } from './chain-links';
import { FIT_DEMO_LINK_REASON, FIT_LINK_ROUTES_V1, NATIVE_ETH_ADDRESS, fitExplorerHref, fitMarketDestinations, type FitLinkTarget } from './fit-links';
import { renderableHref } from './registry';
import { ROUTE_EVIDENCE_SCHEMA, parseRouteEvidence, type RouteEvidenceRecord } from './route-evidence';

const FIT = '0x2D9fB39AA944E8ba72285D6777AaDC1cE3b2BE01';
const POOL = '0x6B31FC7CC51D9F7D16EC3F262FDDB6E441EF96B1DF63CC8D3C6BCF8FF1B1AF5E';
const TX = `0x${'cd'.repeat(32)}`;

const target = (chainId: number, overrides: Partial<FitLinkTarget> = {}): FitLinkTarget => ({ chainId, token: FIT, poolId: POOL, demo: false, ...overrides });

function evidence(overrides: Partial<RouteEvidenceRecord> = {}): RouteEvidenceRecord {
  return parseRouteEvidence({
    schema: ROUTE_EVIDENCE_SCHEMA,
    routeId: 'FIT-UNI-ETH',
    chainId: 1,
    providerId: 'uniswap-web',
    kind: 'execution',
    token: FIT,
    quote: NATIVE_ETH_ADDRESS,
    poolId: POOL,
    result: 'pass',
    testedAt: '2026-10-10T10:00:00Z',
    testedBy: 'founder',
    frontend: { build: 'web/5.170.0', testnetMode: null, universalRouterVersion: '2.1.2', routerAddress: null },
    transactions: [TX],
    evidenceRecord: 'docs/evidence/SH-V2-route-mainnet.md',
    ...overrides,
  });
}

describe('FIT pair page destinations (F37, F38 (1))', () => {
  it('builds no URL for the demo or the local chain (EXT-08)', () => {
    for (const destination of fitMarketDestinations(target(31_337, { demo: true }))) {
      expect(destination).toMatchObject({ href: null, state: 'unverified', reason: FIT_DEMO_LINK_REASON });
    }
    const local = fitMarketDestinations(target(31_337));
    expect(local.map((d) => [d.kind, d.state, d.href])).toEqual([
      ['execution', 'unverified', null],
      ['discovery', 'unverified', null],
      ['explorer', 'unavailable', null],
    ]);
    expect(local.every((d) => d.reason === LOCAL_CHAIN_LINK_REASON)).toBe(true);
  });

  it('links Etherscan for the exact FIT address and keeps Uniswap and DEX Screener unverified without evidence', () => {
    const [uniswap, dex, explorer] = fitMarketDestinations(target(1));
    expect(uniswap).toMatchObject({ kind: 'execution', provider: 'Uniswap web app', state: 'unverified', href: null, routeId: 'FIT-UNI-ETH' });
    expect(dex).toMatchObject({ kind: 'discovery', provider: 'DEX Screener', state: 'unverified', href: null });
    expect(explorer).toMatchObject({ kind: 'explorer', provider: 'Etherscan', state: 'available', href: `https://etherscan.io/token/${FIT}` });
    if (!explorer) throw new Error('no explorer');
    expect(renderableHref(explorer, { chainId: 1, token: { chainId: 1, address: FIT } } as never)).toEqual({ href: `https://etherscan.io/token/${FIT}`, host: 'etherscan.io' });
  });

  it('turns Uniswap into a native-ETH link only with a passing record for this chain, FIT and ETH (EXT-05, MKT-02)', () => {
    const [uniswap] = fitMarketDestinations(target(1), [evidence()]);
    expect(uniswap).toMatchObject({ state: 'available', href: `https://app.uniswap.org/swap?chain=mainnet&inputCurrency=ETH&outputCurrency=${FIT}`, validatedAt: '2026-10-10T10:00:00Z' });
    expect(vetExternalHref(uniswap?.href, 'execution').ok).toBe(true);
    // A failed test, another token, another quote or another chain enables nothing.
    for (const record of [
      evidence({ result: 'fail', transactions: [] }),
      evidence({ token: '0x0000000000000000000000000000000000000abc' }),
      evidence({ quote: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }),
      evidence({ chainId: 11_155_111, frontend: { build: 'x', testnetMode: true, universalRouterVersion: null, routerAddress: null } }),
    ]) {
      expect(fitMarketDestinations(target(1), [record])[0]).toMatchObject({ state: 'unverified', href: null });
    }
  });

  it('links DEX Screener by the lowercase v4 pool id once its route is evidenced', () => {
    const record = evidence({ routeId: 'FIT-DS-POOL', providerId: 'dexscreener', kind: 'discovery' });
    const [, dex] = fitMarketDestinations(target(1), [record]);
    expect(dex).toMatchObject({ state: 'available', href: `https://dexscreener.com/ethereum/${POOL.toLowerCase()}` });
    // The link names a pool, so the record must have tested that pool: a pass on a copy ETH/FIT pool enables nothing.
    const copyPool = evidence({ routeId: 'FIT-DS-POOL', providerId: 'dexscreener', kind: 'discovery', poolId: `0x${'ee'.repeat(32)}` });
    expect(fitMarketDestinations(target(1), [copyPool])[1]).toMatchObject({ state: 'unverified', href: null });
    // Uniswap routes by itself (no pool in the link): its record is matched on chain, FIT and ETH only.
    expect(fitMarketDestinations(target(1), [evidence({ poolId: `0x${'ee'.repeat(32)}` })])[0]).toMatchObject({ state: 'available' });
  });

  it('keeps the Testnet-mode warning with Sepolia’s Uniswap route and has no Sepolia DEX Screener page', () => {
    const record = evidence({ routeId: 'FIT-SEP-UNI-ETH', chainId: 11_155_111, frontend: { build: 'web', testnetMode: true, universalRouterVersion: '2.1.2', routerAddress: null } });
    const [uniswap, dex, explorer] = fitMarketDestinations(target(11_155_111), [record]);
    expect(uniswap).toMatchObject({ state: 'available', href: `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=ETH&outputCurrency=${FIT}`, warning: UNISWAP_TESTNET_MODE_WARNING });
    expect(dex).toMatchObject({ state: 'unavailable', href: null, reason: SEPOLIA_DISCOVERY_REASON });
    // Without a record: unverified, the reason once and the Testnet-mode caveat once (it is the warning, not in the reason).
    const [unverified] = fitMarketDestinations(target(11_155_111));
    expect(unverified).toMatchObject({ state: 'unverified', warning: UNISWAP_TESTNET_MODE_WARNING });
    expect(unverified?.reason).not.toContain(UNISWAP_TESTNET_MODE_WARNING);
    expect(explorer).toMatchObject({ state: 'available', href: `https://sepolia.etherscan.io/token/${FIT}` });
  });

  it('answers unavailable for other chains and malformed identities, and never throws', () => {
    expect(fitMarketDestinations(target(10)).every((d) => d.state === 'unavailable' && d.href === null)).toBe(true);
    for (const bad of [{ token: 'nope' }, { token: `${FIT}00` }, { poolId: '0x1234' }, { poolId: `${POOL}"` }]) {
      expect(fitMarketDestinations(target(1, bad)).every((d) => d.state === 'unavailable' && d.href === null)).toBe(true);
    }
  });

  it('uses only reviewed providers and URL shapes without forbidden parameters', () => {
    for (const route of FIT_LINK_ROUTES_V1) {
      if (route.pathTemplate === null) continue;
      const href = `https://example.invalid${route.pathTemplate.replace('{T}', FIT).replace('{POOL}', POOL.toLowerCase())}`;
      expect(href).not.toMatch(/connect=|value=|field=|slippage|recipient=/i);
      if (route.kind === 'execution') expect(route.pathTemplate).toContain('inputCurrency=ETH');
    }
  });
});

describe('fitExplorerHref', () => {
  it('builds address and transaction pages on Ethereum and Sepolia only', () => {
    expect(fitExplorerHref(1, { txHash: TX })).toBe(`https://etherscan.io/tx/${TX}`);
    expect(fitExplorerHref(11_155_111, { address: FIT })).toBe(`https://sepolia.etherscan.io/address/${FIT}`);
    expect(fitExplorerHref(31_337, { txHash: TX })).toBeNull();
    expect(fitExplorerHref(1, { txHash: '0x12' })).toBeNull();
    expect(fitExplorerHref(1, { address: FIT, txHash: TX })).toBeNull();
    expect(fitExplorerHref(1, {})).toBeNull();
  });
});
