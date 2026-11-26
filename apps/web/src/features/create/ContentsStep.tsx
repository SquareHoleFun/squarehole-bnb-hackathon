/**
 * Step 2, Contents (box creation flow § 3, F70 (2), F71): what is in the box. Two tiles, none pre-chosen: "Just the
 * token" (TOKEN_ONLY: no items, no vault) or "New collection" (the art, shown open or hidden until drawn, the
 * collection's own cover, F74 U3: a separate upload, the logo stays the token's; below: the collection page's banner,
 * teasers and link, the royalty, permanent storage, and under More the marketplace owner, its own name and ticker,
 * special series and the ticket's texts). "Coming later" cards (not controls) close the step: NFTs you own with F71's
 * address check, NFTs from fees, token baskets. The two tiles are tall radios with an icon and a second line ("No
 * NFTs" / "Your NFTs"). The v2 flow adds a third, Shop ("Many collections", box type SHOP), through `shop`: a shop
 * holds no collection of its own, so it keeps the token's fields and its settings come in `extra` (create/v2/ShopStep).
 */
import { MAX_SYMBOL_BYTES, MAX_TOKEN_NAME_BYTES } from '@squarehole/box-spec';
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { RoyaltyTo } from '../boxes/box-model';
import { CoinGlyph, GridGlyph } from '../boxes/BoxParts';
import { TemplateIcon } from '../brand/template-icons';
import { bpsText } from '../boxes/spec-record';
import { formatCount } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { CheckIcon, ChipGroup, FieldError, ITEM_FILE_TYPES, InfoLine, PicturePicker, TextField, takeFiles, type StepProps } from './create-parts';
import { MAX_SPECIALS, MAX_TEASERS, ROYALTY_BPS, artHasModels, effectivePageLink, type ArtCommitment, type ArtState, type CoverState, type PageState, type SpecialRow } from './create-model';
import { ART_PLAN_INFO, HIDDEN_NUMBERED_LINE, HIDDEN_PLANNED_LINE, PLAN_LINK, PLAN_PATH } from './plan-guide';
import { CONTROL, type ControlId } from './reason-copy';
import type { PictureStatus } from './use-create-flow';
import { TESTNET } from '@squarehole/chain/write/wallet';

/** SH-258: hidden draws on this test network (not on BNB Chain testnet). */
const DRAWS = TESTNET.switches.draws;
/** SH-258: the inbox's sale list (CoW) on this test network (not on BNB Chain testnet). */
const COW_SALES = TESTNET.switches.cowSales;
/** SH-258: permanent storage of the art (Arweave) on this test network (not on BNB Chain testnet). */
const STORE_ALL = TESTNET.switches.arweavePictures;

export interface ContentsStepProps extends StepProps {
  readonly art: ArtState | null;
  readonly commitment: ArtCommitment | null;
  /** The collection's own cover (field 28): its contractURI image. */
  readonly collectionCover: CoverState | null;
  readonly page: PageState;
  readonly pictures: { readonly collection: PictureStatus; readonly banner: PictureStatus; readonly teaser: PictureStatus };
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly onArt: (files: File[]) => void;
  readonly onCollectionCover: (file: File) => void;
  readonly onBanner: (file: File) => void;
  readonly onTeasers: (files: readonly File[]) => void;
  readonly onPage: (page: PageState) => void;
  /**
   * The v2 flow's own choices for the chosen contents (a token-only box's coin pile, a collection's pick fee): right
   * after that contents' fields, before "Coming later", so they read as part of the choice above them.
   */
  readonly extra?: ReactNode;
  /**
   * The v2 flow's Shop tile: whether the shop is the choice (the form then says 'token'), and what choosing a tile
   * does (the v2 flow keeps the shop's settings beside the form). Absent: the two tiles of v1.
   */
  readonly shop?: { readonly chosen: boolean; readonly onChoose: (contents: 'token' | 'collection' | 'shop') => void };
  /**
   * The v2 flow (RC6, F138): royalties reach the box's own inbox and follow its fee setup, so there is no destination
   * to choose. Absent: v1's three destinations.
   */
  readonly inbox?: boolean;
  /** SH-245: the chosen price coin's symbol, named in the v2 flow's royalty (i); "the price coin" without one. */
  readonly priceCoin?: string;
  /**
   * The v2 flow (SH-AI-PLAN): hidden art's one line on numbered files, with its link to the plan guide. Absent: v1's
   * flow (the development build only, by URL), which reads a plan all the same but keeps its own first screen.
   */
  readonly planLine?: boolean;
  /**
   * TA-27: the caller shows the collection page's link (`PageLinkField`) apart: a loaded setup keeps the rest of the
   * step read-only, and the link is the creator's own. Absent: the link is in the collection page's group.
   */
  readonly pageLinkApart?: boolean;
  /** SH-BOX-PICTURE-FIT: where the pictures show (PictureSlots), under the collection cover. */
  readonly slots?: ReactNode;
  /**
   * SH-218 rail 2 (the v2 flow): the Contents tiles and the royalty rates the release switched off. They stay on the
   * page, `aria-disabled`, and cannot be chosen; `line` draws the flow's one line under the group. Absent: none is off.
   */
  readonly off?: {
    readonly contents: (value: 'token' | 'collection' | 'shop') => boolean;
    readonly royalty: boolean;
    /** Hidden art (its placeholders), new special series, and the collection page's banner, teasers and link. */
    readonly hidden?: boolean;
    readonly specials?: boolean;
    readonly page?: boolean;
    readonly line: (id: string) => ReactNode;
  };
}

