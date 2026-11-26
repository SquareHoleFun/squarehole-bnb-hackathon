/**
 * F134 R46B (founder desk round 46, 2026-10-11): the first handoff's pages are off in every build, the development build
 * included, the same way the production site has redirected them since SH-V2-FE6 (src/routes.tsx). The specs written
 * only for them stay in the repository unrun (playwright.config.ts `LEGACY_SPECS`); a test in a mixed spec that needs
 * one of them skips itself with `LEGACY_OFF`. e2e/no-demo-text.spec.ts pins the redirects and crawls their targets.
 */
export const LEGACY_OFF = 'F134 R46B: the first handoff’s pages (/pairs, /pair/…, /rewards, /portfolio) are off in every build';

/** Every old URL and where each build sends it now: the pair pages to the boxes, Claims and Portfolio to My Box. */
export const LEGACY_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/pairs', '/'],
  ['/pairs?type=nft_collection&q=orchard', '/'],
  ['/collections', '/'],
  ['/pair/31337/0x0000000000000000000000000000000000000066', '/'],
  ['/pair/31337/0x000000000000000000000000000000000000006a', '/'],
  ['/?q=orch&type=token', '/?q=orch'],
  ['/?sort=turnover', '/'],
  ['/rewards', '/my-box'],
  ['/rewards?pair=31337%3A0x000000000000000000000000000000000000006a', '/my-box'],
  ['/rewards?scenario=conversion_fails', '/my-box'],
  ['/portfolio', '/my-box'],
];
