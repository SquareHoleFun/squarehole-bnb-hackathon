import { CastCharacter } from '@squarehole/design';
import { useId } from 'react';
import { useSearchParams } from 'react-router';
import { ConnectPrompt, parseSelectedPair, useAccountScenario } from '../features/accounts';
import { SourceChip, useDataSource } from '../features/data-source';
import { ClaimsView } from '../features/rewards/ClaimsView';
import { DemoControls } from '../features/rewards/DemoControls';
import { TrackedClaimsSection } from '../features/rewards/TrackedClaims';
import { useClaimAccount } from '../features/rewards/useClaimAccount';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * `/rewards`, labelled Claims (SH-014, SH-015; F23 safe wording): historical claims across pairs for the connected account. Disconnected, it explains what
 * it needs and offers an explicit button (UI-09). A claim that was already signed keeps being tracked after a
 * disconnect or a switch to another demo account (its own section), so a sent transaction never silently disappears
 * (06-ARCHITECTURE). Demo controls choose the mock data and next outcome.
 */
export function RewardsPage() {
  usePageTitle('Claims');
  const [params] = useSearchParams();
  const [scenario, setScenario] = useAccountScenario();
  const selected = parseSelectedPair(params.get('pair'));
  const promptId = useId();
  const { account: connected, tracked } = useClaimAccount();
  const source = useDataSource();

  return (
    <section className="sh-page sh-rewards-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <div className="sh-page__title-row">
          <PageHeading>Claims</PageHeading>
          <SourceChip />
        </div>
        <p className="sh-page__lede">
          Fee shares credited to your address as a holder, across pairs, including amounts credited before you sold. Each
          pair pays claims in the asset it chose at launch.
        </p>
      </div>

      {DEMO_BUILD && source.isDemo ? <DemoControls scenario={scenario} onScenarioChange={setScenario} /> : null}

      {connected === null && tracked.length === 0 ? (
        <ConnectPrompt headingId={promptId} title="Connect a wallet to see your claims" cast="sorter">
          <p>
            Fee shares are credited to the account that held each pair, so this page needs to know which account is yours.
            Browsing pairs never needs a wallet.
          </p>
        </ConnectPrompt>
      ) : null}
      {connected === null && tracked.length > 0 ? (
        <ConnectPrompt headingId={promptId} title="Wallet disconnected" cast="sorter">
          <p>
            A claim you already sent is still being tracked below; its result will appear there. Connect again to see all
            your claims or to claim anything else.
          </p>
        </ConnectPrompt>
      ) : null}
      {connected !== null ? <ClaimsView key={connected.toLowerCase()} account={connected} scenario={scenario} selected={selected} /> : null}
      {tracked.length > 0 ? <TrackedClaimsSection entries={tracked} scenario={scenario} reason={connected === null ? 'disconnected' : 'switched'} /> : null}

      <ClaimsExplainer />
    </section>
  );
}

function ClaimsExplainer() {
  return (
    <details className="sh-panel sh-explainer">
      <summary>How claims work</summary>
      <div className="sh-explainer__body">
        <CastCharacter id="coin" size={72} caption={false} className="sh-explainer__cast" />
        <ul className="sh-facts">
          <li>Credited in total = claimable now + already claimed. Only the claimable part can be claimed.</li>
          <li>
            Pending harvest is your share of fees that were observed but not yet recognised by the fee-credit ledger. It
            is not claimable and is not credited to you until it is recognised.
          </li>
          <li>Amounts stay with the account they were credited to. Selling later does not remove them, and a buyer does not get them.</li>
          <li>
            A pair that pays in its own token credits the paired asset and converts it when you claim, with a read-only
            minimum and deadline. If the conversion fails, the claim transaction reverts and your claim stays intact.
          </li>
          <li>A claim is done only once its block is finalized. A transaction hash, “pending” or “included” is not done yet.</li>
          <li>There is no amount to choose: a claim settles everything claimable on that pair. Square Hole has no trading.</li>
        </ul>
      </div>
    </details>
  );
}
