import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { useId } from 'react';
import { BOX0_TAX_WHERE } from './box0-fees';
import { formatBlock, formatTaxPips, formatUtc } from './fit-format';
import { DisclosureIcon } from './FitParts';
import type { FitMarketTarget } from './fit-target';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { LiveData } from './live-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const CELLS_LABEL = 'Launch tax per block';

/**
 * The 32 cells with the router's tax per block (`LaunchTaxRouter.taxTable()`, rounded up to two decimals: a charge is
 * never understated); the next block's cell is outlined, passed cells are dashed with a check mark, at full contrast
 * (WCAG 1.4.3), and both say so in words.
 */
function TaxCells({ data, target, labelledBy }: { data: LiveData | null; target: FitMarketTarget; labelledBy: string }) {
  const next = data?.window.nextBlock ?? null;
  return (
    <ol className="sh-fit-window__cells" aria-labelledby={labelledBy}>
      {LAUNCH_TAX_TABLE_PIPS.map((pips, offset) => {
        const block = target.openBlock + BigInt(offset);
        const state = next === null ? 'unknown' : block < next ? 'past' : block === next ? 'next' : 'ahead';
        return (
          <li key={offset} className="sh-fit-window__cell" data-state={state} aria-current={state === 'next' ? 'step' : undefined}>
            <span className="sh-fit-window__offset">
              +{offset}
              {state === 'past' ? (
                <span className="sh-fit-window__mark" aria-hidden="true">
                  {' '}
                  ✓
                </span>
              ) : null}
            </span>
            <span className="sh-fit-window__tax">{formatTaxPips(pips)}</span>
            {state === 'past' ? <span className="sh-visually-hidden">, passed</span> : state === 'next' ? <span className="sh-visually-hidden">, next block</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The 32-block launch window (F33, VL-6): beside the curve, never on the band. One status line (blocks first; a time
 * only as a labelled estimate, 12 s a slot, missed slots push it later), then the cells under a visible "Launch tax per
 * block" label, so the tax is named before the open too. Once the window has closed (most of the page's life) the
 * cells fold into a closed disclosure with the same label. How the window works is behind the (i).
 */
export function LaunchWindow({ data, target }: { data: LiveData | null; target: FitMarketTarget }) {
  const tip = useInfoTip();
  const labelId = useId();
  const status = data?.window.status ?? 'unknown';
  const closed = status === 'open';
  return (
    <section className="sh-detail-card sh-fit-window" aria-labelledby="fit-window-title" data-status={status}>
      <div className="sh-detail-card__head">
        <h2 id="fit-window-title" className="sh-detail-card__title">
          Launch window
        </h2>
        <InfoButton tip={tip} label="About the launch window" />
      </div>
      <InfoPanel tip={tip}>
        <p>
          Blocks {formatBlock(target.openBlock)} – {formatBlock(target.closeBlock - 1n)}: buys go only through the launch router, which takes the tax in each cell{' '}
          {DEMO_BUILD && target.kind === 'demo' ? `(rounded up), ${BOX0_TAX_WHERE}.` : 'for the treasury (rounded up).'} Sells are never taxed. After that, only the 1% pool fee.
        </p>
        <p>Blocks come every 12 seconds; a missed slot pushes a time later, so any time shown is an estimate.</p>
      </InfoPanel>
      <p className="sh-fit-window__text">{windowText(data, target)}</p>
      {closed ? (
        <details className="sh-fit-details sh-fit-window__details">
          <summary>
            <span className="sh-fit-details__chevron" aria-hidden="true">
              <DisclosureIcon />
            </span>
            <span id={labelId}>{CELLS_LABEL}</span>
          </summary>
          <TaxCells data={data} target={target} labelledBy={labelId} />
        </details>
      ) : (
        <>
          <p id={labelId} className="sh-fit-window__caption">
            {CELLS_LABEL}
          </p>
          <TaxCells data={data} target={target} labelledBy={labelId} />
        </>
      )}
    </section>
  );
}

function eta(unix: bigint | null): string {
  return unix === null ? '' : ` · ~${formatUtc(unix, false)} (estimate)`;
}

/**
 * The card's one status line, beside the header's phase line (which carries the countdown and the next block's tax):
 * "Opens at block … · ~… (estimate)", "Ends after block … · ~… (estimate)", "Closed · 1% pool fee only".
 */
export function windowText(data: LiveData | null, target: FitMarketTarget): string {
  if (data === null) return `From block ${formatBlock(target.openBlock)} · unknown until the curve can be read`;
  const w = data.window;
  if (w.status === 'before_open') return `Opens at block ${formatBlock(w.openBlock)}${eta(w.etaOpenUnix)}`;
  if (w.status === 'router_window') return `Ends after block ${formatBlock(w.closeBlock - 1n)}${eta(w.etaCloseUnix)}`;
  return 'Closed · 1% pool fee only';
}
