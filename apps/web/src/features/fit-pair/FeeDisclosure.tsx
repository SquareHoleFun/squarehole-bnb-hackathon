import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { Link } from 'react-router';
import { TEST_NETWORK_LINK } from '../legal';
import { box0FeeWhere, BOX0_TAX_WHERE } from './box0-fees';
import { formatBlock, formatTaxPips } from './fit-format';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { LiveData } from './live-model';
import { LAUNCH_NAMES, type FitMarketNames } from './market-names';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const FIRST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS[0] ?? 0);
const LAST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0);

/**
 * What the card's one line adds after "1% pool fee": the launch tax while it applies or is about to (F33), so the tax is
 * never missing from the fee line before the open; null otherwise.
 */
export function feeLine(data: LiveData | null): string | null {
  const status = data?.window.status;
  if (data && (status === 'before_open' || status === 'router_window')) return `+ launch tax on buys until block ${formatBlock(data.window.closeBlock - 1n)}`;
  return null;
}

/**
 * Fees (C3: 1% pool fee; F33: the launch tax). One line ("1% pool fee", plus the launch tax while it applies); how the
 * pool fee and the launch tax work, and where the fee goes, is behind the (i). Mechanics only, never a return (F23 safe
 * wording). The page's own sentences use the market's names (a rehearsal's neutral set).
 *
 * F49 D3 (2026-10-01): the pool is closed to outside liquidity for good, so the F40 L3 notice ("After graduation: a
 * reduced fee share", Terms 5.7 (e) quoted word for word) is gone from the page. Until the pool is rebuilt, a deployed
 * pool whose hook still reports `liquidityOpensAt()` (today's contracts, the Sepolia rehearsal) keeps one factual line
 * with the Terms link, so the page and the accepted Terms never disagree about a deployment; the Demo shows the D3
 * design and says nothing. The Terms keep 5.7 (e) and risk (t) until counsel revises them with the rebuild (a blocker
 * before mainnet: DECISION-LOG F49, docs/evidence/SH-BOX-UI-launch.md).
 *
 * F77 (the Misfits like all the others): by the same rule the Demo shows box 0's F77 split (11/15 burn, 2/15 its own
 * pool, 2/15 platform; sellers' 13/15 burned, 2/15 its pool; the launch tax into its pool after
 * graduation, `box0-fees.ts`), and a deployed pool keeps describing its own v2 code (2/15 and the tax to the treasury,
 * 13/15 buy-and-burn). The Terms (5.6, 5.8, 5.10, 5.13, 11.2) still describe v2 and go to counsel (SH-F77 evidence).
 */
export function FeeDisclosure({ data, names = LAUNCH_NAMES, deployment = DEMO_BUILD ? 'demo' : 'chain' }: { data: LiveData | null; names?: FitMarketNames; deployment?: 'demo' | 'chain' }) {
  const tip = useInfoTip();
  const t = names.tokenSymbol;
  const extra = feeLine(data);
  const opens = deployment === 'chain' ? (data?.state.liquidityOpensAtBlock ?? null) : null;
  const demo = DEMO_BUILD && deployment === 'demo';
  return (
    <section className="sh-detail-card sh-fit-fees" aria-labelledby="fit-fees-title">
      <div className="sh-detail-card__head">
        <h2 id="fit-fees-title" className="sh-detail-card__title">
          Fees
        </h2>
        <InfoButton tip={tip} label="About the fees" />
      </div>
      <InfoPanel tip={tip}>
        <dl className="sh-fit-fees__list">
          <div>
            <dt>Pool fee</dt>
            <dd>{`1% of every trade on every route, from the first block: in ETH on a buy, in ${t} on a sell.`}</dd>
          </div>
          <div>
            <dt>Launch tax</dt>
            <dd>
              Only on buys in the 32-block launch window, through the launch router: {FIRST_TAX} in its first block, falling to {LAST_TAX} in its last (rounded up),{' '}
              {demo ? `${BOX0_TAX_WHERE}.` : 'to the treasury.'}
            </dd>
          </div>
          <div>
            <dt>Where the pool fee goes</dt>
            <dd>
              {demo
                ? box0FeeWhere(t, names.item)
                : `Of the ETH part, 2/15 (about 13%) goes to the treasury and 13/15 buys ${t} and burns it; all of the ${t} part is burned today, and after graduation it is planned to go to the per-${names.item} stream${TEST_NETWORK_LINK ? '' : ' (Terms 5.10)'}, which is not built yet.`}
            </dd>
          </div>
        </dl>
      </InfoPanel>
      <p className="sh-fit-fees__line">
        <strong>1% pool fee</strong>
        {extra ? ` ${extra}` : null}
      </p>
      {opens !== null ? (
        <p className="sh-fit-fees__outside" data-disclosure="">
          {`This deployed pool accepts outside liquidity ${opens > (data?.head.number ?? 0n) ? 'from' : 'since'} block ${formatBlock(opens)}, which lowers the pool’s fee share (`}
          {/* The Sepolia test site's one legal text, the test network notice, has no clause 5.7 (SH-TA-02). */}
          <Link to="/about/terms">{TEST_NETWORK_LINK ?? 'Terms 5.7 (e)'}</Link>
          ).
        </p>
      ) : null}
    </section>
  );
}
