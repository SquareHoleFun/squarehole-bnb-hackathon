/**
 * The contract address (always shown, with Copy) and the links out of a core v1 box, built from its row
 * (`boxDestinations`, packages/links/src/box-links.ts; BC-099, BC-092): a link only for an allowlisted, evidenced
 * destination in a phase that trades; otherwise the provider and a state word, with the reasons behind (i). Never a
 * trade form, never a wallet request.
 */
import { boxDestinations, type BoxDestination, type BoxLinkPhase } from '@squarehole/links';
import type { BoxRow } from '@squarehole/chain';
import type { CorePhase } from '@squarehole/indexer/client';
import { STATE_WORD } from '../fit-pair/MarketLinks';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { CopyButton } from '../pair/CopyButton';
import { ExternalIcon } from '../pair/pair-icons';
import type { RowRef } from '../boxes/box-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export function destinationsFor(ref: RowRef, phase: CorePhase | null): readonly BoxDestination[] {
  const row: BoxRow = ref.row;
  return boxDestinations({
    network: ref.network,
    chainId: row.chainId,
    token: row.contracts.token as string,
    q: row.q,
    qClass: row.qAsset.qClass,
    templateId: row.templateId,
    poolId: row.poolId,
    phase: phase as BoxLinkPhase | null,
  });
}

/** The Market counter's link: Uniswap when it is one, else its state word. */
export function rowMarketLink(ref: RowRef, phase: CorePhase | null): { readonly link: { readonly href: string; readonly host: string } | null; readonly reason: string } {
  if ((DEMO_BUILD && ref.network === 'demo') || ref.network === 'local') return { link: null, reason: 'No links on a local chain' };
  const execution = destinationsFor(ref, phase).find((d) => d.kind === 'execution');
  if (execution?.href && execution.host) return { link: { href: execution.href, host: execution.host }, reason: '' };
  const word = execution?.state === 'closed' ? STATE_WORD.closed : execution?.state === 'unknown' ? STATE_WORD.unknown : STATE_WORD.unchecked;
  return { link: null, reason: word.charAt(0).toUpperCase() + word.slice(1) };
}

const KIND_LABEL: Readonly<Record<BoxDestination['kind'], string>> = { execution: 'Pool on Uniswap', discovery: 'Market information', explorer: 'Token on a block explorer' };

export function RowLinks({ rowRef, phase, ticker }: { rowRef: RowRef; phase: CorePhase | null; ticker: string }) {
  const tip = useInfoTip();
  const row = rowRef.row;
  const token = row.contracts.token as string;
  const destinations = destinationsFor(rowRef, phase);
  const demo = DEMO_BUILD && rowRef.network === 'demo';
  const any = destinations.some((d) => d.href);
  const reasons = [...new Map(destinations.map((d) => [`${d.reason}${d.warning ? ` ${d.warning}` : ''}`, d.provider])).entries()];
  return (
    <section className="sh-detail-card sh-box-token__ca" aria-labelledby="core-ca">
      <div className="sh-fit-label-row">
        <h3 id="core-ca" className="sh-detail-card__title">
          Contract address
        </h3>
      </div>
      <div className="sh-fit-ca__row">
        <code className="sh-fit-ca__address">{token}</code>
        <CopyButton value={token} label={`Copy the ${ticker} contract address`} />
      </div>
      <ul className="sh-fit-links" aria-label="Links out">
        {destinations.map((d) => (
          <li key={d.kind} className="sh-fit-link" data-kind={d.kind} data-route={d.state}>
            {d.href ? (
              <a href={d.href} target="_blank" rel="noopener noreferrer" className="sh-fit-link__body">
                <ExternalIcon />
                <span className="sh-fit-link__name">{d.provider}</span>
                <span className="sh-fit-link__state">{d.host}</span>
                <span className="sh-visually-hidden"> ({KIND_LABEL[d.kind]}, opens in a new tab)</span>
              </a>
            ) : (
              <span className="sh-fit-link__off">
                {d.provider}
                <span className="sh-visually-hidden">:</span> <span className="sh-fit-link__state">{STATE_WORD[d.state === 'available' ? 'unchecked' : d.state]}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="sh-muted">
        {demo || rowRef.network === 'local' ? 'No links on a local chain' : any ? null : 'Links once checked'} <InfoButton tip={tip} label="Why these links" />
      </p>
      <InfoPanel tip={tip}>
        {reasons.map(([why, who]) => (
          <p key={why}>
            <strong>{who}:</strong> {why}
          </p>
        ))}
      </InfoPanel>
    </section>
  );
}
