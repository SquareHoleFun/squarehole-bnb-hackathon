/**
 * The coin picker (SH-V21-FE14): the price coin on Basics and a coin pile's seed coin on Contents, ready for hundreds of
 * listed coins. One radio group, as before (its legend, each coin a radio named by its symbol), now in groups by what a
 * coin is (the native coin, stablecoins, stock-linked coins, box coins, other coins), each sorted by symbol and showing
 * its first SHOWN coins until "Show all" is pressed; a search narrows every group by symbol, name or address once the
 * book has more coins than one group shows (a short book stays a row of chips, the founder's minimal-text rule). The
 * chosen coin always stays on the page, even when a search or a short group would hide it. Two listed coins can share a
 * symbol (a coin's address is its identity, F123): each of those is named with its short address. Nothing is asked of a
 * wallet. SH-218 rail 2: a coin the release switched off (`off`) stays in its group, `aria-disabled`, cannot be chosen,
 * and the picker says so once (line A); the chosen coin is never changed for another.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { CheckIcon, FieldError } from '../create-parts';
import { isBoxToken, type SiteListing } from './listings';
import { ListingClass } from './spec-types';
import { OffLine } from './CreateOptionsLines';

/** How many coins a group shows before "Show all". */
export const SHOWN = 12;
/** Groups in the order they are shown; each coin belongs to exactly one. */
export const COIN_GROUPS = ['native', 'stable', 'stock', 'box', 'other'] as const;
export type CoinGroup = (typeof COIN_GROUPS)[number];
export const COIN_GROUP_LABEL: Readonly<Record<CoinGroup, string>> = { native: 'Native', stable: 'Stablecoins', stock: 'Stock-linked', box: 'Box coins', other: 'Other coins' };

/** A coin's group: a graduated box's coin first by kind, then the listing's class. */
export function coinGroupOf(listing: Pick<SiteListing, 'kind' | 'class'>): CoinGroup {
  if (isBoxToken(listing)) return 'box';
  return listing.class === ListingClass.NATIVE ? 'native' : listing.class === ListingClass.STABLE ? 'stable' : listing.class === ListingClass.STOCK ? 'stock' : 'other';
}

/** Whether a coin matches a search: its symbol or name contains it, or its address starts with it (any letter case). */
export function coinMatches(listing: Pick<SiteListing, 'symbol' | 'name' | 'token'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (/^0x[0-9a-f]*$/.test(q)) return listing.token.toLowerCase().startsWith(q);
  return listing.symbol.toLowerCase().includes(q) || listing.name.toLowerCase().includes(q);
}

/** The coins of each group, sorted by symbol (then listing id), after the search; empty groups left out. */
export function groupCoins(listings: readonly SiteListing[], query: string): readonly (readonly [CoinGroup, readonly SiteListing[]])[] {
  const order = (a: SiteListing, b: SiteListing) => a.symbol.localeCompare(b.symbol, 'en', { sensitivity: 'base' }) || a.id - b.id;
  return COIN_GROUPS.map((group) => [group, listings.filter((l) => coinGroupOf(l) === group && coinMatches(l, query)).sort(order)] as const).filter(([, coins]) => coins.length > 0);
}

/** The symbols more than one listed coin uses (any letter case). */
export function sharedSymbols(listings: readonly Pick<SiteListing, 'symbol'>[]): ReadonlySet<string> {
  const seen = new Set<string>(); const twice = new Set<string>();
  for (const { symbol } of listings) { const key = symbol.toLowerCase(); if (seen.has(key)) twice.add(key); seen.add(key); }
  return twice;
}
/** A coin's name on its chip: its symbol, with its short address when another listed coin uses the same symbol. */
export const coinLabel = (listing: Pick<SiteListing, 'symbol' | 'token'>, shared: ReadonlySet<string>): string =>
  shared.has(listing.symbol.toLowerCase()) ? `${listing.symbol} · ${listing.token.slice(0, 6)}…${listing.token.slice(-4)}` : listing.symbol;

export interface CoinPickerProps {
  /** The group's element id (the page's error summary focuses it). */
  readonly id: string;
  readonly legend: string;
  readonly info?: { readonly label: string; readonly body: ReactNode };
  /** The offered coins (listings.ts `offeredListings`). */
  readonly listings: readonly SiteListing[];
  /** The chosen coin's address, or null. */
  readonly value: string | null;
  readonly onChange: (token: string) => void;
  /** A second line under a coin (the price coin's raise). */
  readonly hint?: (listing: SiteListing) => string | undefined;
  readonly error?: string | null;
  /** SH-218 rail 2: whether choosing this coin needs a switched-off option. */
  readonly off?: (token: string) => boolean;
}

