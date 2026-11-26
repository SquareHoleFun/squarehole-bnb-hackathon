/**
 * Validation messages (box creation flow § 5): every verdict of `validateBoxSpecV1` (the factory's own check) and every
 * per-field check the page runs with the same rule code (`checkString`, the generated constants) maps to a step, the
 * control to fix and a few words on it. A verdict the page should never produce is a builder bug: it is shown with a
 * generic message and its reason and field names under Details, never hidden.
 */
import {
  CONTEXT_V2,
  ENUM_MEMBERS,
  FIELD_NAMES,
  Field,
  MAX_N,
  MAX_SYMBOL_BYTES,
  MAX_TEXT_BYTES,
  MAX_TOKEN_NAME_BYTES,
  MIN_N,
  NOT_BUILT,
  REASON_NAMES,
  RULE_RANGES,
  Reason,
  STRICTEST_NETWORK,
  boxSpecV1Schema,
  checkString,
  type BoxSpecV1,
  type Network,
  type Verdict,
} from '@squarehole/box-spec';
import { linkProblem, pageLinkReason, MAX_PAGE_LINK_BYTES, MAX_SITE_LINK_CHARS, type LinkKey, type LinkProblem } from '../boxes/site-links';
import { ethExact } from '../boxes/spec-record';
import {
  MAX_SPECIALS,
  MAX_TEASERS,
  PICK_TIME_MAX_AHEAD_SECONDS,
  PICK_TIME_MIN_AHEAD_SECONDS,
  collectionNames,
  effectivePageLink,
  metadataTableHex,
  openAheadSeconds,
  parseCount,
  parseEthText,
  raiseOf,
  ticketNames,
  type ArtCommitment,
  type ArtState,
  type CoverState,
  type CreateForm,
  type OwnerProblem,
  type PageState,
  type StepId,
} from './create-model';
import { NATIVE_SYMBOL } from '../data-source/native-coin';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** The control ids the messages point at (the error summary's links move focus there). */
export const CONTROL = Object.freeze({
  pair: 'create-pair',
  name: 'create-name',
  ticker: 'create-ticker',
  logo: 'create-logo',
  about: 'create-about',
  website: 'create-website',
  x: 'create-x',
  telegram: 'create-telegram',
  contents: 'create-contents',
  collectionName: 'create-collection-name',
  collectionSymbol: 'create-collection-ticker',
  art: 'create-art',
  shown: 'create-shown',
  collectionCover: 'create-collection-cover',
  specials: 'create-specials',
  ticketLine: 'create-ticket-line',
  hiddenLine: 'create-hidden-line',
  banner: 'create-banner',
  teasers: 'create-teasers',
  pageLink: 'create-page-link',
  royalty: 'create-royalty',
  royaltyTo: 'create-royalty-to',
  storeAll: 'create-store-all',
  buyers: 'create-buyers',
  sellers: 'create-sellers',
  cap: 'create-cap',
  capExcess: 'create-cap-excess',
  target: 'create-target',
  deadline: 'create-deadline',
  opens: 'create-opens',
  openTime: 'create-open-time',
  firstIn: 'create-first-in',
  rights: 'create-rights',
  owner: 'create-owner',
  reveal: 'create-reveal',
});

export type ControlId = (typeof CONTROL)[keyof typeof CONTROL];

/** The field each control is, for the error summary ("Name: Required"); its inline message sits on the field itself. */
export const CONTROL_LABEL: Readonly<Record<ControlId, string>> = Object.freeze({
  'create-pair': 'Paired with',
  'create-name': 'Name',
  'create-ticker': 'Ticker',
  'create-logo': 'Logo',
  'create-about': 'About',
  'create-website': 'Website',
  'create-x': 'X',
  'create-telegram': 'Telegram',
  'create-contents': 'What’s in the box',
  'create-collection-name': 'Collection name',
  'create-collection-ticker': 'Collection ticker',
  'create-art': 'Art',
  'create-shown': 'Shown',
  'create-collection-cover': 'Collection cover',
  'create-specials': 'Special series',
  'create-ticket-line': 'Ticket text',
  'create-hidden-line': 'Hidden item text',
  'create-banner': 'Banner',
  'create-teasers': 'Teasers',
  'create-page-link': 'Link',
  'create-royalty': 'Royalty',
  'create-royalty-to': 'Royalty to',
  'create-store-all': 'Storage',
  'create-buyers': 'Buyers’ fees',
  'create-sellers': 'Sellers’ fees',
  'create-cap': 'Cap your fees',
  'create-cap-excess': 'Above the cap',
  'create-target': 'Target',
  'create-deadline': 'Deadline',
  'create-opens': 'Opens',
  'create-open-time': 'Time',
  'create-first-in': `Your ${NATIVE_SYMBOL}`,
  'create-rights': 'Rights',
  'create-owner': 'Your address',
  'create-reveal': 'Reveal file',
});

/**
 * An error-summary line: the field's name first, unless the message already names it ("Add a logo") or is a builder
 * bug (its field is a guess; the reason is under Details).
 */
export function summaryLine(issue: Pick<Issue, 'control' | 'message' | 'detail'>): string {
  const label = CONTROL_LABEL[issue.control];
  if (issue.detail !== undefined || issue.message.toLowerCase().includes(label.toLowerCase())) return issue.message;
  return `${label}: ${issue.message}`;
}

export interface Issue {
  readonly step: StepId;
  readonly control: ControlId;
  readonly message: string;
  /** Builder bugs only: the verdict's reason and field names, shown under Details. */
  readonly detail?: string;
}

export const MESSAGES = Object.freeze({
  required: 'Required',
  upTo: (max: bigint) => `Up to ${max === 1024n ? '1,024' : max.toString()} characters`,
  badCharacter: 'Plain letters, numbers and punctuation only. No " \\ or emoji.',
  svg: 'Plain SVG text only',
  items: `${MIN_N} to ${MAX_N.toLocaleString('en-US')} items`,
  openTime: 'Pick a time within 14 days',
  openSoon: 'Pick a time at least 2 minutes ahead',
  pickTime: 'Pick a time',
  belowTarget: (raise: bigint) => `Below the target: less than ${ethExact(raise)} ${NATIVE_SYMBOL}`,
  number: 'Use a number like 0.05',
  count: 'Use a whole number like 12',
  addLogo: 'Add a logo',
  addCollectionCover: 'Add a collection cover',
  /** F74 U1: holder payouts are offered in the Demo only (chain sources: never mainnet; Sepolia once S14 builds them). */
  demoOnly: DEMO_BUILD ? 'Not offered here yet, pending legal review' : 'Not offered here yet',
  /** Sepolia's rules leave out what core v1 does not build (a conversion or a sell: the swap module). */
  notOnTestnet: 'Not on testnet yet',
  addArt: 'Add your art',
  fixArt: 'Fix the art files listed',
  tooManyTraits: 'Too many traits for one box',
  addAddress: 'Add your address',
  notAddress: 'Not a full 0x address',
  checksum: 'Check the address',
  pickOption: 'Pick one of the options',
  pickContents: 'Pick what’s in the box',
  seriesSize: 'A series can’t be larger than the box',
  seriesCount: `Up to ${MAX_SPECIALS} special series`,
  teaserCount: `Up to ${MAX_TEASERS} teasers`,
  httpsLink: 'Use a full https:// link',
  xLink: 'An @handle or an x.com link',
  telegramLink: 'A t.me link',
  /** BP-13: the sellers' Burn FIT sells T for Q, the buyers' Burn T buys it back in the same pool. */
  notBesideBurn: (ticker: string) => `Not beside Burn ${ticker || 'the token'} on buyers’ fees`,
  rights: 'Confirm your rights',
  reveal: 'Download the reveal file first',
  bug: 'This page built a box it can’t create. Reload and try again.',
});

type Place = { readonly step: StepId; readonly control: ControlId };

const FIELD_CONTROL: ReadonlyMap<number, Place> = new Map([
  [Field.tokenName, { step: 'basics', control: CONTROL.name }],
  [Field.tokenSymbol, { step: 'basics', control: CONTROL.ticker }],
  [Field.description, { step: 'basics', control: CONTROL.about }],
  [Field.q, { step: 'basics', control: CONTROL.pair }],
  [Field.coverSha256, { step: 'basics', control: CONTROL.logo }],
  // F74 U3 (field 28): a new collection's own cover, its own upload on Contents.
  [Field.collectionCoverSha256, { step: 'contents', control: CONTROL.collectionCover }],
  [Field.n, { step: 'contents', control: CONTROL.art }],
  [Field.artMode, { step: 'contents', control: CONTROL.shown }],
  [Field.revealRoot, { step: 'contents', control: CONTROL.art }],
  [Field.metadataTable, { step: 'contents', control: CONTROL.art }],
  [Field.revealListId, { step: 'contents', control: CONTROL.art }],
  [Field.addOns, { step: 'contents', control: CONTROL.specials }],
  [Field['addOns.placeholders.placeholderDescription'], { step: 'contents', control: CONTROL.ticketLine }],
  [Field['addOns.placeholders.hiddenDescription'], { step: 'contents', control: CONTROL.hiddenLine }],
  [Field['addOns.placeholders.hiddenSvg'], { step: 'contents', control: CONTROL.shown }],
  [Field['addOns.edition-specials.label'], { step: 'contents', control: CONTROL.specials }],
  [Field['addOns.edition-specials.count'], { step: 'contents', control: CONTROL.specials }],
  [Field['addOns.royalties.bps'], { step: 'contents', control: CONTROL.royalty }],
  [Field['addOns.royalties.destination'], { step: 'contents', control: CONTROL.royaltyTo }],
  [Field['addOns.collection-metadata.bannerSha256'], { step: 'contents', control: CONTROL.banner }],
  [Field['addOns.collection-metadata.teaserSha256s'], { step: 'contents', control: CONTROL.teasers }],
  [Field['addOns.collection-metadata.externalLink'], { step: 'contents', control: CONTROL.pageLink }],
  [Field.qStream, { step: 'kind', control: CONTROL.buyers }],
  [Field.tStream, { step: 'kind', control: CONTROL.sellers }],
  [Field['addOns.creator-fee-cap.capPerEpoch'], { step: 'kind', control: CONTROL.cap }],
  [Field['addOns.creator-fee-cap.excess'], { step: 'kind', control: CONTROL.capExcess }],
  [Field.raise, { step: 'raise', control: CONTROL.target }],
  [Field.deadlineDays, { step: 'raise', control: CONTROL.deadline }],
  [Field.creatorBuy, { step: 'launch', control: CONTROL.firstIn }],
  [Field.marketplaceOwner, { step: 'overview', control: CONTROL.owner }],
  [Field.creatorFeeRecipient, { step: 'overview', control: CONTROL.owner }],
]);

/** Max bytes of each text field the messages name ("Up to 32 characters"). */
const TEXT_MAX: ReadonlyMap<number, bigint> = new Map([
  [Field.tokenName, MAX_TOKEN_NAME_BYTES],
  [Field.tokenSymbol, MAX_SYMBOL_BYTES],
  [Field.collectionName, MAX_TOKEN_NAME_BYTES],
  [Field.collectionSymbol, MAX_SYMBOL_BYTES],
  [Field.description, MAX_TEXT_BYTES],
  [Field['addOns.placeholders.placeholderName'], 32n],
  [Field['addOns.placeholders.placeholderSymbol'], 11n],
  [Field['addOns.placeholders.placeholderDescription'], 1024n],
  [Field['addOns.placeholders.hiddenDescription'], 1024n],
  // SH-EX-O1: a loaded setup's own hidden picture is the file's text, checked like the rest of its contents.
  [Field['addOns.placeholders.hiddenSvg'], 4096n],
  [Field['addOns.edition-specials.label'], 32n],
]);

const TEXT_VALUE: Readonly<Record<number, (spec: BoxSpecV1) => string>> = {
  [Field.tokenName]: (s) => s.tokenName,
  [Field.tokenSymbol]: (s) => s.tokenSymbol,
  [Field.collectionName]: (s) => s.collectionName,
  [Field.collectionSymbol]: (s) => s.collectionSymbol,
  [Field.description]: (s) => s.description,
};

/** Where a field is set, given the form (a collection's own name and ticker live under Contents' More). */
function placeOf(field: number, form: CreateForm): Place | null {
  const ownName = form.separateCollection;
  if (field === Field.collectionName || field === Field['addOns.placeholders.placeholderName']) return ownName ? { step: 'contents', control: CONTROL.collectionName } : { step: 'basics', control: CONTROL.name };
  if (field === Field.collectionSymbol || field === Field['addOns.placeholders.placeholderSymbol']) return ownName ? { step: 'contents', control: CONTROL.collectionSymbol } : { step: 'basics', control: CONTROL.ticker };
  // A picked time is fixed on its own field (one message, not one on the field and one on the chips).
  if (field === Field.openAt) return { step: 'launch', control: form.open.kind === 'time' ? CONTROL.openTime : CONTROL.opens };
  return FIELD_CONTROL.get(field) ?? null;
}

const bug = (verdict: Verdict, place: Place | null): Issue => ({
  step: place?.step ?? 'overview',
  control: place?.control ?? CONTROL.owner,
  message: MESSAGES.bug,
  detail: `${REASON_NAMES[verdict.reason] ?? `reason ${verdict.reason}`} at ${FIELD_NAMES[verdict.field] ?? `field ${verdict.field}`}`,
});

/** The message for a verdict of `validateBoxSpecV1` on the spec this form built (§ 5's table). */
export function issueForVerdict(verdict: Verdict, spec: BoxSpecV1, form: CreateForm): Issue | null {
  if (verdict.reason === Reason.OK) return null;
  const place = placeOf(verdict.field, form);
  if (place === null) return bug(verdict, null);
  const at = (message: string): Issue => ({ ...place, message });
  switch (verdict.reason) {
    case Reason.LENGTH_OUT_OF_RANGE: {
      if (verdict.field === Field.metadataTable) return at(MESSAGES.tooManyTraits);
      if (verdict.field === Field['addOns.collection-metadata.teaserSha256s']) return at(MESSAGES.teaserCount);
      if (verdict.field === Field['addOns.collection-metadata.externalLink']) return at(MESSAGES.upTo(BigInt(MAX_PAGE_LINK_BYTES)));
      const max = TEXT_MAX.get(verdict.field);
      if (max === undefined) return bug(verdict, place);
      const value = TEXT_VALUE[verdict.field]?.(spec);
      return at(value === '' ? MESSAGES.required : MESSAGES.upTo(max));
    }
    case Reason.BAD_CHARACTER:
      if (verdict.field === Field['addOns.collection-metadata.externalLink']) return at(MESSAGES.httpsLink);
      return at(verdict.field === Field['addOns.placeholders.hiddenSvg'] ? MESSAGES.svg : MESSAGES.badCharacter);
    case Reason.OUT_OF_RANGE:
      if (verdict.field === Field.n) return at(MESSAGES.items);
      // openAt below 2026-09-01 (validate()'s MIN_OPEN_AT): a time already passed, never Now (0 is valid).
      if (verdict.field === Field.openAt) return at(MESSAGES.openSoon);
      if (verdict.field === Field.creatorBuy) return at(MESSAGES.belowTarget(spec.raise));
      if (verdict.field === Field['addOns.edition-specials.count']) return at(MESSAGES.seriesSize);
      return bug(verdict, place);
    case Reason.ZERO_VALUE:
      if (verdict.field === Field.coverSha256) return at(MESSAGES.addLogo);
      if (verdict.field === Field.collectionCoverSha256) return at(MESSAGES.addCollectionCover);
      if (verdict.field === Field.revealRoot || verdict.field === Field.revealListId) return at(MESSAGES.addArt);
      if (verdict.field === Field.marketplaceOwner || verdict.field === Field.creatorFeeRecipient) return at(MESSAGES.addAddress);
      return bug(verdict, place);
    case Reason.NOT_OFFERED:
      // A value kept from the Demo on a source that does not offer it: a holder payout (F74 U1), or on Sepolia's rules
      // a value core v1 does not build there (a conversion or a sell, the swap module).
      if (verdict.field === Field.qStream || verdict.field === Field.tStream) {
        const [enumName, value] = verdict.field === Field.qStream ? ['QStream', spec.qStream] : ['TStream', spec.tStream];
        const name = ENUM_MEMBERS[enumName]?.find((member) => member.value === value)?.name;
        return at(name !== undefined && NOT_BUILT[enumName]?.[name] !== undefined ? MESSAGES.notOnTestnet : MESSAGES.demoOnly);
      }
      if (verdict.field === Field['addOns.creator-fee-cap.excess']) return at(MESSAGES.demoOnly);
      return bug(verdict, place);
    case Reason.NOT_A_MEMBER:
      if (verdict.field === Field.deadlineDays || verdict.field === Field['addOns.royalties.bps'] || verdict.field === Field['addOns.creator-fee-cap.capPerEpoch'] || verdict.field === Field['addOns.creator-fee-cap.excess']) {
        return at(MESSAGES.pickOption);
      }
      return bug(verdict, place);
    case Reason.MENU_RULE:
      // BP-13 is normally unreachable (the option is disabled); any other menu rule is a builder bug.
      if (verdict.field === Field.tStream) return at(MESSAGES.notBesideBurn(spec.tokenSymbol));
      return bug(verdict, place);
    case Reason.TOO_MANY_ADD_ONS:
      return at(MESSAGES.seriesCount);
    default:
      return bug(verdict, place);
  }
}

const textCheck = (text: string, max: bigint, min = 1): number => checkString(new TextEncoder().encode(text), min, Number(max), RULE_RANGES.JSON_TEXT);

function textIssue(text: string, max: bigint, field: number, form: CreateForm, min = 1, control?: Place): Issue | null {
  const reason = textCheck(text, max, min);
  if (reason === Reason.OK) return null;
  const place = control ?? placeOf(field, form);
  if (!place) return null;
  return { ...place, message: reason === Reason.BAD_CHARACTER ? MESSAGES.badCharacter : text === '' ? MESSAGES.required : MESSAGES.upTo(max) };
}

const LINK_MESSAGE: Readonly<Record<LinkProblem, string>> = Object.freeze({
  website: MESSAGES.httpsLink,
  x: MESSAGES.xLink,
  telegram: MESSAGES.telegramLink,
  'too-long': MESSAGES.upTo(BigInt(MAX_SITE_LINK_CHARS)),
});
const LINK_CONTROL: Readonly<Record<LinkKey, ControlId>> = Object.freeze({ website: CONTROL.website, x: CONTROL.x, telegram: CONTROL.telegram });

export interface CheckInput {
  readonly form: CreateForm;
  readonly art: ArtState | null;
  readonly commitment: ArtCommitment | null;
  readonly cover: CoverState | null;
  /** A new collection's own cover (field 28, F74 U3). */
  readonly collectionCover?: CoverState | null;
  readonly page?: PageState;
  readonly nowMs: number;
  /** Whose rules the spec is checked with (F74 U1): the Demo's, Sepolia's (Sepolia, local) or mainnet's (the default). */
  readonly network?: Network;
  /** Hidden art: whether the reveal file was downloaded for this art. */
  readonly revealSaved: boolean;
  /** Chain sources: why the pasted address cannot be used (`chooseOwner`), or null. */
  readonly ownerProblem?: OwnerProblem | null;
  /** The creator's address (connected or pasted); the Overview needs one for the site record. Undefined: not checked. */
  readonly owner?: string | null;
}

function basicsIssues({ form, cover }: CheckInput): (Issue | null)[] {
  const step = 'basics' as const;
  const issues: (Issue | null)[] = [
    textIssue(form.name, MAX_TOKEN_NAME_BYTES, Field.tokenName, form),
    textIssue(form.ticker, MAX_SYMBOL_BYTES, Field.tokenSymbol, form),
    cover ? null : { step, control: CONTROL.logo, message: MESSAGES.addLogo },
    textIssue(form.description, MAX_TEXT_BYTES, Field.description, form, 0),
  ];
  for (const key of ['website', 'x', 'telegram'] as const) {
    const problem = linkProblem(key, form.links[key]);
    if (problem) issues.push({ step, control: LINK_CONTROL[key], message: LINK_MESSAGE[problem] });
  }
  return issues;
}

function contentsIssues({ form, art, commitment, collectionCover = null, page }: CheckInput): (Issue | null)[] {
  const step = 'contents' as const;
  if (form.contents === null) return [{ step, control: CONTROL.contents, message: MESSAGES.pickContents }];
  if (form.contents === 'token') return [];
  const issues: (Issue | null)[] = [];
  const names = collectionNames(form);
  if (form.separateCollection) {
    issues.push(textIssue(form.collectionName, MAX_TOKEN_NAME_BYTES, Field.collectionName, form));
    issues.push(textIssue(form.collectionSymbol, MAX_SYMBOL_BYTES, Field.collectionSymbol, form));
  }
  // Problems first: a plan with a problem deals no items (SH-AI-PLAN), and its files still need fixing, not adding.
  if (art && art.problems.length > 0) issues.push({ step, control: CONTROL.art, message: MESSAGES.fixArt });
  else if (!art || art.items.length === 0) issues.push({ step, control: CONTROL.art, message: MESSAGES.addArt });
  else if (art.items.length < MIN_N || art.items.length > MAX_N) issues.push({ step, control: CONTROL.art, message: MESSAGES.items });
  else if (!commitment || metadataTableHex(textCheck(form.description, MAX_TEXT_BYTES, 0) === Reason.OK ? form.description : '', commitment.traitTypes) === null) {
    // The table holds the About text too; a bad About is reported on About, not here.
    issues.push({ step, control: CONTROL.art, message: MESSAGES.tooManyTraits });
  }
  if (!collectionCover) issues.push({ step, control: CONTROL.collectionCover, message: MESSAGES.addCollectionCover });
  if (form.artMode === 'hidden') {
    const ticket = ticketNames(names.name, names.symbol);
    if (names.name !== '') issues.push(textIssue(ticket.name, 32n, Field['addOns.placeholders.placeholderName'], form));
    issues.push(textIssue(form.ticketLine, 1024n, Field['addOns.placeholders.placeholderDescription'], form, 0));
    issues.push(textIssue(form.hiddenLine, 1024n, Field['addOns.placeholders.hiddenDescription'], form, 0));
  }
  if (form.specials.length > MAX_SPECIALS) issues.push({ step, control: CONTROL.specials, message: MESSAGES.seriesCount });
  for (const row of form.specials) {
    issues.push(textIssue(row.label, 32n, Field['addOns.edition-specials.label'], form));
    const count = parseCount(row.count);
    if (count === null) issues.push({ step, control: CONTROL.specials, message: MESSAGES.count });
    else if (art && count > art.items.length) issues.push({ step, control: CONTROL.specials, message: MESSAGES.seriesSize });
  }
  if ((page?.teasers.length ?? 0) > MAX_TEASERS) issues.push({ step, control: CONTROL.teasers, message: MESSAGES.teaserCount });
  const link = pageLinkReason(effectivePageLink(form));
  if (link === Reason.BAD_CHARACTER) issues.push({ step, control: CONTROL.pageLink, message: MESSAGES.httpsLink });
  else if (link === Reason.LENGTH_OUT_OF_RANGE) issues.push({ step, control: CONTROL.pageLink, message: MESSAGES.upTo(BigInt(MAX_PAGE_LINK_BYTES)) });
  return issues;
}

function launchIssues({ form, nowMs }: CheckInput): (Issue | null)[] {
  const step = 'launch' as const;
  const issues: (Issue | null)[] = [];
  if (form.open.kind === 'time') {
    // An exact UTC time (openAt): at least 2 minutes ahead (a slow wallet or block would open the box at once) and
    // at most 14 days (the factory refuses more at creation, OpenAtTooFar; validate() cannot see the clock).
    const ahead = openAheadSeconds(form.open, nowMs);
    if (!Number.isFinite(ahead)) issues.push({ step, control: CONTROL.openTime, message: MESSAGES.pickTime });
    else if (ahead < PICK_TIME_MIN_AHEAD_SECONDS) issues.push({ step, control: CONTROL.openTime, message: MESSAGES.openSoon });
    else if (ahead > PICK_TIME_MAX_AHEAD_SECONDS) issues.push({ step, control: CONTROL.openTime, message: MESSAGES.openTime });
  }
  const first = parseEthText(form.firstIn);
  const raise = raiseOf(form.qIndex);
  if (first === null) issues.push({ step, control: CONTROL.firstIn, message: MESSAGES.number });
  else if (first !== 0n && first >= raise) issues.push({ step, control: CONTROL.firstIn, message: MESSAGES.belowTarget(raise) });
  return issues;
}

/** The Overview's own checks: the creator's address, the reveal file, the rights confirmation (F70 step 5). */
function overviewIssues({ form, commitment, revealSaved, ownerProblem = null, owner }: CheckInput): (Issue | null)[] {
  const step = 'overview' as const;
  const issues: (Issue | null)[] = [];
  if (ownerProblem) issues.push({ step, control: CONTROL.owner, message: ownerProblem === 'checksum' ? MESSAGES.checksum : MESSAGES.notAddress });
  else if (owner === null) issues.push({ step, control: CONTROL.owner, message: MESSAGES.addAddress });
  if (form.contents === 'collection' && form.artMode === 'hidden' && commitment && !revealSaved) issues.push({ step, control: CONTROL.reveal, message: MESSAGES.reveal });
  if (!form.rights) issues.push({ step, control: CONTROL.rights, message: MESSAGES.rights });
  return issues;
}

/** The page's own checks, all fields of a step at once (validate() stops at the first), with the rules' own code. */
export function fieldIssues(step: StepId, input: CheckInput): Issue[] {
  const issues = step === 'basics' ? basicsIssues(input) : step === 'contents' ? contentsIssues(input) : step === 'launch' ? launchIssues(input) : step === 'overview' ? overviewIssues(input) : [];
  return issues.filter((issue): issue is Issue => issue !== null);
}

/** One message per control, the page's own first (it is the more specific), in the order given. */
export function dedupe(issues: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.control)) return false;
    seen.add(issue.control);
    return true;
  });
}

/** The final gate (Overview, Create): the zod schema of the version context on `network`, its issue carrying `{ reason, field }`. */
export function finalGate(spec: BoxSpecV1, form: CreateForm, network: Network = STRICTEST_NETWORK): Issue | null {
  const result = boxSpecV1Schema(CONTEXT_V2, network).safeParse(spec);
  if (result.success) return null;
  const params = (result.error.issues[0] as { params?: { reason?: number; field?: number } } | undefined)?.params;
  if (typeof params?.reason !== 'number' || typeof params.field !== 'number') {
    return { step: 'overview', control: CONTROL.owner, message: MESSAGES.bug, detail: result.error.issues[0]?.message ?? 'schema' };
  }
  return issueForVerdict({ reason: params.reason, field: params.field }, spec, form);
}
