/**
 * `/create/:step`: launch a box (F70's order; docs/design/box-create-flow.md). Six short steps build one BoxSpecV1
 * (version 2), checked with `validateBoxSpecV1` / the zod schema of the version context, the factory's own check:
 * Basics, Contents, Box kind, Raise, Opening, then the Overview with every parameter and an Edit link per step. Kind,
 * Raise and Opening start on their defaults, so Basics + Contents + Overview is the shortest path. v1's slugs redirect.
 *
 * Demo: Create adds the box to the Demo at once (feed, its own page, the creator's wallet box), a plain token launch
 * through the same record path as a collection. Chain sources: the same Overview, Create off until the box factory
 * exists, the BoxSpec downloadable. Nothing in the flow uploads, sends a transaction or asks a wallet for anything; the
 * Demo wallet opens only from "Connect to create". The state lives in use-create-flow.ts; this file lays it out.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { PAGE_TITLE_ID, usePageTitle } from '../../pages/page-parts';
import { boxPath } from '../boxes/box-id';
import { useCreatedBoxes } from '../boxes/created-boxes';
import { specNetwork } from '../boxes/spec-network';
import { useDataSource } from '../data-source';
import { DemoWalletDialog, useWallet } from '../wallet';
import { BROWSER_ART, type ArtEnvironment } from './art-files';
import { BasicsStep } from './BasicsStep';
import { CardPreview, StatsPreview } from './BoxPreview';
import { LaunchStep, RaiseStep } from './ChoiceSteps';
import { ContentsStep } from './ContentsStep';
import { BackGlyph, ErrorSummary, Stepper, focusControl } from './create-parts';
import { LEGACY_STEPS, STEPS, isStepId, stepIndex, type StepId } from './create-model';
import { clearDraft, updateDraft, useDraft, type Draft } from './draft';
import { KindStep } from './KindStep';
import { CONTROL } from './reason-copy';
import { CostLine, CreateAction, OverviewStep, PagePreview } from './OverviewStep';
import { useArtReading, useClock, useCreateActions, useCreateModel, useShownIssues, type CreateModel } from './use-create-flow';
import { CreateV2Flow } from './v2/CreateV2Flow';
import type { SiteListing } from './v2/listings';
import { isV2Slug, isV2Step } from './v2/v2-steps';
import { isPictureStep } from './picture/picture-route';
import { CreateSetFlow } from './set/CreateSetFlow';
import { isSetStep } from './set/set-steps';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// SH-EXISTING-NFTS-E08C: the existing-NFTs add-on is local only until its release ticket: none on the production site.
const SET_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface CreatePageProps {
  /** Test seam: how files are read (production: this browser's WebCrypto and canvas). */
  readonly env?: ArtEnvironment;
  /** The v2 flow's Demo pause between the plan's transactions (tests: 0). */
  readonly demoStepMs?: number;
  /** Test seam: the v2 flow's listings (production: the Demo's in wave 1). */
  readonly v2Listings?: readonly SiteListing[];
}

/** The Demo plays each transaction of the v2 plan this long, so "waiting for its table" can be seen. */
const DEMO_STEP_MS = 900;

export function CreatePage({ env = BROWSER_ART, demoStepMs = DEMO_STEP_MS, v2Listings }: CreatePageProps) {
  const { step } = useParams();
  // SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's flow at /create/set-<step>; local only until its release ticket
  // (the production site has none: the branch folds away there, and its steps open the format 2 flow below).
  if (SET_BUILD && isSetStep(step)) return <CreateSetFlow step={step} env={env} />;
  // M1-53-a: the format 2 flow at /create/v2-<step>, beside v1's (wave 2 decides when it replaces it).
  if (isV2Step(step)) return <CreateV2Flow step={step} env={env} demoStepMs={demoStepMs} listings={v2Listings} />;
  // SH-251: the visual Create at /create/v2-picture, the same flow on the same draft (a second way in, beside the steps).
  if (isPictureStep(step)) return <CreateV2Flow step={step} env={env} demoStepMs={demoStepMs} listings={v2Listings} />;
  // The production site has the format 2 flow only (routes.tsx): v1's steps and slugs open it.
  return DEMO_BUILD ? <CreateV1 step={step} env={env} /> : <Navigate replace to="/create/v2-basics" />;
}

/**
 * v1's flow, its slugs and its earlier step names (the Demo build only, by URL: no link leads here since Launch opens
 * the format 2 flow in every build, routes.tsx). Any other step name opens the format 2 flow, as on the production site.
 */
