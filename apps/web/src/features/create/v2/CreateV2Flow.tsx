/**
 * `/create/v2-<step>`: launch a format 2 box (ticket M1-53-a; F70's six steps; box-spec-v2-draft.md § 9 item 5):
 * Basics with the pricing token, Contents with the pick fee, Fees (three choices per side), Raise,
 * Opening, Overview. Demo data, labelled Demo. It shares v1's draft for what both flows build alike (names, logo, art,
 * covers, page, open time, rights) and keeps its own choices in v2-draft.ts. Navigation never asks a wallet; the Demo
 * wallet opens only from "Connect to create", and Create plays the plan in the Demo (the box waits for its table).
 * TA-22: on a real build (a chain source with one v2 release) "Connect to create" opens the browser-wallet window and
 * Create sends the plan step by step (create-send.ts, useCreateSend.ts); Download BoxSpec stays beside it (the file
 * carries the pictures to publish).
 * SH-192 (BOXSPEC-AUTOSAVE): for a box that commits a reveal root (a collection, open or hidden), Create's press first
 * saves the box file itself (box-file-save.ts: the save window where the browser has one, else a download) and sends
 * nothing until the salts have a confirmed file write or an IndexedDB write/read-back with persistence granted.
 * The run's predicted token keys the device copy (reveal-keep.ts), before any wallet request (useCreateSend `keep`).
 * SH-218 rail 2: the selected release's switched-off options (useCreateOptions.ts) mark the template tiles, the Contents
 * tiles, the coins, the coin pile, the royalty and the fee choices they cover; a draft or settings file that needs one,
 * or a list that cannot be read now, cannot be sent (lines A and B, create-options-words.ts), and the draft stays as it
 * is. The last check reads the list afresh right before the wallet is asked for the payment approval or createBox
 * (`checkBeforeWallet`, required by the executor); a created box's later steps never ask it.
 */
import type { Address } from '@squarehole/domain';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { keccak256, type Hex } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { PAGE_TITLE_ID, usePageTitle } from '../../../pages/page-parts';
import { useDataSource } from '../../data-source';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { BUILD_CORE } from '../../core/useCore';
import { sourceV2 } from '../../core/v2/indexer-v2';
import { BoxLinksAfterCreate } from '../../core/v2/BoxLinksV2';
import type { ArtEnvironment } from '../art-files';
import { BasicsStep } from '../BasicsStep';
import { PictureSlots } from '../PictureSlots';
import { COLLECTION_PAGE_OFF, ContentsStep, PageLinkField } from '../ContentsStep';
import { BackGlyph, focusControl } from '../create-parts';
import { artHasModels, buildSpec, commitArt, revealAckFor, revealFile, revealList, revealSavedFor } from '../create-model';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { EMPTY_DRAFT, clearDraft, draftGeneration, updateDraft, useDraft, type Draft } from '../draft';
import { CONTROL } from '../reason-copy';
import { CREATE_OFF } from './create-options-words';
import { useArtReading, useClock } from '../use-create-flow';
import { creationPlan, demoCreateGas } from './creation-plan';
import { CreateSendPanel, planLabels } from './CreateSendPanel';
import { useCreateSend } from './useCreateSend';
import { CreateRefusal, specOfRun, type CreateRunV2 } from './create-send';
import { BoxFileError, FILE_FAILED, download, saveBoxFile } from './box-file-save';
import { commitsReveal, revealDataOf } from './reveal-data';
import { REVEAL_KEEP_FORMAT, keepReveal, keptKey, readKept, type KeptReveal } from './reveal-keep';
import { PicturesStatus, usePicturePublish } from './usePicturePublish';
import { ArweaveLines, useFreePictures } from './useFreePictures';
import { FeesStep } from './FeesStep';
import { isDemoListing, offeredListings, type SiteListing } from './listings';
import { useListingsV2 } from './indexer-listings';
import { boxSpecFrame, buildSpecV2, modelPart, picturePart, pileInOther, pileInPrice, pileSeedOf, recipeCtx, stillPlayed, v2Issues, V2_CONTROL, type V2Choices, type V2Issue } from './model';
import { useAlchemistOffer, useAlchemistRows } from './alchemist';
import { useSaleListV21 } from './sale-list';
import { PileStep } from './PileStep';
import { SHOP_CONTROL, addressOf, newShop, shopConfigOf, starterItemsOf, type StarterItem } from './shop';
import { STARTER_CHECKS_KEY, useCollectionChecker, useShopChecks, useStarterChecks } from './shop-checks';
import { ShopStep } from './ShopStep';
import { BLOCKED_TITLE, OverviewV2, type DemoRun } from './OverviewV2';
import { committedModelHashes, eachCommittedModel, eachCommittedPicture, type MissingPicture, type PictureRole } from './pictures';
import { BoxTypeV2, specHashV2 } from './spec-types';
import { clearV2, currentV2Loaded, setV2Loaded, setV2Template, updateV2, useV2Choices, useV2Loaded, useV2Template } from './v2-draft';
import { LoadSettings, LoadedNote } from './LoadSettings';
import { lockedFormPatch, lockedV2Patch, repriceLoaded, type LoadedDraft } from './load-settings';
import { TemplateRow } from './TemplateRow';
import { offeredTemplates, templateDraft, type Template } from './templates';
import { HIDDEN_KEYS, PAGE_KEYS, PILE_KEYS, ROYALTY_KEYS, SPECIALS_KEYS, checkBeforeWallet, checkSpec, contentsKeys, createOptionsLine, overviewRowsOf, type OverviewRow, feeKeys, needsModuleDirectory, offKeysOf, pileCoinKey, priceKey, templateKey, type CreateGate } from './create-options';
import { releaseModuleDirectory, useCreateOptions, useModuleDirectory } from './useCreateOptions';
import { OffLine, UnavailableLine } from './CreateOptionsLines';
import type { LoadOptionsCheck } from './LoadSettings';
import type { CreateSendPlanV2 } from '../../../../../../packages/chain/src/core/v2';
import { choiceOf, moduleIdOf, type FeeChoice, type FeeSide } from './recipes';
import { PickFee, PricingPicker, OpeningV2, RaiseV2 } from './V2Steps';
import { V2_STEPS, v2Index, v2Path, type V2StepId } from './v2-steps';
import './create-v2.css';
import { PICTURE_WORDS, pictureWords } from '../../box-picture/picture-words';
import type { PartId } from '../../box-picture/picture';
import { CreatePicture, type PictureIssue } from '../picture/CreatePicture';
import { CreateWays } from '../picture/CreateWays';
import { isPictureVisit, issueLine, partOfIssue, partOfStep, pictureInputOf, type PictureVisit } from '../picture/picture-input';
import { PICTURE_PATH, isPictureStep, type PictureStep } from '../picture/picture-route';
import { TemplateArt } from '../picture/TemplateArt';
import '../picture/create-picture.css';
import { TESTNET } from '../../data-source/testnet';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * F-1, since SH-NO-PICTURE-GATE (founder 2026-10-24): the box is listed as soon as it is created; each picture shows once
 * its bytes answer by their sha256 (a plain placeholder until then; hidden art's items at the reveal). The file carries
 * every committed picture. Where pictures are published is still open; the wording is the founder's to refine.
 */
export const picturesNote = (contents: 'token' | 'open' | 'hidden'): string => contents === 'token'
  ? 'Your box shows up as soon as it is created. Its logo appears once published. The BoxSpec file carries it.'
  : contents === 'open'
    ? 'Your box shows up as soon as it is created. Each picture appears once published. The BoxSpec file carries every picture.'
    : 'Your box shows up as soon as it is created. Its logo and cover appear once published, item pictures at the reveal. The BoxSpec file carries every picture.';
/** An item file the page no longer has (a reload keeps the art's hashes, never its files), or one it can no longer read. */
export const PICTURES_AGAIN = 'Add the item pictures again: after a reload this page keeps only their hashes, and the file needs their bytes.';
/** R74-ART: the same for art with 3D models, whose models (`<id>.glb`) go into the file too. */
export const MODELS_AGAIN = 'Add the item pictures and models again: after a reload this page keeps only their hashes, and the file needs their bytes.';
/**
 * TA-50: hidden art on a real build: the reveal file is saved before Create sends anything. One line beside the button:
 * what the file is for, and what losing it means.
 */
export const REVEAL_FILE_NOTE = 'Keep this file safe: it proves each item later. If you lose it, only our reveal service can open items, and only if you gave it the file.';
/** The file could not be built or saved (the browser refused it, or ran out of room). */
export { FILE_FAILED };
/** SH-192: the one line before Create's press, for a box that commits a reveal root. */
export const BOX_FILE_FIRST = 'Create first saves your box file.';
/** SH-192: while Create's press saves the box file (nothing is sent meanwhile). */
export const BOX_FILE_SAVING = 'Saving your box file…';
/** SH-192: the box file is saved, under the name the creator kept. */
export const boxFileSaved = (name: string): string => `Saved: ${name}`;
/** SH-192: this browser did not keep its copy of the reveal data (reveal-keep.ts); the run stops before sending. */
export const KEEP_FAILED = 'The reveal data could not be kept in this browser. Nothing sent. Save again.';
/** SH-192: the saved run's box is not created and this page no longer holds the art its reveal root commits. */
export const KEEP_NOT_HERE = 'This page no longer holds this box’s reveal data, so nothing was sent. Start over.';
const ROLE_WORDS: Readonly<Record<PictureRole, string>> = { logo: 'the logo', 'collection cover': 'the collection cover', banner: 'the banner', teaser: 'the teasers', item: 'the item pictures' };
/** Which pictures to add again: any item file (PICTURES_AGAIN), else the processed pictures whose bytes no longer match the spec. */
export function picturesMissingText(missing: readonly MissingPicture[]): string {
  if (missing.some((picture) => picture.role === 'item')) return PICTURES_AGAIN;
  const words = [...new Set(missing.map((picture) => ROLE_WORDS[picture.role]))];
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? 'the pictures';
  return `Add ${list} again: ${missing.length === 1 ? 'its bytes do' : 'their bytes do'} not match this spec.`;
}

// TA-27: while a setup is loaded, only the five choices and the links change (load-settings.ts `lockedFormPatch`, `lockedV2Patch`).
const setForm = (patch: Partial<Draft['form']>) => {
  const allowed = lockedFormPatch(patch, currentV2Loaded());
  if (Object.keys(allowed).length > 0) updateDraft((d) => ({ ...d, form: { ...d.form, ...allowed }, restored: false }));
};
const setPage = (page: Draft['page']) => { if (!currentV2Loaded()) updateDraft((d) => ({ ...d, page, restored: false })); };
const setV2 = (patch: Partial<V2Choices>) => {
  const allowed = lockedV2Patch(patch, currentV2Loaded());
  if (Object.keys(allowed).length > 0) updateV2((choices) => ({ ...choices, ...allowed }));
};
const ignore = () => undefined;
const NO_STARTERS: readonly StarterItem[] = Object.freeze([]);
const NO_ROWS: ReadonlySet<OverviewRow> = new Set();

/** SH-192: where Create's own save of the box file stands, for the spec hash it was made for. */
type BoxFileState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving'; readonly hash: Hex }
  | { readonly phase: 'saved'; readonly hash: Hex; readonly name: string; readonly via: 'picker' | 'download' }
  | { readonly phase: 'failed'; readonly hash: Hex; readonly line: string };
const NO_BOX_FILE: BoxFileState = Object.freeze({ phase: 'idle' });

/** SH-254: the sheet key of a sheet carried over a replace navigation (see `sheetAt`). */
const CARRY = 'carry';

/** SH-254: where each Overview row a release switched off is fixed on the picture (its step, part and field). */
const OFF_ROW_FIX: readonly { readonly row: OverviewRow; readonly step: V2StepId; readonly part: PartId; readonly control: string }[] = [
  { row: 'price', step: 'v2-basics', part: 'price', control: V2_CONTROL.pricing },
  { row: 'seed', step: 'v2-contents', part: 'contents', control: V2_CONTROL.pileCoin },
  { row: 'contents', step: 'v2-contents', part: 'contents', control: CONTROL.contents },
  { row: 'buyers', step: 'v2-fees', part: 'buyers', control: V2_CONTROL.buyers },
  { row: 'sellers', step: 'v2-fees', part: 'sellers', control: V2_CONTROL.sellers },
];

/** When a control shows its message: after it was left, or once Next or Create was pressed on its step. */
function useShown(step: V2StepId | PictureStep, live: readonly V2Issue[]) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState<ReadonlySet<V2StepId | PictureStep>>(() => new Set());
  // SH-251: the picture holds every step's controls, so each of its controls shows its own issue, whatever the step.
  const own = (entry: V2Issue) => isPictureStep(step) || entry.step === step;
  const [summaryKey, setSummaryKey] = useState(0);
  const touch = useCallback((control: string) => setTouched((before) => (before.has(control) ? before : new Set([...before, control]))), []);
  const errorFor = useCallback((control: string) => {
    const issue = live.find((entry) => (isPictureStep(step) || entry.step === step) && entry.control === control);
    return issue && (submitted.has(step) || touched.has(control)) ? issue.message : null;
  }, [live, step, submitted, touched]);
  const submit = (issues: readonly V2Issue[]) => {
    setSubmitted((before) => new Set([...before, step]));
    if (issues.length > 0) setSummaryKey((key) => key + 1);
    return issues.length > 0;
  };
  // The Overview's summary names every step's issues; each other step names its own.
  const summary = submitted.has(step) ? live.filter((issue) => step === 'v2-overview' || own(issue)) : [];
  // SH-254: a new box (Start over) starts with nothing left or submitted.
  const reset = useCallback(() => { setTouched(new Set()); setSubmitted(new Set()); setSummaryKey(0); }, []);
  return { touch, errorFor, submit, summaryKey, summary, reset };
}

