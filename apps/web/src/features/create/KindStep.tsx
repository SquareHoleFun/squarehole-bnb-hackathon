/**
 * Step 3, Box kind (box creation flow § 2.2, F70 (3)): each fee side picks who gets its 10/15 (You, Holders, Burn) and
 * the token it is paid in or burns, built from the catalog's members on this source's network (`sideChoices`), never a
 * copied table. Holders (F74 U1): offered in the Demo, marked "Pending" with "Pending legal review" once picked; on a
 * chain source off with "Demo only"; never on mainnet. A sell gets one plain flag line ("Sells KITE for ETH", a `<p>`
 * tied to its choice), BP-13's pair is shown off with its reason, and the fee cap (add-on 5, closed until wanted, a
 * fixed ETH amount per 30 days, F74 U2) appears only while a side pays you. The fixed values sit behind the (i).
 */
import { CapExcess, QStream, TStream, type Network } from '@squarehole/box-spec';
import { useMemo, useState } from 'react';
import { firstChoice, isOffered, qBurns, qSymbol, sellsLine, sideChoices, sideFacts, sidePending, tokenWord, creatorOnEitherSide, type FeeSide, type KindChoice, type SideKind } from '../boxes/fee-kinds';
import { offeredOn, pendingNote } from '../boxes/spec-network';
import { ethText } from '../boxes/spec-record';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { ChipGroup, InfoLine, type ChipOption, type StepProps } from './create-parts';
import { CAP_EXCESS, CAP_EXCESS_KEY, CAP_PRESETS, Q_ASSETS, capOffered, type CreateForm } from './create-model';
import { FixedValues, feeSplitLine } from './FixedValues';
import { CONTROL } from './reason-copy';

const KIND_LABEL: Readonly<Record<SideKind, string>> = Object.freeze({ creator: 'You', holders: 'Holders', burn: 'Burn' });
const EXCESS_LABEL: Readonly<Record<number, string>> = Object.freeze({ [CapExcess.HOLDERS]: 'Holders', [CapExcess.BURN]: 'Burn', [CapExcess.POOL_DEPTH]: 'Pool' });
const SIDE_LABEL: Readonly<Record<FeeSide, string>> = Object.freeze({ buyers: 'buyers’', sellers: 'sellers’' });
/** Why a holder payout is off on a chain source (F74 U1), the same words for the sides and the cap's excess. */
export const HOLDERS_DEMO_ONLY = 'Not offered here yet: pending legal review.';
/** The chip's short words: offered early ("Pending"), or off on this source ("Not offered here yet"; no Demo word, F130). */
export const PENDING_HINT = 'Pending';
export const DEMO_ONLY_HINT = 'Not offered here yet';

export const tickerOf = (form: Pick<CreateForm, 'ticker'>): string => form.ticker.trim() || 'Token';
export const pairOf = (form: Pick<CreateForm, 'qIndex'>): string => qSymbol(Q_ASSETS[form.qIndex]?.token ?? Q_ASSETS[0]?.token ?? '0x0000000000000000000000000000000000000000');

interface SideProps {
  readonly side: FeeSide;
  readonly form: CreateForm;
  readonly set: StepProps['set'];
  readonly error: string | null;
  readonly network: Network;
}

/**
 * What a side's kinds mean, behind its (i): only the choices this network offers (Sepolia builds no conversion or sell
 * yet: the swap module).
 */
