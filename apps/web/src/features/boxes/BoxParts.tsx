/**
 * Small shared pieces of the box interface: the state chip and the state band (text, never colour alone), the chain
 * chip, the Demo tape, the progress bar, the box cover, the wallet's box shell and the Demo toy blocks. Decorative
 * glyphs are hidden from screen readers; every state is said in words next to them.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';
import { boxArt } from '@squarehole/design';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { FitIcon, NeutralIcon } from '../fit-pair/FitParts';
import { WithheldTile } from '../pictures/WithheldTile';
import { STATE_LABELS, type BoxRecord, type BoxState } from './box-model';
import { canLoad, lookupOf, usePictureState } from './box-pictures';
import { chooseSlotPicture, groundUrl, NO_SOURCE, SLOT_ORDER, SLOT_WAIT_MS, slotSource, type PictureRole, type PictureSlot, type SlotChoice } from './picture-slot';
import type { FamilyRow } from './misfits-content';


function Glyph({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="sh-box-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const STATE_GLYPHS: Readonly<Record<BoxState, ReactNode>> = {
  upcoming: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  window: <path d="M19 5 5 19M7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />,
  bonding: (
    <>
      <path d="M4 19c6 0 9-4 11-9s3-5 5-5" />
      <path d="M4 19h16" />
    </>
  ),
  graduating: <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8s8 3 8 8" />,
  graduated: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  failed: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
};

export const BoxGlyph = () => (
  <Glyph>
    <path d="M3 8l9-4 9 4-9 4z" />
    <path d="M3 8v8l9 4 9-4V8M12 12v8" />
  </Glyph>
);

/** A coin: a plain token launch (Token). */
export const CoinGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
  </Glyph>
);

/** A grid of squares: a collection of items. */
export const GridGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Glyph>
);

export const WalletGlyph = () => (
  <Glyph>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18M16 14.5h.01" />
  </Glyph>
);

export const LockGlyph = () => (
  <Glyph>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Glyph>
);

export const SwapGlyph = () => (
  <Glyph>
    <path d="M7 8h12l-3-3M17 16H5l3 3" />
  </Glyph>
);

export const ClaimGlyph = () => (
  <Glyph>
    <path d="M4 14h4l1.5 2h5L16 14h4v6H4z" />
    <path d="M12 3v9M8.5 8.5 12 12l3.5-3.5" />
  </Glyph>
);

export const StoreGlyph = () => (
  <Glyph>
    <path d="M4 10h16l-1.5-5h-13zM5 10v9h14v-9M10 19v-5h4v5" />
  </Glyph>
);

export const OutGlyph = () => (
  <Glyph>
    <path d="M4 14v6h16v-6" />
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
  </Glyph>
);

export const InGlyph = () => (
  <Glyph>
    <path d="M4 14v6h16v-6" />
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
  </Glyph>
);

export const UserGlyph = () => (
  <Glyph>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Glyph>
);

export const CountersGlyph = () => (
  <Glyph>
    <rect x="3.5" y="4" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="4" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="14" width="7" height="7" rx="1.5" />
    <path d="M17 14.5v6M14 17.5h6" />
  </Glyph>
);

/** A stack of cards: items held whose ids the app cannot list yet. */
export const StackGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="6" y="7" width="12" height="14" rx="2" />
    <path d="M8 4h10a2 2 0 0 1 2 2v11" />
  </Glyph>
);

export const ExternalGlyph = () => (
  <Glyph size={14}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Glyph>
);

export const EthGlyph = () => (TESTNET.name === 'sepolia' ? (
  <svg className="sh-box-glyph" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M12 2 5.5 12.3 12 16l6.5-3.7z" />
    <path d="M12 17.3 5.5 13.6 12 22l6.5-8.4z" opacity=".7" />
  </svg>
) : (
  // SH-258: another test network (BNB Chain testnet) gets a plain square on its point, not Ethereum's mark.
  <svg className="sh-box-glyph" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false" data-glyph="testnet">
    <path fillRule="evenodd" d="M12 3 21 12 12 21 3 12zm0 5.5L8.5 12 12 15.5 15.5 12z" />
  </svg>
));

