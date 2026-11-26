import { CastCharacter } from '@squarehole/design';
import { useId } from 'react';
import { ConnectPrompt, useAccountScenario } from '../features/accounts';
import { SourceChip } from '../features/data-source';
import { PositionsView } from '../features/portfolio/PositionsView';
import { useWallet } from '../features/wallet';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

/**
 * `/portfolio` (SH-014): current economic balances, each shown once, with whole NFTs and the remaining fraction beneath
 * for collections, the NFT ids held, and links to pair detail and rewards. No trade control of any kind.
 */
export function PortfolioPage() {
  usePageTitle('Portfolio');
  const wallet = useWallet();
  const [scenario] = useAccountScenario();
  const promptId = useId();
  const account = wallet.status === 'connected' ? wallet.account : null;

  return (
    <section className="sh-page sh-portfolio" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <div className="sh-page__title-row">
          <PageHeading>Portfolio</PageHeading>
          <SourceChip />
        </div>
        <p className="sh-page__lede">
          Your balances per pair. Each balance is counted once; for NFT collections, the whole NFTs and the leftover
          fraction beneath it are the same units, not extra.
        </p>
      </div>

      {account === null ? (
        <ConnectPrompt headingId={promptId} title="Connect a wallet to see your portfolio" cast="sorter">
          <p>Balances belong to an account, so this page needs to know which one is yours. Browsing pairs never needs a wallet.</p>
        </ConnectPrompt>
      ) : (
        <PositionsView key={account.toLowerCase()} account={account} scenario={scenario} />
      )}

      <FractionsExplainer />
    </section>
  );
}

/** 01-PRODUCT: fractions are not ownership of a chosen NFT; a "before you trade externally" notice. */
function FractionsExplainer() {
  return (
    <section className="sh-panel sh-explainer sh-explainer--open" aria-labelledby="fractions-title">
      <div className="sh-explainer__body">
        <CastCharacter id="collector" size={72} caption={false} className="sh-explainer__cast" />
        <div className="sh-explainer__text">
          <h2 id="fractions-title" className="sh-section-title">
            Fractions are not a piece of a particular NFT
          </h2>
          <p>
            A collection’s units are fungible. An NFT exists for each whole unit you hold; the rest is a plain fraction.
            Holding 0.25 of a unit does not mean owning a quarter of any specific NFT, rare or not, and a fraction gives no
            claim on a chosen artwork. Rare traits never change fees or fee shares.
          </p>
          <h3 className="sh-explainer__subtitle">Before you trade externally</h3>
          <p>
            Square Hole has no trade form: trading happens on external venues. Sending or trading part of a balance can
            change which NFTs you hold. For example, going from 3.25 to 2.9 units leaves 2 whole NFTs, so one of your NFTs
            is removed, and it may not be the one you would choose. Controls to keep a specific NFT are not available in
            this app yet.
          </p>
        </div>
      </div>
    </section>
  );
}
