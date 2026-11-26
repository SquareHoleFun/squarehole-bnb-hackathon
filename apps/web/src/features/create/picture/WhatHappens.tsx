/**
 * SH-251: "What happens": a few made-up trades after graduation, each fee cut into fifteenths as the fee map does
 * (box-picture/fee-split.ts; what that model leaves out is said behind the (?), closed by default), so a creator sees
 * where the money of their own settings goes. It moves no money and calls nothing: its buttons only change this page's
 * numbers and play the picture's coins.
 */
import { useId } from 'react';
import { TEMPLATE_ICONS } from '../../brand/template-icons';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { roundedText, shortText } from '../../box-picture/amounts';
import type { SimTotals } from '../../box-picture/fee-split';
import { LOCK_ICON } from '../../box-picture/mini';
import type { LedgerRow } from '../../box-picture/picture';
import { PICTURE_WORDS, aboutOf, pictureWords } from '../../box-picture/picture-words';

export type Play = 'buy' | 'sell' | 'hundred';

export interface WhatHappensProps {
  readonly symbol: string;
  readonly decimals: number;
  /** One trade's amount (one whole price coin). */
  readonly trade: bigint;
  readonly totals: SimTotals;
  readonly rows: readonly LedgerRow[];
  readonly playing: boolean;
  /** The box coin's name for the sale-fees line behind the (?). */
  readonly boxCoin: string;
  readonly onPlay: (play: Play) => void;
  readonly onClear: () => void;
}

function RowIcon({ icon }: { icon: LedgerRow['icon'] }) {
  if (icon === 'mark') {
    return (
      <svg viewBox="0 0 24 24" className="sh-pic-row__icon" aria-hidden="true" focusable="false">
        <rect x="2" y="2" width="20" height="20" rx="6" className="sh-pic-mark" />
        <rect x="7.5" y="7.5" width="9" height="9" rx="1.8" className="sh-pic-mark__hole" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="sh-pic-row__icon sh-pic-icon" aria-hidden="true" focusable="false">
      {icon === 'lock' ? <path d={LOCK_ICON} /> : icon === 'pool' ? TEMPLATE_ICONS.liquidity.art : icon === null ? null : TEMPLATE_ICONS[icon].art}
    </svg>
  );
}

export function WhatHappens({ symbol, decimals, trade, totals, rows, playing, boxCoin, onPlay, onClear }: WhatHappensProps) {
  const titleId = useId();
  const tip = useInfoTip();
  const one = roundedText(trade, decimals, decimals);
  const ran = totals.trades > 0;
  const traded = ran ? pictureWords.traded(roundedText(totals.traded, decimals, 2), shortText(totals.fees, decimals), symbol) : PICTURE_WORDS.everyTrade;
  // Said once when a run ends: the result line, then each line of the list (all words already on the page).
  const said = ran && !playing ? [traded, ...rows.map((row) => `${row.label} ${row.amount ?? ''} ${symbol}`)].join('. ') : '';
  const about = aboutOf('happens');
  // While a run plays the buttons stay focusable and say they are off (the site's way); a press then does nothing.
  const press = (what: Play) => () => { if (!playing) onPlay(what); };
  return (
    <section className="sh-pic-card sh-pic-happens" aria-labelledby={titleId}>
      <div className="sh-pic-happens__head">
        <div>
          <h2 id={titleId} className="sh-pic-card__title">{PICTURE_WORDS.whatHappens}</h2>
          <p className="sh-pic-muted-text sh-pic-small-text">{PICTURE_WORDS.afterGraduation}</p>
        </div>
        <InfoButton tip={tip} label={about} />
        <button type="button" className="sh-button sh-pic-clear" aria-label={PICTURE_WORDS.clear} aria-disabled={ran ? undefined : 'true'} onClick={() => { if (ran) onClear(); }}><span aria-hidden="true">↺</span></button>
      </div>
      {/* The founder chose no line on the collection tip (desk round 125, 24 November 2026): only the site's sale-fees line. */}
      <InfoPanel tip={tip}>
        <p>{pictureWords.saleFees(boxCoin, symbol)}</p>
      </InfoPanel>
      <div className="sh-pic-play">
        <button type="button" className="sh-button" aria-disabled={playing ? 'true' : undefined} onClick={press('buy')}>
          {PICTURE_WORDS.someoneBuys}{' '}<small>{pictureWords.amount(one, symbol)}</small>
        </button>
        <button type="button" className="sh-button" aria-disabled={playing ? 'true' : undefined} onClick={press('sell')}>
          {PICTURE_WORDS.someoneSells}{' '}<small>{pictureWords.amount(one, symbol)}</small>
        </button>
        <button type="button" className="sh-button" aria-disabled={playing ? 'true' : undefined} onClick={press('hundred')}>
          {PICTURE_WORDS.hundred}{' '}<small>{pictureWords.amount(roundedText(trade * 100n, decimals, decimals), symbol)}</small>
        </button>
      </div>
      <p className="sh-pic-small-text" data-traded="">{traded}</p>
      <p className="sh-visually-hidden" role="status" data-said="">{said}</p>
      <ul className="sh-pic-ledger">
        {rows.map((row) => (
          <li key={row.key} data-row={row.key} data-warn={row.warn || undefined}>
            <RowIcon icon={row.icon} />
            <span className="sh-pic-ledger__label">{row.label}</span>
            <span className="sh-pic-ledger__amount">
              <b>{row.amount ?? '–'}</b>
              {row.share !== null ? <small>{`${symbol} · ${row.share}`}</small> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
