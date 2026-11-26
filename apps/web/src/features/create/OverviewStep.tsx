/**
 * Step 6, Overview (box creation flow § 1, F70 (6)): the warnings that apply (a sell, the deadline's refunds, hidden
 * art's reveal file, the creator's share) and the box card first; then every parameter grouped by step, each group with
 * an Edit link that returns here ("Back to overview"): the logo and the collection cover as pictures (F74 U3), a holder
 * payout with "Pending legal review" in the Demo and "Demo only" on a chain source (F74 U1; a value Sepolia's rules
 * leave out, "Not on testnet yet"), the cap in ETH per 30 days (U2), the one target (U5); and the fixed
 * values (closed); then, last, what Create needs:
 * your address, the reveal file, the rights box while unticked, and the bar with the cost and Create (Demo) or Create
 * off with Download BoxSpec (chain sources). So Create always comes after the parameters (F70: "then Create"). Under
 * it: the collection page data (contractURI, F71 (2)) and Details, closed; the box page preview below the form.
 * Nothing here sends, uploads or asks a wallet for anything.
 */
import { AddOnId, CapExcess, type BoxSpecV1, type Network } from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { boxPath } from '../boxes/box-id';
import type { BoxRecord } from '../boxes/box-model';
import { qBurns, sellsLine, sideFacts, sideWords, type FeeSide } from '../boxes/fee-kinds';
import { noteOn } from '../boxes/spec-network';
import { cleanLinks, linkHref, type LinkKey } from '../boxes/site-links';
import { bpsText, ethText } from '../boxes/spec-record';
import { formatCount, shortAddress } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { CardPreview, HeaderPreview } from './BoxPreview';
import { firstInShare, pickedTimeText, RightsBox, targetText, utcTime } from './ChoiceSteps';
import { ROYALTY_TO_WORDS } from './ContentsStep';
import { EditGlyph, TextField, type StepProps } from './create-parts';
import { CAP_EXCESS_KEY, OPEN_PRESETS, Q_ASSETS, STEPS, collectionNames, contractUri, costEstimate, effectivePageLink, type CoverState, type Hex, type PageState, type StepId } from './create-model';
import { FixedValues } from './FixedValues';
import { capLine, pairOf, tickerOf } from './KindStep';
import { CONTROL, type ControlId } from './reason-copy';
import { NATIVE_SYMBOL } from '../data-source/native-coin';

/** "0x1a2b3c…9f0e": a hash short enough for one line; the full one is under Details. */
export const shortHash = (hash: Hex) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/** The cost, or null when the spec does not encode (buildSpec keeps every number encodable; this is the backstop). */
function safeCost(spec: BoxSpecV1): ReturnType<typeof costEstimate> | null {
  try {
    return costEstimate(spec);
  } catch {
    return null;
  }
}

/** "Cost ≈ 0.056 ETH" with its (i): the bar's first words on the Overview. */
export function CostLine({ spec }: { spec: BoxSpecV1 }) {
  const tip = useInfoTip();
  const cost = safeCost(spec);
  return (
    <div className="sh-newbox-cost">
      <p>
        {cost ? `Cost ≈ ${ethText(cost.totalWei)} ${NATIVE_SYMBOL}` : 'Cost not known yet'} {cost ? <InfoButton tip={tip} label="About the cost" /> : null}
      </p>
      {cost ? (
        <InfoPanel tip={tip}>
          <p>{`About ${formatCount(cost.gas)} gas at 1 gwei, the 0.0015 ${NATIVE_SYMBOL} first trade that is burned, and your ${NATIVE_SYMBOL} at start. ${NATIVE_SYMBOL} only.`}</p>
        </InfoPanel>
      ) : null}
    </div>
  );
}

interface Row {
  readonly label: string;
  readonly value: ReactNode;
}

