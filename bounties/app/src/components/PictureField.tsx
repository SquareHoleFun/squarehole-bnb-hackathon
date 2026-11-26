/**
 * SH-294: a launch's picture, one field on both launch forms (Flap and Four.meme, the Visual way and the Steps share
 * it). The file is shrunk the platform's way for a logo (raster only, its size ladder to Turbo's free size), published
 * to Arweave with a throwaway key (no wallet prompt, no account), and its link (lib/pictures/publish.ts `pictureLink`)
 * becomes the launch's link field: Flap's `meta`, OpenFour's `tokenUri`. No picture, or a failed publish, leaves the
 * field empty and the launch possible.
 *
 * The words are the platform's own: "Picture" (create/v2 Basics), "Add picture" (core/v2/AddPictureV2.tsx), its lines
 * "Publishing…", "Too large to store for free.", "Not published. Try again." (ADD_PICTURE_LINES), and the shrink's
 * refusals (pictures/shrink.ts TOO_DETAILED, UNREADABLE), and "Remove" (the platform's desk).
 */
import { useState, type ChangeEvent } from 'react';
import { publishPicture, type PicturePublish, type PublishSeams } from '../lib/pictures/publish';
import { rememberLaunchPicture, useLaunchPictureUrl } from '../lib/pictures/read';
import '../styles/picture-field.css';

export const PICTURE_WORDS = Object.freeze({
  label: 'Picture',
  add: 'Add picture',
  remove: 'Remove',
  publishing: 'Publishing…',
  tooLarge: 'Too large to store for free.',
  failed: 'Not published. Try again.',
});

type Phase = { readonly kind: 'idle' } | { readonly kind: 'publishing' } | { readonly kind: 'refused'; readonly line: string };

/** The line a failed publish shows (the platform's own lines). */
export function publishLine(result: Exclude<PicturePublish, { ok: true }>): string {
  if (result.reason === 'shrink') return result.line;
  if (result.reason === 'too-large') return PICTURE_WORDS.tooLarge;
  return PICTURE_WORDS.failed;
}

export interface PictureFieldProps {
  /** The launch's link now ('' for none). */
  readonly value: string;
  readonly onChange: (link: string) => void;
  readonly disabled?: boolean;
  readonly chainId: number;
  /** The publish (tests, the stand's stand-in); default: Turbo. */
  readonly publish?: (file: File, seams: PublishSeams) => Promise<PicturePublish>;
  readonly upload?: string;
}

export function PictureField({ value, onChange, disabled = false, chainId, publish = publishPicture, upload }: PictureFieldProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The thumbnail comes from the link itself (the bytes this page published are kept, checked, by read.tsx): it stays
  // when the screen switches between its two ways, which mount the field anew.
  const thumb = useLaunchPictureUrl(value);
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setPhase({ kind: 'publishing' });
    onChange('');
    const result = await publish(file, { chainId, ...(upload ? { upload } : {}) });
    if (result.ok) {
      await rememberLaunchPicture(result.link, result.bytes);
      setPhase({ kind: 'idle' });
      onChange(result.link);
    } else setPhase({ kind: 'refused', line: publishLine(result) });
  };
  const busy = phase.kind === 'publishing';
  return (
    <div className="field field-wide picture-field" data-picture-field={value ? 'set' : phase.kind}>
      <span className="field-label">{PICTURE_WORDS.label}</span>
      <span className="picture-field__row">
        {value && thumb ? <img className="picture-field__thumb" src={thumb} alt="" width={48} height={48} /> : null}
        <label className="btn picture-field__add" data-busy={busy || undefined}>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled || busy} onChange={(e) => { void pick(e); }} data-testid="picture-input" />
          <span>{PICTURE_WORDS.add}</span>
        </label>
        {value && !busy ? (
          <button type="button" className="btn" disabled={disabled} onClick={() => { setPhase({ kind: 'idle' }); onChange(''); }}>{PICTURE_WORDS.remove}</button>
        ) : null}
      </span>
      {busy ? <span className="muted small" role="status">{PICTURE_WORDS.publishing}</span> : null}
      {phase.kind === 'refused' ? <span className="refusal" role="status" data-testid="picture-refusal">{phase.line}</span> : null}
    </div>
  );
}
