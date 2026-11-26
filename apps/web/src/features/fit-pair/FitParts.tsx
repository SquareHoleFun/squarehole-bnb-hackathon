import { LAUNCH_TAX_TABLE_PIPS, type CurveShape } from '@squarehole/indexer/client';
import type { ReactNode } from 'react';
import type { Freshness, LiveView } from './live-controller';
import { blocks, formatBlock, formatTaxPips } from './fit-format';
import { graduationBandSqrtX96, type FitMarketTarget } from './fit-target';
import { tierOfBlock, type LiveData } from './live-model';
import type { FitMarketNames } from './market-names';


/**
 * The approved FIT icon (packages/design/art/fit/fit-icon-small.svg; F20 (5), (6)): the lavender round coin with a
 * square hole, no gold version, nothing inside. Same paths and colours as the file (FitParts.test.tsx compares them).
 */
export const FIT_ICON_PATHS = Object.freeze([
  { fill: '#6D4AE2', d: 'M12 0a12 12 0 1 1 0 24a12 12 0 1 1 0-24ZM7 7v10h10V7Z' },
  { fill: '#A78BFA', d: 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20ZM6 6v12h12V6Z' },
]);

export function FitIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {FIT_ICON_PATHS.map((path) => (
        <path key={path.fill} fill={path.fill} fillRule="evenodd" d={path.d} />
      ))}
    </svg>
  );
}

/**
 * A rehearsal's icon: the plain grey tile its neutral collection shows on chain (`#6b7280`, contractURI), never the
 * FIT art, so nothing on a neutral market's page looks like the launch's.
 */
export function NeutralIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#6b7280" />
    </svg>
  );
}

/** The market's icon: the approved FIT icon for the launch, the neutral tile for a rehearsal with neutral names. */
export function MarketIcon({ names, size, className }: { names: FitMarketNames; size?: number; className?: string }) {
  return names.kind === 'launch' ? <FitIcon size={size} className={className} /> : <NeutralIcon size={size} className={className} />;
}

/** Small decorative 16 px glyphs (text always names the state next to them). */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg className="sh-glyph" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const PulseIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="5.6" />
  </Glyph>
);

export const ClockIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.8V8l2.2 1.4" />
  </Glyph>
);

export const AlertIcon = () => (
  <Glyph>
    <path d="M8 2.5 14 13H2L8 2.5Z" />
    <path d="M8 6.6v3M8 11.4h.01" />
  </Glyph>
);

export const LockIcon = () => (
  <Glyph>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </Glyph>
);

/** A right-pointing chevron; turned down by CSS when its disclosure is open. */
export const DisclosureIcon = () => (
  <Glyph>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Glyph>
);

export const ChainIcon = () => (
  <Glyph>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7.2 4.6 8.4 3.4a2.6 2.6 0 0 1 3.7 3.7L10.9 8.3M8.8 11.4l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" />
  </Glyph>
);

const FRESHNESS_WORD: Readonly<Record<Freshness, string>> = {
  connecting: 'Connecting',
  live: 'Live',
  polling: 'Polling',
  direct: 'Direct chain read',
  stale: 'Stale',
  unverified: 'Unverified',
  unavailable: 'Unavailable',
};

/** Whether the newest block is final yet (said in the curve's info panel; the drawing shows it as the dashed ring). */
export function headTierText(data: LiveData): string {
  const tier = tierOfBlock(data.head.number, data);
  return tier === 'head' ? 'not final' : tier === 'confirmed' ? 'confirmed, not final' : tier === 'safe' ? 'safe' : 'final';
}

/**
 * The one freshness word ("Live", "Polling", "Stale", "Unverified", …). The sample stream takes the same words: no Demo
 * label anywhere in the UI (F130, superseding "mock data stays labelled Demo").
 */
export function freshnessWord(view: Pick<LiveView, 'freshness'>): string {
  return FRESHNESS_WORD[view.freshness];
}

/** "Connecting" keeps the still clock: the curve below already shows the logo loader for that wait (one wait, one loader). */
export function FreshnessIcon({ freshness }: { freshness: Freshness }) {
  if (freshness === 'live' || freshness === 'polling') return <PulseIcon />;
  if (freshness === 'direct') return <ChainIcon />;
  return freshness === 'connecting' ? <ClockIcon /> : <AlertIcon />;
}

/** "since block B" for stale data; otherwise null (the caller names its own block). */
export function staleDetail(view: Pick<LiveView, 'freshness' | 'staleSinceBlock'>): string | null {
  return view.freshness === 'stale' && view.staleSinceBlock !== null ? `since block ${formatBlock(view.staleSinceBlock)}` : null;
}