/** The state in words with its glyph (never colour alone). */
export function StateChip({ state, className = '' }: { state: BoxState | null; className?: string }) {
  if (state === null) {
    return <span className={`sh-box-state ${className}`} data-state="unavailable">Unavailable</span>;
  }
  return (
    <span className={`sh-box-state ${className}`} data-state={state}>
      <Glyph size={14}>{STATE_GLYPHS[state]}</Glyph>
      {STATE_LABELS[state]}
    </span>
  );
}

/**
 * The state band along the cover's bottom edge (BOX-INTERFACE § 6: the state is never hidden): the state's colour, its
 * glyph, its name and the one figure that matters in it ("Bonding · 30.5% · 1.2867 / 4.206980085 ETH"), with a thin bar
 * while a curve runs. The words carry the state; the colour only repeats it.
 */
/** `label` replaces the state's word (a closed v2 box says "Closed", F100). */
export function StateBand({ state, figure, barBps, className = '', label }: { state: BoxState | null; figure: string | null; barBps: number | null; className?: string; label?: string }) {
  return (
    <p className={`sh-box-band ${className}`} data-state={state ?? 'unavailable'}>
      <span className="sh-box-band__label">
        {state ? <Glyph size={15}>{STATE_GLYPHS[state]}</Glyph> : null}
        {state ? (label ?? STATE_LABELS[state]) : 'Unavailable'}
      </span>
      {figure ? (
        <span className="sh-box-band__figure">
          <span className="sh-visually-hidden">: </span>
          {figure}
        </span>
      ) : null}
      {barBps !== null ? <Bar bps={barBps} /> : null}
    </p>
  );
}

/** What the chain chip needs: the chain id, the sample flag, and whether the box is on a local chain (a twin may carry Sepolia's id). */
export type ChainChipRecord = Pick<BoxRecord, 'chainId' | 'demo'> & { readonly row?: BoxRecord['row']; readonly local?: boolean; readonly v2Chain?: BoxRecord['v2Chain'] };

/**
 * A short chain name for the chip ("Sepolia", "Local chain"; the sample data's chain 31337 is a local chain, F130); the full name is in its title and read by
 * screen readers. By source before chain id: the local core chain is a twin with Sepolia's chain id (S10a § 7.1), and a
 * box there is never called Sepolia.
 */
export function chainShort(record: ChainChipRecord): string {
  // SH-224 phase 3 (F2): a core v2 box read from the local source (a twin with Sepolia's chain id) is on a local chain too.
  if (record.local === true || record.row?.network === 'local' || record.v2Chain?.source?.network === 'local') return 'Local chain';
  if (record.chainId === TESTNET.chainId) return TESTNET.badgeName;
  return 'Local chain';
}

/** The chain chip: the glyph and a short name (the name is hidden on a phone, the full name always heard). */
export function ChainChip({ record }: { record: ChainChipRecord & Pick<BoxRecord, 'networkLabel'> }) {
  return (
    <span className="sh-box-kind sh-box-chain" title={record.networkLabel}>
      <EthGlyph />
      <span className="sh-box-chain__short" aria-hidden="true">
        {chainShort(record)}
      </span>
      <span className="sh-visually-hidden">{record.networkLabel}</span>
    </span>
  );
}

/**
 * A wallet as a box: the box shell (Midnight) with the companion's lid slot, dashed while empty, saying what goes there
 * ("Choose your Misfit"). Decoration with words: the slot's text is the page's companion line.
 */
export function WalletShell({ slot, small = false }: { slot: string | null; small?: boolean }) {
  return (
    <span className="sh-box-shell" data-size={small ? 'small' : 'large'}>
      <span className="sh-box-shell__slot">
        <UserGlyph />
        {slot ? <span className="sh-box-shell__text">{slot}</span> : null}
      </span>
    </span>
  );
}

/** A tape on a cover ("Preview"): the words are said once by the card's label, so the tape itself is decoration. */
export function CoverTape({ label }: { label: string }) {
  return (
    <span className="sh-box-tape" aria-hidden="true">
      {label}
    </span>
  );
}

