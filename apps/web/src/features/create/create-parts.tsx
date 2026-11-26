/**
 * Small pieces of the creation page (box creation flow § 7): the stepper (an ordered list, the current step marked
 * `aria-current="step"`), chip groups (native radios in a fieldset: arrow keys, a check icon, never colour alone), text
 * fields with a byte counter, the focused error summary and an info line with its (i).
 */
import { useEffect, useId, useRef, type ChangeEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { STEPS, stepIndex, type CreateForm, type StepId } from './create-model';
import { summaryLine, type ControlId, type Issue } from './reason-copy';

/** What every step gets: the form, a patcher, the message to show on a control now, and "this control was left". */
export interface StepProps {
  readonly form: CreateForm;
  readonly set: (patch: Partial<CreateForm>) => void;
  /** The message to show on a control now (after it was left, or after Next), or null. */
  readonly errorFor: (control: ControlId) => string | null;
  readonly touch: (control: ControlId) => void;
}

export const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
/** The item files a collection's art picker takes: pictures, R74-ART's 3D models (`<id>.glb`) and a traits file. */
export const ITEM_FILE_TYPES = `${IMAGE_TYPES},.glb,model/gltf-binary,.json,.csv,application/json,text/csv`;

/** The files a file input was given; the input is cleared so the same file can be picked again. */
export function takeFiles(event: ChangeEvent<HTMLInputElement>): File[] {
  const input = event.currentTarget;
  const files = Array.from(input.files ?? []);
  input.value = '';
  return files;
}

/**
 * A picture picker: the native file input covers its button ("Add image", "Change"), named by the field's label and
 * the button's words, described by its hint and error. A square picture shows its thumbnail beside the button; a wide
 * one (the banner) shows full width at 4:1 under it, so its crop can be judged. `count` keeps the label's "3/4" when
 * the picker is `full` (no more files); `info` puts an (i) right after the label; `onRemove` puts a Remove button
 * beside Change; `children` follow the hint (the teaser list).
 */
export function PicturePicker({
  id,
  label,
  action,
  busy,
  thumb,
  error,
  multiple = false,
  wide = false,
  full = false,
  count,
  hint,
  hintInfo,
  info,
  onRemove,
  removeLabel,
  onFiles,
  children,
  off,
}: {
  id: string;
  label: ReactNode;
  action: string;
  busy: boolean;
  thumb: string | null;
  error: string | null;
  multiple?: boolean;
  wide?: boolean;
  /** No more files: the label, its count, the hint and the list stay; the button goes. */
  full?: boolean;
  /** "3/4" beside the label. */
  count?: string;
  hint?: string;
  /** An (i) right after the hint. */
  hintInfo?: { readonly label: string; readonly body: ReactNode };
  /** An (i) right after the label (what the picture is for), with no hint line. */
  info?: { readonly label: string; readonly body: ReactNode };
  onRemove?: () => void;
  /** The Remove button's accessible name ("Remove banner"); it reads "Remove". */
  removeLabel?: string;
  onFiles: (files: File[]) => void;
  children?: ReactNode;
  /**
   * SH-218 rail 2 (the v2 flow): the id of the line that says this picture is switched off for new boxes. The picker then
   * stays visible and focusable, `aria-disabled`, and takes no new file; what is chosen stays, and Remove still works.
   * Absent: as before.
   */
  off?: string;
}) {
  const labelId = `${id}-label`;
  const actionId = `${id}-action`;
  const hintId = `${id}-hint`;
  const described = [hint ? hintId : null, error ? `${id}-error` : null, off ?? null].filter(Boolean).join(' ') || undefined;
  const tip = useInfoTip();
  const labelTip = useInfoTip();
  return (
    <div className="sh-newbox-field">
      <div className={`sh-newbox-field__top${info ? ' sh-newbox-field__top--start' : ''}`}>
        <span className="sh-newbox-label" id={labelId}>
          {label}
        </span>
        {info ? <InfoButton tip={labelTip} label={info.label} /> : null}
        {count ? (
          <span className="sh-newbox-count">
            <span className="sh-visually-hidden">Chosen: </span>
            {count}
          </span>
        ) : null}
      </div>
      {info ? <InfoPanel tip={labelTip}>{info.body}</InfoPanel> : null}
      {full && !onRemove ? null : (
        <div className="sh-newbox-pick">
          {thumb && !wide ? <img className="sh-newbox-thumb" src={thumb} width={56} height={56} alt="" /> : null}
          {full ? null : (
            <label className="sh-button sh-newbox-pick__button" data-busy={busy || undefined} data-create-off={off ? '' : undefined}>
              <input
                id={id}
                type="file"
                accept={IMAGE_TYPES}
                multiple={multiple}
                className="sh-newbox-file"
                aria-labelledby={`${labelId} ${actionId}`}
                aria-invalid={error ? true : undefined}
                aria-describedby={described}
                aria-disabled={off ? 'true' : undefined}
                onClick={off ? (event) => event.preventDefault() : undefined}
                onChange={(event) => {
                  const files = takeFiles(event);
                  if (files.length > 0 && !off) onFiles(files);
                }}
              />
              <span id={actionId}>{busy ? 'Reading…' : action}</span>
            </label>
          )}
          {onRemove ? (
            <button type="button" className="sh-button" aria-label={removeLabel} onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </div>
      )}
      {thumb && wide ? <img className="sh-newbox-wide-preview" src={thumb} width={800} height={200} alt="" /> : null}
      {hint ? (
        <div className="sh-newbox-field__top sh-newbox-field__top--start">
          <p id={hintId} className="sh-newbox-hint">
            {hint}
          </p>
          {hintInfo ? <InfoButton tip={tip} label={hintInfo.label} /> : null}
        </div>
      ) : null}
      {hint && hintInfo ? <InfoPanel tip={tip}>{hintInfo.body}</InfoPanel> : null}
      {children}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

const INSIDE = ['input:not([disabled]):checked', 'input:not([disabled])', 'select, textarea', 'button:not([disabled]), a[href]'] as const;

/**
 * Centres a control, then focuses it without a second jump. On a phone the sticky action bar covers the bottom of the
 * screen, but a control under it still counts as visible to the browser, so `focus()` alone would leave it hidden
 * (WCAG 2.2 SC 2.4.11 Focus Not Obscured).
 */
function show(target: HTMLElement): void {
  target.scrollIntoView?.({ block: 'center' });
  target.focus({ preventScroll: true });
}

/**
 * Moves focus to a control by id: the element itself if focusable, else inside it the checked radio first (a chip
 * group), then the first enabled field or button, else the element (a row with tabindex -1).
 */
export function focusControl(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.matches('input, select, textarea, button, a[href]')) {
    show(element);
    return;
  }
  for (const selector of INSIDE) {
    const target = element.querySelector<HTMLElement>(selector);
    if (target) {
      show(target);
      return;
    }
  }
  show(element);
}

export const CheckIcon = () => (
  <svg className="sh-newbox-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const BackGlyph = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M15 5 8 12l7 7" />
  </svg>
);

export const EditGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

const createPath = (step: StepId) => `/create/${step}`;

/**
 * The stepper: "2/6" and six dots on a phone (the names stay for screen readers), the names on wide screens. Contents is
 * a link once Basics is complete, every step once Contents is (§ 0); a step with something to fix is marked "Fix": in
 * its name, with a "!" in its dot, and on a phone in the count ("3/6 · 2 to fix"), never by colour alone.
 */
export function Stepper({ step, reachable, fix }: { step: StepId; reachable: number; fix: ReadonlySet<StepId> }) {
  const at = stepIndex(step);
  const toFix = STEPS.filter((entry) => fix.has(entry.id)).length;
  return (
    <nav className="sh-newbox-steps" aria-label="Steps">
      <p className="sh-newbox-steps__count" aria-hidden="true">{`${at + 1}/${STEPS.length}${toFix > 0 ? ` · ${toFix} to fix` : ''}`}</p>
      <ol>
        {STEPS.map((entry, index) => {
          const open = index < reachable;
          const state = index < at ? 'done' : index === at ? 'current' : 'todo';
          const content = (
            <>
              <span className="sh-newbox-steps__dot" aria-hidden="true" />
              <span className="sh-newbox-steps__label">
                {entry.label}
                {fix.has(entry.id) ? <span className="sh-newbox-steps__fix"> · Fix</span> : null}
              </span>
            </>
          );
          return (
            <li key={entry.id} data-state={state} data-fix={fix.has(entry.id) || undefined} aria-current={index === at ? 'step' : undefined}>
              {open && index !== at ? (
                <Link to={createPath(entry.id)} className="sh-newbox-steps__link">
                  {content}
                </Link>
              ) : (
                <span className="sh-newbox-steps__link" aria-disabled={open ? undefined : 'true'}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface ChipOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /** A decorative glyph before the label (the Contents tiles). */
  readonly icon?: ReactNode;
  /** A second line under the label (shown in the chip). */
  readonly hint?: string;
  /** Words only screen readers need (the unit the legend shows once: "ETH"). */
  readonly heard?: string;
  /** Off (§ 7): `aria-disabled`, still focusable, its reason tied by `describedBy`; choosing it does nothing. */
  readonly disabled?: boolean;
  /** Ids of the lines that explain this option (its reason when off, a sell flag). */
  readonly describedBy?: string;
}

/**
 * A chip group: a fieldset of native radios (Tab enters, arrows move), the selected chip with a check icon. `info`
 * adds an (i) after the legend (the group's name stays the legend's words); `stack` puts the chips one per line on a
 * phone, so a choice of three never wraps two plus one with the last chip the widest; `tiles` makes them tall tiles
 * with an icon and a second line (the first real choice of Contents). `describedBy` ties lines outside the group to it
 * (the cap's amount).
 */
export function ChipGroup<T extends string | number>({
  id,
  legend,
  options,
  value,
  onChange,
  error,
  info,
  wide = false,
  stack = false,
  tiles = false,
  describedBy,
}: {
  id: string;
  legend: ReactNode;
  options: readonly ChipOption<T>[];
  /** null: nothing chosen yet (the Contents tiles). */
  value: T | null;
  onChange: (value: T) => void;
  error?: string | null;
  info?: { readonly label: string; readonly body: ReactNode };
  wide?: boolean;
  stack?: boolean;
  tiles?: boolean;
  describedBy?: string;
}) {
  const errorId = `${id}-error`;
  const legendId = `${id}-legend`;
  const tip = useInfoTip();
  const described = [describedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset
      id={id}
      className="sh-newbox-chips"
      data-wide={wide || undefined}
      data-stack={stack || undefined}
      data-tiles={tiles || undefined}
      aria-labelledby={info ? legendId : undefined}
      aria-describedby={described}
      aria-invalid={error ? true : undefined}
    >
      <legend className="sh-newbox-label">
        <span id={legendId}>{legend}</span>
        {info ? <InfoButton tip={tip} label={info.label} /> : null}
      </legend>
      {info ? <InfoPanel tip={tip}>{info.body}</InfoPanel> : null}
      <div className="sh-newbox-chips__row">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label key={String(option.value)} className="sh-newbox-chip" data-checked={checked || undefined} data-disabled={option.disabled || undefined}>
              <input
                type="radio"
                name={id}
                value={String(option.value)}
                checked={checked}
                aria-disabled={option.disabled ? 'true' : undefined}
                aria-describedby={option.describedBy}
                onChange={() => {
                  if (!option.disabled) onChange(option.value);
                }}
              />
              {checked ? <CheckIcon /> : null}
              {option.icon ? (
                <span className="sh-newbox-chip__icon" aria-hidden="true">
                  {option.icon}
                </span>
              ) : null}
              <span className="sh-newbox-chip__text">
                {option.label}
                {option.heard ? (
                  <>
                    {' '}
                    <span className="sh-visually-hidden">{option.heard}</span>
                  </>
                ) : null}
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
            </label>
          );
        })}
      </div>
      <FieldError id={errorId} message={error ?? null} />
    </fieldset>
  );
}

export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="sh-newbox-error">
      <span aria-hidden="true">!</span> {message}
    </p>
  );
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** A labelled text field with its byte counter ("5/11") and its error, both tied to it with `aria-describedby`. */
export function TextField({
  id,
  label,
  value,
  onChange,
  onBlur,
  maxBytes,
  error,
  hint,
  multiline = false,
  rows = 3,
  inputMode,
  placeholder,
  autoComplete = 'off',
  spellCheck,
  off,
  offAccepts,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  maxBytes?: number;
  error?: string | null;
  hint?: ReactNode;
  multiline?: boolean;
  rows?: number;
  inputMode?: 'text' | 'decimal';
  placeholder?: string;
  autoComplete?: string;
  spellCheck?: boolean;
  /**
   * SH-218 rail 2 (the v2 flow): the id of the line that says this field is switched off for new boxes. The field then
   * stays visible and focusable, `aria-disabled`, keeps what it holds and takes no new text, except what `offAccepts`
   * lets through (clearing it). Absent: as before.
   */
  off?: string;
  offAccepts?: (value: string) => boolean;
}) {
  const counterId = `${id}-count`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [maxBytes !== undefined ? counterId : null, hint ? hintId : null, error ? errorId : null, off ?? null].filter(Boolean).join(' ') || undefined;
  const change = (next: string) => { if (!off || offAccepts?.(next) === true) onChange(next); };
  const bytes = byteLength(value);
  const common = {
    id,
    value,
    className: 'sh-newbox-input',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described,
    'aria-disabled': off ? ('true' as const) : undefined,
    'data-create-off': off ? '' : undefined,
    onBlur,
    placeholder,
    autoComplete,
    spellCheck,
  };
  return (
    <div className="sh-newbox-field">
      <div className="sh-newbox-field__top">
        <label htmlFor={id} className="sh-newbox-label">
          {label}
        </label>
        {maxBytes !== undefined ? (
          <span id={counterId} className="sh-newbox-count" data-over={bytes > maxBytes || undefined}>
            <span className="sh-visually-hidden">Characters used: </span>
            {`${bytes}/${maxBytes}`}
          </span>
        ) : null}
      </div>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(event) => change(event.currentTarget.value)} />
      ) : (
        <input {...common} type="text" inputMode={inputMode} onChange={(event) => change(event.currentTarget.value)} />
      )}
      {hint ? (
        <p id={hintId} className="sh-newbox-hint">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId} message={error ?? null} />
    </div>
  );
}

/** The error summary shown after Next or Create: focused, announced, each line a link to its control. */
export function ErrorSummary({ issues, focusKey, onGo }: { issues: readonly Issue[]; focusKey: number; onGo: (issue: Issue) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);
  if (issues.length === 0) return null;
  return (
    <div ref={ref} className="sh-newbox-summary" role="alert" aria-labelledby={titleId} tabIndex={-1}>
      <p id={titleId} className="sh-newbox-summary__title">
        {issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}
      </p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.control}-${issue.message}`}>
            <a
              href={`#${issue.control}`}
              onClick={(event) => {
                event.preventDefault();
                onGo(issue);
              }}
            >
              {summaryLine(issue)}
            </a>
            {issue.detail ? (
              <details className="sh-newbox-summary__detail">
                <summary>Details</summary>
                <code>{issue.detail}</code>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One short line with its (i): the explanation lives behind the button (F45: numbers first, details on demand). */
export function InfoLine({ label, children, info, className = '' }: { label: string; children: ReactNode; info: ReactNode; className?: string }) {
  const tip = useInfoTip();
  return (
    <div className={`sh-newbox-line ${className}`}>
      <p>
        {children} <InfoButton tip={tip} label={label} />
      </p>
      <InfoPanel tip={tip}>{info}</InfoPanel>
    </div>
  );
}
