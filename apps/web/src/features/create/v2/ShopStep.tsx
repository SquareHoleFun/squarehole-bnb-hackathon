/**
 * A shop's settings on the Contents step (box type SHOP; shop.ts): the seed and the four give tiers in the box's own
 * coin, the pick multiple, the two weekly limits, how long a new entry waits, the curator (or none: a fixed list) and
 * the starting collections with their tiers and the creator's starter ids. Numbers and chips first, one short line
 * where a number needs one; the rules are behind each (i). Only presets the factory accepts are offered (shop.ts).
 */
import { formatUnits, type Address } from '@squarehole/domain';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { ChipGroup, FieldError, TextField } from '../create-parts';
import {
  SHOP_COLLECTION_BPS,
  SHOP_CONTROL,
  SHOP_LIST_DELAY_DAYS,
  SHOP_MAX_COLLECTIONS,
  SHOP_PICK_BPS,
  SHOP_STARTER_MIN,
  SHOP_TIERS,
  SHOP_WEEKLY_BPS,
  addressOf,
  bpsPercent,
  cheapestListedGive,
  pickText,
  shopConfigOf,
  tOf,
  type CollectionCheck,
  type ShopChoice,
  type ShopTier,
} from './shop';

export interface ShopStepProps {
  readonly shop: ShopChoice;
  /** The ticker as typed on Basics ("T" until there is one). */
  readonly ticker: string;
  /** The connected wallet: the curator by default. */
  readonly owner: Address | null;
  /** The chain's answer per typed collection (shop-checks.ts); undefined where nothing is asked (the Demo). */
  readonly checks?: ReadonlyMap<string, CollectionCheck | 'unknown'>;
  readonly onChange: (shop: ShopChoice) => void;
  readonly errorFor: (control: string) => string | null;
  readonly touch: (control: string) => void;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The four give tiers: one field each, cheapest first, under one legend and its (i). */
function Tiers({ shop, ticker, onChange, errorFor, touch }: Pick<ShopStepProps, 'shop' | 'ticker' | 'onChange' | 'errorFor' | 'touch'>) {
  const tip = useInfoTip();
  const set = (i: number, text: string) => onChange({ ...shop, prices: shop.prices.map((price, j) => (j === i ? text : price)) as unknown as ShopChoice['prices'] });
  return (
    <fieldset id={SHOP_CONTROL.tiers} className="sh-v2-shop-tiers" tabIndex={-1} aria-labelledby={`${SHOP_CONTROL.tiers}-legend`}>
      <legend className="sh-newbox-label">
        <span id={`${SHOP_CONTROL.tiers}-legend`}>{`Give tiers · ${ticker}`}</span> <InfoButton tip={tip} label="About the give tiers" />
      </legend>
      <InfoPanel tip={tip}>
        <p>{`What the shop pays in ${ticker} for one item of a collection at that tier. Fixed at Create, for good; each tier above the one before.`}</p>
      </InfoPanel>
      <div className="sh-v2-shop-tiers__row">
        {SHOP_TIERS.map((tier) => (
          <TextField
            key={tier}
            id={SHOP_CONTROL.tier(tier)}
            label={`Tier ${tier + 1}`}
            value={shop.prices[tier] ?? ''}
            inputMode="decimal"
            placeholder="0"
            onChange={(text) => set(tier, text)}
            onBlur={() => touch(SHOP_CONTROL.tier(tier))}
            error={errorFor(SHOP_CONTROL.tier(tier))}
          />
        ))}
      </div>
      <p className="sh-newbox-hint">What a giver gets, cheapest first</p>
    </fieldset>
  );
}

/** The starting collections: an address, a tier and starter ids each, 1 to 64, behind one legend and its (i). */
function Collections({ shop, ticker, checks, onChange, errorFor, touch }: Pick<ShopStepProps, 'shop' | 'ticker' | 'checks' | 'onChange' | 'errorFor' | 'touch'>) {
  const tip = useInfoTip();
  const rows = shop.collections;
  const price = (tier: ShopTier) => tOf(shop.prices[tier] ?? '');
  const setRow = (i: number, patch: Partial<ShopChoice['collections'][number]>) => onChange({ ...shop, collections: rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  const error = errorFor(SHOP_CONTROL.collections);
  return (
    <fieldset id={SHOP_CONTROL.collections} className="sh-v2-shop-collections" tabIndex={-1} aria-labelledby={`${SHOP_CONTROL.collections}-legend`} aria-describedby={error ? `${SHOP_CONTROL.collections}-error` : undefined}>
      <legend className="sh-newbox-label">
        <span id={`${SHOP_CONTROL.collections}-legend`}>{`Collections · ${rows.length}/${SHOP_MAX_COLLECTIONS}`}</span> <InfoButton tip={tip} label="About the starting collections" />
      </legend>
      <InfoPanel tip={tip}>
        <p>ERC-721 collections whose items the shop takes in, each at one tier. Each takes gives once the wait for new entries has passed after Create. The curator can add more later.</p>
        <p>{`Starter ids: items of yours the shop holds from the start, ${SHOP_STARTER_MIN} or more in all, or none. After Create each is approved and loaded from your wallet.`}</p>
      </InfoPanel>
      <ol className="sh-v2-shop-rows">
        {rows.map((row, i) => {
          const address = addressOf(row.address);
          const check = address ? checks?.get(address.toLowerCase()) : undefined;
          return (
            <li key={i} className="sh-v2-shop-row">
              <TextField
                id={SHOP_CONTROL.collection(i)}
                label={`Collection ${i + 1}`}
                value={row.address}
                placeholder="0x…"
                spellCheck={false}
                onChange={(text) => setRow(i, { address: text })}
                onBlur={() => touch(SHOP_CONTROL.collection(i))}
                error={errorFor(SHOP_CONTROL.collection(i))}
                hint={check === 'erc721' ? 'ERC-721' : undefined}
              />
              <ChipGroup
                id={`${SHOP_CONTROL.collection(i)}-tier`}
                legend={<>{'Tier '}<span className="sh-visually-hidden">{`of collection ${i + 1}`}</span></>}
                options={SHOP_TIERS.map((tier) => {
                  const give = price(tier);
                  return { value: tier, label: String(tier + 1), ...(give !== null && give > 0n ? { hint: `${formatUnits(give, 18)} ${ticker}` } : {}) };
                })}
                value={row.tier}
                onChange={(tier) => setRow(i, { tier })}
              />
              <TextField
                id={SHOP_CONTROL.starters(i)}
                // "Starter ids 1", beside "Collection 1": a name that never contains another field's ("Collection 1").
                label={<>{'Starter ids '}<span className="sh-visually-hidden">{String(i + 1)}</span></>}
                value={row.ids ?? ''}
                placeholder="1, 2, 5-9"
                spellCheck={false}
                onChange={(ids) => setRow(i, { ids })}
                onBlur={() => touch(SHOP_CONTROL.starters(i))}
                error={errorFor(SHOP_CONTROL.starters(i))}
              />
              {rows.length > 1 ? (
                <button type="button" className="sh-button sh-newbox-remove" aria-label={`Remove collection ${i + 1}`} onClick={() => onChange({ ...shop, collections: rows.filter((_, j) => j !== i) })}>
                  ×
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <button type="button" className="sh-button" disabled={rows.length >= SHOP_MAX_COLLECTIONS} onClick={() => onChange({ ...shop, collections: [...rows, { address: '', tier: 0, ids: '' }] })}>
        Add collection
      </button>
      <FieldError id={`${SHOP_CONTROL.collections}-error`} message={error} />
    </fieldset>
  );
}

export function ShopStep({ shop, ticker: typed, owner, checks, onChange, errorFor, touch }: ShopStepProps) {
  const ticker = typed || 'T';
  const cheapest = cheapestListedGive(shopConfigOf(shop, owner));
  const minimum = cheapest !== null && cheapest > 0n ? `${formatUnits(2n * cheapest, 18)} ${ticker}` : null;
  return (
    <div className="sh-v2-shop">
      <TextField
        id={SHOP_CONTROL.seed}
        label={`Seed · ${ticker}`}
        value={shop.seed}
        inputMode="decimal"
        placeholder="0"
        onChange={(seed) => onChange({ ...shop, seed })}
        onBlur={() => touch(SHOP_CONTROL.seed)}
        error={errorFor(SHOP_CONTROL.seed)}
        hint={minimum ? `At least ${minimum} · from your first buy` : 'From your first buy'}
      />
      <Tiers shop={shop} ticker={ticker} onChange={onChange} errorFor={errorFor} touch={touch} />
      <ChipGroup
        id={SHOP_CONTROL.pick}
        legend="Pick"
        info={{ label: 'About the pick price', body: <>
          <p>{`A pick costs this multiple of the item’s give price, rounded up, in ${ticker}, and goes into the budget.`}</p>
          <p>Always above the give price, so giving an item and picking it back cannot empty the budget. The last item always stays.</p>
        </> }}
        options={SHOP_PICK_BPS.map((bps) => ({ value: bps, label: pickText(bps) }))}
        value={shop.pickBps}
        onChange={(pickBps) => onChange({ ...shop, pickBps })}
        error={errorFor(SHOP_CONTROL.pick)}
      />
      <ChipGroup
        id={SHOP_CONTROL.weekly}
        legend="Gives a week"
        info={{ label: 'About the weekly limit', body: <>
          <p>At most this share of the budget pays for gives each week, and never less than one cheapest give while the budget covers it.</p>
          <p>A week’s first give or pick fixes that week’s budget. Picks pay for later weeks; unused room does not carry over.</p>
        </> }}
        options={SHOP_WEEKLY_BPS.map((bps) => ({ value: bps, label: bpsPercent(bps) }))}
        value={shop.weeklyBps}
        onChange={(weeklyBps) => onChange({ ...shop, weeklyBps })}
        error={errorFor(SHOP_CONTROL.weekly)}
      />
      <ChipGroup
        id={SHOP_CONTROL.perCollection}
        legend="Per collection a week"
        info={{ label: 'About the limit per collection', body: <p>The same kind of limit for each collection on its own, also never less than one cheapest give.</p> }}
        options={SHOP_COLLECTION_BPS.map((bps) => ({ value: bps, label: bpsPercent(bps) }))}
        value={shop.collectionBps}
        onChange={(collectionBps) => onChange({ ...shop, collectionBps })}
        error={errorFor(SHOP_CONTROL.perCollection)}
      />
      <ChipGroup
        id={SHOP_CONTROL.delay}
        legend="New entries wait · days"
        info={{ label: 'About the wait for new entries', body: <p>A collection takes gives only this long after it is listed: the starting ones after Create, a later one after the curator adds it.</p> }}
        options={SHOP_LIST_DELAY_DAYS.map((days) => ({ value: days, label: String(days), heard: 'days' }))}
        value={shop.listDelayDays}
        onChange={(listDelayDays) => onChange({ ...shop, listDelayDays })}
        error={errorFor(SHOP_CONTROL.delay)}
      />
      <ChipGroup
        id={SHOP_CONTROL.curator}
        legend="Curator"
        info={{ label: 'About the curator', body: <>
          <p>The curator can only add collections, at most one a week, each at a tier fixed for good. Nobody can remove a collection or change a price.</p>
          <p>Handing over needs the next curator to accept. Renouncing freezes the list.</p>
        </> }}
        options={[
          { value: 'creator' as const, label: 'You', hint: owner ? short(owner) : 'Your wallet' },
          { value: 'address' as const, label: 'Another address', hint: 'A Safe works' },
          { value: 'none' as const, label: 'No curator', hint: 'Fixed list' },
        ]}
        value={shop.curator}
        onChange={(curator) => onChange({ ...shop, curator })}
      />
      {shop.curator === 'address' ? (
        <TextField
          id={SHOP_CONTROL.curatorAddress}
          label="Curator address"
          value={shop.curatorAddress}
          placeholder="0x…"
          spellCheck={false}
          onChange={(curatorAddress) => onChange({ ...shop, curatorAddress })}
          onBlur={() => touch(SHOP_CONTROL.curatorAddress)}
          error={errorFor(SHOP_CONTROL.curatorAddress)}
        />
      ) : null}
      <Collections shop={shop} ticker={ticker} checks={checks} onChange={onChange} errorFor={errorFor} touch={touch} />
    </div>
  );
}