/** A thin progress bar (basis points); its numbers are in the text beside it. */
export function Bar({ bps }: { bps: number }) {
  const clamped = Math.max(0, Math.min(10_000, Math.trunc(bps)));
  return (
    <span className="sh-box-bar" data-full={clamped >= 10_000} aria-hidden="true">
      <span style={{ width: `${clamped / 100}%` }} />
    </span>
  );
}

/** A picture's own copy, from the spec this page built the box from: the logo, or the collection cover (else the logo). */
function localUrl(record: BoxRecord, which: PictureRole): string | null {
  const spec = record.spec;
  if (!spec) return null;
  return which === 'logo' ? spec.coverUrl : (spec.collectionCoverUrl ?? spec.coverUrl);
}

/**
 * SH-BOX-PICTURE-FIT: the picture a slot shows (picture-slot.ts): a square slot the logo, a card the cover, each the
 * other only when its own is not there at all. Fix round af1: the second picture is asked for at the same time as the
 * first (unless the first is already shown or withheld), so a first picture that never comes does not hold the slot
 * blank: after SLOT_WAIT_MS a verified second shows meanwhile. The first still wins whenever it verifies, and a
 * withheld first is the tile, never the other picture.
 */
export function useSlotPicture(record: BoxRecord, slot: PictureSlot): SlotChoice {
  const [one, two] = SLOT_ORDER[slot];
  const firstLookup = lookupOf(record.pictures, one);
  const firstState = usePictureState(firstLookup.sha256, firstLookup.gateways, firstLookup.arweave, localUrl(record, one));
  const first = slotSource(firstLookup.sha256, firstState, canLoad(firstLookup.sha256, firstLookup.gateways, firstLookup.arweave) || localUrl(record, one) !== null, localUrl(record, one));
  const settled = first.state === 'shown' || first.state === 'withheld';
  const secondLookup = lookupOf(record.pictures, two);
  const secondHash = settled ? null : secondLookup.sha256;
  const secondState = usePictureState(secondHash, secondLookup.gateways, secondLookup.arweave, localUrl(record, two));
  const second = settled ? NO_SOURCE : slotSource(secondHash, secondState, canLoad(secondHash, secondLookup.gateways, secondLookup.arweave) || localUrl(record, two) !== null, localUrl(record, two));
  const late = useLate(first.state === 'pending' ? firstLookup.sha256 : null);
  return chooseSlotPicture(slot, first, second, late);
}

/**
 * Whether `waiting` (a picture's hash, while it loads) has been waited for SLOT_WAIT_MS; null: not waiting. Fix round
 * af2 (review L1): every wait gets its own SLOT_WAIT_MS. A wait that ends (the picture shown, withheld or missing, or
 * another hash) forgets its expiry, so a later lookup of the same hash (one taken off the withheld list) waits again.
 */
function useLate(waiting: string | null): boolean {
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (waiting === null) return undefined;
    const timer = setTimeout(() => setLate(waiting), SLOT_WAIT_MS);
    return () => {
      clearTimeout(timer);
      setLate(null);
    };
  }, [waiting]);
  return waiting !== null && late === waiting;
}

/** The blurred copy of a contained picture behind it, so a wide cover sits on its own colours (box-base.css). */
function groundStyle(url: string): CSSProperties | undefined {
  const ground = groundUrl(url);
  return ground ? ({ '--sh-box-cover-ground': ground } as CSSProperties) : undefined;
}

/**
 * The token's mark: the FIT icon for the launch, a neutral tile for a rehearsal, else the box's logo (a square slot,
 * SH-BOX-PICTURE-FIT): a chain box's committed logo once its bytes verify (box-pictures.ts), the creator's logo for a box
 * built from a BoxSpec (a data URL, only ever through <img>). Without a logo to show, the cover, whole in a rounded
 * square; with neither, a lettered coin. SH-WITHHELD-SITE: a withheld picture is a plain tile (decoration, like the
 * logo), never the picture and never a stand-in for it.
 */
