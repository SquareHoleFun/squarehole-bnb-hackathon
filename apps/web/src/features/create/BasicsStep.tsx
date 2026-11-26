/**
 * Step 1, Basics (box creation flow § 1, F70 (1)): the pair asset Q from the curated list (a fact while the list holds
 * one), the token's name and ticker, the logo (the token's and the card's picture; a collection has its own cover, F74
 * U3), About and the links (Website, X, Telegram: site metadata, never in the spec, § 4.1) closed under "Links".
 * Numbers first; what Q is sits behind an (i).
 */
import { MAX_SYMBOL_BYTES, MAX_TEXT_BYTES, MAX_TOKEN_NAME_BYTES } from '@squarehole/box-spec';
import { useState, type ReactNode } from 'react';
import { qSymbol } from '../boxes/fee-kinds';
import { ChipGroup, InfoLine, PicturePicker, TextField, type StepProps } from './create-parts';
import { Q_ASSETS, type CoverState } from './create-model';
import { CONTROL } from './reason-copy';
import { NATIVE_SYMBOL } from '../data-source/native-coin';

export interface BasicsStepProps extends StepProps {
  readonly cover: CoverState | null;
  readonly coverBusy: boolean;
  readonly coverProblem: string | null;
  readonly onCover: (file: File) => void;
  /** The v2 flow's pricing-token picker in place of v1's "Paired with" (M1-53-a). */
  readonly pairedWith?: ReactNode;
  /** TA-27: a loaded setup keeps the logo and About; they show read-only (the name, ticker and links stay editable). */
  readonly locked?: boolean;
  /** SH-BOX-PICTURE-FIT: where the pictures show (PictureSlots), under the logo. */
  readonly slots?: ReactNode;
}

/** SH-BOX-PICTURE-FIT: which picture goes where, in as few words as the slot preview needs. */
export const LOGO_HINT = 'Square · the icon';

const LINK_FIELDS = [
  { key: 'website', control: CONTROL.website, label: 'Website', placeholder: 'https://' },
  { key: 'x', control: CONTROL.x, label: 'X', placeholder: '@handle' },
  { key: 'telegram', control: CONTROL.telegram, label: 'Telegram', placeholder: 'https://t.me/' },
] as const;

function PairedWith({ form, set }: Pick<StepProps, 'form' | 'set'>) {
  const info = <p>What the box’s curve raises and its token trades against. The list is curated; today it holds native {NATIVE_SYMBOL} only.</p>;
  if (Q_ASSETS.length > 1) {
    return (
      <ChipGroup
        id={CONTROL.pair}
        legend="Paired with"
        info={{ label: 'About the pair asset', body: info }}
        options={Q_ASSETS.map((entry, index) => ({ value: index, label: qSymbol(entry.token) }))}
        value={form.qIndex}
        onChange={(qIndex) => set({ qIndex })}
      />
    );
  }
  return (
    <InfoLine label="About the pair asset" info={info}>
      {`Paired with ${qSymbol(Q_ASSETS[0]?.token ?? '0x0000000000000000000000000000000000000000')}`}
    </InfoLine>
  );
}

function Links({ form, set, errorFor, touch }: StepProps) {
  const [open, setOpen] = useState(false);
  const errors = LINK_FIELDS.some((field) => errorFor(field.control) !== null);
  return (
    <details className="sh-newbox-more" open={open || errors} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Links <span className="sh-newbox-more__note">Optional</span>
      </summary>
      {LINK_FIELDS.map((field) => (
        <TextField
          key={field.key}
          id={field.control}
          label={field.label}
          value={form.links[field.key]}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(value) => set({ links: { ...form.links, [field.key]: value } })}
          onBlur={() => touch(field.control)}
          error={errorFor(field.control)}
        />
      ))}
    </details>
  );
}

export function BasicsStep(props: BasicsStepProps) {
  const { form, set, errorFor, touch, cover, coverBusy, coverProblem, onCover, pairedWith, locked = false, slots = null } = props;
  return (
    <>
      {pairedWith ?? <PairedWith form={form} set={set} />}
      <div className="sh-newbox-pair">
        <TextField id={CONTROL.name} label="Name" value={form.name} maxBytes={Number(MAX_TOKEN_NAME_BYTES)} onChange={(name) => set({ name })} onBlur={() => touch(CONTROL.name)} error={errorFor(CONTROL.name)} />
        <TextField id={CONTROL.ticker} label="Ticker" value={form.ticker} maxBytes={Number(MAX_SYMBOL_BYTES)} onChange={(ticker) => set({ ticker })} onBlur={() => touch(CONTROL.ticker)} error={errorFor(CONTROL.ticker)} spellCheck={false} />
      </div>
      <fieldset className="sh-newbox-locked" disabled={locked} data-locked={locked || undefined}>
      <PicturePicker
        id={CONTROL.logo}
        label="Logo"
        action={cover ? 'Change' : 'Add image'}
        busy={coverBusy}
        thumb={cover?.url ?? null}
        hint={LOGO_HINT}
        error={coverProblem ?? errorFor(CONTROL.logo)}
        onFiles={([file]) => {
          if (file) onCover(file);
        }}
      >
        {slots}
      </PicturePicker>
      <TextField
        id={CONTROL.about}
        label="About"
        value={form.description}
        multiline
        rows={2}
        hint="Optional"
        maxBytes={Number(MAX_TEXT_BYTES)}
        onChange={(description) => set({ description })}
        onBlur={() => touch(CONTROL.about)}
        error={errorFor(CONTROL.about)}
      />
      </fieldset>
      <Links {...props} />
    </>
  );
}