function sideInfo(side: FeeSide, t: string, q: string, network: Network) {
  const converts = isOffered(side, side === 'buyers' ? QStream.CREATOR_IN_T : TStream.CREATOR_IN_Q, network);
  const sells = side === 'sellers' && isOffered('sellers', TStream.SELL_FOR_Q, network);
  return (
    <>
      <p>{side === 'buyers' ? `Buyers pay their 1% in ${q}.` : `Sellers pay their 1% in ${t}.`} This side’s 10/15 goes where you choose.</p>
      <p>{`You: held until graduation, into the refunds if the box fails.${converts ? ` Paid in the other token, it is converted after graduation${side === 'sellers' ? `, which sells ${t} for ${q}` : ''}.` : ''}`}</p>
      <p>{network === 'demo' ? `Holders: paid to ${t} holders. Pending legal review.` : `Holders: not offered here yet, pending legal review; testnet once it is built.`}</p>
      <p>{side === 'buyers' ? `Burn: ${t} is bought back and burned, or the ${q} joins FIT’s burn.` : sells ? `Burn: the ${t} is burned, or sold for ${q} that joins FIT’s burn.` : `Burn: the ${t} is burned.`}</p>
    </>
  );
}

/** "Pending legal review" while a holder payout is chosen (the Demo), in words beside it. */
function PendingNote({ id, note }: { id: string; note: string | null }) {
  if (note === null) return null;
  return (
    <p id={id} className="sh-newbox-pending">
      {note}
    </p>
  );
}

/**
 * Why a choice is off beside the other side's current value (BP-13, the only refused pair): a short visible hint on the
 * chip ("Not with buyers’ Burn KITE") and the full sentence it is described by, each naming the OTHER side's choice.
 */
export function offReason(side: FeeSide, other: number, t: string, q: string, burns: boolean): { readonly hint: string; readonly full: string } {
  const otherSide: FeeSide = side === 'buyers' ? 'sellers' : 'buyers';
  const facts = sideFacts(otherSide, other, burns);
  const choice = facts && facts.kind !== 'stream' ? `${KIND_LABEL[facts.kind]} ${tokenWord(facts.token, t, q)}` : 'its choice';
  const sells = facts?.converts === 'sells' ? ` (${sellsLine(t, q).replace(/^Sells/, 'sells')})` : '';
  return {
    hint: `Not with ${SIDE_LABEL[otherSide]} ${choice}`,
    full: `Not beside ${choice} on ${SIDE_LABEL[otherSide]} fees${sells}: the box would sell and buy back in one pool.`,
  };
}

