/**
 * M3's coin pile on the Contents step of a token-only box (box type PILE; S1 `PileParams`; R43-M3D/M3E): one listed
 * seed coin and an exact seed, loaded by the creator after Create, and v2.1 step 3's fixed leave-behind (0% or 5%). A
 * pile in the box's own price coin can also take fees (To the pile, at Fees). Numbers and chips first; the visible
 * sentences are the leave-behind's line and the no-rescue line, the rest is behind the (i).
 */
import { ChipGroup, TextField } from '../create-parts';
import { CoinPicker } from './CoinPicker';
import { offeredListings, type SiteListing } from './listings';
import { LEAVE_BEHIND_PRESETS, V2_CONTROL, newPile, type PileChoice } from './model';
import { NO_RESCUE_LINE } from '../../core/v2/v2-words';
import { OffLine } from './CreateOptionsLines';

export interface PileStepProps {
  readonly pile: PileChoice | null;
  readonly pricing: SiteListing;
  readonly listings: readonly SiteListing[];
  readonly onChange: (pile: PileChoice | null) => void;
  readonly errorFor: (control: string) => string | null;
  readonly touch: (control: string) => void;
  /** SH-218 rail 2: whether adding a coin pile needs a switched-off option (the box kind), and each seed coin. */
  readonly off?: { readonly pile: boolean; readonly coin: (token: string) => boolean };
}

/** The leave-behind line (v2.1 step 3): what 5% does, in one sentence within the step's word budget; the (i) says the rest. */
export const LEAVE_BEHIND_LINE = 'With 5%, everyone taking their share leaves 5% behind.';

export function PileStep({ pile, pricing, listings, onChange, errorFor, touch, off }: PileStepProps) {
  const offered = offeredListings(listings);
  const coin = pile ? offered.find((l) => l.token.toLowerCase() === pile.asset.toLowerCase()) ?? null : null;
  return <>
    <ChipGroup
      id={V2_CONTROL.pile}
      legend="Coin pile"
      info={{ label: 'About the coin pile', body: <>
        <p>One listed coin, other than this box’s own. You are the seeder: load the exact seed after Create. A nonzero seed must arrive before trading opens. It is separate from the creation payment.</p>
        <p>{`A pile in the price coin (${pricing.symbol}) can also take fees: To the pile, at Fees. They wait until graduation, then anyone moves them into the pile.`}</p>
        <p>After graduation, holders hand in the box coin for its share of the pile’s live balance; the coins handed in are burned. If the box fails, only the recorded seed goes back to you; fees not yet moved join the closing claim.</p>
      </> }}
      options={[{ value: 'none', label: 'None' }, { value: 'pile', label: 'Coin pile', hint: 'One seed coin', ...(off?.pile ? { disabled: true, describedBy: `${V2_CONTROL.pile}-off` } : {}) }]}
      value={pile ? 'pile' : 'none'}
      onChange={(choice) => onChange(choice === 'pile' ? pile ?? newPile(pricing.token) : null)}
    />
    {off?.pile ? <OffLine id={`${V2_CONTROL.pile}-off`} /> : null}
    {pile ? <>
      <CoinPicker
        id={V2_CONTROL.pileCoin}
        legend="Seed coin"
        listings={offered}
        value={coin?.token ?? null}
        onChange={(asset) => onChange({ ...pile, asset })}
        error={errorFor(V2_CONTROL.pileCoin)}
        off={off?.coin}
      />
      <TextField
        id={V2_CONTROL.pileSeed}
        label={`Seed · ${coin?.symbol ?? '?'}`}
        value={pile.seed}
        inputMode="decimal"
        placeholder="0"
        onChange={(seed) => onChange({ ...pile, seed })}
        onBlur={() => touch(V2_CONTROL.pileSeed)}
        error={errorFor(V2_CONTROL.pileSeed)}
        hint="From you, after Create"
      />
      <ChipGroup
        id={V2_CONTROL.pileLeave}
        legend="Leave behind"
        info={{ label: 'About leaving some behind', body: <>
          <p>Fixed at Create. With 5%, each holder who hands in coins gets 95% of their share of the pile; the other 5% stays in the pile for those still holding.</p>
          <p>Whoever hands in every coin still out takes the whole pile, so nothing stays behind.</p>
        </> }}
        options={LEAVE_BEHIND_PRESETS.map((bps) => ({ value: bps, label: `${bps / 100}%` }))}
        value={pile.leaveBehindBps ?? 0}
        onChange={(leaveBehindBps) => onChange({ ...pile, leaveBehindBps })}
        error={errorFor(V2_CONTROL.pileLeave)}
      />
      <p className="sh-newbox-hint">{LEAVE_BEHIND_LINE}</p>
      <p className="sh-newbox-hint" data-no-rescue="">{NO_RESCUE_LINE}</p>
    </> : null}
  </>;
}
