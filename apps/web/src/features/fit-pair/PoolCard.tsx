import { demoPoolFigures, POOL_STEPS_LINE } from './box0-fees';
import { formatEth, formatTokenShort } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { LiveData } from './live-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * The Pool card (F77; BC-142): box 0's pool grows from its own fees and launch tax by pair and lock, like every box's,
 * so the page shows what was added and what waits, numbers first ("Added: x ETH + y FIT · Waiting: z ETH + w FIT"),
 * with one line behind the (i). On the Demo the figures come from the Demo chain and say Demo. A deployed pool today
 * runs v2 code (the Sepolia rehearsal), which has no such pool share: the card is not shown there until a core v1 box 0
 * is deployed and S10a reads the hook (`pairedLiquidity`, `depthBudget`) and the launch router's balance.
 */
export function PoolCard({ data, target }: { data: LiveData | null; target: FitMarketTarget }) {
  const tip = useInfoTip();
  if (!DEMO_BUILD || target.kind !== 'demo') return null;
  const t = target.names.tokenSymbol;
  const figures = demoPoolFigures(data);
  const line = figures
    ? `Added: ${formatEth(figures.addedEth)} + ${formatTokenShort(figures.addedToken, t)} · Waiting: ${formatEth(figures.waitingEth)} + ${formatTokenShort(figures.waitingToken, t)}`
    : 'Added: — · Waiting: —';
  return (
    <section className="sh-detail-card sh-fit-pool" aria-labelledby="fit-pool-title">
      <div className="sh-detail-card__head">
        <h2 id="fit-pool-title" className="sh-detail-card__title">
          Pool
        </h2>
        <InfoButton tip={tip} label="About the pool" />
      </div>
      <InfoPanel tip={tip}>
        <p>{POOL_STEPS_LINE}</p>
      </InfoPanel>
      <p className="sh-fit-fees__line">{line}</p>
    </section>
  );
}