export function TokenMark({ record, size = 18 }: { record: BoxRecord; size?: number }) {
  const choice = useSlotPicture(record, 'square');
  if (record.market) return record.rehearsal ? <NeutralIcon size={size} className="sh-box-mark" /> : <FitIcon size={size} className="sh-box-mark" />;
  if (choice.kind === 'withheld') return <WithheldTile className="sh-box-mark sh-withheld--mark" decorative style={{ width: size, height: size }} />;
  if (choice.kind === 'picture') return <CoinPicture url={choice.url} which={choice.which} size={size} />;
  return (
    // The letter is drawn by CSS (`attr(data-letter)`): an icon, not text to read.
    <span className="sh-box-coin" style={{ width: size, height: size }} data-ticker={record.ticker} data-letter={record.ticker.slice(0, 1)} aria-hidden="true" />
  );
}

/**
 * A token's round mark with a picture (SH-BOX-PICTURE-FIT fix round af2, review M2): the logo centred and cut to the
 * circle, as token marks are everywhere; a cover standing in for the logo is drawn whole in a rounded square
 * (box-base.css). TokenMark and the Launch flow's icon preview (PictureSlots) draw it the same way.
 */
export function CoinPicture({ url, which, size }: { url: string; which: PictureRole; size: number }) {
  return (
    <img
      className={`sh-box-coin sh-box-coin--logo${which === 'cover' ? ' sh-box-coin--cover' : ''}`}
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      data-picture={which}
    />
  );
}

/** The cover art key of a box: the Misfits' sealed box, a Demo box's own cover, or none for a rehearsal (no art). */
export function coverOf(record: BoxRecord, small = false): string | null {
  if (record.art) return record.art.cover;
  // SH-258 round 3: a BNB build has no box 0 cover; the key folds away.
  if (record.market && !record.rehearsal && !(import.meta.env?.SH_BNB === true)) return small ? 'cover-misfits-256' : 'cover-misfits';
  return null;
}

/**
 * One box picture drawn whole in its slot's frame (SH-BOX-PICTURE-FIT): contained, on a blurred copy of itself. The
 * feed, the box pages and the Launch flow's slot preview draw it the same way.
 */
