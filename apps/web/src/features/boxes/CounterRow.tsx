/**
 * The counters row (desktop) and the phone's sticky bar. A closed counter shows a shutter and its reason. Vault actions
 * that are not in this app yet read the same way, as text behind a lock ("Take one out · Put it back · in the app
 * soon"), never as buttons that look clickable. The only working action, the only solid button, is a verified market
 * link, which opens in a new tab (`rel="noopener noreferrer"`).
 *
 * On a phone the row is folded into the bar: the one working action when there is one, otherwise a 44 px counters button
 * (a failed box adds where its refund goes); the counters icon opens all three counters with their reasons in a bottom
 * sheet.
 */
import { useState, type ReactNode } from 'react';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import type { BoxState } from './box-model';
import { ClaimGlyph, CountersGlyph, ExternalGlyph, LockGlyph, StoreGlyph, SwapGlyph } from './BoxParts';
import { BoxSheet } from './BoxSheet';
import { notBuilt, phoneBarNote, primaryAction, type Counter, type CounterAction, type CounterId } from './counters';

const GLYPHS: Readonly<Record<CounterId, () => ReactNode>> = { conversion: SwapGlyph, claims: ClaimGlyph, market: StoreGlyph };

const HELP: Readonly<Record<CounterId, string>> = {
  conversion: 'Take an item out of the vault for the token, or put one back for it. Draw 1% · named pick 25% · put back 5%; every fee is burned. Not in this app yet.',
  claims: 'What a box credits to owners, claimable from your wallet. Not built yet.',
  market: 'Opens the verified pool in a new tab. This app has no trade form and never asks your wallet.',
};

function LinkOut({ action }: { action: CounterAction }) {
  return (
    <a className="sh-button sh-button--primary sh-box-action" href={action.href ?? undefined} target="_blank" rel="noopener noreferrer">
      {action.label}
      <ExternalGlyph />
      <span className="sh-visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function CounterCard({ counter, idPrefix }: { counter: Counter; idPrefix: string }) {
  const tip = useInfoTip();
  const Glyph = GLYPHS[counter.id];
  const soon = notBuilt(counter);
  const links = counter.actions.filter((action) => action.enabled && action.href);
  const titleId = `${idPrefix}-${counter.id}`;
  return (
    <section className="sh-box-counter" data-open={counter.open && !soon} aria-labelledby={titleId}>
      <div className="sh-box-counter__head">
        <span className="sh-box-counter__icon">
          <Glyph />
        </span>
        <h2 id={titleId} className="sh-box-counter__title">
          {counter.label}
        </h2>
        <InfoButton tip={tip} label={`About ${counter.label}`} />
      </div>
      <InfoPanel tip={tip}>
        <p>{HELP[counter.id]}</p>
      </InfoPanel>
      {links.length > 0 ? (
        <div className="sh-box-counter__actions">
          {links.map((action) => (
            <LinkOut key={action.id} action={action} />
          ))}
        </div>
      ) : null}
      {soon ? (
        <p className="sh-box-counter__reason" data-soon="">
          <LockGlyph />
          <span>
            <span className="sh-box-counter__soon">{counter.actions.map((action) => action.label).join(' · ')}</span>
            {counter.reason ? ` · ${counter.reason.toLowerCase()}` : ''}
          </span>
        </p>
      ) : counter.reason ? (
        <p className="sh-box-counter__reason">
          {counter.open ? null : <LockGlyph />}
          {counter.reason}
        </p>
      ) : null}
    </section>
  );
}

export function Counters({ counters, idPrefix = 'box-counter' }: { counters: readonly Counter[]; idPrefix?: string }) {
  return (
    <div className="sh-box-counters">
      {counters.map((counter) => (
        <CounterCard key={counter.id} counter={counter} idPrefix={idPrefix} />
      ))}
    </div>
  );
}

/**
 * The phone's sticky bar: the counters icon (all three counters in a sheet) and the one working action; with nothing to
 * do in the app it shrinks to the 44 px counters button (a failed box: and where its refund goes).
 */
export function PhoneCounterBar({ counters, state, v2 = false }: { counters: readonly Counter[]; state: BoxState | null; v2?: boolean }) {
  const [open, setOpen] = useState(false);
  const primary = primaryAction(counters);
  const note = 'action' in primary ? null : phoneBarNote(counters, state, v2);
  const compact = !('action' in primary);
  return (
    <div className="sh-box-phonebar" data-compact={compact} role="region" aria-label="Next step">
      <button type="button" className="sh-box-phonebar__all" aria-haspopup="dialog" aria-label={`All counters: ${counters.map((counter) => counter.label).join(', ')}`} onClick={() => setOpen(true)}>
        <CountersGlyph />
      </button>
      {'action' in primary ? (
        <>
          <span className="sh-box-phonebar__text">
            <strong>{primary.counter.label}</strong>
          </span>
          <LinkOut action={primary.action} />
        </>
      ) : note ? (
        <span className="sh-box-phonebar__text">{note}</span>
      ) : null}
      {open ? (
        <BoxSheet titleId="box-counters-sheet" title="Counters" onClose={() => setOpen(false)} className="sh-box-sheet--counters">
          <Counters counters={counters} idPrefix="box-sheet-counter" />
        </BoxSheet>
      ) : null}
    </div>
  );
}
