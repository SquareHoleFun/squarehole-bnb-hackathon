/**
 * Steps 4 and 5 (box creation flow § 1): Raise (the target, a fact: one raise for every box, F74 U5; the deadline,
 * refunds if not reached) and Opening (when it opens, the launch window line, your ETH at start, the rights
 * confirmation). Presets, not sliders (v2 C16); each starts on its default, so Contents → Overview is the shortest
 * path. One line of words; the rest behind an (i).
 */
import { LAUNCH_TAX_PIPS_BLOCK_0, LAUNCH_TAX_PIPS_BLOCK_31, TAX_STEP_SECONDS, WINDOW_STEPS, boxCurve, curveBuyOut, issuanceBps, tIsCurrency0 } from '@squarehole/box-spec';
import { formatTaxPips } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { utcTime } from '../boxes/box-figure';
import { bpsText, ethExact } from '../boxes/spec-record';
import { ChipGroup, FieldError, InfoLine, TextField, type StepProps } from './create-parts';
import { DEADLINE_DAYS, DEFAULT_OPEN_PRESET, OPEN_PRESETS, Q_ASSETS, RIGHTS_LABEL, RIGHTS_STATEMENT, ZERO_ADDRESS, openAtOf, parseEthText, raiseOf, utcFieldValue, type CreateForm } from './create-model';
import { windowMinutes } from './FixedValues';
import { pairOf, tickerOf } from './KindStep';
import { CONTROL } from './reason-copy';

/** "4.206980085 ETH": the target with every digit (F74 U5), as the box's own page states it. */
export const targetText = (form: Pick<CreateForm, 'qIndex'>): string => `${ethExact(raiseOf(form.qIndex))} ${pairOf(form)}`;

/** The target as a fact, not a choice (F74 U5): the one raise every box has; why behind its (i). */
function TargetFact({ form }: Pick<StepProps, 'form'>) {
  const tip = useInfoTip();
  return (
    <div className="sh-newbox-field">
      <div className="sh-newbox-fact-row sh-newbox-target" id={CONTROL.target} tabIndex={-1}>
        <span className="sh-newbox-label">Target</span>
        <strong className="sh-newbox-target__value">{targetText(form)}</strong>
        <InfoButton tip={tip} label="About the target" />
      </div>
      <InfoPanel tip={tip}>
        <p>Every box raises this same amount, so nobody picks one.</p>
      </InfoPanel>
    </div>
  );
}

export function RaiseStep({ form, set, errorFor }: StepProps) {
  const q = pairOf(form);
  return (
    <>
      <TargetFact form={form} />
      <ChipGroup
        id={CONTROL.deadline}
        legend="Deadline · days"
        options={DEADLINE_DAYS.map((days) => ({ value: days, label: String(days), heard: 'days' }))}
        value={form.deadlineDays}
        onChange={(deadlineDays) => set({ deadlineDays })}
        error={errorFor(CONTROL.deadline)}
      />
      <InfoLine
        label="About the curve"
        info={
          <>
            <p>80% of the token sits on a curve. Its price moves ×14.7 from the first buy to the last.</p>
            <p>{`Reach the target before the deadline and the box graduates. Otherwise everyone gets their ${q} back in equal shares of what is left.`}</p>
          </>
        }
      >
        Not full by then: equal refunds.
      </InfoLine>
    </>
  );
}

/**
 * The rights confirmation (F70 step 5, § 4.2): one state, shown on Opening and, while unticked, on the Overview. The
 * full statement is behind its (i) (counsel words it). Create stays off until it is ticked: this is its reason.
 */
export function RightsBox({ form, set, errorFor }: Pick<StepProps, 'form' | 'set' | 'errorFor'>) {
  const tip = useInfoTip();
  const error = errorFor(CONTROL.rights);
  return (
    <div className="sh-newbox-rights">
      <div className="sh-newbox-rights__row">
        <label className="sh-newbox-toggle" id={`${CONTROL.rights}-label`}>
          <input id={CONTROL.rights} type="checkbox" checked={form.rights} aria-invalid={error ? true : undefined} aria-describedby={error ? `${CONTROL.rights}-error` : undefined} onChange={(event) => set({ rights: event.currentTarget.checked })} />
          {RIGHTS_LABEL}
        </label>
        <InfoButton tip={tip} label="About the rights statement" />
      </div>
      <InfoPanel tip={tip}>
        <p>{RIGHTS_STATEMENT}</p>
        <p>Kept with your box’s site record and your address; never in the BoxSpec.</p>
      </InfoPanel>
      <FieldError id={`${CONTROL.rights}-error`} message={error} />
    </div>
  );
}

