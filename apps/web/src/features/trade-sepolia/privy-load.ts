/**
 * F161 (4), SH-ALPHA-SITE: which Privy the alpha's pages get, chosen at build time. The join page's door
 * (features/alpha-sepolia/join/JoinPage.tsx) and the Claim card (ClaimCard.tsx) load this module lazily; it loads
 * Privy's SDK (privy-live.tsx) lazily in turn, so Privy's code never sits in a first paint. `SH_ALPHA_STANDIN` is a
 * build literal (build-target.ts `alphaStandinOf`): `true` only in a development build opted in for the browser suites,
 * `false` in every production build, where the stand-in's branch and its import fold away.
 */
import type { PrivyBridge } from '../alpha-sepolia/privy-bridge';

export const loadPrivyBridge = (appId: string): Promise<PrivyBridge> => (import.meta.env?.SH_ALPHA_STANDIN === true
  ? import('./test-support/privy-standin').then((module) => module.standinBridge())
  : import('./privy-live').then((module) => module.liveBridge(appId)));