function CreateV1({ step, env }: { step: string | undefined; env: ArtEnvironment }) {
  if (isV2Slug(step)) return <Navigate replace to="/create/v2-basics" />;
  if (!isStepId(step)) {
    // Own keys only: a step named like an Object.prototype member is no v1 step.
    const v1Step = step !== undefined && Object.hasOwn(LEGACY_STEPS, step) ? LEGACY_STEPS[step] : undefined;
    return <Navigate replace to={v1Step ? `/create/${v1Step}` : '/create/v2-basics'} />;
  }
  return <CreateFlow step={step} env={env} />;
}

const NO_STEPS: ReadonlySet<StepId> = new Set();
const setForm = (patch: Partial<Draft['form']>) => updateDraft((d) => ({ ...d, form: { ...d.form, ...patch }, restored: false }));
const setPage = (page: Draft['page']) => updateDraft((d) => ({ ...d, page, restored: false }));

/** Title (heard as "Launch a box, step 3 of 6: Box kind"), the source chip, the stepper and the draft's banners. */
function FlowHead({ step, demo, sourceLabel, model, fix, restored, capReset }: { step: StepId; demo: boolean; sourceLabel: string; model: CreateModel; fix: ReadonlySet<StepId>; restored: boolean; capReset: boolean }) {
  const position = stepIndex(step);
  return (
    <>
      <header className="sh-newbox__head">
        <h1 id={PAGE_TITLE_ID} className="sh-newbox__title" tabIndex={-1}>
          <span className="sh-visually-hidden">{`Launch a box, step ${position + 1} of ${STEPS.length}: `}</span>
          {STEPS[position]?.label}
        </h1>
        {demo ? null : (
          <span className="sh-status-chip sh-newbox__source" data-disclosure="">
            {sourceLabel}
          </span>
        )}
        <Stepper step={step} reachable={model.reachable} fix={fix} />
      </header>
      {restored ? (
        <p className="sh-newbox-banner">
          {/* A draft saved with a share-of-the-raise cap comes back with the cap off (F74 U2): said here, once. */}
          {capReset ? 'Draft restored · Fee cap reset · ' : 'Draft restored · '}
          <button type="button" className="sh-newbox-text-button" onClick={clearDraft}>
            Start over
          </button>
        </p>
      ) : null}
      {model.duplicateId && step !== 'overview' ? (
        <p className="sh-newbox-banner">
          Already created · <Link to={boxPath(model.duplicateId)}>Open box</Link> ·{' '}
          <button type="button" className="sh-newbox-text-button" onClick={clearDraft}>
            Start a new box
          </button>
        </p>
      ) : null}
    </>
  );
}