/** The time field's first value: an hour from now, the next whole minute, in UTC (the field is a UTC time). */
const inAnHour = (nowMs: number): string => utcFieldValue(Math.ceil((nowMs + 3_600_000) / 60_000) * 60_000);

export { utcTime };

/** "in 25 min", "in 3 h", "in 5 days": how far away a moment is, rounded. */
export function inWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/**
 * Under the time field (its label says UTC): how far the picked time is, "in 3 h" (the words budget, D17); null for a
 * time not after `nowMs` or one that is not a time (the step says why).
 */
export function pickedAheadText(openAt: number, nowMs: number): string | null {
  const ms = openAt * 1000;
  return openAt <= 1 || ms <= nowMs ? null : inWords(ms - nowMs);
}

/**
 * An opening time (the spec's openAt, Unix seconds) as the Overview shows it: "18:00 UTC · in 3 h";
 * null for Now (0), a time not after `nowMs` or one that is not a time (the steps say why).
 */
export function pickedTimeText(openAt: number, nowMs: number): string | null {
  const ms = openAt * 1000;
  if (openAt <= 1 || ms <= nowMs) return null;
  return `${utcTime(ms, nowMs)} · ${inWords(ms - nowMs)}`;
}

/** "≈ 13% of KITE": the share of the token the creator's ETH comes to (an estimate from the curve), or null. */
export function firstInShare(form: CreateForm): string | null {
  const raw = parseEthText(form.firstIn);
  const raise = raiseOf(form.qIndex);
  if (raw === null || raw === 0n || raw >= raise) return null;
  const asset = Q_ASSETS[form.qIndex] ?? Q_ASSETS[0];
  try {
    // The token address is not known before creation; T sorts above native ETH either way (ETH is the zero address).
    const curve = boxCurve(raise, tIsCurrency0('0xffffffffffffffffffffffffffffffffffffffff', asset?.token ?? ZERO_ADDRESS));
    return `≈ ${bpsText(issuanceBps(curveBuyOut(curve, raw)))} of ${tickerOf(form)}`;
  } catch {
    return null;
  }
}

export interface LaunchStepProps extends StepProps {
  readonly nowMs: number;
}

export function LaunchStep({ form, set, errorFor, touch, nowMs }: LaunchStepProps) {
  const timeError = errorFor(CONTROL.openTime);
  const openAt = openAtOf(form.open, nowMs);
  const share = firstInShare(form);
  const q = pairOf(form);
  return (
    <>
      <ChipGroup
        id={CONTROL.opens}
        legend="Opens"
        options={[...OPEN_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: 'time', label: 'Pick a time' }]}
        value={form.open.kind === 'time' ? 'time' : (OPEN_PRESETS.find((preset) => form.open.kind === 'preset' && preset.id === form.open.id)?.id ?? DEFAULT_OPEN_PRESET.id)}
        onChange={(id) => {
          const preset = OPEN_PRESETS.find((entry) => entry.id === id);
          set({ open: preset ? { kind: 'preset', id: preset.id } : { kind: 'time', utc: form.open.kind === 'time' ? form.open.utc : inAnHour(nowMs) } });
        }}
        error={errorFor(CONTROL.opens)}
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
          <p id={`${CONTROL.openTime}-utc`} className="sh-newbox-hint">
            {pickedAheadText(openAt, nowMs) ?? ' '}
          </p>
          {timeError ? (
            <p id={`${CONTROL.openTime}-error`} className="sh-newbox-error">
              <span aria-hidden="true">!</span> {timeError}
            </p>
          ) : null}
        </div>
      ) : null}
      <InfoLine
        className="sh-newbox-line--tax"
        label="About the launch tax"
        info={
          <p>{`Buys in the first ${windowMinutes()} minutes pay a falling tax, one step every ${TAX_STEP_SECONDS} seconds: ${formatTaxPips(LAUNCH_TAX_PIPS_BLOCK_0)} in the first to ${formatTaxPips(LAUNCH_TAX_PIPS_BLOCK_31)} in the last of ${WINDOW_STEPS}, then none. It is kept in the box: its pool after graduation, the refunds if it fails.`}</p>
        }
      >
        {`First ${windowMinutes()} min: falling tax`}
      </InfoLine>
      <TextField
        id={CONTROL.firstIn}
        label={`Your ${q} at start`}
        value={form.firstIn}
        inputMode="decimal"
        placeholder="0"
        onChange={(firstIn) => set({ firstIn })}
        onBlur={() => touch(CONTROL.firstIn)}
        error={errorFor(CONTROL.firstIn)}
        hint={
          share ? (
            <>
              <span className="sh-newbox-share">{share}</span>
              Shown on your box
            </>
          ) : (
            'Optional · shown on your box'
          )
        }
      />
      <RightsBox form={form} set={set} errorFor={errorFor} />
    </>
  );
}