function Summary({ issues, focusKey, onGo, symbol }: { issues: readonly V2Issue[]; focusKey: number; onGo: (issue: V2Issue) => void; symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);
  if (issues.length === 0) return null;
  return (
    <div ref={ref} className="sh-newbox-summary" role="alert" aria-labelledby={titleId} tabIndex={-1}>
      <p id={titleId} className="sh-newbox-summary__title">
        {issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}
      </p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.control}-${issue.message}`}>
            <a
              href={`#${issue.control}`}
              onClick={(event) => {
                event.preventDefault();
                onGo(issue);
              }}
            >
              {/* SH-254: each named by its field, as the picture's list names it ("Sellers’ fees: Choose a fee destination."). */}
              {issueLine(issue, symbol)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stepper({ step, reachable, fix }: { step: V2StepId; reachable: number; fix: ReadonlySet<V2StepId> }) {
  const at = v2Index(step);
  return (
    <nav className="sh-newbox-steps" aria-label="Steps">
      <p className="sh-newbox-steps__count" aria-hidden="true">{`${at + 1}/${V2_STEPS.length}`}</p>
      <ol>
        {V2_STEPS.map((entry, index) => {
          const content = (
            <>
              <span className="sh-newbox-steps__dot" aria-hidden="true" />
              <span className="sh-newbox-steps__label">
                {entry.label}
                {fix.has(entry.id) ? <span className="sh-newbox-steps__fix"> · Fix</span> : null}
              </span>
            </>
          );
          return (
            <li key={entry.id} data-state={index < at ? 'done' : index === at ? 'current' : 'todo'} data-fix={fix.has(entry.id) || undefined} aria-current={index === at ? 'step' : undefined}>
              {index < reachable && index !== at ? (
                <Link to={v2Path(entry.id)} className="sh-newbox-steps__link">
                  {content}
                </Link>
              ) : (
                <span className="sh-newbox-steps__link" aria-disabled={index < reachable ? undefined : 'true'}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface CreateV2FlowProps {
  /** One of the six steps, or (SH-251) the picture, on the same draft. */
  readonly step: V2StepId | PictureStep;
  readonly env: ArtEnvironment;
  /** The Demo's pause between the plan's transactions (tests: 0). */
  readonly demoStepMs: number;
  /** The listings offered (wave 1: the Demo's; wave 2: M1-52's feed). */
  readonly listings?: readonly SiteListing[];
}

export function CreateV2Flow(props: CreateV2FlowProps) {
  const { listings, error } = useListingsV2(props.listings);
  // A read that worked but offers no coin says so (SH-TA-12); a failed or pending read says why.
  if (error || offeredListings(listings).length === 0) return <section className="sh-page"><h1>Launch a box</h1><p role="status">{error ?? 'No price coins listed yet'}</p></section>;
  return <CreateV2Ready {...props} listings={listings} />;
}
function CreateV2Ready({ step, env, demoStepMs, listings }: CreateV2FlowProps & { listings: readonly SiteListing[] }) {
  const draft = useDraft();
  const v2 = useV2Choices();
  const template = useV2Template();
  const loaded = useV2Loaded();
  const source = useDataSource();
  const wallet = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  // SH-251: the picture way, on the same draft, the same checks and the same fields; and the part whose sheet is open.
  const picture = isPictureStep(step);
  const flowStep: V2StepId = isPictureStep(step) ? 'v2-basics' : step;
  // The open sheet belongs to the picture's visit: leaving for the steps and coming back opens none. SH-254: a visit
  // that names a part (a problem pressed on an Overview reached from the picture) opens that part's sheet.
  const visit = picture && isPictureVisit(location.state) ? location.state.open : null;
  const [sheetAt, setSheetAt] = useState<{ readonly key: string | null; readonly part: PartId | null }>({ key: null, part: null });
  // CARRY: the sheet a used Edit instruction opened, kept across the replace navigation that clears it (U3): it is
  // tied to the new entry's key on the first render there, so Back to another entry never finds it.
  if (sheetAt.key === CARRY && sheetAt.part !== null && visit === null) setSheetAt({ key: location.key, part: sheetAt.part });
  const sheet = sheetAt.key === location.key || sheetAt.key === CARRY ? sheetAt.part : visit?.part ?? null;
  const setSheet = useCallback((part: PartId | null) => setSheetAt({ key: location.key, part }), [location.key]);
  // Such a sheet opens without taking focus itself (the page's heading takes it on arrival, Shell.tsx); right after,
  // focus moves to the field where the problem is fixed, or to the sheet's title.
  const visitPart = visit?.part ?? null;
  const visitControl = visit?.control ?? null;
  const quietSheet = sheetAt.key !== location.key && visitPart !== null;
  const nowMs = useClock(step === 'v2-overview' ? 'overview' : 'basics');
  const label = isPictureStep(step) ? PICTURE_WORDS.visual : V2_STEPS[v2Index(step)]?.label ?? '';
  usePageTitle(`Launch a box · ${label}`);
  const demo = DEMO_BUILD && source.isDemo;
  const owner: Address | null = wallet.status === 'connected' ? wallet.account : null;
  const { form, art, cover, collectionCover, page } = draft;
  // Hidden art commits a sorted trait table (create-model `commitArt`): the art mode is part of the commitment.
  const commitment = useMemo(() => commitArt(art, form.artMode), [art, form.artMode]);
  // SH-AI-PLAN fix round 2: the reveal file counts as saved only for the commitment it was saved for (its root).
  const revealSaved = useMemo(() => revealSavedFor(draft.revealSavedFor, commitment), [draft.revealSavedFor, commitment]);
  // A shop's starting collections, as the chain answers whether each is an ERC-721 (none is asked in the Demo).
  const shop = form.contents === 'token' ? v2.shop : null;
  const collections = useMemo(() => (shop ? shop.collections.flatMap((row) => { const address = addressOf(row.address); return address ? [address] : []; }) : []), [shop]);
  const shopChecks = useShopChecks(collections);
  // SH-SHOP-CREATE: a shop's starter items, each asked on the chain once a wallet is connected: the creator must hold them.
  const starters = useMemo(() => (shop ? starterItemsOf(shop) : null), [shop]);
  const starterChecks = useStarterChecks(starters, owner);
  const queryClient = useQueryClient();
  // TA-27: a loaded shop's collections, asked on this chain before the setup is installed (none in the Demo).
  const checkCollections = useCollectionChecker();
  // A coin pile in another coin than the price coin: The Alchemist's rows for that pair, as the chain resolves them.
  const otherPile = useMemo(() => pileInOther({ form, v2, listings }), [form, v2, listings]);
  // SH-RC7-SITE-INBOX: the sale list a box created now copies (read-only; none in the Demo), read on the Fees step only.
  // SH-258: no sale list where the test network has none (BNB Chain testnet: `cowSales`): never read.
  const saleList = useSaleListV21(TESTNET.switches.cowSales && (step === 'v2-fees' || (picture && (sheet === 'buyers' || sheet === 'sellers' || sheet === 'holders'))));
  const alchemist = useAlchemistRows(otherPile ? recipeCtx({ form, v2, listings }).pricing.token : null, otherPile?.token ?? null);
  // ALCH-TEMPLATE: on Basics, a listed pile coin The Alchemist resolves for with this price coin (the template's tile shows only then).
  const pileCoins = useMemo(() => offeredListings(listings).map((listing) => listing.token), [listings]);
  const alchemistOffer = useAlchemistOffer(step === 'v2-basics' || picture ? recipeCtx({ form, v2, listings }).pricing.token : null, pileCoins);
  const input = useMemo(() => ({ form, art, commitment, cover, collectionCover, page, owner, nowMs, v2, listings, revealSaved, shopChecks, starterChecks, alchemist }), [form, art, commitment, cover, collectionCover, page, owner, nowMs, v2, listings, revealSaved, shopChecks, starterChecks, alchemist]);
  const spec = useMemo(() => buildSpecV2(input), [input]);
  const hash = useMemo(() => specHashV2(spec), [spec]);
  // A save/check belongs to this page, route and draft. Never continue an old press after any of them leaves.
  const generation = draftGeneration();
  const press = useRef({ cancelled: false });
  useLayoutEffect(() => {
    const current = { cancelled: false };
    press.current = current;
    return () => { current.cancelled = true; };
  }, [hash, location.key, generation]);
  const ctx = useMemo(() => recipeCtx(input), [input]);
  const seed = useMemo(() => pileSeedOf(input), [input]);
  // A shop's seed in T: the creator approves the shop and it pulls the seed after Create, then the loader opens the box.
  const shopSeedT = useMemo(() => (spec.boxType === BoxTypeV2.SHOP && shop ? shopConfigOf(shop, owner).seedT : null), [spec.boxType, shop, owner]);
  // The Demo plays its own estimate; a real build estimates each step on chain as it sends it.
  // A shop's starter items as add-on 8 commits them (none when they do not parse: the page's checks refuse those).
  const shopStarters = useMemo(() => (spec.boxType === BoxTypeV2.SHOP && starters ? starters : NO_STARTERS), [spec.boxType, starters]);
  const plan = useMemo(() => creationPlan(spec, ctx.pricing, { estimate: demo ? demoCreateGas : null, seed, shopSeedT, starters: shopStarters.length }), [spec, ctx.pricing, seed, shopSeedT, demo, shopStarters]);
  // TA-22: a real build's chain (a source with one v2 release); none in the Demo.
  const v2Source = useMemo(() => { if (demo) return null; try { return sourceV2(source.id, BUILD_CORE); } catch { return null; } }, [demo, source.id]);
  const signer = wallet.signer;
  // SH-ARWEAVE-PICTURES-WEB: where the source keeps the logo and cover on Arweave, they are shrunk to Turbo's free tier
  // as they are read, and one that cannot fit is refused before Create. Fix round 1 (integrator decision): Create's
  // press publishes both after its checks and before the wallet is asked for anything (useCreateSend `beforeWallet`;
  // the run asks it after reading the starter items' owners, the step's checks and its estimate), so their hashes are on
  // Arweave before the createBox transaction makes them public.
  const arweaveOn = v2Source?.arweave === true;
  const chainId = v2Source?.manifest.chainId ?? null;
  const pictures = usePicturePublish({ on: arweaveOn, draft, chainId, digest: env.digest });
  // SH-192: the run's reveal data, kept in this browser (reveal-keep.ts) before the run reads or sends anything. A copy
  // already kept for this box and spec is written/read back with a fresh persistence check; else the draft's art must commit the run's own reveal root. Without a
  // copy the run stops there, unless its box already exists (its root is public then, and the rest only finishes it).
  // SH-192: Create's own save of the box file, for this spec only (a changed draft saves again).
  const [boxFileState, setBoxFile] = useState<BoxFileState>(NO_BOX_FILE);
  const boxFile = boxFileState.phase === 'idle' || boxFileState.hash === hash ? boxFileState : NO_BOX_FILE;
  const durableRoot = useRef<string | null>(null);
  const keep = useCallback(async (kept: CreateRunV2, created: () => Promise<boolean>, attempt: string) => {
    const runSpec = specOfRun(kept);
    if (!commitsReveal(runSpec)) return;
    const specHash = keccak256(kept.encoded).toLowerCase() as Hex;
    const held = await readKept(kept.chainId, kept.token);
    const matching = held?.specHash === specHash && held.revealRoot === runSpec.revealRoot.toLowerCase() ? held : null;
    const data = revealDataOf({ spec: runSpec, art, commitment, ctx, v1Spec: () => buildSpec(input) });
    const copy: KeptReveal | null = matching ?? (data ? { format: REVEAL_KEEP_FORMAT, key: keptKey(kept.chainId, kept.token), chainId: kept.chainId,
      token: kept.token.toLowerCase() as Address, creator: kept.creator, specHash, revealRoot: data.revealRoot,
      artMode: data.artMode, n: data.n, fileName: data.fileName, text: data.text, savedAt: Date.now() } : null);
    if (!copy) {
      if (durableRoot.current === runSpec.revealRoot.toLowerCase() || await created().catch(() => false)) return;
      throw new CreateRefusal('refused', KEEP_NOT_HERE);
    }
    try {
      await keepReveal({ ...copy, attempt, abandoned: false, discardWhenAbsent: false, savedAt: Date.now() });
    } catch (error) {
      console.error('Create v2: the reveal data could not be kept in this browser', error);
      if (durableRoot.current === runSpec.revealRoot.toLowerCase() || await created().catch(() => false)) return;
      setBoxFile({ phase: 'failed', hash, line: KEEP_FAILED });
      throw new CreateRefusal('refused', KEEP_FAILED);
    }
  }, [art, commitment, ctx, input, hash]);
  // SH-218 rail 2: the selected release's switched-off options (none read in the Demo).
  const createOptions = useCreateOptions(v2Source);
  const directory = useModuleDirectory(v2Source, needsModuleDirectory(spec) || otherPile !== null);
  const offKeys = useMemo(() => offKeysOf(createOptions.document), [createOptions.document]);
  const isOff = useCallback((keys: readonly string[]) => keys.some((key) => offKeys.has(key)), [offKeys]);
  // The draft against the list: 'none' without one (the Demo), 'reading' until it (and a module row's directory) is known.
  const draftCheck = useMemo((): { readonly state: 'none' | 'reading' | 'unavailable' | 'ok' | 'off' | 'blocked'; readonly keys: readonly string[] } => {
    if (createOptions.phase === 'none') return { state: 'none', keys: [] };
    if (createOptions.phase === 'failed') return { state: 'unavailable', keys: [] };
    if (!createOptions.document) return { state: 'reading', keys: [] };
    let moduleDirectory: Address | undefined;
    if (needsModuleDirectory(spec)) {
      if (directory.state === 'failed') return { state: 'unavailable', keys: [] };
      if (directory.state !== 'ready') return { state: 'reading', keys: [] };
      moduleDirectory = directory.directory;
    }
    const checked = checkSpec(createOptions.document, spec, moduleDirectory);
    return checked.state === 'off' ? checked : { state: checked.state, keys: [] };
  }, [createOptions.phase, createOptions.document, spec, directory]);
  const draftOptions = draftCheck.state;
  const createAllowed = draftOptions === 'none' || (draftOptions === 'ok' && createOptions.fresh);
  const { retry: retryOptions, check: checkOptions, target: optionsTarget } = createOptions;
  // The executor's last check: a fresh read for the run's own plan. A refusal also reads the page's list again.
  const gate = useMemo((): CreateGate => ({ target: optionsTarget, moduleDirectory: () => (v2Source ? releaseModuleDirectory(v2Source) : Promise.reject(new Error('V2 chain unavailable'))) }), [optionsTarget, v2Source]);
  const createOptionsCheck = useCallback(async (plan: CreateSendPlanV2) => {
    try {
      await checkBeforeWallet(gate, plan);
    } catch (error) {
      retryOptions();
      throw error;
    }
  }, [gate, retryOptions]);
  const loadCheck = useMemo((): LoadOptionsCheck | null => (createOptions.phase === 'none' || !v2Source ? null : async (fileSpec) => {
    const list = await checkOptions();
    if (!list) return 'unavailable';
    let moduleDirectory: Address | undefined;
    if (needsModuleDirectory(fileSpec)) {
      try { moduleDirectory = await releaseModuleDirectory(v2Source); } catch { return 'unavailable'; }
    }
    return checkSpec(list, fileSpec, moduleDirectory).state === 'ok' ? 'ok' : 'off';
  }), [createOptions.phase, v2Source, checkOptions]);
  const send = useCreateSend({ source: v2Source, spec, starters: shopStarters, owner, wallet: signer?.request ?? null, listings, beforeWallet: pictures.beforeWallet, keep, createOptionsCheck });
  const realCreate = !demo && send.available;
  // The free check covers what the press commits: this draft's pictures on a press that prepares it; the saved run's
  // own (where the draft holds them) on a press that resumes it before its createBox was sent (fix round 1, F4); none
  // once it was (its hashes are public, and the box must be finished).
  const freeSpec = !send.resumes ? spec : send.created || send.run?.sent.createBox !== undefined ? null : send.runSpec;
  const free = useFreePictures({ on: arweaveOn, chainId, spec: freeSpec, draft });
  const issues = useMemo(() => v2Issues(input), [input]);
  // SH-251: the picture's input, read from the same choices and checks.
  const items = art?.items.length ?? null;
  const pictureInput = useMemo(() => pictureInputOf({ form, v2, ctx, issues, items, totals: null }), [form, v2, ctx, issues, items]);
  const fix = useMemo(() => new Set(issues.map((issue) => issue.step)), [issues]);
  const reachable = fix.has('v2-basics') ? 1 : fix.has('v2-contents') ? 2 : V2_STEPS.length;
  const shown = useShown(step, issues);
  // (The visit's focus: its field shows its message as on the steps once it was left, also after a reload.)
  const touchControl = shown.touch;
  useEffect(() => {
    if (visitPart === null) return undefined;
    const timer = window.setTimeout(() => {
      // A field that no longer exists (the problem was fixed another way) falls back to the sheet's title.
      if (visitControl !== null && document.getElementById(visitControl)) {
        touchControl(visitControl);
        focusControl(visitControl);
      } else document.querySelector<HTMLElement>('[data-sheet] .sh-pic-sheet__title')?.focus();
      // The instruction is used once: cleared through the router (a replace navigation without it), so neither a
      // reload, nor Back, nor a remount of this page (a listings read that fails and recovers) reopens a sheet the
      // person has closed since; the open sheet is carried over to the cleared entry.
      setSheetAt({ key: CARRY, part: visitPart });
      navigate(location.pathname, { replace: true, state: null });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location.key, location.pathname, visitPart, visitControl, touchControl, navigate]);
  const reading = useArtReading(env, () => shown.touch(CONTROL.art), free.readFit);
  const fromOverview = (location.state as { fromOverview?: boolean } | null)?.fromOverview === true && step !== 'v2-overview';
  // SH-251: an Overview reached from the picture goes Back to the picture, the way it came.
  const viaPicture = (location.state as { via?: string } | null)?.via === 'picture' && step === 'v2-overview';
  const [walletOpen, setWalletOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  // F-1: why the BoxSpec file could not carry every committed picture (an item file not read since a reload).
  const [pictureProblem, setPictureProblem] = useState<string | null>(null);
  // SH-254: grows with each Start over; the visual way's own state is keyed by it.
  const [freshKey, setFreshKey] = useState(0);
  const [run, setRun] = useState<DemoRun | null>(null);
  // TA-27: what a price-coin change of a loaded setup refused, or the fee choices it asks to make again.
  const [priceLine, setPriceLine] = useState<{ readonly problem: string | null; readonly notes: readonly string[] } | null>(null);
  const timers = useRef<number[]>([]);
  const stopTimers = () => timers.current.forEach((timer) => window.clearTimeout(timer));
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  // The run shown is this plan's own: once the choices, the listing or a box token's raise change, it is not (round 3).
  const played = run?.played ?? null;
  const runIsPlan = useMemo(() => played !== null && stillPlayed(played, input), [played, input]);
  const current = runIsPlan ? run : null;

  // SH-254: on an Overview reached from the picture, a problem leads back to the picture, to the part where it is fixed.
  const toPicture = (part: PartId, control: string | null) => navigate(PICTURE_PATH, { state: { open: { part, control } } satisfies PictureVisit });
  const go = (issue: V2Issue) => {
    const part = viaPicture ? partOfIssue(issue) : null;
    if (issue.step === step) focusControl(issue.control);
    else if (part !== null) toPicture(part, issue.control);
    else navigate(v2Path(issue.step), { state: { fromOverview: step === 'v2-overview' } });
  };
  // ...and a group's Edit leads to the part of its first problem, or to the part that holds its step's fields.
  // A group with no problem but a switched-off option (the release's rows, create-options.ts `overviewRowsOf`) leads to
  // that option's part and field: Priced in, the seed coin, the contents, a side's fees.
  const editOnPicture = (at: V2StepId) => {
    const first = issues.find((issue) => issue.step === at && partOfIssue(issue) !== null);
    const offRow = first ? undefined : OFF_ROW_FIX.find((row) => row.step === at && offRows.has(row.row));
    const part = first ? partOfIssue(first) : offRow?.part ?? partOfStep(at);
    const control = first?.control ?? offRow?.control ?? null;
    return part === null ? { to: v2Path(at), state: { fromOverview: true } } : { to: PICTURE_PATH, state: { open: { part, control } } satisfies PictureVisit };
  };
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (shown.submit(issues.filter((issue) => issue.step === step))) return;
    const following = V2_STEPS[v2Index(flowStep) + 1];
    if (fromOverview) navigate(v2Path('v2-overview'));
    else if (following) navigate(v2Path(following.id));
  };
  const create = () => {
    if (shown.submit(issues) || !demo || owner === null || plan.blocked !== null) return;
    stopTimers();
    setRun({ plan, sent: 0, played: { hash, listingId: ctx.pricing.id, atMs: input.nowMs } });
    timers.current = plan.steps.map((_, index) => window.setTimeout(() => setRun((before) => before && { ...before, sent: Math.max(before.sent, index + 1) }), (index + 1) * demoStepMs));
  };
  const revealPending = form.contents === 'collection' && form.artMode === 'hidden' && commitment !== null && !revealSaved;
  // TA-22: Create on a real build. Only a press that resumes the saved run (`send.resumes`, the hook's own decision; its
  // spec was checked when it was prepared) skips the draft's checks; any other press prepares this draft, so it must pass.
  // SH-ARWEAVE-PICTURES-WEB: either press first checks the pictures it commits (`freeSpec`) against Turbo's free size as
  // /info states it now, before anything is signed; the run then publishes them before its wallet request.
  // SH-192: a press that prepares this draft, for a box that commits a reveal root, saves the box file first.
  const needsBoxFile = realCreate && !send.resumes && commitsReveal(spec);
  const createReal = () => {
    const pressed = press.current;
    const start = () => { if (!pressed.cancelled) void send.start(); };
    // XR-SH-SHOP-CREATE F2: each press asks the page's starter check again (the run reads the items itself as well).
    if (starters !== null && starters.length > 0) void queryClient.invalidateQueries({ queryKey: [STARTER_CHECKS_KEY] });
    if (!send.resumes && (shown.submit(issues) || plan.blocked !== null || revealPending || free.refused || !createAllowed)) return;
    if (needsBoxFile && boxFile.phase !== 'saved') {
      // Saving now, or a save that failed (then only "Save box file" saves again): nothing is sent.
      if (boxFile.phase !== 'idle') return;
      // The save window opens on this press, the creator's own gesture; the run starts only once the file is saved.
      void saveBoxFileNow().then((saved) => { if (saved && !pressed.cancelled) free.beforeCreate(start); });
      return;
    }
    free.beforeCreate(start);
  };
  const saveReveal = () => {
    if (!art || !commitment) return;
    const file = revealFile(buildSpec(input), art, commitment);
    if (download(file.name, [file.text])) updateDraft((d) => ({ ...d, revealSavedFor: revealAckFor(commitment) }));
  };
  // F-1: the file carries every picture the spec commits (and open art's reveal list), each checked against its hash;
  // R74-ART: and every 3D model its art commits, checked as the site's viewer checks one. One file at a time: each is
  // read, checked and turned into its own part before the next, so a large collection never holds all its bytes at once.
  // Create's private backup also carries hidden salts; Download BoxSpec keeps its shareable form.
  // Parts are built on demand; BoxFileError carries the line for missing pictures or a failed build.
  const specFile = (privateCopy = false) => {
    const again = artHasModels(art) ? MODELS_AGAIN : PICTURES_AGAIN;
    const open = form.contents === 'collection' && form.artMode === 'open' && art !== null && commitment !== null;
    // The automatic private backup also carries hidden salts; the shareable Download BoxSpec still omits them.
    const hidden = privateCopy && form.contents === 'collection' && form.artMode === 'hidden' && art && commitment
      ? JSON.parse(revealFile(buildSpec(input), art, commitment).text) as unknown : null;
    const frame = boxSpecFrame(spec, ctx, open ? revealList(art, commitment.packed) : hidden, committedModelHashes(spec, art).length > 0);
    const build = async (): Promise<BlobPart[]> => {
      try {
        const parts: BlobPart[] = [frame.head];
        const missing = await eachCommittedPicture(spec, draft, env.digest, (picture) => { parts.push(new Blob([picturePart(picture, parts.length === 1)])); });
        if (missing.length > 0) throw new BoxFileError(missing.some((picture) => picture.role === 'item') ? again : picturesMissingText(missing));
        if (frame.models !== null) {
          parts.push(frame.models);
          const first = parts.length;
          const lost = await eachCommittedModel(spec, draft, (model) => { parts.push(new Blob([modelPart(model, parts.length === first)])); });
          if (lost.length > 0) throw new BoxFileError(again);
        }
        parts.push(frame.tail);
        return parts;
      } catch (error) {
        if (error instanceof BoxFileError) throw error;
        // A chosen item file moved or changed since it was read, or the browser ran out of room for the file.
        console.error('Create v2: the BoxSpec file could not be built', error);
        throw new BoxFileError(error instanceof DOMException && (error.name === 'NotReadableError' || error.name === 'NotFoundError') ? again : FILE_FAILED);
      }
    };
    return { name: frame.name, build };
  };
  const downloadSpec = async () => {
    if (shown.submit(issues)) return;
    setPictureProblem(null);
    // SH-254: a download that finishes after Start over is the old box's: its answer is dropped, as the save's is.
    const at = draftGeneration();
    try {
      const file = specFile();
      const built = await file.build();
      if (draftGeneration() !== at) return;
      if (!download(file.name, built)) setPictureProblem(FILE_FAILED);
    } catch (error) {
      if (draftGeneration() !== at) return;
      if (!(error instanceof BoxFileError)) console.error('Create v2: the BoxSpec file could not be built', error);
      setPictureProblem(error instanceof BoxFileError ? error.message : FILE_FAILED);
    }
  };
  // Complete this press's save attempt. Only a closed picker write establishes durable file proof.
  const saveBoxFileNow = async (): Promise<boolean> => {
    const at = hash;
    const pressed = press.current;
    setBoxFile({ phase: 'saving', hash: at });
    setPictureProblem(null);
    try {
      const file = specFile(true);
      const saved = await saveBoxFile(file.name, file.build);
      if (pressed.cancelled) return false;
      if (saved.via === 'picker') durableRoot.current = spec.revealRoot.toLowerCase();
      setBoxFile({ phase: 'saved', hash: at, name: saved.name, via: saved.via });
      return true;
    } catch (error) {
      if (!(error instanceof BoxFileError)) console.error('Create v2: the box file could not be saved', error);
      if (pressed.cancelled) return false;
      setBoxFile({ phase: 'failed', hash: at, line: error instanceof BoxFileError ? error.message : FILE_FAILED });
      return false;
    }
  };
  // F128: a template fills only its recipe (contents, both fee choices, the coin pile, a shop); the price coin, names
  // and everything else stay as they are, and all of it stays editable.
  const pickTemplate = (chosen: Template) => {
    if (currentV2Loaded() || isOff([templateKey(chosen.id)])) return;
    // A new pile starts in the price coin as the page resolves it (the live listing, as the Coin pile step does).
    const { form: patch, v2: choices } = templateDraft(chosen, { pricing: ctx.pricing.token, pile: v2.pile, shop: v2.shop, alchemist: alchemistOffer });
    setForm(patch); updateV2((current) => ({ ...current, ...choices })); setV2Template(chosen.id);
  };
  // Contents: Token, New collection or Shop. A shop is a token-like box with its own settings, never with a pile.
  const chooseContents = (contents: 'token' | 'collection' | 'shop') => {
    if (currentV2Loaded() || isOff(contentsKeys(contents, v2.pile !== null))) return;
    setForm({ contents: contents === 'collection' ? 'collection' : 'token' });
    setV2(contents === 'shop' ? { shop: v2.shop ?? newShop(), pile: null } : { shop: null });
  };
  const startOver = () => {
    press.current.cancelled = true;
    clearDraft();
    clearV2();
    forgetItemFiles();
    send.forget();
    setRun(null);
    setPriceLine(null);
    // SH-254: a new box keeps nothing of the old one on the page either: fields left or submitted, a picture's line,
    // the box file's state, and (a new key) the visual way's own state, its simulated trades among them.
    shown.reset();
    reading.reset();
    setPictureProblem(null);
    setBoxFile(NO_BOX_FILE);
    setFreshKey((before) => before + 1);
    // The sheet the old box had open is forgotten, so Back to its entry never reopens it on the new box.
    setSheetAt({ key: null, part: null });
    // SH-254: a visitor on the visual way stays there; "Start a new box" after a create opens the default way (Visual).
    navigate(picture || step === 'v2-overview' ? PICTURE_PATH : v2Path('v2-basics'));
  };
  // TA-27: a loaded setup replaces the whole draft: its parts, its item files and its choices; then only the five change.
  // clearDraft starts a new draft generation, so a picture or art read still running from before never lands in it, and
  // the lock (setV2Loaded) guards the draft store itself (load-settings.ts `lockedDraft`).
  const loadSetup = (next: LoadedDraft, itemFiles: ReadonlyMap<string, Blob>) => {
    press.current.cancelled = true;
    clearDraft(); clearV2(); forgetItemFiles(); send.forget(); setRun(null); setPriceLine(null);
    updateDraft(() => ({ ...EMPTY_DRAFT, form: next.form, art: next.art, cover: next.cover, collectionCover: next.collectionCover, page: next.page }));
    keepItemFiles(itemFiles);
    updateV2(() => next.v2);
    setV2Loaded(next.info);
  };
  // A loaded setup's price coin: what depends on it follows, and what the setup cannot keep is refused (repriceLoaded).
  const pickPricing = (pricing: string) => {
    if (!loaded) { setV2({ pricing }); return; }
    const result = repriceLoaded(v2, pricing, loaded, listings);
    if (!result.ok) { setPriceLine({ problem: result.error, notes: [] }); return; }
    updateV2(() => result.value.v2);
    setPriceLine(result.value.notes.length > 0 ? { problem: null, notes: result.value.notes } : null);
  };
  const locked = loaded !== null;
  // SH-218 rail 2: what each control's option needs, against the list (The Alchemist's row once the directory is known).
  const newestRow = alchemist.state === 'ready' ? alchemist.rows[0] ?? null : null;
  const feeOff = (side: FeeSide, choice: FeeChoice) => {
    const pick = choiceOf(v2[side]) === 'alchemist' ? moduleIdOf(v2[side]) : null;
    const row = choice === 'alchemist' ? pick ?? newestRow?.id ?? null : null;
    return isOff(feeKeys(side, choice, row !== null && directory.state === 'ready' ? { directory: directory.directory, row } : null));
  };
  const contentsOff = { contents: (value: 'token' | 'collection' | 'shop') => isOff(contentsKeys(value, v2.pile !== null)), royalty: isOff(ROYALTY_KEYS),
    hidden: isOff(HIDDEN_KEYS), specials: isOff(SPECIALS_KEYS), page: isOff(PAGE_KEYS), line: (id: string) => <OffLine id={id} /> };
  const optionsLine = createOptionsLine(draftOptions, issues.length, realCreate && !send.resumes);
  // af1: each Overview row that holds a switched-off option says so (the line under Create is announced once).
  const offRows = optionsLine === 'off' ? overviewRowsOf(draftCheck.keys, spec) : NO_ROWS;
  // SH-BOX-PICTURE-FIT: the icon and the card as the site draws them, under each picture picker.
  const slots = <PictureSlots logo={cover?.url ?? null} cover={form.contents === 'collection' ? (collectionCover?.url ?? null) : null} />;

  const stepProps = { form, set: setForm, errorFor: shown.errorFor, touch: shown.touch };
  const overview = step === 'v2-overview';
  const previous = V2_STEPS[v2Index(flowStep) - 1];
  const opened = current !== null && current.sent >= current.plan.steps.length;
  // SH-251: each step's fields as one block, so the six steps and the picture's sheets show the SAME components.
  const pricingBlock = (
    <>
      <PricingPicker listing={ctx.pricing} listings={listings} onPick={pickPricing} off={(token) => isOff([priceKey(token)])} />
      {priceLine?.problem ? <p className="sh-newbox-error" role="alert" data-price-refused=""><span aria-hidden="true">!</span> {priceLine.problem}</p> : null}
      {priceLine?.notes.map((note) => <p key={note} className="sh-newbox-note" role="status" data-price-note="">{note}</p>)}
    </>
  );
  const basicsBlock = (pairedWith: ReactNode) => (
    <BasicsStep {...stepProps} locked={locked} cover={cover} coverBusy={reading.coverBusy} coverProblem={reading.coverProblem} onCover={locked ? ignore : reading.onCover} slots={slots} pairedWith={pairedWith} />
  );
  const contentsBlock = (
    <fieldset className="sh-newbox-locked" disabled={locked} data-locked={locked || undefined}>
    <ContentsStep
      {...stepProps}
      art={art}
      commitment={commitment}
      collectionCover={collectionCover}
      page={page}
      pictures={{ collection: reading.pictures.collection, banner: reading.pictures.banner, teaser: reading.pictures.teaser }}
      progress={reading.progress}
      onArt={locked ? ignore : reading.onArt}
      onCollectionCover={locked ? ignore : reading.onCollectionCover}
      onBanner={locked ? ignore : reading.onBanner}
      onTeasers={locked ? ignore : reading.onTeasers}
      onPage={setPage}
      shop={{ chosen: shop !== null, onChoose: chooseContents }}
      off={contentsOff}
      inbox
      priceCoin={ctx.pricing.symbol}
      planLine
      pageLinkApart={locked}
      slots={slots}
      extra={form.contents === 'collection'
        ? (locked ? null : <PickFee bps={v2.pickFeeBps} onPick={(pickFeeBps) => setV2({ pickFeeBps })} error={shown.errorFor('create-v2-pick-fee')} />)
        : shop ? <ShopStep shop={shop} ticker={ctx.ticker ?? ''} owner={owner} checks={shopChecks} onChange={(next) => setV2({ shop: next })} errorFor={shown.errorFor} touch={shown.touch} />
        : form.contents === 'token' ? <PileStep pile={v2.pile} pricing={ctx.pricing} listings={listings} onChange={(pile) => setV2({ pile })} errorFor={shown.errorFor} touch={shown.touch}
          off={{ pile: isOff(PILE_KEYS), coin: (token) => isOff([pileCoinKey(token)]) }} /> : null}
    />
    </fieldset>
  );
  const lockedPickFee = <PickFee bps={v2.pickFeeBps} onPick={(pickFeeBps) => setV2({ pickFeeBps })} error={shown.errorFor('create-v2-pick-fee')} />;
  const lockedPageLink = <PageLinkField {...stepProps} label="Collection page link" off={isOff(PAGE_KEYS) ? COLLECTION_PAGE_OFF : undefined} />;
  const feesBlock = (only?: FeeSide) => (
    <FeesStep buyers={v2.buyers} sellers={v2.sellers} ctx={ctx} collection={form.contents === 'collection'} pileInPrice={pileInPrice(input)} shop={shop} alchemist={otherPile ? { pile: otherPile, answer: alchemist } : null} saleList={saleList} errorFor={shown.errorFor} set={setV2} off={feeOff} only={only} />
  );
  const raiseBlock = <RaiseV2 locked={locked} listing={ctx.pricing} deadlineDays={v2.deadlineDays} onDeadline={(deadlineDays) => setV2({ deadlineDays })} error={shown.errorFor(CONTROL.deadline)} />;
  const openingBlock = <OpeningV2 {...stepProps} nowMs={nowMs} listing={ctx.pricing} />;
  const sourceChip = DEMO_BUILD && (source.isDemo || listings.some(isDemoListing)) ? null : (
    <span className="sh-status-chip sh-newbox__source" data-disclosure="">
      {source.dataLabel}
    </span>
  );

  if (picture) {
    // SH-251: the picture way. Its sheets hold the blocks above; the Overview and everything after it are the steps' own.
    const loadedNote = loaded ? <LoadedNote info={loaded} onStartOver={startOver} /> : null;
    const sheetBody = (part: PartId): ReactNode => {
      switch (part) {
        case 'token': return basicsBlock(false);
        case 'price': return pricingBlock;
        case 'contents': return <>{loadedNote}{contentsBlock}{locked && form.contents === 'collection' ? <>{lockedPickFee}{lockedPageLink}</> : null}</>;
        case 'buyers': case 'sellers': return feesBlock(part);
        case 'holders': return feesBlock();
        case 'raise': return <>{loadedNote}{raiseBlock}</>;
        case 'creator': return openingBlock;
        default: return null;
      }
    };
    // The issues the steps would show now: a control left, or after Overview was pressed (useShown), never the
    // Overview's own (their controls live on the Overview, which checks them).
    // One line per control and message: two steps' checks can name the same field (the steps show each on its own step).
    const listed = new Set<string>();
    const pictureIssues: PictureIssue[] = issues.flatMap((issue) => {
      const part = partOfIssue(issue);
      const key = `${issue.control}|${issue.message}`;
      if (part === null || shown.errorFor(issue.control) === null || listed.has(key)) return [];
      listed.add(key);
      return [{ key, line: issueLine(issue, ctx.pricing.symbol), part, control: issue.control }];
    });
    const openIssue = (issue: PictureIssue) => {
      setSheet(issue.part);
      window.setTimeout(() => focusControl(issue.control), 0);
    };
    // The steps' own rule: their Stepper reaches the Overview only when Basics and Contents have nothing to fix. Until
    // then Overview reveals what to fix (all of it, as the steps' summary after Next) instead of leaving the picture.
    const toOverview = () => {
      if (shown.submit(issues.filter((issue) => issue.step === 'v2-basics' || issue.step === 'v2-contents'))) return;
      navigate(v2Path('v2-overview'), { state: { via: 'picture' } });
    };
    return (
      <section className="sh-page sh-newbox sh-v2 sh-pic-create" aria-labelledby={PAGE_TITLE_ID} data-step={step}>
        <CreateWays current="picture" />
        <header className="sh-newbox__head">
          <h1 id={PAGE_TITLE_ID} className="sh-newbox__title" tabIndex={-1}>{PICTURE_WORDS.title}</h1>
          {sourceChip}
        </header>
        <CreatePicture
          key={freshKey}
          input={pictureInput}
          templates={loaded ? null : <TemplateRow current={template} onPick={pickTemplate} templates={offeredTemplates(alchemistOffer)} off={(tile) => isOff([templateKey(tile.id)])} art={(tile) => <TemplateArt template={tile} />} />}
          open={sheet}
          onOpen={setSheet}
          openQuietly={quietSheet}
          sheetBody={sheetBody}
          issues={pictureIssues}
          onIssue={openIssue}
          onOverview={toOverview}
          revealKey={shown.summaryKey}
          boxCoin={ctx.ticker || PICTURE_WORDS.boxCoin}
          notice={loaded ? <LoadedNote info={loaded} first onStartOver={startOver} /> : null}
        />
      </section>
    );
  }

  return (
    <section className="sh-page sh-newbox sh-v2" aria-labelledby={PAGE_TITLE_ID} data-step={step}>
      {/* SH-251: the two ways in, in a row of their own above the steps' header (the header itself is as before). */}
      <CreateWays current="steps" />
      <header className="sh-newbox__head">
        <h1 id={PAGE_TITLE_ID} className="sh-newbox__title" tabIndex={-1}>
          <span className="sh-visually-hidden">{`Launch a box, step ${v2Index(flowStep) + 1} of ${V2_STEPS.length}: `}</span>
          {label}
        </h1>
        {sourceChip}
        <Stepper step={flowStep} reachable={reachable} fix={overview || shown.summary.length > 0 ? fix : new Set()} />
      </header>
      <form className="sh-newbox__form" noValidate onSubmit={next} aria-labelledby={PAGE_TITLE_ID}>
        <Summary issues={shown.summary} focusKey={shown.summaryKey} onGo={go} symbol={ctx.pricing.symbol} />
        {step === 'v2-basics' && loaded ? <LoadedNote info={loaded} first onStartOver={startOver} /> : null}
        {step === 'v2-basics' && !loaded ? <LoadSettings env={env} listings={listings} pricing={ctx.pricing.token} demo={demo || (DEMO_BUILD && listings.some(isDemoListing))} checkCollections={checkCollections} onLoaded={loadSetup} optionsCheck={loadCheck} /> : null}
        {step === 'v2-basics' && !loaded ? <TemplateRow current={template} onPick={pickTemplate} templates={offeredTemplates(alchemistOffer)} off={(tile) => isOff([templateKey(tile.id)])} /> : null}
        {step === 'v2-basics' ? basicsBlock(pricingBlock) : null}
        {step === 'v2-contents' && loaded ? <LoadedNote info={loaded} onStartOver={startOver} /> : null}
        {step === 'v2-contents' ? contentsBlock : null}
        {step === 'v2-contents' && locked && form.contents === 'collection' ? lockedPickFee : null}
        {step === 'v2-contents' && locked && form.contents === 'collection' ? lockedPageLink : null}
        {step === 'v2-fees' ? feesBlock() : null}
        {step === 'v2-raise' && loaded ? <LoadedNote info={loaded} onStartOver={startOver} /> : null}
        {step === 'v2-raise' ? raiseBlock : null}
        {step === 'v2-opening' ? openingBlock : null}
        {overview ? <OverviewV2 editTo={viaPicture ? editOnPicture : undefined} offRows={offRows} spec={spec} hash={hash} form={form} v2={v2} ctx={ctx} plan={plan} nowMs={nowMs} fix={fix} run={current} seed={seed} owner={owner} alchemist={alchemist.state === 'ready' ? alchemist.rows : []}
          startersNote={issues.find((issue) => issue.control === SHOP_CONTROL.startersRow)?.message ?? null}
          sending={realCreate ? <>
            <CreateSendPanel view={send.view} planned={planLabels(plan, ctx.pricing, seed, ctx.ticker ?? '')} blockedTitle={plan.blocked ? BLOCKED_TITLE[plan.blocked] : null}
              runTicker={send.otherBox} />
            <PicturesStatus view={pictures.view} onRetry={pictures.retry} />
          </> : null} /> : null}
        <div className="sh-newbox__bar" data-place={overview ? 'inline' : undefined}>
          {viaPicture ? (
            <Link to={PICTURE_PATH} className="sh-button sh-newbox__back" aria-label={pictureWords.backTo(PICTURE_WORDS.visual)}>
              <BackGlyph />
            </Link>
          ) : previous && !fromOverview ? (
            <Link to={v2Path(previous.id)} className="sh-button sh-newbox__back" aria-label={`Back to ${previous.label}`}>
              <BackGlyph />
            </Link>
          ) : null}
          {!overview ? (
            <button type="submit" className="sh-button sh-button--primary sh-newbox__next">
              {fromOverview ? 'Back to overview' : 'Next'}
            </button>
          ) : opened ? (
            <button type="button" className="sh-button sh-button--primary" onClick={startOver}>
              Start a new box
            </button>
          ) : realCreate ? (
            <>
              <RealCreateButtons send={send} connected={owner !== null && signer !== null} wrongChain={signer !== null && v2Source !== null && wallet.chainId !== v2Source.manifest.chainId}
                revealPending={revealPending} onConnect={() => setBrowserOpen(true)} onSwitch={() => { if (v2Source) void wallet.switchChain(v2Source.manifest.chainId).catch(() => undefined); }}
                onSaveReveal={saveReveal} onCreate={createReal} onStartOver={startOver} disabled={!send.resumes && (plan.blocked !== null || free.refused || !createAllowed)}
                boxFile={boxFile.phase === 'failed' || needsBoxFile ? boxFile.phase : 'none'} onSaveBoxFile={() => void saveBoxFileNow()} />
              <button type="button" className="sh-button sh-newbox-download" onClick={() => void downloadSpec()}>
                Download BoxSpec
              </button>
              {optionsLine === 'unavailable' ? <UnavailableLine onRetry={retryOptions} />
                : optionsLine === 'off' && !(send.view.phase === 'failed' && send.view.message === CREATE_OFF) ? <OffLine alert /> : null}
              {revealPending && !send.resumes ? <p className="sh-newbox-note" data-reveal-note="">{REVEAL_FILE_NOTE}</p> : null}
              {send.view.phase === 'failed' && boxFile.phase === 'failed' && send.view.message === boxFile.line ? null : <BoxFileLine state={boxFile} needed={needsBoxFile && !revealPending && owner !== null} />}
              <p className="sh-newbox-note" data-pictures-note="">{picturesNote(form.contents !== 'collection' ? 'token' : form.artMode === 'hidden' ? 'hidden' : 'open')}</p>
              <ArweaveLines on={free.on} refused={free.refused} />
              {pictureProblem ? <p className="sh-newbox-error" role="alert"><span aria-hidden="true">!</span> {pictureProblem}</p> : null}
              {/* LINKS-WEB: the draft's links, read-only, and one signature for them (none: no card). */}
              {send.view.phase === 'done' && send.run && v2Source ? <BoxLinksAfterCreate source={v2Source} token={send.run.token} creator={send.run.creator} draft={form.links} /> : null}
            </>
          ) : !demo ? (
            <>
              <button type="button" className="sh-button sh-newbox-download" onClick={() => void downloadSpec()}>
                Download BoxSpec
              </button>
              <p className="sh-newbox-note">Creation opens with the v2 factory.</p>
              <p className="sh-newbox-note" data-pictures-note="">{picturesNote(form.contents !== 'collection' ? 'token' : form.artMode === 'hidden' ? 'hidden' : 'open')}</p>
              {pictureProblem ? <p className="sh-newbox-error" role="alert"><span aria-hidden="true">!</span> {pictureProblem}</p> : null}
            </>
          ) : owner === null ? (
            <button type="button" className="sh-button sh-button--primary" aria-haspopup="dialog" onClick={() => setWalletOpen(true)}>
              Connect to create
            </button>
          ) : revealPending ? (
            <button type="button" className="sh-button sh-button--primary" onClick={saveReveal}>
              Save reveal file
            </button>
          ) : (
            <button type="button" className="sh-button sh-button--primary" disabled={current !== null || plan.blocked !== null} onClick={create}>
              Create
            </button>
          )}
        </div>
      </form>
      {DEMO_BUILD ? <DemoWalletDialog open={walletOpen} onClose={() => setWalletOpen(false)} /> : null}
      <BrowserWalletDialog open={browserOpen} onClose={() => setBrowserOpen(false)} />
    </section>
  );
}

/** SH-192: one plain line on Create's own save of the box file: before the press, while saving, saved, or why not. */
function BoxFileLine({ state, needed }: { state: BoxFileState; needed: boolean }) {
  if (state.phase === 'failed') return <p className="sh-newbox-error" role="alert" data-box-file="failed"><span aria-hidden="true">!</span> {state.line}</p>;
  if (state.phase === 'saving') return <p className="sh-newbox-note" role="status" data-box-file="saving">{BOX_FILE_SAVING}</p>;
  if (state.phase === 'saved') return <p className="sh-newbox-note" role="status" data-box-file="saved">{state.via === 'picker' ? boxFileSaved(state.name) : `Download requested: ${state.name}`}</p>;
  return needed ? <p className="sh-newbox-note" data-box-file="first">{BOX_FILE_FIRST}</p> : null;
}

interface RealCreateButtonsProps {
  readonly send: ReturnType<typeof useCreateSend>;
  /** SH-192: Create's own save of the box file, where the press needs one ('none' where it does not). */
  readonly boxFile: 'none' | BoxFileState['phase'];
  readonly onSaveBoxFile: () => void;
  readonly connected: boolean;
  readonly wrongChain: boolean;
  readonly revealPending: boolean;
  readonly disabled: boolean;
  readonly onConnect: () => void;
  readonly onSwitch: () => void;
  readonly onSaveReveal: () => void;
  readonly onCreate: () => void;
  readonly onStartOver: () => void;
}

/** TA-22: the real Create's one primary action, by where the run stands: connect, switch, create, stop, continue, open. */
function RealCreateButtons({ send, connected, wrongChain, revealPending, disabled, boxFile, onConnect, onSwitch, onSaveReveal, onSaveBoxFile, onCreate, onStartOver }: RealCreateButtonsProps) {
  const { view } = send;
  if (view.phase === 'done') {
    return (
      <>
        <Link to={view.box} className="sh-button sh-button--primary">Open your box</Link>
        <button type="button" className="sh-button" onClick={onStartOver}>Start a new box</button>
      </>
    );
  }
  if (!connected) return <button type="button" className="sh-button sh-button--primary" aria-haspopup="dialog" onClick={onConnect}>Connect to create</button>;
  if (wrongChain) return <button type="button" className="sh-button sh-button--primary" onClick={onSwitch}>Switch network</button>;
  if (view.phase === 'running') return <button type="button" className="sh-button sh-button--primary" disabled={view.stopping} onClick={send.stop}>Stop</button>;
  if (view.phase === 'preparing') return <button type="button" className="sh-button sh-button--primary" disabled>Create</button>;
  const resume = send.resumes && (view.phase === 'stopped' || view.phase === 'failed');
  if (boxFile !== 'failed' && !send.resumes && revealPending) return <button type="button" className="sh-button sh-button--primary" onClick={onSaveReveal}>Save reveal file</button>;
  // SH-192: Create stays disabled while the box file is saving, and after a failed save until "Save box file" saved it.
  if (!resume && boxFile === 'saving') return <button type="button" className="sh-button sh-button--primary" disabled>Create</button>;
  if (boxFile === 'failed') {
    return (
      <>
        <button type="button" className="sh-button sh-button--primary" onClick={onSaveBoxFile}>Save box file</button>
        <button type="button" className="sh-button" disabled>Create</button>
      </>
    );
  }
  return <button type="button" className="sh-button sh-button--primary" disabled={!resume && disabled} onClick={onCreate}>{resume ? 'Continue' : 'Create'}</button>;
}
