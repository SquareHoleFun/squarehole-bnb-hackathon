/**
 * Test-only: the first handoff's pages, which no build routes any more (F134 R46B; routes.tsx). Their own tests (the
 * pair feed, a pair, Claims, Portfolio) mount them at their old paths through `AppRoutes`' `legacyPages` seam, so the
 * page modules that stay in the repository keep their tests. The app never imports this file.
 */
import type { LegacyPages } from '../routes';
import { FeedPage } from '../pages/FeedPage';
import { PairPage } from '../pages/PairPage';
import { PortfolioPage } from '../pages/PortfolioPage';
import { RewardsPage } from '../pages/RewardsPage';

export const LEGACY_PAGES: LegacyPages = Object.freeze({
  pairs: <FeedPage />,
  pair: <PairPage />,
  rewards: <RewardsPage />,
  portfolio: <PortfolioPage />,
});
