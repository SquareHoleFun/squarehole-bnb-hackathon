import { CastCharacter } from '@squarehole/design';
import { FIT_MARKETS } from 'virtual:squarehole-deployments';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCoreSource } from '../features/core/useCore';
import { useDataSource } from '../features/data-source';
import { isDemoScenario, type DemoScenario } from '../features/fit-pair/demo-chain';
import { FitPairView } from '../features/fit-pair/FitPairView';
import { resolveFitTarget, type FitBuild } from '../features/fit-pair/fit-target';
import { BackIcon } from '../features/pair/pair-icons';
import { LaunchRedirect } from './LaunchRedirect';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

function BackToFeed() {
  return (
    <p className="sh-pair-back">
      <Link to="/" className="sh-pair-back__link">
        <BackIcon />
        Feed
      </Link>
    </p>
  );
}

export interface FitPairPageProps {
  /** Test seam: what the build embeds (production: `virtual:squarehole-deployments`). */
  readonly build?: FitBuild;
}

/**
 * `/fit-pair` (S10a § 6: it redirects to box 0): where the data source has core v1 and no v2 market record, FIT is box
 * 0, opened by its row like `/misfits` and `/fit` (the page would otherwise say "No FIT market in this build", which is
 * false there). The v2 pair page below stays only for a source whose build carries a v2 market record (the Demo, the
 * Sepolia rehearsal, the first handoff's local chain) until step 11 retires it.
 */
export function FitPairPage(props: FitPairPageProps) {
  const source = useDataSource();
  const core = useCoreSource();
  const v2 = useMemo(() => resolveFitTarget(source.id, props.build ?? { fitMarkets: FIT_MARKETS, localRpcUrl: source.localRpcUrl }).status === 'ready', [source.id, source.localRpcUrl, props.build]);
  return core.status === 'ready' && !v2 ? <LaunchRedirect /> : <FitPairV2Page {...props} />;
}

/**
 * The v2 FIT / Misfits pair page (T19; BOX-SYSTEM § 2.5, realtime-chain-data § 10, F37, F38). Since the launch set
 * (SH-BOX-UI-launch) `/misfits` and `/fit` open the FIT market's box instead; this page keeps its file and its tests.
 * Read-only: links out, never a trade form, never a wallet request on navigation (C09, UI-05). `?scenario=` picks a
 * Demo scenario and is honoured only for the Demo data.
 */
function FitPairV2Page({ build }: FitPairPageProps) {
  const source = useDataSource();
  const [params] = useSearchParams();
  // One target object per source: the live controller is keyed on it.
  const resolution = useMemo(() => resolveFitTarget(source.id, build ?? { fitMarkets: FIT_MARKETS, localRpcUrl: source.localRpcUrl }), [source.id, source.localRpcUrl, build]);
  const requested = params.get('scenario');
  const scenario: DemoScenario = DEMO_BUILD && source.isDemo && isDemoScenario(requested) ? requested : 'curve';
  // The names the market's contracts carry: FIT · The Misfits, or a rehearsal's neutral set (RHT2 · Rehearsal Collection).
  usePageTitle(resolution.status === 'ready' ? `${resolution.target.names.tokenSymbol} · ${resolution.target.names.collectionName}` : 'FIT · not available');

  if (resolution.status !== 'ready') {
    return (
      <section className="sh-page sh-fit-page" aria-labelledby={PAGE_TITLE_ID}>
        <BackToFeed />
        <div className="sh-page__header">
          <PageHeading>FIT · The Misfits</PageHeading>
        </div>
        <div className="sh-panel sh-pair-missing" data-reason={resolution.status}>
          <CastCharacter id="sorter" size={84} caption={false} />
          <div className="sh-pair-missing__body">
            <p>{resolution.reason}</p>
            <p>
              Nothing on {source.dataLabel} is shown as FIT in its place.
            </p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="sh-page sh-fit-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-pair-top">
        <BackToFeed />
        {/* The network and the Demo badge sit beside the contract address; only a chosen Demo scenario is named here. */}
        {scenario === 'curve' ? null : (
          <p className="sh-feed__asof">
            <span className="sh-feed__scenario">Scenario: {scenario.replace('_', ' ')}</span>
          </p>
        )}
      </div>
      <FitPairView key={`${source.id}:${scenario}`} target={resolution.target} scenario={scenario} />
    </section>
  );
}

export default FitPairPage;
