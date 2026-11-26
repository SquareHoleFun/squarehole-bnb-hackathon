import { lazy, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { DemoBoxesPage, ExamplesDoor, demoBoxes } from './features/examples';
import { NotFoundPage } from './pages/NotFoundPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { RisksPage } from './pages/RisksPage';
import { SettingsPage } from './pages/SettingsPage';
import { TermsPage } from './pages/TermsPage';
import { lazyRoute } from './shell/lazy-route';
import { Shell } from './shell/Shell';
import { TESTNET } from '@squarehole/chain/write/wallet';

const BOX0_ROUTES = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0);
const DRAW_ROUTES = TESTNET.switches.draws;

/*
 * The box pages and the old FIT pair page carry the curve math and the live transports (and through them the chain
 * package): their own chunks, loaded on the way there, so the pages that do not need them stay light.
 */
const BoxFeedPage = lazy(() => import('./pages/BoxFeedPage'));
const BoxPage = lazy(() => import('./pages/BoxPage'));
const WalletBoxPage = lazy(() => import('./pages/WalletBoxPage'));
const LaunchRedirect = lazy(() => import('./pages/LaunchRedirect'));
const FitPairPage = lazy(() => import('./pages/FitPairPage'));
const CreatePage = lazy(() => import('./features/create/CreatePage'));
const PlanGuidePage = lazy(() => import('./features/create/PlanGuidePage'));

/**
 * F156 (SH-ALPHA-TEST-COINS): the Sepolia alpha's test-coin page, the trade folders' second door (the box page's slot,
 * features/core/v2/TradeSlotMount.tsx, is the first). `import.meta.env.SH_SEPOLIA_TRADE` is a build literal
 * (build-target.ts `sepoliaTradeOf`): `false` in the mainnet build, so this branch, its dynamic import and the route
 * below fold away and nothing under features/trade-sepolia enters the bundle; `true` in the Sepolia build (and a dev
 * opt-in). The door opens the same module as the slot's, so the trade code stays one lazily loaded chunk.
 */
const TestCoinPage = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('./features/trade-sepolia/TradeSlot').then((module) => ({ default: module.TestCoinPage }))) : null;

/**
 * Route table (F46 launch set; BOX-INTERFACE § 9): `/` is the feed of boxes, `/box/:chain/:address` the one box
 * template (the earlier `/box/<chainId>-<token>` redirects to it), `/wallet/:address` a wallet
 * box (view only), `/my-box` the connected account's. `/misfits` and `/fit` open the FIT market's box, and the FIT pair
 * page is `/fit-pair`. Launch is `/create/:step` (F69 C1, F70: anyone launches a box, a plain token or a collection; the
 * earlier `/launch` pair wizard and its session records redirect there, and v1's step slugs to the steps that now hold
 * them). The first handoff's pages are off in every build (below).
 */
/**
 * Where Launch starts, in every build: the format 2 flow, whose price coins are the live listings (the production site
 * since SH-V2-FE6; the development build too since the founder, 2026-10-11, met v1's ETH-only flow behind Launch on the
 * local v2 stack). v1's flow has no entry point any more: box 0 is deployed by script, and on a chain v1 can only
 * download a v1 BoxSpec. Its step URLs stay in the development build for its own tests (CreatePage.tsx).
 */
const CREATE_START = '/create/v2-picture'; // SH-254: the visual way is the default (the founder, 24 November 2026)

/**
 * The first handoff's pages: the pair feed (`/pairs`, and `/collections`, its NFT filter), a pair (`/pair/…`), Claims
 * (`/rewards`) and Portfolio (`/portfolio`). Off in every build (F134 R46B, founder 2026-10-11; the production site since
 * SH-V2-FE6): their links open the boxes and My Box instead, and no build routes their pages or shows the old fixture
 * (the development build still loads that fixture behind its app-wide providers, unseen). The page modules stay in the
 * repository, unrouted; their own tests mount them through `legacyPages`.
 */