function CreateFlow({ step, env }: { step: StepId; env: ArtEnvironment }) {
  const draft = useDraft();
  const source = useDataSource();
  const wallet = useWallet();
  const location = useLocation();
  const created = useCreatedBoxes();
  usePageTitle(`Launch a box · ${STEPS[stepIndex(step)]?.label ?? ''}`);
  const nowMs = useClock(step);
  const demo = DEMO_BUILD && source.isDemo;
  const network = specNetwork(source);
  const connected = wallet.status === 'connected' ? wallet.account : null;
  const model = useCreateModel({ draft, step, nowMs, demo, connected, chainId: source.chainId, dataLabel: source.dataLabel, created, network });
  const shown = useShownIssues(step, model.live);
  const reading = useArtReading(env, () => shown.touch(CONTROL.art));
  const routeState = location.state as { focus?: string; fromOverview?: boolean } | null;
  const fromOverview = routeState?.fromOverview === true && step !== 'overview';
  const actions = useCreateActions({ step, draft, model, demo, showIssues: shown.showIssues, fromOverview });
  const [walletOpen, setWalletOpen] = useState(false);
  // The stepper marks "Fix" once Create or Download was pressed on the Overview (as v1); the Overview's groups always do.
  const stepperFix = useMemo(() => (shown.submitted.has('overview') ? model.fix : NO_STEPS), [shown.submitted, model.fix]);

  // An Edit link or an error on another step asks for its control: focus it once the step has rendered (after the
  // Shell's own move to the heading).
  const focusRequest = routeState?.focus;
  useEffect(() => {
    if (!focusRequest) return undefined;
    const timer = window.setTimeout(() => focusControl(focusRequest), 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest, location.key]);

  const { form, art, cover, collectionCover, page } = draft;
  const stepProps = { form, set: setForm, errorFor: shown.errorFor, touch: shown.touch };
  const previous = STEPS[stepIndex(step) - 1];
  const revealNeeded = form.contents === 'collection' && form.artMode === 'hidden' && model.commitment !== null;
  const overview = step === 'overview';
  // The action bar: Back and the primary button; sticky at the bottom of a phone screen. On the Overview it sits in
  // the flow after every group and the fixed values (F70: the parameters, then Create), with your address and the
  // rights box right above it.
  const bar = (
    <div className="sh-newbox__bar" data-place={overview ? 'inline' : undefined}>
      {previous && !fromOverview ? (
        <Link to={`/create/${previous.id}`} className="sh-button sh-newbox__back" aria-label={`Back to ${previous.label}`}>
          <BackGlyph />
        </Link>
      ) : null}
      {overview ? <CostLine spec={model.spec} /> : null}
      {overview ? (
        <CreateAction
          demo={demo}
          owner={model.owner}
          rights={form.rights}
          revealPending={revealNeeded && !model.input.revealSaved}
          specHash={model.hash}
          onCreate={actions.create}
          onConnect={() => setWalletOpen(true)}
          onSaveReveal={actions.downloadReveal}
          onDownloadSpec={actions.downloadSpec}
        />
      ) : (
        <button type="submit" className="sh-button sh-button--primary sh-newbox__next">
          {fromOverview ? 'Back to overview' : 'Next'}
        </button>
      )}
      <p className="sh-newbox__demo-line">Nothing is uploaded or sent.</p>
    </div>
  );
  return (
    <section className="sh-page sh-newbox" aria-labelledby={PAGE_TITLE_ID} data-step={step}>
      <FlowHead step={step} demo={demo} sourceLabel={source.dataLabel} model={model} fix={stepperFix} restored={draft.restored} capReset={draft.capReset} />
      <div className="sh-newbox__layout">
        <form className="sh-newbox__form" noValidate onSubmit={actions.next} aria-labelledby={PAGE_TITLE_ID}>
          <ErrorSummary issues={shown.summary} focusKey={shown.summaryKey} onGo={actions.go} />
          {step === 'basics' ? <BasicsStep {...stepProps} cover={cover} coverBusy={reading.coverBusy} coverProblem={reading.coverProblem} onCover={reading.onCover} /> : null}
          {step === 'contents' ? (
            <ContentsStep
              {...stepProps}
              art={art}
              commitment={model.commitment}
              collectionCover={collectionCover}
              page={page}
              pictures={{ collection: reading.pictures.collection, banner: reading.pictures.banner, teaser: reading.pictures.teaser }}
              progress={reading.progress}
              onArt={reading.onArt}
              onCollectionCover={reading.onCollectionCover}
              onBanner={reading.onBanner}
              onTeasers={reading.onTeasers}
              onPage={setPage}
            />
          ) : null}
          {step === 'kind' ? <KindStep {...stepProps} network={network} /> : null}
          {step === 'raise' ? <RaiseStep {...stepProps} /> : null}
          {step === 'launch' ? <LaunchStep {...stepProps} nowMs={nowMs} /> : null}
          {overview ? (
            <OverviewStep
              {...stepProps}
              spec={model.spec}
              record={model.record}
              specHash={model.hash}
              owner={model.owner}
              demo={demo}
              network={network}
              nowMs={nowMs}
              cover={cover}
              collectionCover={collectionCover}
              page={page}
              fix={model.fix}
              duplicateId={model.duplicateId}
              revealNeeded={revealNeeded}
              revealSaved={model.input.revealSaved}
              revealInBar={demo && model.owner !== null}
              onDownloadSpec={actions.downloadSpec}
              onDownloadReveal={actions.downloadReveal}
              bar={bar}
            />
          ) : null}
          {actions.note ? (
            <p className="sh-newbox-hint" role="status">
              {actions.note}
            </p>
          ) : null}
          {overview ? null : bar}
        </form>
        <aside className="sh-newbox__preview" aria-label="Preview">
          <CardPreview record={model.record} />
          {overview ? null : <StatsPreview record={model.record} />}
        </aside>
      </div>
      {overview ? <PagePreview record={model.record} /> : null}
      <DemoWalletDialog open={walletOpen} onClose={() => setWalletOpen(false)} />
    </section>
  );
}

export default CreatePage;