const NONE_OFF = (): boolean => false;

export function CoinPicker({ id, legend, info, listings, value, onChange, hint, error = null, off = NONE_OFF }: CoinPickerProps) {
  const tip = useInfoTip();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const searchable = listings.length > SHOWN;
  const [open, setOpen] = useState<ReadonlySet<CoinGroup>>(() => new Set());
  const groups = useMemo(() => groupCoins(listings, query), [listings, query]);
  const shared = useMemo(() => sharedSymbols(listings), [listings]);
  const chosen = value === null ? null : listings.find((l) => l.token.toLowerCase() === value.toLowerCase()) ?? null;
  // The chosen coin stays on the page: in its group's shown part, or in a row of its own above the groups.
  const shownOf = (group: CoinGroup, coins: readonly SiteListing[]) => (open.has(group) || query.trim() !== '' ? coins : coins.slice(0, SHOWN));
  const visible = new Set(groups.flatMap(([group, coins]) => shownOf(group, coins).map((l) => l.token.toLowerCase())));
  const pinned = chosen && !visible.has(chosen.token.toLowerCase()) ? chosen : null;
  const chip = (listing: SiteListing) => {
    const checked = chosen?.token.toLowerCase() === listing.token.toLowerCase();
    const second = hint?.(listing);
    const isOff = off(listing.token);
    return <label key={listing.token} className="sh-newbox-chip" data-checked={checked || undefined} data-disabled={isOff || undefined}>
      <input type="radio" name={id} value={listing.token} checked={checked} aria-disabled={isOff ? 'true' : undefined} aria-describedby={isOff ? `${id}-off` : undefined}
        onChange={() => { if (!isOff) onChange(listing.token); }} />
      {checked ? <CheckIcon /> : null}
      <span className="sh-newbox-chip__text">{coinLabel(listing, shared)}{second ? <small>{second}</small> : null}</span>
    </label>;
  };
  const errorId = `${id}-error`;
  return <fieldset id={id} className="sh-newbox-chips sh-v2-coins" aria-labelledby={`${id}-legend`} aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined} tabIndex={-1}>
    <legend className="sh-newbox-label"><span id={`${id}-legend`}>{legend}</span>{info ? <InfoButton tip={tip} label={info.label} /> : null}</legend>
    {info ? <InfoPanel tip={tip}>{info.body}</InfoPanel> : null}
    {searchable ? <div className="sh-v2-coins__search">
      <label htmlFor={searchId} className="sh-visually-hidden">{`Find a coin · ${legend}`}</label>
      <input id={searchId} type="search" className="sh-newbox-input" placeholder="Symbol, name or 0x…" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      <small className="sh-newbox-hint" aria-live="polite">{query.trim() === '' ? `${listings.length} coins` : `${groups.reduce((n, [, coins]) => n + coins.length, 0)} of ${listings.length}`}</small>
    </div> : null}
    {pinned ? <div className="sh-v2-coins__group" data-group="chosen"><span className="sh-v2-coins__name">Chosen</span><div className="sh-newbox-chips__row">{chip(pinned)}</div></div> : null}
    {groups.map(([group, coins]) => {
      const shown = shownOf(group, coins);
      return <div key={group} className="sh-v2-coins__group" role="group" aria-label={COIN_GROUP_LABEL[group]} data-group={group}>
        <span className="sh-v2-coins__name" aria-hidden="true">{`${COIN_GROUP_LABEL[group]} · ${coins.length}`}</span>
        <div className="sh-newbox-chips__row">{shown.map(chip)}</div>
        {shown.length < coins.length ? <button type="button" className="sh-button sh-v2-coins__more" onClick={() => setOpen((before) => new Set([...before, group]))}>{`Show all ${coins.length}`}</button> : null}
      </div>;
    })}
    {groups.length === 0 ? <p className="sh-newbox-hint" role="status">{`No listed coin matches “${query.trim()}”.`}</p> : null}
    {listings.some((listing) => off(listing.token)) ? <OffLine id={`${id}-off`} /> : null}
    <FieldError id={errorId} message={error} />
  </fieldset>;
}
