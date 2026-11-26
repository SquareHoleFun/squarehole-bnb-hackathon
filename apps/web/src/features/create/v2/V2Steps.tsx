import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { RightsBox, pickedAheadText } from '../ChoiceSteps';
import { ChipGroup, FieldError, InfoLine, TextField, type StepProps } from '../create-parts';
import { DEFAULT_OPEN_PRESET, OPEN_PRESETS, openAtOf, utcFieldValue } from '../create-model';
import { windowMinutes } from '../FixedValues';
import { CONTROL } from '../reason-copy';
import { SetEntryTile } from '../set/SetEntryTile';
import { CoinPicker } from './CoinPicker';
import { issuerLines, offeredListings, parentPath, raiseOf, raiseText, type SiteListing } from './listings';
import { DEADLINE_DAYS_V2, PICK_FEE_PRESETS, V2_CONTROL } from './model';
import { useV2Choices } from './v2-draft';

// SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's entry (create/set/SetEntryTile.tsx) is local only until its release
// ticket; a production build folds it away, and its module and stylesheet with it.
const SET_BUILD = !import.meta.env?.SH_PRODUCTION;

function Fact({ label, value, info, id }: { label: string; value: string; info: ReactNode; id?: string }) {
  const tip = useInfoTip();
  return (
    <div className="sh-newbox-field">
      <div className="sh-newbox-fact-row sh-newbox-target" id={id} tabIndex={id ? -1 : undefined}>
        <span className="sh-newbox-label">{label}</span>
        <strong className="sh-newbox-target__value">{value}</strong>
        <InfoButton tip={tip} label={`About the ${label.toLowerCase()}`} />
      </div>
      <InfoPanel tip={tip}>{info}</InfoPanel>
    </div>
  );
}

