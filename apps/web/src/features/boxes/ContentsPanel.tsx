/**
 * "What's in the box?" (F45 (2), F47), the same blocks for every box:
 *
 * - the lead, with N from the data (the vault's N once read; "Unverified" when it disagrees with the market record);
 * - before graduation: the sneak peek (one ordinary piece per family, then two more, under one "Examples" chip, never a
 *   token number; a tap opens the example with its family and finish), the composition ("Planned counts"; the rare rows
 *   as counts behind a lock, merged into one hatched "Rare" segment) and the sealed count;
 * - after graduation: Demo example tiles, or canonical revealed items with pictures, avatars and a 3D viewer;
 *   the composition as "Edition counts", and the lead says how many are outside, so each number
 *   is said once on the page (the header has Inside);
 * - a rehearsal: its counts and "Test set only", no art, no teasers, no composition;
 * - a box built from a BoxSpec: its open art and traits, the sealed count, then its teasers labelled "Teaser" (F71 (2):
 *   never items, never counted), always after the items and the sealed count, so a teaser never leads or passes for an
 *   item, before or after the reveal; a token-only box (F70 "Nothing") leads with "Token".
 */
import { boxArt } from '@squarehole/design';
import { useState } from 'react';
import { failedWords } from '../core/v2/v2-words';
import { formatCount } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import type { BoxRecord, BoxState } from './box-model';
import { BoxSheet } from './BoxSheet';
import { ChainItems } from './ChainItems';
import { FamilyAvatar, LockGlyph, ToyBlock, toyShapeOf } from './BoxParts';
import { SealedPicture } from './SealedPicture';
import { compositionFor, familyCount, MISFIT_ROLES, MISFIT_ROOMS, MISFIT_SLOTS, TEASERS, type Composition, type Teaser } from './misfits-content';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface ContentsCounts {
  /** n: items inside (null = not read). */
  readonly inside: bigint | null;
  /** Placeholders taken during the curve (kept ones for a failed box). */
  readonly reserved: bigint | null;
}

/** N as the page shows it: the vault's once read, else the market record's; "mismatch" when the two disagree. */
export interface EditionSize {
  readonly size: bigint;
  readonly check: 'record' | 'vault' | 'mismatch';
  /** The market record's N, for the (i) when the two disagree. */
  readonly recordSize: bigint;
}

/** The id of the lead heading: the header's peek strip moves focus here. */
export const CONTENTS_LEAD_ID = 'box-contents-lead';

/** The lead line, and why the items are sealed behind its (i) while they are. */
function Lead({ text, sealed, noun, edition }: { text: string; sealed: boolean; noun: string; edition: EditionSize }) {
  const tip = useInfoTip();
  const mismatch = edition.check === 'mismatch';
  return (
    <>
      <div className="sh-box-lead">
        <h2 id={CONTENTS_LEAD_ID} tabIndex={-1}>
          {text}
        </h2>
        {mismatch ? (
          <span className="sh-status-chip" data-disclosure="">
            Unverified
          </span>
        ) : null}
        {sealed || mismatch ? <InfoButton tip={tip} label={mismatch ? 'Why unverified' : 'Why sealed'} /> : null}
      </div>
      {sealed || mismatch ? (
        <InfoPanel tip={tip}>
          {mismatch ? <p>{`The vault reports ${formatCount(edition.size)} ${noun}; this build’s market record says ${formatCount(edition.recordSize)}. The counts are the vault’s; the planned composition is not shown.`}</p> : null}
          {sealed ? <p>{`The art of the ${noun} stays sealed until graduation. A placeholder taken during the curve opens as one of them then.`}</p> : null}
        </InfoPanel>
      ) : null}
    </>
  );
}