/** One fee side: who gets it, then what it is paid in (You, Holders) or what it burns (Burn); a sell flagged under it. */
function Side({ side, form, set, error, network }: SideProps) {
  const t = tickerOf(form);
  const q = pairOf(form);
  const id = side === 'buyers' ? CONTROL.buyers : CONTROL.sellers;
  const value = side === 'buyers' ? form.qStream : form.tStream;
  const other = side === 'buyers' ? form.tStream : form.qStream;
  const asset = Q_ASSETS[form.qIndex] ?? Q_ASSETS[0];
  const choices = useMemo(() => sideChoices(side, other, asset, undefined, network), [side, other, asset, network]);
  const current = choices.find((choice) => choice.members.some((member) => member.value === value));
  const member = current?.members.find((entry) => entry.value === value);
  const setValue = (next: number) => set(side === 'buyers' ? { qStream: next } : { tStream: next });
  const laterId = `${id}-later`;
  const pendingId = `${id}-pending`;
  const offId = `${id}-off`;
  const flagId = `${id}-sells`;
  const noteId = `${id}-note`;
  const legendId = `${id}-legend`;
  const off = offReason(side, other, t, q, qBurns(asset));
  const kindOptions = choices.map((choice: KindChoice) => {
    const later = choice.members.length === 0;
    const pending = !later && choice.pending !== null;
    return { value: choice.kind, label: KIND_LABEL[choice.kind], hint: later ? DEMO_ONLY_HINT : pending ? PENDING_HINT : undefined, disabled: later, describedBy: later ? laterId : pending ? pendingId : undefined };
  });
  const sub = current ?? null;
  const note = member ? sidePending(side, member.value) : null;
  const tip = useInfoTip();
  return (
    <fieldset id={id} className="sh-newbox-side" aria-labelledby={legendId} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="sh-newbox-side__legend">
        <span id={legendId}>{`${side === 'buyers' ? 'Buyers’' : 'Sellers’'} fees · ${side === 'buyers' ? q : t}`}</span>
        <InfoButton tip={tip} label={side === 'buyers' ? 'About buyers’ fees' : 'About sellers’ fees'} />
      </legend>
      <InfoPanel tip={tip}>{sideInfo(side, t, q, network)}</InfoPanel>
      <span id={laterId} hidden>
        {HOLDERS_DEMO_ONLY}
      </span>
      <span id={pendingId} hidden>
        {choices.find((choice) => choice.pending !== null)?.pending ?? ''}
      </span>
      <span id={offId} hidden>
        {off.full}
      </span>
      <ChipGroup
        id={`${id}-kind`}
        legend={<span className="sh-visually-hidden">Goes to</span>}
        options={kindOptions}
        value={current?.kind ?? null}
        onChange={(kind) => {
          const choice = choices.find((entry) => entry.kind === kind);
          const next = choice ? firstChoice(choice) : null;
          if (next !== null) setValue(next);
        }}
      />
      {sub ? (
        <ChipGroup
          id={`${id}-token`}
          legend={sub.kind === 'burn' ? 'Burns' : 'Paid in'}
          options={sub.members.map((entry) => ({
            value: entry.value,
            label: tokenWord(entry.token, t, q),
            // Off beside the other side's choice (BP-13): its reason in sight, as Holders show theirs.
            hint: entry.disabled ? off.hint : undefined,
            disabled: entry.disabled,
            describedBy: entry.disabled ? offId : entry.converts === 'sells' && entry.value === value ? flagId : undefined,
          }))}
          value={value}
          onChange={setValue}
        />
      ) : null}
      {/* Always in the page, so the flag and the note are announced when a choice adds them (a region added with its words often is not). */}
      <div className="sh-newbox-side__live" role="status" aria-live="polite">
        {member?.converts === 'sells' ? (
          <p id={flagId} className="sh-newbox-flag">
            {sellsLine(t, q)}
          </p>
        ) : null}
        <PendingNote id={noteId} note={note} />
      </div>
      {error ? (
        <p id={`${id}-error`} className="sh-newbox-error">
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Where fees above the cap may go on `network`, from the enum's members: Holders offered by the sample data marked
 * "Pending" (F74 U1), shown off with "Not offered here yet" on a chain source.
 */
export function excessOptions(network: Network): ChipOption<number>[] {
  return CAP_EXCESS.map((excess) => {
    const off = !offeredOn(CAP_EXCESS_KEY, excess, network);
    const pending = !off && pendingNote('CapExcess', excess) !== null;
    return {
      value: excess,
      label: EXCESS_LABEL[excess] ?? String(excess),
      hint: off ? DEMO_ONLY_HINT : pending ? PENDING_HINT : undefined,
      disabled: off,
      describedBy: off ? `${CONTROL.capExcess}-later` : pending ? `${CONTROL.capExcess}-pending` : undefined,
    };
  });
}

/** "4 ETH / 30 days": the cap per 30 days, a fixed amount (F74 U2; bigint). */
export const capLine = (cap: bigint, q: string): string => `${ethText(cap)} ${q} / 30 days`;

/** Where fees above the cap go, in the (i)'s words, for the choices this network offers (holders: the Demo only, F74 U1). */
const EXCESS_WORDS: readonly (readonly [number, string])[] = [
  [CapExcess.BURN, 'are burned'],
  [CapExcess.POOL_DEPTH, 'go into the pool'],
  [CapExcess.HOLDERS, 'go to holders'],
];

/**
 * The cap's (i): what it is, every excess choice on screen, and how a payout in the token counts against the ETH amount
 * (P, add-on 5 defaults): paid as the token, at the pool's 1-hour average; bought for you from buyers' fees, the ETH its
 * buy spent (only where that choice is offered: not on Sepolia, which has no swap module yet).
 */
function capInfo(form: CreateForm, network: Network): string {
  const t = tickerOf(form);
  const q = pairOf(form);
  const words = EXCESS_WORDS.filter(([excess]) => offeredOn(CAP_EXCESS_KEY, excess, network)).map(([, word]) => word);
  const above = words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? 'are burned');
  const bought = isOffered('buyers', QStream.CREATOR_IN_T, network) ? `; ${t} bought for you counts the ${q} spent` : '';
  return `The most you receive per 30 days, a fixed amount. Above it, fees ${above}. ${t} paid to you counts at the pool’s 1-hour average price${bought}.`;
}

/**
 * The creator-fee cap (add-on 5): closed until wanted ("Fee cap", "Fee cap · 4 ETH / 30 days" once on); opened by an
 * error on it. A fixed amount per 30 days (F74 U2: 1, 4, 8, 16 or 32 ETH, the catalog's `OFFERED_AMOUNTS`), not a
 * share of the target.
 */
function Cap({ form, set, errorFor, network }: StepProps & { readonly network: Network }) {
  const q = pairOf(form);
  const [open, setOpen] = useState(false);
  const options = useMemo(() => excessOptions(network), [network]);
  const excessNote = form.capPerEpoch !== 0n && offeredOn(CAP_EXCESS_KEY, form.capExcess, network) ? pendingNote('CapExcess', form.capExcess) : null;
  const errors = errorFor(CONTROL.cap) !== null || errorFor(CONTROL.capExcess) !== null;
  const hintId = `${CONTROL.cap}-hint`;
  const shown = open || errors;
  return (
    <details className="sh-newbox-more" open={shown} onToggle={(event) => setOpen(event.currentTarget.open)}>
      {/* The amount once: in the summary while closed, on its chip while open (the hint says the period). */}
      <summary>{form.capPerEpoch === 0n || shown ? 'Fee cap' : `Fee cap · ${capLine(form.capPerEpoch, q)}`}</summary>
      <ChipGroup
        id={CONTROL.cap}
        legend="Cap your fees"
        info={{ label: 'About the cap', body: <p>{capInfo(form, network)}</p> }}
        options={CAP_PRESETS.map((cap) => ({ value: cap.toString(), label: cap === 0n ? 'Off' : `${ethText(cap)} ${q}` }))}
        value={form.capPerEpoch.toString()}
        onChange={(cap) => set({ capPerEpoch: BigInt(cap) })}
        error={errorFor(CONTROL.cap)}
        describedBy={hintId}
      />
      <p id={hintId} className="sh-newbox-hint">
        Per 30 days
      </p>
      {form.capPerEpoch !== 0n ? (
        <>
          <span id={`${CONTROL.capExcess}-later`} hidden>
            {HOLDERS_DEMO_ONLY}
          </span>
          <span id={`${CONTROL.capExcess}-pending`} hidden>
            {pendingNote('CapExcess', CapExcess.HOLDERS) ?? ''}
          </span>
          <ChipGroup id={CONTROL.capExcess} legend="Above the cap" options={options} value={form.capExcess} onChange={(capExcess) => set({ capExcess })} error={errorFor(CONTROL.capExcess)} />
          <div role="status" aria-live="polite">
            <PendingNote id={`${CONTROL.capExcess}-note`} note={excessNote} />
          </div>
        </>
      ) : null}
    </details>
  );
}

export interface KindStepProps extends StepProps {
  /** Whose rules apply (F74 U1): the Demo offers holder payouts; a chain source does not. */
  readonly network: Network;
}

export function KindStep(props: KindStepProps) {
  const { form, set, errorFor, network } = props;
  return (
    <>
      <InfoLine label="About the fee split" info={<FixedValues ticker={tickerOf(form)} q={pairOf(form)} />}>
        {feeSplitLine()}
      </InfoLine>
      <Side side="buyers" form={form} set={set} error={errorFor(CONTROL.buyers)} network={network} />
      <Side side="sellers" form={form} set={set} error={errorFor(CONTROL.sellers)} network={network} />
      {creatorOnEitherSide(form.qStream, form.tStream) && capOffered(form.qIndex) ? <Cap {...props} /> : null}
    </>
  );
}