/** Where the royalty goes, in the same words here and on the Overview. */
export const ROYALTY_TO_WORDS: Readonly<Record<RoyaltyTo, string>> = Object.freeze({ fees: 'With fees', creator: 'You', pool: 'Pool depth' });
const ROYALTY_TO_OPTIONS = (['fees', 'creator', 'pool'] as const).map((value) => ({ value, label: ROYALTY_TO_WORDS[value] }));
const MORE_CONTROLS: readonly ControlId[] = [CONTROL.collectionName, CONTROL.collectionSymbol, CONTROL.specials, CONTROL.ticketLine, CONTROL.hiddenLine];
const PAGE_CONTROLS: readonly ControlId[] = [CONTROL.banner, CONTROL.teasers, CONTROL.pageLink];
/** SH-218 rail 2: the id of the line under the collection page group when the release switched it off (add-on 6). */
export const COLLECTION_PAGE_OFF = `${CONTROL.banner}-off`;
/** SH-BOX-PICTURE-FIT: which picture goes where, in as few words as the slot preview needs. */
export const COVER_HINT = 'Wide · the card';

/** The status line's words: reading progress, what the art came to, or that it is not ready. */
function statusText({ art, commitment, progress }: Pick<ContentsStepProps, 'art' | 'commitment' | 'progress'>): string | null {
  if (progress) {
    const step = Math.max(1, Math.ceil(progress.total / 10));
    return `Reading ${formatCount(BigInt(progress.done - (progress.done % step)))} / ${formatCount(BigInt(progress.total))}`;
  }
  if (!art) return null;
  if (art.problems.length > 0) return `Not ready · ${art.problems.length} ${art.problems.length === 1 ? 'problem' : 'problems'}`;
  if (art.items.length === 0) return null;
  const traits = commitment?.traitTypes.length ?? 0;
  // R74-ART: art with a model for every item says so.
  return `${formatCount(BigInt(art.items.length))} items · ${traits} ${traits === 1 ? 'trait' : 'traits'}${artHasModels(art) ? ' · 3D' : ''}`;
}

/**
 * "120 items · 3 traits", "Not ready · 2 problems" or the reading progress (every 10%), in a polite live region that is
 * always in the page (a region added together with its words is often not announced), only hidden while empty.
 */
