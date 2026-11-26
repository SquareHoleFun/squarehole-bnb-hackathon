/**
 * The creation page's state, in three hooks (box creation flow § 5-§ 6): reading the files, the gates on the one spec
 * the draft builds, and the actions (Next, Back to overview, Create, the downloads). The page component only lays them
 * out.
 *
 * One spec, one moment: the clock ticks every 15 s (and once on entering the Overview), the spec, its hash, the preview
 * and the duplicate check are all built from that tick, and Create and Download use that same spec. With a picked open
 * time, the hash on screen is the hash of what is created or saved.
 */
import { specHash as hashOf, type BoxSpecV1, type Network } from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { boxPath } from '../boxes/box-id';
import type { BoxRecord } from '../boxes/box-model';
import { addCreatedBox, demoBoxIdFor, type CreatedBoxEntry } from '../boxes/created-boxes';
import { cleanLinks } from '../boxes/site-links';
import { FREE_KINDS, readArt, readPicture, type ArtEnvironment, type PictureKind } from './art-files';
import type { FreeFit } from '../pictures/arweave-publish';
import { keepItemFiles } from './item-files';
import { previewRecord } from './BoxPreview';
import { reachableSteps, reviewIssues, stepIssues, stepsToFix, type GateInput } from './create-checks';
import { focusControl } from './create-parts';
import { MAX_TEASERS, STEPS, boxSpecFile, buildSpec, chooseOwner, commitArt, revealAckFor, revealFile, revealList, revealSavedFor, rightsRecord, stepIndex, type ArtCommitment, type CoverState, type Hex, type StepId } from './create-model';
import { currentDraft, draftGeneration, updateDraft, type Draft } from './draft';
import { CONTROL, MESSAGES, type ControlId, type Issue } from './reason-copy';

const CLOCK_TICK_MS = 15_000;

/** The page's clock: one tick every 15 s, and a fresh one on entering the Overview (the hash shown is built from it). */
export function useClock(step: StepId): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (step !== 'overview') return undefined;
    const timer = window.setTimeout(() => setNowMs(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, [step]);
  return nowMs;
}

export type Progress = { readonly done: number; readonly total: number } | null;

/** A picture being read: busy, or the reason the last one could not be used. */
export interface PictureStatus {
  readonly busy: boolean;
  readonly problem: string | null;
}

const IDLE: PictureStatus = Object.freeze({ busy: false, problem: null });

/**
 * Reading the art and the pictures (logo, collection cover, banner, teasers); it keeps going while the creator moves
 * between steps (the page stays mounted). A newer pick of the same kind wins over one still being read.
 *
 * SH-ARWEAVE-PICTURES-WEB: `free`, where the source publishes the logo and cover to Arweave, gives the free-tier check
 * (Turbo's free size and the chain's tags) those two are shrunk to; null elsewhere (the earlier rule).
 */