export interface LegacyPages {
  readonly pairs: ReactElement;
  readonly pair: ReactElement;
  readonly rewards: ReactElement;
  readonly portfolio: ReactElement;
}

export interface AppRoutesProps {
  /** Test seam (src/test-support/legacy-pages.tsx): the old pages at their old paths. The app passes none. */
  readonly legacyPages?: LegacyPages;
}

export function AppRoutes({ legacyPages }: AppRoutesProps = {}) {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={lazyRoute(BoxFeedPage, 'the boxes', {})} />
        <Route path="box/:chain/:address" element={lazyRoute(BoxPage, 'the box', {})} />
        <Route path="box/:id" element={lazyRoute(BoxPage, 'the box', {})} />
        <Route path="wallet/:address" element={lazyRoute(WalletBoxPage, 'the wallet', {})} />
        <Route path="my-box" element={lazyRoute(WalletBoxPage, 'your box', { mine: true })} />
        {/* SH-258: box 0's pages exist where the test network has box 0 (not on BNB Chain testnet). */}
        {/* SH-258 round 3: a BNB build has no box 0 routes at all (they fold away; such a path is not found). */}
        {import.meta.env?.SH_BNB === true ? null : <Route path="misfits" element={BOX0_ROUTES ? lazyRoute(LaunchRedirect, 'the Misfits', {}) : <Navigate replace to="/" />} />}
        {import.meta.env?.SH_BNB === true ? null : <Route path="fit" element={BOX0_ROUTES ? lazyRoute(LaunchRedirect, 'the Misfits', {}) : <Navigate replace to="/" />} />}
        <Route path="pairs" element={legacyPages?.pairs ?? <Navigate replace to="/" />} />
        <Route path="collections" element={<Navigate replace to="/" />} />
        {import.meta.env?.SH_BNB === true ? null : <Route path="fit-pair" element={BOX0_ROUTES ? lazyRoute(FitPairPage, 'the FIT pair page', {}) : <Navigate replace to="/" />} />}
        <Route path="create" element={<Navigate replace to={CREATE_START} />} />
        {/* SH-AI-PLAN: the plan guide, linked from the Contents step (a static segment: it wins over :step). */}
        {/* SH-258: the plan guide plans a hidden collection: only where the test network offers hidden draws. */}
        <Route path="create/plan" element={DRAW_ROUTES ? lazyRoute(PlanGuidePage, 'the plan guide', {}) : <Navigate replace to={CREATE_START} />} />
        <Route path="create/:step" element={lazyRoute(CreatePage, 'the launch page', {})} />
        {/* SH-252: the examples (the explainer's own page, features/examples), linked from Create. */}
        {/* SH-324: on both test networks (a BNB build carries the page's BNB version, build/testnet-output.ts). */}
        <Route path="examples" element={<ExamplesDoor />} />
        {/* SH-261, SH-324: the demo boxes that exist on the build's chain (chain 97), at an address no file of the page has. */}
        <Route path="examples/boxes" element={demoBoxes().length > 0 ? <DemoBoxesPage /> : <Navigate replace to={CREATE_START} />} />
        <Route path="launch" element={<Navigate replace to={CREATE_START} />} />
        <Route path="launch/*" element={<Navigate replace to={CREATE_START} />} />
        <Route path="rewards" element={legacyPages?.rewards ?? <Navigate replace to="/my-box" />} />
        <Route path="portfolio" element={legacyPages?.portfolio ?? <Navigate replace to="/my-box" />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="about/risks" element={<RisksPage />} />
        <Route path="about/terms" element={<TermsPage />} />
        <Route path="about/privacy" element={<PrivacyPage />} />
        {TestCoinPage ? <Route path="test-coins" element={lazyRoute(TestCoinPage, 'the test coins', {})} /> : null}
        <Route path="pair/:chainId/:address" element={legacyPages?.pair ?? <Navigate replace to="/" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
