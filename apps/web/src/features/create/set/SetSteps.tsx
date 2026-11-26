/**
 * SH-EXISTING-NFTS-E08C: the set Create flow's first three steps, numbers and short labels first (the founder's
 * minimal-text rule): Basics (price coin, name, ticker, logo, About), Items (the collection's address, the pasted ids,
 * the pick fee) and Raise (the listing's raise, the deadline, an optional first buy). Nothing here asks a wallet.
 */
import { formatCount } from '../../fit-pair/fit-format';
import { ChipGroup, PicturePicker, TextField } from '../create-parts';
import { CoinPicker } from '../v2/CoinPicker';
import { offeredListings, raiseText, type SiteListing } from '../v2/listings';
import { SET_CONTROL, collectionOf } from './set-create-model';
import { SET_DEADLINE_DAYS, SET_PICK_FEES, updateSetDraft, type SetDraft } from './set-draft';
import { parseSetIds } from './set-ids';

export interface SetStepProps {
  readonly draft: SetDraft;
  readonly errorFor: (control: string) => string | null;
  readonly touch: (control: string) => void;
}

const set = (patch: Partial<SetDraft>) => updateSetDraft((draft) => ({ ...draft, ...patch }));

export function SetBasicsStep({ draft, errorFor, touch, listings, listing, logo }: SetStepProps & {
  readonly listings: readonly SiteListing[];
  readonly listing: SiteListing | null;
  readonly logo: { readonly busy: boolean; readonly problem: string | null; readonly onFile: (file: File) => void };
}) {
  return (
    <>
      <CoinPicker
        id={SET_CONTROL.pricing}
        legend="Priced in"
        info={{ label: 'About the price coin', body: <p>What the curve raises and the box’s token trades against.</p> }}
        listings={offeredListings(listings)}
        value={listing?.token ?? null}
        onChange={(pricing) => set({ pricing })}
        hint={(entry) => `Raise ${raiseText(entry, entry.raise)}`}
        error={errorFor(SET_CONTROL.pricing)}
      />
      <div className="sh-newbox-pair">
        <TextField id={SET_CONTROL.name} label="Name" value={draft.name} maxBytes={32} onChange={(name) => set({ name })} onBlur={() => touch(SET_CONTROL.name)} error={errorFor(SET_CONTROL.name)} />
        <TextField id={SET_CONTROL.ticker} label="Ticker" value={draft.ticker} maxBytes={11} spellCheck={false} onChange={(ticker) => set({ ticker })} onBlur={() => touch(SET_CONTROL.ticker)} error={errorFor(SET_CONTROL.ticker)} />
      </div>
      <PicturePicker
        id={SET_CONTROL.logo}
        label="Logo"
        action={draft.logo ? 'Change' : 'Add image'}
        busy={logo.busy}
        thumb={draft.logo?.url ?? null}
        error={logo.problem ?? errorFor(SET_CONTROL.logo)}
        onFiles={([file]) => {
          if (file) logo.onFile(file);
        }}
      />
      <TextField id={SET_CONTROL.about} label="About" value={draft.about} multiline rows={2} hint="Optional" maxBytes={1024} onChange={(about) => set({ about })} onBlur={() => touch(SET_CONTROL.about)} error={errorFor(SET_CONTROL.about)} />
    </>
  );
}

/** "40 ids" once the pasted ids read; nothing while they do not (the field's own line says why). */
export function idsStatus(text: string): string | null {
  const parsed = parseSetIds(text);
  return parsed.ok ? `${formatCount(BigInt(parsed.ids.length))} ids` : null;
}

export function SetItemsStep({ draft, errorFor, touch }: SetStepProps) {
  const collection = collectionOf(draft.collection);
  return (
    <>
      <TextField
        id={SET_CONTROL.collection}
        label="Collection"
        value={draft.collection}
        placeholder="0x…"
        spellCheck={false}
        hint={collection ? `ERC-721 · ${collection}` : 'ERC-721 address'}
        onChange={(value) => set({ collection: value })}
        onBlur={() => touch(SET_CONTROL.collection)}
        error={errorFor(SET_CONTROL.collection)}
      />
      <TextField
        id={SET_CONTROL.ids}
        label="Ids"
        value={draft.ids}
        multiline
        rows={6}
        placeholder="1, 2, 5-9"
        spellCheck={false}
        hint={idsStatus(draft.ids) ?? '10 to 10,000 ids · in this order'}
        onChange={(ids) => set({ ids })}
        onBlur={() => touch(SET_CONTROL.ids)}
        error={errorFor(SET_CONTROL.ids)}
      />
      <ChipGroup
        id={SET_CONTROL.pickFee}
        legend="Pick fee"
        info={{ label: 'About the pick fee', body: <p>Added to the price of a named pick, then burned. A return keeps back a fixed 5%, also burned.</p> }}
        options={SET_PICK_FEES.map((value) => ({ value, label: `${value / 100}%` }))}
        value={draft.pickFeeBps}
        onChange={(pickFeeBps) => set({ pickFeeBps })}
        error={errorFor(SET_CONTROL.pickFee)}
      />
    </>
  );
}

export function SetRaiseStep({ draft, errorFor, touch, listing }: SetStepProps & { readonly listing: SiteListing | null }) {
  return (
    <>
      <div className="sh-newbox-field">
        <div className="sh-newbox-fact-row sh-newbox-target">
          <span className="sh-newbox-label">Raise</span>
          <strong className="sh-newbox-target__value">{listing ? raiseText(listing, listing.raise) : 'Unavailable'}</strong>
        </div>
      </div>
      <ChipGroup id={SET_CONTROL.deadline} legend="Deadline · days" options={SET_DEADLINE_DAYS.map((days) => ({ value: days, label: String(days), heard: 'days' }))} value={draft.deadlineDays} onChange={(deadlineDays) => set({ deadlineDays })} error={errorFor(SET_CONTROL.deadline)} />
      <TextField
        id={SET_CONTROL.firstIn}
        label={`Your ${listing?.symbol ?? 'coins'} at start`}
        value={draft.firstIn}
        inputMode="decimal"
        placeholder="0"
        hint="Optional"
        onChange={(firstIn) => set({ firstIn })}
        onBlur={() => touch(SET_CONTROL.firstIn)}
        error={errorFor(SET_CONTROL.firstIn)}
      />
      <p className="sh-newbox-hint">Trading opens once every item is loaded.</p>
    </>
  );
}