export function useArtReading(env: ArtEnvironment, onArtRead: () => void, free: (() => Promise<FreeFit>) | null = null) {
  const freeRef = useRef(free);
  useEffect(() => { freeRef.current = free; });
  const [progress, setProgress] = useState<Progress>(null);
  const [pictures, setPictures] = useState<Readonly<Record<PictureKind, PictureStatus>>>({ logo: IDLE, collection: IDLE, banner: IDLE, teaser: IDLE });
  const artJob = useRef(0);
  const jobs = useRef<Record<PictureKind, number>>({ logo: 0, collection: 0, banner: 0, teaser: 0 });

  function onArt(files: File[]) {
    const job = ++artJob.current;
    // A read finishing after Start over or a loaded setup is not this draft's: it is dropped (TA-27).
    const generation = draftGeneration();
    setProgress({ done: 0, total: files.length });
    let shown = -1;
    const onProgress = (done: number, total: number) => {
      const tick = Math.max(1, Math.ceil(total / 100));
      if (job !== artJob.current || (done !== total && done - shown < tick)) return;
      shown = done;
      setProgress({ done, total });
    };
    // F-1: the files whose bytes the spec commits, kept in memory for the BoxSpec file (never stored).
    const itemFiles = new Map<string, Blob>();
    readArt(files, { env, onProgress, onItemFile: (sha256, file) => itemFiles.set(sha256, file) }).then(
      (next) => {
        if (job !== artJob.current) return;
        if (generation !== draftGeneration()) { setProgress(null); return; }
        keepItemFiles(itemFiles);
        updateDraft((d) => ({ ...d, art: next, restored: false }));
        setProgress(null);
        onArtRead();
      },
      () => {
        if (job === artJob.current) setProgress(null);
      },
    );
  }

  const status = (kind: PictureKind, next: PictureStatus) => setPictures((before) => ({ ...before, [kind]: next }));

  /**
   * Reads pictures of one kind in order; `apply` stores each that could be used, unless `refuse` names a reason (the
   * draft as it is now, and the sha256 of the file as uploaded).
   */
  function onPictures(kind: PictureKind, files: readonly File[], apply: (d: Draft, picture: CoverState) => Draft, refuse?: (d: Draft, sourceSha256: Hex) => string | null) {
    if (files.length === 0) return;
    const job = ++jobs.current[kind];
    const generation = draftGeneration();
    status(kind, { busy: true, problem: null });
    (async () => {
      let problem: string | null = null;
      const asked = FREE_KINDS.has(kind) ? freeRef.current : null;
      // Never the earlier 1 MiB rule while Arweave is on: a check that cannot be had refuses the file (the catch below).
      const fits = asked ? await asked() : null;
      for (const file of files) {
        const result = await readPicture(file, env, kind, fits).catch(() => ({ error: 'The file could not be read.' }));
        if (job !== jobs.current[kind]) return;
        if (generation !== draftGeneration()) { status(kind, IDLE); return; }
        const refused = 'error' in result ? result.error : (refuse?.(currentDraft(), result.sourceSha256) ?? null);
        if (refused !== null) problem = refused;
        else if (!('error' in result)) updateDraft((d) => apply(d, result.picture));
      }
      status(kind, { busy: false, problem });
    })().catch(() => status(kind, { busy: false, problem: 'The file could not be read.' }));
  }

  const onCover = (file: File) => onPictures('logo', [file], (d, cover) => ({ ...d, cover, restored: false }));
  const onCollectionCover = (file: File) => onPictures('collection', [file], (d, collectionCover) => ({ ...d, collectionCover, restored: false }));
  const onBanner = (file: File) => onPictures('banner', [file], (d, banner) => ({ ...d, page: { ...d.page, banner }, restored: false }));
  const onTeasers = (files: readonly File[]) =>
    onPictures(
      'teaser',
      files,
      (d, teaser) => (d.page.teasers.length >= MAX_TEASERS ? d : { ...d, page: { ...d.page, teasers: [...d.page.teasers, teaser] }, restored: false }),
      teaserRefusal,
    );

  // SH-254: a new box (Start over) starts with no picture read and no read's error; a read still running is dropped.
  const reset = useCallback(() => {
    artJob.current += 1;
    for (const kind of Object.keys(jobs.current) as PictureKind[]) jobs.current[kind] += 1;
    setProgress(null);
    setPictures({ logo: IDLE, collection: IDLE, banner: IDLE, teaser: IDLE });
  }, []);
  return { progress, pictures, coverBusy: pictures.logo.busy, coverProblem: pictures.logo.problem, onArt, onCover, onCollectionCover, onBanner, onTeasers, reset };
}

/** F71: teasers show the style "without having to reveal the artwork". Hidden art: one of its own item files is refused. */
export const TEASER_IS_ITEM = 'This picture is one of your hidden items. Use another one.';

/** Why a teaser cannot be added: its file, as uploaded, is one of the hidden items (items are hashed as uploaded). */
export function teaserRefusal(d: Pick<Draft, 'form' | 'art'>, sourceSha256: Hex): string | null {
  if (d.form.contents !== 'collection' || d.form.artMode !== 'hidden' || !d.art) return null;
  return d.art.items.some((item) => item.imageSha256.toLowerCase() === sourceSha256.toLowerCase()) ? TEASER_IS_ITEM : null;
}

export interface ModelInput {
  readonly draft: Draft;
  readonly step: StepId;
  readonly nowMs: number;
  readonly demo: boolean;
  readonly connected: Address | null;
  readonly chainId: number;
  readonly dataLabel: string;
  readonly created: readonly CreatedBoxEntry[];
  /** Whose rules the spec is checked with (F74 U1; `specNetwork` of the data source). */
  readonly network: Network;
}

export interface CreateModel {
  readonly network: Network;
  readonly commitment: ArtCommitment | null;
  readonly owner: Address | null;
  readonly input: GateInput;
  readonly live: readonly Issue[];
  /** How many steps the stepper reaches (§ 0). */
  readonly reachable: number;
  /** Steps with something to fix now (the Overview's groups say "Fix"). */
  readonly fix: ReadonlySet<StepId>;
  readonly spec: BoxSpecV1;
  readonly hash: Hex | null;
  readonly duplicateId: string | null;
  readonly record: BoxRecord;
  /** Item thumbnails a created box may carry: open art only (hidden art keeps its pictures out of the record). */
  readonly thumbs: readonly string[];
}