export function PictureFrame({ url, slot, which, className = '' }: { url: string; slot: PictureSlot; which: PictureRole; className?: string }) {
  return (
    <span className={`sh-box-cover ${className}`} data-art="image" data-slot={slot} data-picture={which} data-fit="contain" style={groundStyle(url)}>
      <img src={url} width={320} height={320} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

/**
 * The box picture in one slot (SH-BOX-PICTURE-FIT, picture-slot.ts): `card` (the feed card, My Box's tiles) shows the
 * cover, `square` (the box page's header icon, a list row's thumbnail) the logo; each the other only when its own is
 * not there. The picture is always drawn whole (contained, on a blurred copy of itself), so a wide cover keeps its
 * words. A chain box's pictures show once their bytes verify against the spec's hashes (box-pictures.ts); a box built
 * from a BoxSpec shows its creator's own copies, data URLs, only ever through <img> (BC-095). Without a picture: art
 * when the box has some, otherwise a plain closed-box tile (a rehearsal shows no art). SH-WITHHELD-SITE: a withheld
 * picture shows the neutral "Picture withheld" tile in its place (never the picture, never a stand-in for it).
 */
export function BoxCover({ record, small = false, className = '', slot = 'card' }: { record: BoxRecord; small?: boolean; className?: string; slot?: PictureSlot }) {
  const choice = useSlotPicture(record, slot);
  if (choice.kind === 'withheld') {
    return (
      <span className={`sh-box-cover ${className}`} data-art="withheld" data-slot={slot}>
        <WithheldTile className="sh-withheld--fill" />
      </span>
    );
  }
  if (choice.kind === 'picture') return <PictureFrame url={choice.url} slot={slot} which={choice.which} className={className} />;
  const key = coverOf(record, small);
  const art = key ? boxArt(key) : null;
  return (
    <span className={`sh-box-cover ${className}`} data-art={art ? 'image' : 'plain'} data-slot={slot}>
      {art ? <img src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" /> : <BoxGlyph />}
    </span>
  );
}

/**
 * A family's ordinary avatar, cropped to the character: the renders are whole scenes (plate, hole, room), so the circle
 * zooms in on the character (the mock-up's `*-a` crops, done in CSS).
 */
export function FamilyAvatar({ row }: { row: Pick<FamilyRow, 'avatar'> }) {
  const art = row.avatar ? boxArt(`m-${row.avatar}-256`) : null;
  if (!art) return null;
  return (
    // Its size is the context's (`--sh-box-avatar-size`): 28 px in the legend, 36 px on a feed card (32 px on a phone).
    <span className="sh-box-avatar" aria-hidden="true">
      <img src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

const TOY_COLOURS = ['red', 'blue', 'yellow', 'green', 'orange', 'teal'] as const;
const TOY_SHAPES = ['Cube', 'Ball', 'Pyramid', 'Cylinder', 'Arch', 'Star'] as const;
export type ToyShape = (typeof TOY_SHAPES)[number];

/** One faceless toy block (Demo art for Toy Trains' items; our own drawing, ported from the box mock-up). */
export function ToyBlock({ index }: { index: number }) {
  const shape: ToyShape = TOY_SHAPES[index % TOY_SHAPES.length] ?? 'Cube';
  const colour = TOY_COLOURS[(index + Math.floor(index / TOY_SHAPES.length) * 2) % TOY_COLOURS.length] ?? 'red';
  const fill = `var(--sh-box-toy-${colour})`;
  const shade = 'var(--sh-box-toy-shade)';
  const light = 'var(--sh-box-toy-light)';
  let body: ReactNode;
  switch (shape) {
    case 'Ball':
      body = (
        <>
          <circle cx="50" cy="52" r="30" fill={fill} />
          <path d="M50 22a30 30 0 0 1 0 60a22 30 0 0 0 0-60z" fill={shade} />
          <ellipse cx="40" cy="40" rx="9" ry="6" fill={light} />
        </>
      );
      break;
    case 'Pyramid':
      body = (
        <>
          <polygon points="50,16 20,70 50,82" fill={fill} />
          <polygon points="50,16 50,82 80,70" fill={fill} />
          <polygon points="50,16 50,82 80,70" fill={shade} />
        </>
      );
      break;
    case 'Cylinder':
      body = (
        <>
          <rect x="22" y="30" width="56" height="44" fill={fill} />
          <rect x="50" y="30" width="28" height="44" fill={shade} />
          <ellipse cx="50" cy="74" rx="28" ry="10" fill={fill} />
          <ellipse cx="50" cy="30" rx="28" ry="10" fill={fill} />
          <ellipse cx="50" cy="30" rx="28" ry="10" fill={light} />
        </>
      );
      break;
    case 'Arch':
      body = (
        <>
          <path d="M14 82V46Q14 22 50 22Q86 22 86 46V82H68V60Q68 44 50 44Q32 44 32 60V82Z" fill={fill} />
          <path d="M68 82V60Q68 44 50 44V22Q86 22 86 46V82Z" fill={shade} />
        </>
      );
      break;
    case 'Star':
      body = (
        <>
          <polygon points="50,16 59,38 83,40 65,55 71,79 50,66 29,79 35,55 17,40 41,38" fill={fill} />
          <polygon points="50,16 59,38 50,44 41,38" fill={light} />
        </>
      );
      break;
    default:
      body = (
        <>
          <polygon points="50,20 80,35 50,50 20,35" fill={fill} />
          <polygon points="50,20 80,35 50,50 20,35" fill={light} />
          <polygon points="20,35 50,50 50,82 20,67" fill={fill} />
          <polygon points="50,50 80,35 80,67 50,82" fill={fill} />
          <polygon points="50,50 80,35 80,67 50,82" fill={shade} />
        </>
      );
  }
  return (
    <svg className="sh-box-toy" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect width="100" height="100" fill="var(--sh-box-toy-bg-2)" />
      <circle cx="50" cy="48" r="44" fill="var(--sh-box-toy-bg-1)" />
      <ellipse cx="50" cy="88" rx="30" ry="5" fill={shade} />
      {body}
    </svg>
  );
}

export const toyShapeOf = (index: number): ToyShape => TOY_SHAPES[index % TOY_SHAPES.length] ?? 'Cube';