/**
 * The page's one freshness chip (VL-7): "Live", "Polling", "Direct chain read", "Unverified", and
 * "Stale · since block B", the one state where the block is news. The newest block is in the chip's title and in the
 * curve's info panel. Only the word is a live region, so a screen reader hears a change of state, not every block.
 */
export function LiveChip({ view }: { view: LiveView }) {
  const stale = staleDetail(view);
  const head = view.data ? `Block ${formatBlock(view.data.head.number)}` : undefined;
  return (
    <p className="sh-fit-chip" data-freshness={view.freshness} title={head}>
      <FreshnessIcon freshness={view.freshness} />
      <span role="status" aria-live="polite" className="sh-fit-chip__word">
        {freshnessWord(view)}
      </span>
      {stale ? <span className="sh-fit-chip__detail"> · {stale}</span> : null}
    </p>
  );
}

/** Terms 5.6 (f): graduation needs the price within about 0.1% of the target (`PriceOutOfBand` otherwise). */
function graduationWhen(data: LiveData, curve: Pick<CurveShape, 'tickLower'>): string {
  const state = data.state;
  const from = state.graduatesFromBlock;
  const head = data.head.number;
  if (from === null) return '';
  const band = 'in any block where the price is within about 0.1% of the target';
  if (from > head) return `Anyone can trigger graduation from block ${formatBlock(from)} (in ${blocks(from - head)}), ${band}.`;
  const inside = state.sqrtPriceX96 <= graduationBandSqrtX96(curve);
  return `Anyone can trigger graduation from block ${formatBlock(from)}, ${band}. At block ${formatBlock(state.block)} the price is ${
    inside ? 'within that band.' : 'outside that band, so graduation waits until it is back inside.'
  }`;
}

export interface PhaseText {
  /** The phase chip in the header (1–2 words). */
  readonly label: string;
  /** The one line under it, or null when the chip already says it (the launch tax whenever it applies). */
  readonly short: string | null;
  /** Everything else, for the curve's info panel (null when the curve's own explanation covers it). */
  readonly detail: string | null;
}

const FIRST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS[0] ?? 0);
const LAST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0);

/** The completed phase's line: pending, and whether anyone can trigger graduation in this block (Terms 5.6 (f)). */
function pendingLine(data: LiveData, curve: Pick<CurveShape, 'tickLower'>): string {
  const from = data.state.graduatesFromBlock;
  const head = data.head.number;
  if (from === null) return 'Graduation pending';
  if (from > head) return `Graduation pending · possible in ${blocks(from - head)}`;
  return data.state.sqrtPriceX96 <= graduationBandSqrtX96(curve) ? 'Graduation pending · anyone can trigger it' : 'Graduation pending · price outside the band';
}

/**
 * The launch phase in words (v2 docs/02 states as the hook reports them). 100% is not graduation (BOX-SYSTEM § 4.1).
 * The launch tax is named on the first screen whenever it applies or is about to (F33): before the open its range,
 * in the window the next block's rate. A charge is never rounded down (`formatTaxPips`).
 */
export function phaseText(data: LiveData, market: Pick<FitMarketTarget, 'curve' | 'names'>): PhaseText {
  const { curve, names } = market;
  const state = data.state;
  const head = data.head.number;
  if (state.phase === 'migrated') {
    // F49 D3: the pool is closed to outside liquidity for good, so the page no longer says when outside liquidity may
    // be added (the deployed hook's `liquidityOpensAt()` is still read; the pool rebuild removes it).
    return {
      label: 'Graduated',
      short: `Since block ${formatBlock(state.migratedBlock ?? head)}`,
      detail: `The curve has ended: its ETH and the rest of the ${names.tokenSymbol} now sit in the same pool in the graduation layout, and the ${names.kind === 'launch' ? 'Misfits' : names.collectionName} vault is open.`,
    };
  }
  if (state.phase === 'completed') {
    const when = graduationWhen(data, curve);
    return {
      label: 'Target reached',
      short: pendingLine(data, curve),
      detail: `Target reached at block ${formatBlock(state.completedBlock ?? head)}. ${when ? `${when} ` : ''}A large sell left standing at a block end can still reopen the curve before then.`,
    };
  }
  const w = data.window;
  if (w.status === 'before_open') {
    return { label: 'Not open yet', short: `Opens in ${blocks(w.blocksToOpen + 1n)} · launch tax ${FIRST_TAX} → ${LAST_TAX} on buys`, detail: 'No route can buy before the open.' };
  }
  if (w.status === 'router_window') {
    return {
      label: 'Launch window',
      short: `Launch tax ${formatTaxPips(w.nextBlockTaxPips)} on buys · ${blocks(w.blocksToClose)} left`,
      detail: 'For 32 blocks, buys go only through the launch router, at a tax that falls every block. The price shown is the pool’s, before that tax.',
    };
  }
  return { label: 'Curve open', short: null, detail: null };
}