/** The one spec the draft builds at this tick, its hash, the preview record and the live issues of this step. */
export function useCreateModel({ draft, step, nowMs, demo, connected, chainId, dataLabel, created, network }: ModelInput): CreateModel {
  const { form, art, cover, collectionCover, page } = draft;
  // Hidden art commits a sorted trait table (create-model `commitArt`): the art mode is part of the commitment.
  const commitment = useMemo(() => commitArt(art, form.artMode), [art, form.artMode]);
  // SH-AI-PLAN fix round 2: the reveal file counts as saved only for the commitment it was saved for (its root).
  const revealSaved = revealSavedFor(draft.revealSavedFor, commitment);
  const { owner, problem: ownerProblem } = useMemo(() => chooseOwner(demo, connected, form.ownerText), [demo, connected, form.ownerText]);
  const input: GateInput = useMemo(
    () => ({ form, art, commitment, cover, collectionCover, page, nowMs, revealSaved, owner, ownerProblem, network }),
    [form, art, commitment, cover, collectionCover, page, nowMs, revealSaved, owner, ownerProblem, network],
  );
  const review = useMemo(() => reviewIssues(input).issues, [input]);
  const live = useMemo(() => (step === 'overview' ? review : stepIssues(step, input)), [step, input, review]);
  const reachable = useMemo(() => reachableSteps(input), [input]);
  // The groups: what each step still needs (the Overview's own checks, address, reveal file and rights, are not a group).
  const fix = useMemo(() => stepsToFix(review.filter((issue) => issue.step !== 'overview')), [review]);
  const spec = useMemo(() => buildSpec({ form, art, commitment, cover, collectionCover, page, owner, nowMs }), [form, art, commitment, cover, collectionCover, page, owner, nowMs]);
  const hash = useMemo(() => {
    try {
      return hashOf(spec);
    } catch {
      return null;
    }
  }, [spec]);
  const duplicateId = demo && hash && created.some((entry) => entry.specHash === hash) ? demoBoxIdFor(hash) : null;
  const thumbs = useMemo(() => (form.contents === 'collection' && form.artMode === 'open' ? (art?.thumbs ?? []) : []), [form.contents, form.artMode, art]);
  const pictures = useMemo(() => pageUrls(draft), [draft]);
  const record = useMemo(
    () =>
      previewRecord({
        spec,
        coverUrl: cover?.url ?? null,
        collectionCoverUrl: form.contents === 'collection' ? (collectionCover?.url ?? null) : null,
        thumbs,
        demo,
        chainId,
        networkLabel: demo ? 'Local chain 31337' : dataLabel,
        nowMs,
        bannerUrl: pictures.bannerUrl,
        teaserUrls: pictures.teaserUrls,
        links: cleanLinks(form.links),
        creator: owner,
      }),
    [spec, cover, collectionCover, form.contents, thumbs, demo, chainId, dataLabel, nowMs, pictures, form.links, owner],
  );
  return { network, commitment, owner, input, live, reachable, fix, spec, hash, duplicateId, record, thumbs };
}

/** The collection page's thumbnails a box may carry (never for "Token"). */
export function pageUrls(draft: Pick<Draft, 'form' | 'page'>): { readonly bannerUrl: string | null; readonly teaserUrls: readonly string[] } {
  if (draft.form.contents === 'token') return { bannerUrl: null, teaserUrls: [] };
  return { bannerUrl: draft.page.banner?.url ?? null, teaserUrls: draft.page.teasers.flatMap((teaser) => (teaser.url ? [teaser.url] : [])) };
}

