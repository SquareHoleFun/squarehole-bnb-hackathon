/** The BNB Boxes feed's three views, with the current view and the box filters kept in the URL. */
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { LaunchRail } from '../launch-cards/launch-reads';
import { TESTNET } from '@squarehole/chain/write/wallet';
import { LAUNCH_ON_WORDS } from '../create/picture/LaunchOn';

interface RailsProps {
  readonly params: URLSearchParams;
  readonly network?: string;
}

const MAINNET = import.meta.env?.SH_PRODUCTION === true && import.meta.env?.SH_TEST_NETWORK !== true;

export function activeLaunchRail(params: URLSearchParams, network = TESTNET.name): LaunchRail | null {
  if (MAINNET || network !== 'bnb') return null;
  const on = params.get('on');
  return on === 'flap' || on === 'four' ? on : null;
}

function RailsRow({ params, network = TESTNET.name }: RailsProps) {
  if (network !== 'bnb') return null;
  const rail = activeLaunchRail(params, network);
  const option: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 36, padding: '0 14px', borderRadius: 'var(--sh-radius-pill, 999px)',
    color: 'var(--sh-text-secondary, #b5c0d5)', textDecoration: 'none', fontWeight: 700, fontSize: 'var(--sh-type-small, 14px)' };
  const current: CSSProperties = { ...option, background: 'var(--sh-selected, #241e4f)', color: 'var(--sh-text, #f3f5fb)', boxShadow: 'inset 0 -3px 0 var(--sh-accent, #a78bfa)' };
  function tab(value: LaunchRail | null, label: string) {
    if (rail === value) return <span aria-current="page" style={current}>{label}</span>;
    const next = new URLSearchParams(params);
    if (value === null) next.delete('on');
    else next.set('on', value);
    return <Link to={{ pathname: '/', search: next.toString() }} style={option}>{label}</Link>;
  }
  return (
    // The group's name is the "Launch on" row's own (no new words).
    <div role="group" aria-label={LAUNCH_ON_WORDS.label} data-launch-rails="" style={{ display: 'flex', marginBottom: 'var(--sh-gap-2, 8px)' }}>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', border: '1px solid var(--sh-border-strong, #63769b)', borderRadius: 'var(--sh-radius-pill, 999px)', padding: 2 }}>
        {tab(null, 'Boxes')}
        {tab('flap', 'On Flap')}
        {tab('four', 'On Four.meme')}
      </span>
    </div>
  );
}

function NoRails(): null { return null; }

/** A mainnet build (production and not a test network) folds this to nothing, so the row never ships there. */
export const LaunchRails: (props: RailsProps) => ReturnType<typeof RailsRow> = MAINNET ? NoRails : RailsRow;