function ArtStatus({ art, commitment, progress }: Pick<ContentsStepProps, 'art' | 'commitment' | 'progress'>) {
  return (
    <>
      <p className="sh-newbox-status" role="status" aria-live="polite">
        {statusText({ art, commitment, progress })}
      </p>
      {!progress && art && art.problems.length > 0 ? (
        <ul className="sh-newbox-problems" aria-label="Art problems">
          {art.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {!progress && art && art.thumbs.length > 0 && art.problems.length === 0 ? (
        <ul className="sh-newbox-thumbs" aria-hidden="true">
          {art.thumbs.slice(0, 6).map((url, index) => (
            <li key={index}>
              <img src={url} width={48} height={48} alt="" />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SpecialRows({ rows, set, error, off = null }: { rows: readonly SpecialRow[]; set: (rows: SpecialRow[]) => void; error: string | null; off?: ReactNode }) {
  const offId = `${CONTROL.specials}-off`;
  const change = (index: number, patch: Partial<SpecialRow>) => set(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset id={CONTROL.specials} className="sh-newbox-specials" aria-describedby={error ? `${CONTROL.specials}-error` : undefined}>
      <legend className="sh-newbox-label">Special series</legend>
      {rows.map((row, index) => (
        <div key={index} className="sh-newbox-specials__row">
          <label className="sh-newbox-mini">
            <span>Series {index + 1}</span>
            <input className="sh-newbox-input" value={row.label} maxLength={64} onChange={(event) => change(index, { label: event.currentTarget.value })} />
          </label>
          <label className="sh-newbox-mini sh-newbox-mini--count">
            <span>Count</span>
            <input className="sh-newbox-input" inputMode="numeric" value={row.count} maxLength={6} onChange={(event) => change(index, { count: event.currentTarget.value })} />
          </label>
          <button type="button" className="sh-button sh-newbox-remove" aria-label={`Remove series ${index + 1}`} onClick={() => set(rows.filter((_, i) => i !== index))}>
            ×
          </button>
        </div>
      ))}
      {rows.length < MAX_SPECIALS ? (
        <button type="button" className="sh-button" data-create-off={off ? '' : undefined} aria-disabled={off ? 'true' : undefined} aria-describedby={off ? offId : undefined}
          onClick={() => { if (!off) set([...rows, { label: '', count: '' }]); }}>
          Add series
        </button>
      ) : null}
      {off}
      <FieldError id={`${CONTROL.specials}-error`} message={error} />
    </fieldset>
  );
}

function ArtLabel() {
  const tip = useInfoTip();
  return (
    <>
      <div className="sh-newbox-field__top sh-newbox-field__top--start">
        <span className="sh-newbox-label" id="create-art-label">
          Art
        </span>
        <InfoButton tip={tip} label="About the art files" />
      </div>
      <InfoPanel tip={tip}>
        <p>Pictures named 1.png … N.png (PNG, JPEG or WebP, up to 1 MB each), plus one traits file (CSV or JSON). Or a folder with the pictures and their 1.json … N.json.</p>
        <p>3D: a model beside every picture, 1.glb … N.glb (one self-contained GLB, up to 1 MB each).</p>
        <p>{ART_PLAN_INFO}</p>
      </InfoPanel>
    </>
  );
}

/**
 * SH-AI-PLAN, hidden art: one short line. Numbered files tell whoever named them which item is which, so it points to
 * the plan (the guide at PLAN_PATH); art read with a plan says the numbers were picked here.
 */
function HiddenNumbersLine({ planned }: { planned: boolean }) {
  return planned ? (
    <p className="sh-newbox-note" data-plan-note="planned">{HIDDEN_PLANNED_LINE}</p>
  ) : (
    <p className="sh-newbox-note" data-plan-note="numbered">
      {HIDDEN_NUMBERED_LINE} <Link to={PLAN_PATH}>{PLAN_LINK}</Link>
    </p>
  );
}

/** The two art pickers (files, or a folder); once usable art is read, one Change button that brings them back. */
function ArtPickers({ ready, error, onArt }: { ready: boolean; error: string | null; onArt: (files: File[]) => void }) {
  const [changing, setChanging] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = takeFiles(event);
    if (files.length === 0) return;
    setChanging(false);
    onArt(files);
  };
  if (ready && !changing) {
    return (
      <div className="sh-newbox-pick" id={CONTROL.art}>
        <button
          type="button"
          className="sh-button"
          aria-label="Change art"
          onClick={() => {
            setChanging(true);
            window.setTimeout(() => first.current?.focus(), 0);
          }}
        >
          Change
        </button>
      </div>
    );
  }
  const described = error ? `${CONTROL.art}-error` : undefined;
  return (
    <div className="sh-newbox-pick" id={CONTROL.art}>
      <label className="sh-button sh-newbox-pick__button">
        <input ref={first} type="file" multiple accept={ITEM_FILE_TYPES} className="sh-newbox-file" aria-labelledby="create-art-label create-art-files" aria-invalid={error ? true : undefined} aria-describedby={described} onChange={pick} />
        <span id="create-art-files">Images + traits</span>
      </label>
      <label className="sh-button sh-newbox-pick__button">
        <input type="file" multiple className="sh-newbox-file" aria-labelledby="create-art-label create-art-folder" {...({ webkitdirectory: '' } as Record<string, string>)} onChange={pick} />
        <span id="create-art-folder">Folder</span>
      </label>
    </div>
  );
}

/** The teasers chosen so far: each labelled "Teaser" (in sight and in its picture's name), each removable. */
function TeaserList({ page, onPage }: Pick<ContentsStepProps, 'page' | 'onPage'>) {
  if (page.teasers.length === 0) return null;
  return (
    <ul className="sh-newbox-teasers">
      {page.teasers.map((teaser, index) => (
        <li key={`${teaser.sha256}-${index}`}>
          {teaser.url ? <img src={teaser.url} width={64} height={64} alt={`Teaser ${index + 1}`} /> : null}
          <span className="sh-newbox-teasers__label" aria-hidden="true">
            Teaser
          </span>
          <button type="button" className="sh-button sh-newbox-remove" aria-label={`Remove teaser ${index + 1}`} onClick={() => onPage({ ...page, teasers: page.teasers.filter((_, i) => i !== index) })}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The collection page's link (field 603): as typed once edited, else prefilled from Website (`effectivePageLink`). */
export function PageLinkField({ form, set, errorFor, touch, label = 'Link', off }: StepProps & { readonly label?: string; readonly off?: string }) {
  return (
    <TextField
      off={off}
      // Switched off (SH-218 rail 2): the link can still be cleared, which takes the collection page off the box.
      offAccepts={(value) => value === ''}
      id={CONTROL.pageLink}
      label={label}
      value={effectivePageLink(form)}
      placeholder="https://"
      spellCheck={false}
      hint={form.pageLinkEdited ? undefined : 'From your website'}
      onChange={(pageLink) => set({ pageLink, pageLinkEdited: true })}
      onBlur={() => touch(CONTROL.pageLink)}
      error={errorFor(CONTROL.pageLink)}
    />
  );
}

/**
 * The collection page (add-on 6, F71 (2)): the banner (shown full width at 4:1 once chosen, Change and Remove side by
 * side), up to 4 teasers (label and count, the picker, its hint, then the list) and its link (prefilled from Website).
 */
function CollectionPage(props: ContentsStepProps) {
  const { errorFor, page, pictures, onBanner, onTeasers, onPage, pageLinkApart = false } = props;
  // SH-218 rail 2: switched off, the group's fields take no new picture or text (what is there stays; Remove works).
  const off = props.off?.page ? COLLECTION_PAGE_OFF : undefined;
  const [open, setOpen] = useState(false);
  const errors = PAGE_CONTROLS.some((control) => (!pageLinkApart || control !== CONTROL.pageLink) && errorFor(control) !== null);
  const full = page.teasers.length >= MAX_TEASERS;
  return (
    <details className="sh-newbox-more" open={open || errors} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Collection page</summary>
      <PicturePicker
        id={CONTROL.banner}
        label="Banner"
        action={page.banner ? 'Change' : 'Add image'}
        busy={pictures.banner.busy}
        thumb={page.banner?.url ?? null}
        wide
        hint={page.banner ? undefined : 'Wide, about 4:1'}
        error={pictures.banner.problem ?? errorFor(CONTROL.banner)}
        onRemove={page.banner ? () => onPage({ ...page, banner: null }) : undefined}
        removeLabel="Remove banner"
        off={off}
        onFiles={([file]) => {
          if (file) onBanner(file);
        }}
      />
      <PicturePicker
        id={CONTROL.teasers}
        label="Teasers"
        count={`${page.teasers.length}/${MAX_TEASERS}`}
        action="Add images"
        busy={pictures.teaser.busy}
        thumb={null}
        multiple
        full={full}
        hint="Labelled Teaser, never an item"
        hintInfo={{ label: 'About teasers', body: <p>Show the style without revealing items. Each one is labelled Teaser on the box page and the Overview, and never counted as an item.{DRAWS ? ' Hidden art: use new pictures, not your items.' : ''}</p> }}
        error={pictures.teaser.problem ?? errorFor(CONTROL.teasers)}
        off={off}
        onFiles={(files) => onTeasers(files.slice(0, MAX_TEASERS - page.teasers.length))}
      >
        <TeaserList page={page} onPage={onPage} />
      </PicturePicker>
      {pageLinkApart ? null : <PageLinkField {...props} off={off} />}
    </details>
  );
}

function More({ form, set, errorFor, touch, off }: StepProps & Pick<ContentsStepProps, 'off'>) {
  const [open, setOpen] = useState(false);
  const errors = MORE_CONTROLS.some((control) => errorFor(control) !== null);
  return (
    <details className="sh-newbox-more" open={open || errors} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>More</summary>
      <label className="sh-newbox-toggle">
        <input type="checkbox" checked={form.separateCollection} onChange={(event) => set({ separateCollection: event.currentTarget.checked })} />
        Own collection name and ticker
      </label>
      {form.separateCollection ? (
        <div className="sh-newbox-pair">
          <TextField id={CONTROL.collectionName} label="Collection name" value={form.collectionName} maxBytes={Number(MAX_TOKEN_NAME_BYTES)} onChange={(collectionName) => set({ collectionName })} onBlur={() => touch(CONTROL.collectionName)} error={errorFor(CONTROL.collectionName)} />
          <TextField id={CONTROL.collectionSymbol} label="Collection ticker" value={form.collectionSymbol} maxBytes={Number(MAX_SYMBOL_BYTES)} onChange={(collectionSymbol) => set({ collectionSymbol })} onBlur={() => touch(CONTROL.collectionSymbol)} error={errorFor(CONTROL.collectionSymbol)} spellCheck={false} />
        </div>
      ) : null}
      <InfoLine label="About the marketplace owner" info={<p>The collection’s owner() that marketplaces read: your address, set on the Overview. It changes nothing in the box.</p>}>
        Marketplace owner: You
      </InfoLine>
      <SpecialRows rows={form.specials} set={(specials) => set({ specials })} error={errorFor(CONTROL.specials)} off={off?.specials ? off.line(`${CONTROL.specials}-off`) : null} />
      {form.artMode === 'hidden' ? (
        <>
          <TextField id={CONTROL.ticketLine} label="Ticket text" value={form.ticketLine} multiline maxBytes={1024} onChange={(ticketLine) => set({ ticketLine })} onBlur={() => touch(CONTROL.ticketLine)} error={errorFor(CONTROL.ticketLine)} />
          <TextField id={CONTROL.hiddenLine} label="Hidden item text" value={form.hiddenLine} multiline maxBytes={1024} onChange={(hiddenLine) => set({ hiddenLine })} onBlur={() => touch(CONTROL.hiddenLine)} error={errorFor(CONTROL.hiddenLine)} />
        </>
      ) : null}
    </details>
  );
}

function LaterCard({ title, line, info, children }: { title: string; line: string; info: string; children?: ReactNode }) {
  const tip = useInfoTip();
  return (
    <li className="sh-newbox-later__card">
      <p className="sh-newbox-later__title">
        <strong>{title}</strong> <InfoButton tip={tip} label={`About ${title}`} />
      </p>
      <p className="sh-newbox-later__line">{line}</p>
      {children}
      <InfoPanel tip={tip}>
        <p>{info}</p>
      </InfoPanel>
    </li>
  );
}

/** A circle with a dash: a label for a collection not on the curated list (static, never a control). */
const UnverifiedGlyph = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12h7" />
  </svg>
);

/** "Coming later" (§ 3.3): cards, not controls. NFTs you own carry F71 (1)'s check: the address is the identity. */
export function ComingLater() {
  return (
    <section className="sh-newbox-later" aria-labelledby="create-later-title">
      <h2 id="create-later-title" className="sh-newbox-label">
        Coming later
      </h2>
      <ul>
        <LaterCard
          title="NFTs you own"
          line="Checked by address"
          info="The box fixes the source collection’s address and links it to an explorer and a marketplace. Verified only for collections on our curated list; otherwise “Unverified collection”, and “Not the real {name}” when the name copies a known collection at another address. One collection per box."
        >
          <p className="sh-newbox-later__badges" aria-label="Labels a box of NFTs you own shows">
            <span className="sh-newbox-later__badge" data-verified="">
              <CheckIcon />
              Verified
            </span>
            <span className="sh-newbox-later__badge">
              <UnverifiedGlyph />
              Unverified
            </span>
          </p>
        </LaterCard>
        <LaterCard title="NFTs from fees" line="Fees collect NFTs" info="An add-on: the box’s fees collect NFTs into it over time. After counsel." />
        <LaterCard title="Token baskets" line="A box of tokens" info="A box that holds tokens instead of NFTs. Not designed yet." />
      </ul>
    </section>
  );
}

function NewCollection(props: ContentsStepProps) {
  const { form, set, errorFor, art, commitment, collectionCover, pictures, progress, onArt, onCollectionCover, inbox = false, planLine = false, priceCoin } = props;
  const artError = errorFor(CONTROL.art);
  const artReady = !progress && commitment !== null;
  const mb = art && art.problems.length === 0 ? Math.max(1, Math.ceil(art.totalBytes / 1_048_576)) : null;
  return (
    <>
      <div className="sh-newbox-field">
        <ArtLabel />
        <ArtPickers ready={artReady} error={artError} onArt={onArt} />
        <ArtStatus art={art} commitment={commitment} progress={progress} />
        <FieldError id={`${CONTROL.art}-error`} message={artError} />
      </div>
      <ChipGroup
        id={CONTROL.shown}
        legend="Shown"
        info={{
          label: DRAWS ? 'About open and hidden art' : 'About open art',
          body: (
            <>
              <p>Open: every item’s art is public from the start.</p>
              {DRAWS ? <p>Hidden until drawn: buyers get a placeholder that opens as one item once its number is drawn. Keep the reveal file you save on the Overview: items reveal only with it.</p> : null}
            </>
          ),
        }}
        options={[
          { value: 'open', label: 'Open' },
          // SH-258: not offered at all where the test network has no hidden draws (BNB Chain testnet).
          ...(DRAWS ? [{ value: 'hidden' as const, label: 'Hidden until drawn', ...(props.off?.hidden ? { disabled: true, describedBy: `${CONTROL.shown}-off` } : {}) }] : []),
        ]}
        value={form.artMode}
        onChange={(artMode) => set({ artMode, storeAll: artMode === 'hidden' ? false : form.storeAll })}
        error={errorFor(CONTROL.shown)}
      />
      {DRAWS && props.off?.hidden ? props.off.line(`${CONTROL.shown}-off`) : null}
      {planLine && form.artMode === 'hidden' ? <HiddenNumbersLine planned={art?.planned === true && art.problems.length === 0} /> : null}
      <PicturePicker
        id={CONTROL.collectionCover}
        label="Collection cover"
        action={collectionCover ? 'Change' : 'Add image'}
        busy={pictures.collection.busy}
        thumb={collectionCover?.url ?? null}
        // Built: an open-art item shows the collection cover until it is revealed (BoxCollection's hidden view); whether
        // it should be the logo instead is a founder question (P, box-spec field 28).
        info={{
          label: 'About the collection cover',
          body: <p>{`The collection’s picture on marketplaces${form.artMode === 'open' ? ', and each item’s until it is revealed' : ''}. Your logo stays the token’s picture.`}</p>,
        }}
        hint={COVER_HINT}
        error={pictures.collection.problem ?? errorFor(CONTROL.collectionCover)}
        onFiles={([file]) => {
          if (file) onCollectionCover(file);
        }}
      >
        {props.slots ?? null}
      </PicturePicker>
      <CollectionPage {...props} />
      {props.off?.page ? props.off.line(COLLECTION_PAGE_OFF) : null}
      <ChipGroup
        id={CONTROL.royalty}
        legend="Royalty"
        info={{
          label: 'About the royalty',
          body: inbox
            ? <p>{`Asked of marketplaces each time an item is resold; they may skip it. Royalties reach this box’s inbox. Once in ${priceCoin ?? 'the price coin'} they follow the buyers’ side, except To holders: that 10/15 goes into the pool. If the box fails first, they join the closing claim.${COW_SALES ? ` The box offers coins on its sale list for ${priceCoin ?? 'the price coin'} on CoW; your payee can take one that does not sell for 30 days.` : ''}`}</p>
            : <p>Asked of marketplaces each time an item is resold; they may skip it. With fees: split like the trade fees. You: paid to your address, the same one as your fee payouts. Pool depth: added to this box’s pool.</p>,
        }}
        options={ROYALTY_BPS.map((bps) => ({ value: bps, label: bps === 0 ? 'Off' : bpsText(BigInt(bps)), ...(bps !== 0 && props.off?.royalty ? { disabled: true, describedBy: `${CONTROL.royalty}-off` } : {}) }))}
        value={form.royaltyBps}
        onChange={(royaltyBps) => set({ royaltyBps })}
        error={errorFor(CONTROL.royalty)}
      />
      {props.off?.royalty ? props.off.line(`${CONTROL.royalty}-off`) : null}
      {form.royaltyBps !== 0 && !inbox ? <ChipGroup id={CONTROL.royaltyTo} legend="Royalty to" options={ROYALTY_TO_OPTIONS} value={form.royaltyTo} onChange={(royaltyTo) => set({ royaltyTo })} error={errorFor(CONTROL.royaltyTo)} /> : null}
      {/* SH-258: permanent storage (Arweave) only where the test network keeps pictures there (not BNB Chain testnet). */}
      {STORE_ALL ? <label className="sh-newbox-toggle" data-disabled={form.artMode === 'hidden' || undefined}>
        <input id={CONTROL.storeAll} type="checkbox" checked={form.storeAll} disabled={form.artMode === 'hidden'} onChange={(event) => set({ storeAll: event.currentTarget.checked })} />
        Store all art permanently
        <small>{form.artMode === 'hidden' ? 'Open art only' : mb === null ? 'Add art first' : `${mb} MB · price later`}</small>
      </label> : null}
      <More {...props} />
    </>
  );
}

export function ContentsStep(props: ContentsStepProps) {
  const { form, set, errorFor, shop, off } = props;
  const offId = `${CONTROL.contents}-off`;
  type Tile = { value: 'token' | 'collection' | 'shop'; label: string; hint: string; icon: ReactNode; disabled?: boolean; describedBy?: string };
  const all: Tile[] = [
    { value: 'token', label: 'Token', hint: 'No NFTs', icon: <CoinGlyph size={24} /> },
    { value: 'collection', label: 'New collection', hint: 'Your NFTs', icon: <GridGlyph size={24} /> },
    ...(shop ? [{ value: 'shop' as const, label: 'Shop', hint: 'Many collections', icon: <TemplateIcon id="shop" size={24} decorative /> }] : []),
  ];
  const tiles = all.map((tile): Tile => (off?.contents(tile.value) ? { ...tile, disabled: true, describedBy: offId } : tile));
  return (
    <>
      <ChipGroup
        id={CONTROL.contents}
        legend={<span className="sh-visually-hidden">What’s in the box</span>}
        options={tiles}
        value={shop?.chosen && form.contents === 'token' ? 'shop' : form.contents}
        onChange={(contents) => (shop ? shop.onChoose(contents) : set({ contents: contents === 'token' ? 'token' : 'collection' }))}
        error={errorFor(CONTROL.contents)}
        wide
        tiles
      />
      {off && tiles.some((tile) => tile.disabled) ? off.line(offId) : null}
      {form.contents === 'collection' ? <NewCollection {...props} /> : null}
      {props.extra}
      <ComingLater />
    </>
  );
}
