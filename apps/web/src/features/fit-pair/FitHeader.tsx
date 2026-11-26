import { PAGE_TITLE_ID } from '../../pages/page-parts';
import { ContractAddress } from './ContractAddress';
import { formatCount } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { MarketIcon, phaseText } from './FitParts';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { LiveView } from './live-controller';
import { MarketLinks } from './MarketLinks';


/**
 * What the token is, for the (i) next to its name, in the names its contracts carry. A rehearsal also says what it
 * rehearses, that its set is a labelled test set with no art and that its tokens have no value.
 */
function About({ target, network }: { target: FitMarketTarget; network: string }) {
  const n = target.names;
  const size = formatCount(target.collectionSize);
  if (n.kind === 'launch') {
    return (
      <>
        <p>{`FIT is the fraction token of The Misfits: 1,000,000,000 FIT, issued once. The ${size} Misfits start in its vault.`}</p>
        <p>
          The pool pairs FIT with native ETH on {network}.
        </p>
      </>
    );
  }
  return (
    <>
      <p>{`${n.tokenName} (${n.tokenSymbol}) is the fraction token of the ${n.collectionName} (${n.collectionSymbol}): 1,000,000,000 ${n.tokenSymbol}, issued once. The ${size} ${n.items} start in its vault.`}</p>
      <p>A rehearsal of the launch: the same contracts under neutral names, a labelled test set, no art. Test tokens have no value.</p>
      <p>{`The pool pairs ${n.tokenSymbol} with native ETH on ${network}.`}</p>
    </>
  );
}

/**
 * The pair's identity (F37 (2): "real trenchers work with CAs"): name, phase chip and the phase's one line (the launch
 * tax whenever it applies, so it is on the first screen at every width), the token's contract address, large, with a
 * copy button, and the links out. A Demo badge sits beside the address, because that address is the thing someone
 * could copy; on a chain source the same place names the network, and a rehearsal's record (neutral names) adds a
 * "Rehearsal · test set" badge. The names are the ones the contracts carry (FIT, or a rehearsal's neutral set), so a
 * wallet shows the same. What the token is lives behind the (i) next to the name.
 */
export function FitHeader({ target, view }: { target: FitMarketTarget; view: LiveView }) {
  const tip = useInfoTip();
  const data = view.data;
  const names = target.names;
  const phase = data ? phaseText(data, target) : null;
  // "Local chain 31337" already names the id; only a bare name gets it added.
  const network = target.networkLabel.includes(String(target.chainId)) ? target.networkLabel : `${target.networkLabel} (chain id ${target.chainId})`;
  return (
    <header className="sh-detail-card sh-fit-head">
      <div className="sh-fit-head__id">
        <MarketIcon names={names} size={56} className="sh-fit-head__icon" />
        <div className="sh-fit-head__name">
          <div className="sh-fit-head__title-row">
            <h1 id={PAGE_TITLE_ID} className="sh-page__title sh-fit-head__title" tabIndex={-1}>
              {`${names.tokenSymbol} `}
              <span className="sh-fit-head__pair">{names.collectionName}</span>
            </h1>
            <InfoButton tip={tip} label={`About ${names.tokenSymbol}`} />
            {phase ? (
              <span className="sh-status-chip sh-fit-head__phase" data-phase={data?.state.phase}>
                {phase.label}
              </span>
            ) : null}
          </div>
          {phase?.short ? (
            <p className="sh-fit-phase" data-phase={data?.state.phase} data-window={data?.window.status}>
              {phase.short}
            </p>
          ) : null}
          <InfoPanel tip={tip}>
            <About target={target} network={network} />
          </InfoPanel>
        </div>
      </div>
      <ContractAddress target={target} />
      <MarketLinks data={data} target={target} freshness={view.freshness} />
    </header>
  );
}