function ItemSheet({ teaser, composition, onClose }: { teaser: Teaser; composition: Composition | null; onClose: () => void }) {
  const art = boxArt(`m-${teaser.slug}`);
  const family = familyCount(composition, teaser.family);
  return (
    <BoxSheet titleId="box-sheet-title" title={teaser.title} onClose={onClose}>
      {art ? <img className="sh-box-sheet__art" src={art.src} width={art.width} height={art.height} alt={import.meta.env?.SH_BNB === true ? teaser.title : `${teaser.title}, an example Misfit`} /> : null}
      <p className="sh-box-sheet__traits">
        <span className="sh-box-trait">
          <small>Family</small>
          {`${teaser.family}${family ? ` · ${family.approx ? '~' : ''}${formatCount(family.count)}` : ''}`}
        </span>
        <span className="sh-box-trait">
          <small>Role</small>
          {teaser.role}
        </span>
        <span className="sh-box-trait">
          <small>Finish</small>
          {teaser.finish}
        </span>
      </p>
      <p className="sh-muted">Example. Never a token number.</p>
    </BoxSheet>
  );
}

/** The ordinary examples as tiles that open their sheet: the sneak peek before graduation, "Inside the vault" after. */
function ExampleGrid({ composition, title, chip }: { composition: Composition | null; title: string; chip: string }) {
  const [open, setOpen] = useState<Teaser | null>(null);
  return (
    <div className="sh-box-card-block">
      <div className="sh-box-block-head">
        <h3>{title}</h3>
        <span className="sh-box-example" data-disclosure="">
          {chip}
        </span>
      </div>
      <ul className="sh-box-peek">
        {TEASERS.map((teaser) => {
          const art = boxArt(`m-${teaser.slug}-256`);
          return (
            <li key={teaser.slug}>
              <button type="button" className="sh-box-peek__tile" aria-label={`${teaser.family}, ${teaser.role}, example`} onClick={() => setOpen(teaser)}>
                {art ? <img src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" /> : null}
                <span className="sh-box-peek__name">{teaser.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open ? <ItemSheet teaser={open} composition={composition} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function FactsInfo() {
  const tip = useInfoTip();
  return (
    <>
      <InfoButton tip={tip} label="About these facts" />
      <InfoPanel tip={tip}>
        <p>{`8 roles: ${MISFIT_ROLES.join(', ')}.`}</p>
        <p>{`8 rooms: ${MISFIT_ROOMS.join(', ')}.`}</p>
        <p>{`8 slots: ${MISFIT_SLOTS.join(', ')}. Items for these slots can come later.`}</p>
      </InfoPanel>
    </>
  );
}

function CompositionCard({ composition, graduated }: { composition: Composition; graduated: boolean }) {
  const tip = useInfoTip();
  const shown = composition.families.filter((row) => !row.sealed);
  const sealed = composition.families.filter((row) => row.sealed);
  const rare = sealed.reduce((sum, row) => sum + row.count, 0n);
  const label = composition.families.map((row) => `${row.id} ${row.approx ? 'about ' : ''}${formatCount(row.count)}`).join(', ');
  return (
    <div className="sh-box-card-block sh-box-comp">
      <div className="sh-box-block-head">
        <h3>Composition</h3>
        <span className="sh-muted">{graduated ? 'Edition counts' : 'Planned counts'}</span>
        {composition.assumed ? (
          <span className="sh-status-chip" data-disclosure="">
            Assumed
          </span>
        ) : null}
        <InfoButton tip={tip} label="About the counts" />
      </div>
      <InfoPanel tip={tip}>
        <p>From the edition plan (F35, F44). The final counts are fixed before the launch; the Shapes are hand-picked, about 200.</p>
        {composition.assumed ? <p>{`The ${formatCount(composition.size)} table is the 4,200 plan plus the Icons series (F49 E8), to be confirmed.`}</p> : null}
        {rare > 0n ? <p>{`The rare ones (${sealed.map((row) => row.id).join(', ')}) are counts only, never shown by picture before the reveal; on the bar they are one hatched part.`}</p> : null}
      </InfoPanel>
      <div className="sh-box-comp__bar" role="img" aria-label={`Families: ${label}`}>
        {shown.map((row, index) => (
          <span key={row.id} data-key={index + 1} style={{ flex: `${row.count.toString()} 1 0` }} />
        ))}
        {rare > 0n ? <span data-key="rare" style={{ flex: `${rare.toString()} 1 0` }} /> : null}
      </div>
      <ul className="sh-box-comp__legend">
        {shown.map((row, index) => (
          <li key={row.id}>
            <span className="sh-box-comp__key" data-key={index + 1} aria-hidden="true" />
            <FamilyAvatar row={row} />
            {row.id} <strong>{`${row.approx ? '~' : ''}${formatCount(row.count)}`}</strong>
          </li>
        ))}
        {sealed.map((row) => (
          <li key={row.id} data-sealed="">
            <span className="sh-box-comp__key" data-key="rare" aria-hidden="true" />
            <LockGlyph />
            {row.id} <strong>{formatCount(row.count)}</strong>
          </li>
        ))}
      </ul>
      <ul className="sh-box-comp__finishes" aria-label="Rare finishes">
        {composition.finishes.map((finish) => (
          <li key={finish.id} data-finish={finish.id}>
            <span className="sh-box-swatch" aria-hidden="true" />
            {finish.id} <strong>{formatCount(finish.count)}</strong>
          </li>
        ))}
      </ul>
      <div className="sh-box-facts">
        <span>8 roles</span>
        <span>8 rooms</span>
        <span>3D · 8 slots</span>
        <FactsInfo />
      </div>
    </div>
  );
}

function SealedCounts({ record, size, counts }: { record: BoxRecord; size: bigint; counts: ContentsCounts }) {
  const reserved = counts.reserved;
  const sealedArt = record.art ? boxArt(record.art.sealed) : record.market && !record.rehearsal && !(import.meta.env?.SH_BNB === true) ? boxArt('cover-misfits-256') : null;
  return (
    <div className="sh-box-card-block sh-box-sealed">
      {/* The spec's hidden picture, checked against our withheld list on a chain box (SealedPicture.tsx); else its art. */}
      <SealedPicture record={record} size={72} tileClassName="sh-withheld--sealed"
        fallback={sealedArt ? <img src={sealedArt.src} width={72} height={72} alt="" loading="lazy" decoding="async" /> : null} />
      <dl>
        <div>
          <dt>{record.kind === 'existing' ? 'Held inside' : 'Sealed inside'}</dt>
          <dd>{reserved === null ? <span className="sh-na">Not available</span> : formatCount(size - reserved)}</dd>
        </div>
      </dl>
    </div>
  );
}

function DemoItems({ size }: { size: bigint }) {
  return (
    <div className="sh-box-card-block">
      <div className="sh-box-block-head">
        <h3>Inside the vault</h3>
        <span className="sh-box-example" data-disclosure="">
          Example art
        </span>
      </div>
      <ul className="sh-box-peek">
        {Array.from({ length: 12 }, (_, index) => (
          <li key={index}>
            <span className="sh-box-peek__tile" role="img" aria-label={`${toyShapeOf(index)} toy block, example art`}>
              <ToyBlock index={index} />
              <span className="sh-box-peek__name">{toyShapeOf(index)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="sh-muted">{`12 of ${formatCount(size)} shown`}</p>
    </div>
  );
}

/**
 * A box built from its BoxSpec: open art shows its own pictures (through <img> only) and its trait types; edition
 * specials are counts. Hidden art shows nothing here but the sealed count below.
 */
function SpecContents({ record, size }: { record: BoxRecord; size: bigint }) {
  const spec = record.spec;
  if (!spec) return null;
  return (
    <>
      {spec.artMode === 'open' && spec.thumbs.length > 0 ? (
        <div className="sh-box-card-block">
          <div className="sh-box-block-head">
            <h3>Art</h3>
          </div>
          <ul className="sh-box-peek">
            {spec.thumbs.map((url, index) => (
              <li key={index}>
                <span className="sh-box-peek__tile">
                  <img src={url} width={160} height={160} alt="" loading="lazy" decoding="async" />
                </span>
              </li>
            ))}
          </ul>
          <p className="sh-muted">{`${spec.thumbs.length} of ${formatCount(size)} shown`}</p>
        </div>
      ) : null}
      {spec.traitTypes.length > 0 || spec.specials.length > 0 ? (
        <div className="sh-box-card-block">
          <div className="sh-box-block-head">
            <h3>Traits</h3>
          </div>
          <p className="sh-box-sheet__traits">
            {spec.traitTypes.map((type) => (
              <span key={type.name} className="sh-box-trait">
                <small>{type.name}</small>
                {`${type.values} ${type.values === 1 ? 'value' : 'values'}`}
              </span>
            ))}
            {spec.specials.map((special) => (
              <span key={special.label} className="sh-box-trait">
                <small>Special</small>
                {`${special.label} · ${formatCount(special.count)}`}
              </span>
            ))}
          </p>
        </div>
      ) : null}
    </>
  );
}

/** The collection page's teasers (F71 (2)): labelled "Teaser" in sight and in each picture's name, apart from the items. */
function Teasers({ record }: { record: BoxRecord }) {
  const urls = record.spec?.teaserUrls ?? [];
  if (urls.length === 0) return null;
  return (
    <div className="sh-box-card-block" data-block="teasers">
      <div className="sh-box-block-head">
        <h3>Teasers</h3>
        <span className="sh-box-example" data-disclosure="">
          Not items
        </span>
      </div>
      <ul className="sh-box-teasers">
        {urls.map((url, index) => (
          <li key={index}>
            <img src={url} width={160} height={160} alt={`Teaser ${index + 1} of ${urls.length}`} loading="lazy" decoding="async" />
            <span className="sh-box-teasers__label" aria-hidden="true">
              Teaser
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A token-only box (F70 "Nothing"): the box holds its token and nothing else. */
function TokenOnly({ record }: { record: BoxRecord }) {
  return (
    <div className="sh-box-card-block">
      <p className="sh-muted">{`Nothing in the box but ${record.ticker}: no NFTs, no vault.`}</p>
    </div>
  );
}

function leadText(record: BoxRecord, state: BoxState | null, size: bigint, counts: ContentsCounts): string {
  if (record.kind === 'token') return 'Token';
  const n = `${formatCount(size)} ${record.itemNoun}`;
  if (record.spec?.artMode === 'open' && state !== 'graduated' && state !== 'failed') return `${n}, in the box until graduation`;
  if (state === 'graduated') return counts.inside === null ? n : `${n} · ${formatCount(size - counts.inside)} outside the vault`;
  if (state === 'failed') return `${n}, sealed. ${failedWords(record.v2 !== undefined).lead}`;
  if (record.kind === 'existing') return `${n}, held until graduation`;
  return `${n}, sealed until graduation`;
}

export function ContentsPanel({ record, state, counts, launchContent, edition }: { record: BoxRecord; state: BoxState | null; counts: ContentsCounts; launchContent: boolean; edition: EditionSize }) {
  const size = edition.size;
  const composition = launchContent && edition.check !== 'mismatch' ? compositionFor(size) : null;
  const graduated = state === 'graduated';
  const openArt = record.spec?.artMode === 'open';
  if (record.kind === 'token') {
    return (
      <div className="sh-box-contents">
        <Lead text={leadText(record, state, size, counts)} sealed={false} noun={record.itemNoun} edition={edition} />
        <TokenOnly record={record} />
      </div>
    );
  }
  return (
    <div className="sh-box-contents">
      <Lead text={leadText(record, state, size, counts)} sealed={!graduated && state !== 'failed' && record.kind !== 'existing' && !openArt} noun={record.itemNoun} edition={edition} />
      <SpecContents record={record} size={size} />
      {record.rehearsal ? (
        <p className="sh-muted" data-disclosure="">
          Test set only: made-up traits, no art.
        </p>
      ) : null}
      {graduated ? (
        DEMO_BUILD && record.art?.toyBlocks ? (
          <DemoItems size={size} />
        ) : DEMO_BUILD && launchContent && record.demo ? (
          <ExampleGrid composition={composition} title="Inside the vault" chip="Examples" />
        ) : (
          <ChainItems record={record} />
        )
      ) : launchContent ? (
        <ExampleGrid composition={composition} title="Sneak peek" chip="Examples" />
      ) : null}
      {composition ? <CompositionCard composition={composition} graduated={graduated} /> : null}
      {!graduated ? (
        <>
          {DEMO_BUILD && record.demoState && record.line === null ? <p className="sh-box-card-block sh-muted">No preview shared</p> : null}
          {openArt ? null : <SealedCounts record={record} size={size} counts={counts} />}
        </>
      ) : null}
      {/* Teasers last (F71 (2); flow doc § 3.2): after the items and the sealed count, before and after the reveal. */}
      <Teasers record={record} />
    </div>
  );
}