/** One step's parameters with its Edit link (named by its group) and "Fix" while that step needs something. */
function Group({ step, rows, fix, focus }: { step: StepId; rows: readonly Row[]; fix: boolean; focus: ControlId }) {
  const label = STEPS.find((entry) => entry.id === step)?.label ?? step;
  const titleId = `overview-${step}`;
  return (
    <section className="sh-newbox-group" aria-labelledby={titleId} data-fix={fix || undefined}>
      <div className="sh-newbox-group__head">
        <h2 id={titleId}>
          {label}
          {fix ? <span className="sh-newbox-group__fix"> · Fix</span> : null}
        </h2>
        <Link to={`/create/${step}`} state={{ fromOverview: true, focus }} aria-label={`Edit ${label}`} className="sh-newbox-edit">
          <EditGlyph />
          Edit
        </Link>
      </div>
      <dl className="sh-newbox-rows">
        {rows.map((row) => (
          <div key={row.label} className="sh-newbox-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The "Opens" value: "Now · next block" (openAt 0), a preset as "in 1 h · 19:00 UTC" (the UTC time the spec carries),
 * or a picked time as "18:00 UTC · in 3 h".
 */
function opensText(form: StepProps['form'], spec: BoxSpecV1, nowMs: number): string {
  if (form.open.kind === 'time') return pickedTimeText(spec.openAt, nowMs) ?? 'Pick a time';
  const id = form.open.id;
  const preset = OPEN_PRESETS.find((entry) => entry.id === id);
  if (!preset) return 'Pick a time';
  // Now (openAt 0) opens in the block after the creation block, never in it.
  return spec.openAt === 0 ? `${preset.label} · next block` : `in ${preset.label} · ${utcTime(spec.openAt * 1000, nowMs)}`;
}

/** The collection page as it will look: the banner and each teaser as a thumbnail (each tagged "Teaser"), the link. */
function PageValue({ page, link }: { page: PageState; link: string }) {
  if (!page.banner && page.teasers.length === 0 && !link) return <>None</>;
  return (
    <span className="sh-newbox-page-row">
      {page.banner ? page.banner.url ? <img className="sh-newbox-thumb sh-newbox-thumb--banner" src={page.banner.url} width={64} height={16} alt="Banner" /> : <span>Banner</span> : null}
      {page.teasers.map((teaser, index) => (
        <span key={`${teaser.sha256}-${index}`} className="sh-newbox-page-row__teaser">
          {teaser.url ? <img className="sh-newbox-thumb sh-newbox-thumb--small" src={teaser.url} width={28} height={28} alt={`Teaser ${index + 1}`} /> : null}
          <small aria-hidden={teaser.url ? 'true' : undefined}>Teaser</small>
        </span>
      ))}
      {link ? <span className="sh-newbox-page-row__link">{link.replace(/^https:\/\//, '')}</span> : null}
    </span>
  );
}

/** The box's description as the spec holds it, two lines at first ("More" shows the rest): the last proofread. */
function AboutText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const textId = `overview-about-text`;
  if (text.trim() === '') return <>None</>;
  // About 70 characters fill two lines of the narrowest column (a phone); shorter text never needs the button.
  const long = text.length > 70;
  return (
    <span className="sh-newbox-about">
      <span id={textId} className="sh-newbox-clamp" data-open={open || undefined}>
        {text}
      </span>
      {long ? (
        <button type="button" className="sh-newbox-text-button" aria-expanded={open} aria-controls={textId} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      ) : null}
    </span>
  );
}

const LINK_KEYS: readonly LinkKey[] = ['website', 'x', 'telegram'];

/** "skylanterns.example · @skylanterns": the links as plain text (never links here), so a typo shows before Create. */
function linksText(links: StepProps['form']['links']): string {
  const kept = cleanLinks(links);
  const shown = LINK_KEYS.flatMap((key) => {
    const link = linkHref(key, kept[key]);
    return link ? [link.text] : [];
  });
  return shown.length === 0 ? 'None' : shown.join(' · ');
}

/** A row's value with its own (i): the details behind a number (hidden art's ticket and item texts). */
function ValueInfo({ value, label, children }: { value: string; label: string; children: ReactNode }) {
  const tip = useInfoTip();
  return (
    <>
      <span className="sh-newbox-value-info">
        {value} <InfoButton tip={tip} label={label} />
      </span>
      <InfoPanel tip={tip}>{children}</InfoPanel>
    </>
  );
}

/** A side in a few words, with this Q's real burn (a burn of Q reads "Burn · Q", never "Burn · FIT", where Q burns). */
function sideOf(side: FeeSide, value: number, form: StepProps['form']): ReturnType<typeof sideFacts> {
  return sideFacts(side, value, qBurns(Q_ASSETS[form.qIndex] ?? Q_ASSETS[0]));
}

export interface OverviewStepProps extends StepProps {
  readonly spec: BoxSpecV1;
  readonly record: BoxRecord;
  readonly specHash: Hex | null;
  readonly owner: Address | null;
  readonly demo: boolean;
  /** Whose rules the spec is checked with (F74 U1): a value's note says why it is off here ("Demo only"). */
  readonly network: Network;
  readonly nowMs: number;
  readonly cover: CoverState | null;
  /** A new collection's own cover (field 28, F74 U3). */
  readonly collectionCover: CoverState | null;
  readonly page: PageState;
  readonly fix: ReadonlySet<StepId>;
  readonly duplicateId: string | null;
  readonly revealNeeded: boolean;
  readonly revealSaved: boolean;
  /** The action bar offers "Save reveal file" (Demo, connected): no second button here. */
  readonly revealInBar: boolean;
  readonly onDownloadSpec: () => void;
  readonly onDownloadReveal: () => void;
  /** The action bar (cost, Create): placed after the groups and the fixed values, with your address and the rights box. */
  readonly bar: ReactNode;
}

/** The warnings that apply (§ 1): words with an icon, never colour alone. */
function Warnings({ form, spec }: { form: StepProps['form']; spec: BoxSpecV1 }) {
  const t = tickerOf(form);
  const q = pairOf(form);
  const sells = [sideOf('buyers', spec.qStream, form), sideOf('sellers', spec.tStream, form)].some((facts) => facts?.converts === 'sells');
  const share = firstInShare(form);
  const lines = [
    sells ? sellsLine(t, q) : null,
    `Not full in ${spec.deadlineDays} days: refunds`,
    form.contents === 'collection' && form.artMode === 'hidden' ? 'Keep the reveal file' : null,
    share ? `Your ${q}: ${share}` : null,
  ].filter((line): line is string => line !== null);
  return (
    <ul className="sh-newbox-warnings" aria-label="Warnings">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function OwnerRow({ form, set, owner, demo, errorFor }: Pick<OverviewStepProps, 'form' | 'set' | 'owner' | 'demo' | 'errorFor'>) {
  const error = errorFor(CONTROL.owner);
  if (!demo) {
    // Chain sources: the address can be pasted (no factory yet, nothing is sent).
    return (
      <TextField
        id={CONTROL.owner}
        label="Your address"
        value={form.ownerText}
        placeholder={owner ?? '0x…'}
        onChange={(ownerText) => set({ ownerText })}
        error={error}
        spellCheck={false}
        hint="Owner and payouts"
      />
    );
  }
  return (
    <>
      <dl className="sh-newbox-rows sh-newbox-overview-owner">
        <div className="sh-newbox-row" id={CONTROL.owner} tabIndex={-1}>
          <dt>Your address</dt>
          <dd>{owner ? <code title={owner}>{shortAddress(owner)}</code> : <span className="sh-muted">Connect to set</span>}</dd>
        </div>
      </dl>
      {error ? (
        <p className="sh-newbox-error">
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </>
  );
}

function RevealBlock({ revealSaved, revealInBar, error, onDownloadReveal }: { revealSaved: boolean; revealInBar: boolean; error: string | null; onDownloadReveal: () => void }) {
  return (
    <div className="sh-newbox-reveal" id={CONTROL.reveal} tabIndex={-1}>
      {revealInBar ? null : (
        <button type="button" className="sh-button" onClick={onDownloadReveal}>
          Download reveal file
        </button>
      )}
      <p className="sh-newbox-hint">{revealSaved ? 'Saved. Keep this file: items reveal only with it.' : revealInBar ? 'Reveal file: save it and keep it. Items reveal only with it.' : 'Keep this file. Items reveal only with it.'}</p>
      {error ? (
        <p className="sh-newbox-error">
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </div>
  );
}

/** The box page as it will look: open at first on wide screens (full width under the form), a tap away on a phone. */
export function PagePreview({ record }: { record: BoxRecord }) {
  const [open, setOpen] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1025px)').matches);
  return (
    <details className="sh-newbox-more sh-newbox-page-preview" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Box page preview</summary>
      {open ? <HeaderPreview record={record} /> : null}
    </details>
  );
}

/** A picture as the Overview shows it: its thumbnail (named by `alt`), "Added" without one, or "Missing". */
function pictureValue(picture: CoverState | null, alt: string): ReactNode {
  if (picture?.url) return <img className="sh-newbox-thumb sh-newbox-thumb--small" src={picture.url} width={28} height={28} alt={alt} />;
  return picture ? 'Added' : 'Missing';
}

/** A row's words with the note its value carries on this source ("Pending legal review", "Demo only", F74 U1), if any. */
function noted(words: string, note: string | null): ReactNode {
  if (note === null) return words;
  return (
    <span className="sh-newbox-value-note">
      {words} <small className="sh-newbox-pending">{note}</small>
    </span>
  );
}

const EXCESS_WORD: Readonly<Record<number, string>> = Object.freeze({ [CapExcess.BURN]: 'burn', [CapExcess.POOL_DEPTH]: 'pool', [CapExcess.HOLDERS]: 'holders' });

/** A side in a few words ("Holders · ETH"), with its note on this source ("Pending legal review" in the Demo, "Demo only" elsewhere). */
const sideValue = (side: FeeSide, value: number, form: StepProps['form'], network: Network): ReactNode =>
  noted(sideWords(sideOf(side, value, form), tickerOf(form), pairOf(form), true), side === 'buyers' ? noteOn('qStream', 'QStream', value, network) : noteOn('tStream', 'TStream', value, network));

/** "4 ETH / 30 days · burn above", with the note when the excess goes to holders. */
const capValue = (form: StepProps['form'], network: Network): ReactNode =>
  noted(`${capLine(form.capPerEpoch, pairOf(form))} · ${EXCESS_WORD[form.capExcess] ?? 'burn'} above`, noteOn(CAP_EXCESS_KEY, 'CapExcess', form.capExcess, network));

function groupsOf({ form, spec, record, cover, collectionCover, page, nowMs, network }: OverviewStepProps): { step: StepId; rows: Row[]; focus: ControlId }[] {
  const t = tickerOf(form);
  const q = pairOf(form);
  const collection = form.contents === 'collection';
  const names = collectionNames(form);
  const share = firstInShare(form);
  const traits = record.spec?.traitTypes.length ?? 0;
  const items = `${formatCount(BigInt(spec.n))} · ${form.artMode === 'open' ? 'open art' : 'hidden'}`;
  const contents: Row[] = collection
    ? [
        {
          label: 'Items',
          value:
            form.artMode === 'hidden' ? (
              <ValueInfo value={items} label="About the hidden texts">
                <p>{`Ticket: ${form.ticketLine}`}</p>
                <p>{`Hidden item: ${form.hiddenLine}`}</p>
              </ValueInfo>
            ) : (
              items
            ),
        },
        { label: 'Traits', value: traits === 0 ? 'None' : `${traits}` },
        // F74 U3: the collection's own cover (marketplaces show it), beside the logo on Basics.
        { label: 'Collection cover', value: pictureValue(collectionCover, 'Collection cover added') },
        ...(form.separateCollection ? [{ label: 'Collection', value: `${names.name} · ${names.symbol}` }] : []),
        { label: 'Owner', value: 'You' },
        { label: 'Royalty', value: form.royaltyBps === 0 ? 'Off' : `${bpsText(BigInt(form.royaltyBps))} · ${ROYALTY_TO_WORDS[form.royaltyTo]}` },
        { label: 'Page', value: <PageValue page={page} link={effectivePageLink(form)} /> },
        ...(form.specials.length > 0 ? [{ label: 'Series', value: form.specials.map((row) => `${row.label.trim() || 'Unnamed'} × ${row.count.trim() || '?'}`).join(' · ') }] : []),
        ...(form.storeAll && form.artMode === 'open' ? [{ label: 'Storage', value: 'All art · price later' }] : []),
      ]
    : [{ label: 'In the box', value: form.contents === 'token' ? 'Token' : 'Not picked' }];
  const cap = spec.addOns.some((addOn) => addOn.id === AddOnId.CreatorFeeCap);
  return [
    {
      step: 'basics',
      focus: CONTROL.name,
      rows: [
        { label: 'Token', value: `${form.name || 'No name'} · ${t}` },
        { label: 'Paired with', value: q },
        { label: 'Logo', value: pictureValue(cover, 'Logo added') },
        { label: 'About', value: <AboutText text={spec.description} /> },
        { label: 'Links', value: linksText(form.links) },
      ],
    },
    { step: 'contents', focus: CONTROL.contents, rows: contents },
    {
      step: 'kind',
      focus: CONTROL.buyers,
      rows: [
        { label: 'Buyers’ fees', value: sideValue('buyers', form.qStream, form, network) },
        { label: 'Sellers’ fees', value: sideValue('sellers', form.tStream, form, network) },
        // A fixed amount per 30 days (F74 U2), then where fees above it go.
        ...(cap ? [{ label: 'Fee cap', value: capValue(form, network) }] : []),
      ],
    },
    // The one target (F74 U5): a fact; the Edit link opens the deadline, the step's only choice.
    { step: 'raise', focus: CONTROL.deadline, rows: [{ label: 'Target', value: `${targetText(form)} · ${spec.deadlineDays} days` }] },
    {
      step: 'launch',
      focus: CONTROL.opens,
      rows: [
        { label: 'Opens', value: opensText(form, spec, nowMs) },
        ...(spec.creatorBuy > 0n ? [{ label: `Your ${q}`, value: `${ethText(spec.creatorBuy)}${share ? ` · ${share}` : ''}` }] : []),
        { label: 'Rights', value: form.rights ? 'Confirmed' : 'Not yet' },
      ],
    },
  ];
}

export function OverviewStep(props: OverviewStepProps) {
  const { form, set, spec, record, specHash, owner, demo, errorFor, fix, duplicateId, revealNeeded, revealSaved, revealInBar, onDownloadSpec, onDownloadReveal, bar } = props;
  const uri = contractUri(spec);
  // The rights box shows while unticked; ticked here, it stays for this visit (no jump, focus kept on it).
  const [rightsHere] = useState(() => !form.rights);
  return (
    <>
      <Warnings form={form} spec={spec} />
      <CardPreview record={record} />
      {groupsOf(props).map((group) => (
        <Group key={group.step} step={group.step} rows={group.rows} fix={fix.has(group.step)} focus={group.focus} />
      ))}
      <details className="sh-newbox-more">
        <summary>Fixed for every box</summary>
        <FixedValues ticker={tickerOf(form)} q={pairOf(form)} />
      </details>
      <OwnerRow form={form} set={set} owner={owner} demo={demo} errorFor={errorFor} />
      {revealNeeded ? <RevealBlock revealSaved={revealSaved} revealInBar={revealInBar} error={errorFor(CONTROL.reveal)} onDownloadReveal={onDownloadReveal} /> : null}
      {rightsHere || !form.rights ? <RightsBox form={form} set={set} errorFor={errorFor} /> : null}
      {duplicateId ? (
        <p className="sh-newbox-duplicate" role="status">
          Already created · <Link to={boxPath(duplicateId)}>Open it</Link>
        </p>
      ) : null}
      {bar}
      {uri ? (
        <details className="sh-newbox-more sh-newbox-uri">
          <summary>Collection page data</summary>
          <pre aria-label="contractURI JSON">{JSON.stringify(uri, null, 2)}</pre>
        </details>
      ) : null}
      <details className="sh-newbox-more sh-newbox-spec">
        <summary>Details</summary>
        <p className="sh-newbox-hash">
          <span>Spec hash</span> <code data-spec-hash={specHash ?? ''}>{specHash ?? 'Not built yet'}</code>
        </p>
        {/* Chain sources have Download BoxSpec in the action bar; the Demo keeps it here. */}
        {demo ? (
          <button type="button" className="sh-button" onClick={onDownloadSpec}>
            Download BoxSpec
          </button>
        ) : null}
      </details>
    </>
  );
}

export interface CreateActionProps {
  readonly demo: boolean;
  readonly owner: Address | null;
  readonly rights: boolean;
  /** Hidden art in the Demo, reveal file not saved yet: the primary button saves it first. */
  readonly revealPending: boolean;
  readonly specHash: Hex | null;
  readonly onCreate: () => void;
  readonly onConnect: () => void;
  readonly onSaveReveal: () => void;
  readonly onDownloadSpec: () => void;
}

/**
 * The action bar's buttons on the Overview. Chain sources: Create off (aria-disabled, still focusable) with its
 * reason, and Download BoxSpec beside it with the short spec hash. Demo: "Connect to create", then "Save reveal file"
 * for hidden art, then Create, off and described by the rights box until it is ticked (a press shows the summary).
 */
export function CreateAction({ demo, owner, rights, revealPending, specHash, onCreate, onConnect, onSaveReveal, onDownloadSpec }: CreateActionProps) {
  if (!demo) {
    return (
      <div className="sh-newbox-action" data-source="chain">
        <button type="button" className="sh-button sh-button--primary" aria-disabled="true" aria-describedby="create-off-reason" onClick={() => document.getElementById('create-off-reason')?.focus()}>
          Create
        </button>
        <button type="button" className="sh-button sh-newbox-download" onClick={onDownloadSpec} aria-describedby={specHash ? 'create-spec-hash' : undefined}>
          Download BoxSpec
        </button>
        <p className="sh-newbox-note">
          <span id="create-off-reason" tabIndex={-1}>
            Creation opens with the box factory.
          </span>{' '}
          {specHash ? (
            <span id="create-spec-hash" className="sh-newbox-note__hash">
              Spec <code title={specHash}>{shortHash(specHash)}</code>
            </span>
          ) : null}
        </p>
      </div>
    );
  }
  if (!owner) {
    return (
      <div className="sh-newbox-action">
        <button type="button" className="sh-button sh-button--primary" aria-haspopup="dialog" onClick={onConnect}>
          Connect to create
        </button>
      </div>
    );
  }
  if (revealPending) {
    return (
      <div className="sh-newbox-action">
        <button type="button" className="sh-button sh-button--primary" onClick={onSaveReveal}>
          Save reveal file
        </button>
      </div>
    );
  }
  return (
    <div className="sh-newbox-action">
      <button
        type="submit"
        className="sh-button sh-button--primary"
        aria-disabled={rights ? undefined : 'true'}
        aria-describedby={rights ? undefined : `${CONTROL.rights}-label`}
        onClick={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        Create
      </button>
    </div>
  );
}