/** The chosen token's card: its fixed raise, a box token's parent, the issuer's powers. */
function PricingCard({ listing }: { listing: SiteListing }) {
  const lines = issuerLines(listing);
  const raise = raiseOf(listing);
  const parentLink = parentPath(listing);
  return (
    <div className="sh-newbox-field sh-v2-pricing" data-pricing-card="">
      <dl className="sh-newbox-rows">
        <div className="sh-newbox-row">
          <dt>Raise</dt>
          <dd>{raiseText(listing, raise)}</dd>
        </div>
        {listing.parent ? (
          <div className="sh-newbox-row">
            <dt>Parent</dt>
            <dd>
              {parentLink ? <Link to={parentLink}>{listing.parent.name}</Link> : <span>{listing.parent.name}</span>}
            </dd>
          </div>
        ) : null}
      </dl>
      {lines.length > 0 ? (
        <ul className="sh-newbox-warnings">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

    </div>
  );
}

/**
 * The price coin. `listing` is the page's (listings.ts `listingFor`: the draft's coin, or the first offered one when the
 * draft's is not offered). SH-256 (E8): a coin shows as chosen only when the draft holds it, so with a stored coin that
 * is no longer offered none is checked and a press on any offered coin picks it ("Choose a current price coin." stays).
 */
export function PricingPicker({ listing, listings, onPick, off }: { listing: SiteListing; listings: readonly SiteListing[]; onPick: (token: string) => void; off?: (token: string) => boolean }) {
  const held = useV2Choices().pricing.toLowerCase();
  const chosen = listing.token.toLowerCase() === held && offeredListings(listings).some((entry) => entry.token.toLowerCase() === held);
  return (
    <>
      {SET_BUILD ? <SetEntryTile /> : null}
      <CoinPicker
        id={V2_CONTROL.pricing}
        legend="Priced in"
        info={{ label: 'About the pricing token', body: <p>What the curve raises and the box’s token trades against: a listed token, or a graduated box’s token.</p> }}
        listings={offeredListings(listings)}
        value={chosen ? listing.token : null}
        onChange={onPick}
        hint={(entry) => `Raise ${raiseText(entry, entry.raise)}`}
        off={off}
      />
      {chosen ? <PricingCard listing={listing} /> : null}
    </>
  );
}

export function PickFee({ bps, onPick, error }: { bps: number; onPick: (bps: number) => void; error: string | null }) {
  return (
    <ChipGroup
      id={V2_CONTROL.pickFee}
      legend="Pick fee"
      info={{ label: 'About the pick fee', body: <p>What a holder pays to take a named item out of the vault. Draws and returns stay fixed.</p> }}
      options={PICK_FEE_PRESETS.map((value) => ({ value, label: `${value / 100}%` }))}
      value={bps}
      onChange={onPick}
      error={error}
    />
  );
}

export function RaiseV2({ listing, deadlineDays, onDeadline, error, locked = false }: { listing: SiteListing; deadlineDays: number; onDeadline: (days: number) => void; error: string | null; locked?: boolean }) {
  const raise = raiseOf(listing);
  return (
    <>
      <Fact
        id={CONTROL.target}
        label="Raise"
        value={raiseText(listing, raise)}
        info={<p>The lister sets this raise. Changes apply only to future boxes; each box keeps its creation raise.</p>}
      />
      {/* TA-27: a loaded setup keeps its deadline; it shows read-only. */}
      <fieldset className="sh-newbox-locked" disabled={locked} data-locked={locked || undefined}>
        <ChipGroup id={CONTROL.deadline} legend="Deadline · days" options={DEADLINE_DAYS_V2.map((days) => ({ value: days, label: String(days), heard: 'days' }))} value={deadlineDays} onChange={onDeadline} error={error} />
      </fieldset>
      <InfoLine label="About the deadline" info={<p>{`Full before the deadline: the box graduates. Otherwise anyone may close it, and holders get the closing price in ${listing.symbol} from its claim pot.`}</p>}>
        Not full by then: closing price.
      </InfoLine>
    </>
  );
}

/** The time field's first value: an hour from now, the next whole minute, in UTC. */
const inAnHour = (nowMs: number): string => utcFieldValue(Math.ceil((nowMs + 3_600_000) / 60_000) * 60_000);

export function OpeningV2({ form, set, errorFor, touch, nowMs, listing }: StepProps & { nowMs: number; listing: SiteListing }) {
  const timeError = errorFor(CONTROL.openTime);
  const choice = form.open.kind === 'time' ? 'time' : (OPEN_PRESETS.find((preset) => form.open.kind === 'preset' && preset.id === form.open.id)?.id ?? DEFAULT_OPEN_PRESET.id);
  return (
    <>
      <ChipGroup
        id={CONTROL.opens}
        legend="Opens"
        options={[...OPEN_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: 'time', label: 'Pick a time' }]}
        value={choice}
        onChange={(id) => {
          const preset = OPEN_PRESETS.find((entry) => entry.id === id);
          set({ open: preset ? { kind: 'preset', id: preset.id } : { kind: 'time', utc: form.open.kind === 'time' ? form.open.utc : inAnHour(nowMs) } });
        }}
      />
      {form.open.kind === 'time' ? (
        <div className="sh-newbox-field">
          <label htmlFor={CONTROL.openTime} className="sh-newbox-label">
            Time (UTC)
          </label>
          <input
            id={CONTROL.openTime}
            className="sh-newbox-input"
            type="datetime-local"
            value={form.open.utc}
            aria-invalid={timeError ? true : undefined}
            aria-describedby={`${CONTROL.openTime}-utc${timeError ? ` ${CONTROL.openTime}-error` : ''}`}
            onChange={(event) => set({ open: { kind: 'time', utc: event.currentTarget.value } })}
            onBlur={() => touch(CONTROL.openTime)}
          />
          <span id={`${CONTROL.openTime}-utc`} className="sh-newbox-hint">
            {pickedAheadText(openAtOf(form.open, nowMs), nowMs) ?? ' '}
          </span>
          <FieldError id={`${CONTROL.openTime}-error`} message={timeError} />
        </div>
      ) : null}
      <InfoLine label="About the launch window" info={<p>{`Buys in the first ${windowMinutes()} minutes pay a falling tax, kept in the box: its pool after graduation, its claim pot if it fails.`}</p>}>
        {`First ${windowMinutes()} min: falling tax`}
      </InfoLine>
      <TextField id={CONTROL.firstIn} label={`Your ${listing.symbol} at start`} value={form.firstIn} inputMode="decimal" placeholder="0" onChange={(firstIn) => set({ firstIn })} onBlur={() => touch(CONTROL.firstIn)} error={errorFor(CONTROL.firstIn)} hint="Optional · shown on your box" />
      {form.contents === 'collection' ? <p className="sh-newbox-hint">The table loads right after creation; the box opens once it is in.</p> : null}
      <RightsBox form={form} set={set} errorFor={errorFor} />
    </>
  );
}