/** Saves a text file through a temporary link; false where the browser cannot (no object URLs). */
function download(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a pointer is pressed right now. Leaving a field by pressing Next shows that field's message, which moves Next
 * down between the press and the release; the click would then land on the bar and be lost. While a pointer is down,
 * a field's message waits for the release (the click, and its summary, come first).
 */
function usePointerDown(): () => boolean {
  const down = useRef(false);
  useEffect(() => {
    const press = () => {
      down.current = true;
    };
    const release = () => {
      down.current = false;
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
    };
  }, []);
  return useCallback(() => down.current, []);
}

/** When each control shows its message: after it was left, or once Next / Create was pressed on its step. */
export function useShownIssues(step: StepId, live: readonly Issue[]) {
  const [touched, setTouched] = useState<ReadonlySet<ControlId>>(() => new Set());
  const [submitted, setSubmitted] = useState<ReadonlySet<StepId>>(() => new Set());
  const [summaryKey, setSummaryKey] = useState(0);
  const pointerDown = usePointerDown();
  const touch = useCallback(
    (control: ControlId) => {
      const apply = () => setTouched((before) => (before.has(control) ? before : new Set([...before, control])));
      if (!pointerDown()) {
        apply();
        return;
      }
      // After the release: pointerup, mouseup and click run in one task, so the click has landed by then.
      const later = () => {
        document.removeEventListener('pointerup', later, true);
        document.removeEventListener('pointercancel', later, true);
        window.setTimeout(apply, 0);
      };
      document.addEventListener('pointerup', later, true);
      document.addEventListener('pointercancel', later, true);
    },
    [pointerDown],
  );
  const errorFor = useCallback(
    (control: ControlId): string | null => {
      const issue = live.find((entry) => entry.control === control);
      if (!issue) return null;
      return submitted.has(step) || touched.has(control) ? issue.message : null;
    },
    [live, submitted, touched, step],
  );
  /** Marks this step submitted; true (and the summary focused) when there is something to fix. */
  const showIssues = useCallback(
    (issues: readonly Issue[]): boolean => {
      setSubmitted((before) => new Set([...before, step]));
      if (issues.length === 0) return false;
      setSummaryKey((key) => key + 1);
      return true;
    },
    [step],
  );
  return { touch, errorFor, showIssues, submitted, summaryKey, summary: submitted.has(step) ? live : [] };
}

export interface ActionInput {
  readonly step: StepId;
  readonly draft: Draft;
  readonly model: CreateModel;
  readonly demo: boolean;
  readonly showIssues: (issues: readonly Issue[]) => boolean;
  /** This step was opened by an Overview Edit link: its primary button returns there (§ 1 "Edit and return"). */
  readonly fromOverview: boolean;
}

/** Next (or Back to overview), Create, Download BoxSpec and the reveal file; each uses the spec on screen (one tick). */
export function useCreateActions({ step, draft, model, demo, showIssues, fromOverview }: ActionInput) {
  const navigate = useNavigate();
  const [note, setNote] = useState<string | null>(null);
  const { input, commitment, thumbs } = model;
  const { form, art, cover, collectionCover, page } = draft;

  function go(issue: Issue) {
    if (issue.step === step) focusControl(issue.control);
    else navigate(`/create/${issue.step}`, { state: { focus: issue.control, fromOverview: step === 'overview' } });
  }

  function next(event: FormEvent) {
    event.preventDefault();
    if (showIssues(stepIssues(step, input))) return;
    if (fromOverview) {
      navigate('/create/overview');
      return;
    }
    const following = STEPS[stepIndex(step) + 1];
    if (following) navigate(`/create/${following.id}`);
  }

  function create() {
    const { spec, issues } = reviewIssues(input);
    if (showIssues(issues) || !demo || model.owner === null) return;
    const nowMs = Date.now();
    let result: ReturnType<typeof addCreatedBox>;
    try {
      const pictures = pageUrls(draft);
      result = addCreatedBox(spec, {
        createdAtMs: nowMs,
        coverUrl: cover?.url ?? null,
        collectionCoverUrl: form.contents === 'collection' ? (collectionCover?.url ?? null) : null,
        thumbs,
        bannerUrl: pictures.bannerUrl,
        teaserUrls: pictures.teaserUrls,
        links: cleanLinks(form.links),
        rights: rightsRecord(hashOf(spec), model.owner, nowMs),
      });
    } catch (error) {
      console.error('Create: the spec passed the page checks but not the sample store', error);
      setNote(MESSAGES.bug);
      return;
    }
    if (result.status === 'duplicate') {
      document.querySelector<HTMLElement>('.sh-newbox-duplicate a')?.focus();
      return;
    }
    navigate(boxPath(result.id), { state: { boxCreated: true, kept: result.kept } });
  }

  function downloadSpec() {
    const { spec, issues } = reviewIssues(input);
    if (showIssues(issues.filter((issue) => issue.control !== CONTROL.reveal)) || model.owner === null) return;
    const collection = form.contents === 'collection';
    const openList = collection && form.artMode === 'open' && art && commitment ? revealList(art, commitment.packed) : null;
    const file = boxSpecFile(spec, {
      builtAtMs: input.nowMs,
      cover,
      collectionCover: collection ? collectionCover : null,
      network: model.network,
      page,
      revealList: openList,
      links: form.links,
      rights: rightsRecord(hashOf(spec), model.owner, Date.now()),
      storeAll: collection && form.storeAll,
    });
    setNote(download(file.name, file.text) ? `Saved ${file.name}` : 'This browser could not save the file.');
  }

  function downloadReveal() {
    if (!art || !commitment) return;
    const file = revealFile(model.spec, art, commitment);
    if (download(file.name, file.text)) updateDraft((d) => ({ ...d, revealSavedFor: revealAckFor(commitment) }));
    else setNote('This browser could not save the file.');
  }

  return { note, go, next, create, downloadSpec, downloadReveal };
}
