/**
 * SH-281: the Visual way of a create screen: the launch as a picture, a part's fields in a sheet beside it (the same
 * fields, on the same form state, as the Steps way), the hint under it. After the platform's CreatePicture.tsx (main
 * b8fbcef9), without its templates, walk and "What happens".
 */
import { useCallback, useId, useRef, type ReactNode } from 'react';
import { ICONS, type IconId } from './icons';
import { WORDS, type LaunchPicture, type PartId } from './launch-picture';
import { LaunchPictureSvg } from './LaunchPictureSvg';
import { PartSheet, type CloseWay } from './PartSheet';

export const SHEET_TITLE: Readonly<Record<PartId, string>> = Object.freeze({
  token: 'Token',
  buyers: 'Buys',
  sellers: 'Sells',
  raise: 'Target',
  price: 'Paid in',
  deadline: 'Deadline',
  creator: 'Creator',
  tax: 'Tax',
  pool: 'Pool',
  pile: 'Pile',
  holders: 'Holders',
  shop: 'Cards',
});

const SHEET_ICON: Readonly<Record<PartId, IconId>> = Object.freeze({
  token: 'liquidity',
  buyers: 'holders',
  sellers: 'holders',
  raise: 'pile',
  price: 'liquidity',
  deadline: 'creator',
  creator: 'creator',
  tax: 'burn',
  pool: 'liquidity',
  pile: 'pile',
  holders: 'holders',
  shop: 'pile',
});

export interface LaunchPictureViewProps {
  readonly picture: LaunchPicture;
  readonly open: PartId | null;
  readonly onOpen: (part: PartId | null) => void;
  readonly sheetBody: (part: PartId) => ReactNode;
  /** The picture's name for screen readers ("Your launch on Flap"). */
  readonly name: string;
  readonly titles?: Partial<Record<PartId, string>>;
  /** SH-294: the launch's own picture on the token's coin (a checked blob: URL), or null. */
  readonly coinPicture?: string | null;
}

export function LaunchPictureView({ picture, open, onOpen, sheetBody, name, titles = {}, coinPicture = null }: LaunchPictureViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const headingId = useId();
  const hintId = useId();
  const anchor = useCallback(() => (open ? (svgRef.current?.querySelector(`[data-part="${open}"]`) ?? null) : null), [open]);
  const stage = useCallback(() => stageRef.current, []);
  // Escape and Close give focus back to the part; leaving the sheet leaves focus where it went.
  const close = useCallback(
    (way: CloseWay) => {
      const was = open;
      onOpen(null);
      if (!was || way === 'left') return;
      window.setTimeout(() => svgRef.current?.querySelector<SVGGElement>(`[data-part="${was}"]`)?.focus(), 0);
    },
    [open, onOpen],
  );
  return (
    <div className="sh-lp-main">
      <h2 id={headingId} className="sh-visually-hidden">
        {name}
      </h2>
      <div ref={stageRef} className="sh-pic-stage">
        <LaunchPictureSvg picture={picture} open={open} onPart={(id) => onOpen(open === id ? null : id)} svgRef={svgRef} labelledBy={headingId} describedBy={hintId} coinPicture={coinPicture} />
        {open ? (
          <PartSheet
            key={open}
            title={titles[open] ?? SHEET_TITLE[open]}
            icon={
              <svg viewBox="0 0 24 24" className="sh-pic-icon" focusable="false">
                {ICONS[SHEET_ICON[open]]}
              </svg>
            }
            anchor={anchor}
            stage={stage}
            onClose={close}
          >
            {/* The fields sit in a form of their own; Enter in a field never sends anything. */}
            <form className="sh-pic-sheet__form" noValidate onSubmit={(event) => event.preventDefault()}>
              {sheetBody(open)}
            </form>
          </PartSheet>
        ) : null}
      </div>
      <p className="sh-pic-hint" id={hintId}>
        {WORDS.hint}
      </p>
    </div>
  );
}
