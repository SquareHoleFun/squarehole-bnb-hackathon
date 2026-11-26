/**
 * BC-099 / BC-092: links out of a core v1 box built from its row alone. Uniswap (input Q, output T) is a link only in
 * bonding and graduated, and only with route evidence for the box's template and Q class (never per pool, so a new box
 * of a tested template needs no record); shut in upcoming, window, graduating (closed) and failed. DEX Screener is
 * unavailable on Sepolia; the explorer is the exact token page on Sepolia; a local twin with Sepolia's chain id and the
 * Demo build no link at all. Every href passes the allowlist and carries no forbidden parameter.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_PARAMS } from './allowlist';
import { boxContractHref, boxDestinations, type BoxLinkInput, type BoxLinkPhase } from './box-links';
import { parseRouteEvidenceV2, ROUTE_EVIDENCE_V2_SCHEMA, type RouteEvidenceV2 } from './route-evidence-v2';

const TEMPLATE = `0x${'a1'.repeat(32)}`;
const T = '0x1111111111111111111111111111111111111111';
const POOL = `0x${'2b'.repeat(32)}`;
const base: BoxLinkInput = { network: 'sepolia', chainId: 11_155_111, token: T, q: '0x0000000000000000000000000000000000000000', qClass: 'NATIVE_ETH', templateId: TEMPLATE, poolId: POOL, phase: 'bonding' };

function evidence(over: Partial<RouteEvidenceV2> = {}): RouteEvidenceV2 {
  return parseRouteEvidenceV2({
    schema: ROUTE_EVIDENCE_V2_SCHEMA,
    routeId: 'BOX-SEP-UNI',
    chainId: 11_155_111,
    providerId: 'uniswap-web',
    kind: 'execution',
    templateId: TEMPLATE,
    qClass: 'NATIVE_ETH',
    // Another box of the same template: the record covers every box of it.
    example: { token: '0x9999999999999999999999999999999999999999', quote: '0x0000000000000000000000000000000000000000', poolId: `0x${'77'.repeat(32)}` },
    result: 'pass',
    testedAt: '2026-10-10T10:00:00Z',
    testedBy: 'founder',
    frontend: { build: 'app.uniswap.org 2026-10', testnetMode: true, universalRouterVersion: '2.0', routerAddress: null },
    transactions: [`0x${'ab'.repeat(32)}`],
    evidenceRecord: 'docs/evidence/SH-S0-routes.md',
    ...over,
  });
}

const execution = (input: BoxLinkInput, records: readonly RouteEvidenceV2[] = []) => boxDestinations(input, records)[0];

describe('BC-099: links from the row', () => {
  it('BC-099: Uniswap: input ETH for native Q, output T, from the row; a link with evidence for the template and Q class', () => {
    const d = execution(base, [evidence()]);
    expect(d?.state).toBe('available');
    expect(d?.href).toBe(`https://app.uniswap.org/swap?chain=sepolia&inputCurrency=ETH&outputCurrency=${T}`);
    const url = new URL(d?.href ?? '');
    for (const name of url.searchParams.keys()) expect(FORBIDDEN_PARAMS.has(name.toLowerCase())).toBe(false);
  });

  it('BC-099: a Q other than native ETH goes in by its address', () => {
    const q = '0x8000000000000000000000000000000000000006';
    const d = execution({ ...base, q, qClass: 'ERC20' }, [evidence({ qClass: 'ERC20' })]);
    expect(d?.href).toContain(`inputCurrency=${q}`);
  });

  it('BC-099: evidence per template and Q class, never per pool: another Q class or template is not checked', () => {
    expect(execution({ ...base, qClass: 'ERC20', q: '0x8000000000000000000000000000000000000006' }, [evidence()])?.state).toBe('unchecked');
    expect(execution({ ...base, templateId: `0x${'b2'.repeat(32)}` }, [evidence()])?.state).toBe('unchecked');
    expect(execution(base, [evidence({ result: 'fail' })])?.state).toBe('unchecked');
    expect(execution(base)?.state).toBe('unchecked');
    expect(execution(base)?.reason).toMatch(/^Not verified: no recorded external/);
  });

  const phases: (BoxLinkPhase | null)[] = ['upcoming', 'window', 'bonding', 'graduating', 'graduated', 'failed', null];
  for (const phase of phases) {
    const open = phase === 'bonding' || phase === 'graduated';
    it(`BC-099 ${String(phase)}: Uniswap ${open ? 'may be a link' : 'is shut'}`, () => {
      const d = execution({ ...base, phase }, [evidence()]);
      expect(d?.state).toBe(open ? 'available' : phase === null ? 'unknown' : 'closed');
      if (!open) expect(d?.href).toBeNull();
    });
  }

  it('BC-099: DEX Screener is unavailable on Sepolia; the explorer is the exact token page', () => {
    const [, discovery, explorer] = boxDestinations(base);
    expect(discovery?.state).toBe('unavailable');
    expect(explorer?.href).toBe(`https://sepolia.etherscan.io/token/${T}`);
    expect(boxContractHref('sepolia', T)).toBe(`https://sepolia.etherscan.io/address/${T}`);
  });

  it('BC-099: links follow the source: a local twin with Sepolia’s chain id and the Demo build none', () => {
    for (const network of ['local', 'demo'] as const) {
      const all = boxDestinations({ ...base, network }, [evidence()]);
      expect(all.every((d) => d.href === null), network).toBe(true);
      expect(boxContractHref(network, T)).toBeNull();
    }
  });

  it('BC-099: a malformed identity builds nothing', () => {
    expect(boxDestinations({ ...base, token: 'nope' }).every((d) => d.href === null && d.state === 'unavailable')).toBe(true);
  });
});
