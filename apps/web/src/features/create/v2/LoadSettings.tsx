/**
 * TA-27 "Load settings" on Create's first step: a file picker for a BoxSpec settings file (this page's own download),
 * then, when the setup has items, the item pictures (numbered files 1..N with optional traits, or their folder), or,
 * when a shop has starter items, their ids per collection (SH-SHOP-CREATE: the file commits only their hash), each
 * checked by load-settings.ts with the page's own rules; a shop's starting collections are asked on this page's chain
 * first (shop-checks.ts). SH-EX-O1: a hidden kit's public template loads together with its plan file (both picked at
 * once), and its item pictures are its plan's twelve pictures and plan.csv, dealt here. R74-ART: a setup with 3D models
 * takes its numbered models (1.glb …) with the pictures. Nothing is uploaded and nothing asks a wallet. Once loaded,
 * `LoadedNote` says, in one short line, that the other fields come from the loaded setup, with Start over beside it.
 * The page names no setups: the creator brings the file.
 * SH-218 rail 2: the file's own spec is checked against the release's switched-off options once it is read, and the
 * setup as it would be installed is checked again (afresh) right before it replaces the draft. A file that needs a
 * switched-off option (line A) or meets a list that cannot be read (line B) is not loaded: the draft stays as it was, a
 * pending setup stays pending with its files, and no coin or recipe is changed for another.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { PICTURES, readArt, type ArtEnvironment, type PictureKind } from '../art-files';
import { ZERO32, commitArt, type ArtState } from '../create-model';
import { ITEM_FILE_TYPES, TextField, takeFiles } from '../create-parts';
import type { SiteListing } from './listings';
import { LOAD_WORDS, MAX_SETTINGS_BYTES, UNASKED, bindPlanTemplate, finishLoad, isTemplateShaped, readPlanManifest, readSettingsFile, setupOf, sortPicked, templatePlanProblem, withStarters, type FinishOptions, type LoadedDraft, type LoadedInfo, type LoadedSetup, type SettingsFile, type Thumbnail } from './load-settings';
import type { PictureRole } from './pictures';
import { addressOf } from './shop';
import type { CollectionChecker } from './shop-checks';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import { buildSpecV2 } from './model';
import type { BoxSpecV2 } from './spec-types';

/** SH-218 rail 2: a spec against the release's switched-off options, read fresh ('none': no list in this build). */
export type LoadOptionsCheck = (spec: BoxSpecV2) => Promise<'ok' | 'off' | 'unavailable'>;

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const LOADED_LINE = 'From the loaded setup.';
export const LOADED_EDITABLE = 'Price coin, name, ticker, links, opening and fees stay yours to change.';
const KIND: Readonly<Record<PictureRole, PictureKind>> = { logo: 'logo', 'collection cover': 'collection', banner: 'banner', teaser: 'teaser', item: 'teaser' };

export interface LoadSettingsProps {
  readonly env: ArtEnvironment;
  readonly listings: readonly SiteListing[];
  /** The price coin the page shows now: used when the file's coin is not listed here. */
  readonly pricing: string;
  /** Files built from sample listings load only in the Demo. */
  readonly demo: boolean;
  /**
   * Asks this page's chain about a shop's starting collections before it loads; null where there is no chain to ask:
   * a shop then loads only in the Demo (`demo`, unchecked as on the Demo's own page) and is refused anywhere else.
   */
  readonly checkCollections: CollectionChecker | null;
  readonly onLoaded: (draft: LoadedDraft, itemFiles: ReadonlyMap<string, Blob>) => void;
  /** SH-218 rail 2: the Create switches' check for a file; null where no list applies (the Demo). */
  readonly optionsCheck: LoadOptionsCheck | null;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/**
 * SH-APP8: a line's file name ("-plan.json", in `pickOne` and `templateNeedsPlan`) stays whole on a phone: it sits in a
 * span that does not wrap (create-v2.css), so a phone never breaks it after its hyphen. The words stay plain text, the
 * same bytes as LOAD_WORDS, for find-in-page and copy/paste.
 */
const FILE_NAME = /(-plan\.json)/;
const problemText = (text: string) => text.split(FILE_NAME).map((part, i) => (i % 2 === 1 ? <span key={i} className="sh-v2-load__name">{part}</span> : part));

export function LoadSettings({ env, listings, pricing, demo, checkCollections, onLoaded, optionsCheck }: LoadSettingsProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<LoadedSetup | null>(null);
  // A shop's starter ids as typed, one text per collection in the file's order.
  const [ids, setIds] = useState<readonly string[]>([]);
  const job = useRef(0);
  const thumbnail: Thumbnail = (bytes, role) => {
    const how = PICTURES[KIND[role]];
    return env.thumbnail(new Blob([bytes.slice().buffer]), how.thumbSide, how.thumbChars).catch(() => null);
  };
  const finish = async (id: number, setup: LoadedSetup, files: ReadonlyMap<string, Blob>, art: ArtState | null) => {
    // A shop's starting collections stay as loaded, so this chain answers for each one before the setup is installed;
    // with no chain to ask, only the Demo loads a shop (finishLoad refuses it anywhere else).
    let shopChecks: FinishOptions['shopChecks'];
    const shop = setup.v2.shop;
    if (shop && checkCollections) {
      const answered = await checkCollections(shop.collections.flatMap((row) => { const address = addressOf(row.address); return address ? [address] : []; })).catch(() => null);
      if (id !== job.current) return;
      if (!answered) { setProblem(LOAD_WORDS.shopUnchecked); return; }
      shopChecks = answered;
    } else if (shop && DEMO_BUILD && demo) shopChecks = UNASKED;
    const result = finishLoad(setup, art, listings, pricing, Date.now(), { salt: () => env.salt(), shopChecks });
    if (!result.ok) { setProblem(result.error); return; }
    // SH-218 rail 2: the setup as it would replace the draft (its price coin settled), against a fresh list.
    if (optionsCheck) {
      const loaded = result.value;
      const spec = buildSpecV2({ form: loaded.form, art: loaded.art, commitment: commitArt(loaded.art, loaded.form.artMode), cover: loaded.cover,
        collectionCover: loaded.collectionCover, page: loaded.page, owner: null, nowMs: Date.now(), v2: loaded.v2, listings });
      const verdict = await optionsCheck(spec);
      if (id !== job.current) return;
      if (verdict !== 'ok') { setProblem(verdict === 'off' ? CREATE_OFF : CREATE_UNAVAILABLE); return; }
    }
    setPending(null);
    onLoaded(result.value, files);
  };
  const run = (work: (id: number) => Promise<void>) => {
    const id = ++job.current;
    setBusy(true); setProblem(null);
    work(id).catch((error: unknown) => {
      console.error('Create v2: the settings could not be loaded', error);
      if (id === job.current) setProblem(LOAD_WORDS.notJson);
    }).finally(() => { if (id === job.current) setBusy(false); });
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = takeFiles(event);
    if (files.length === 0) return;
    run(async (id) => {
      if (files.some((file) => file.size > MAX_SETTINGS_BYTES)) { setProblem(LOAD_WORDS.tooLarge); return; }
      // The settings file, and beside it a hidden kit template's plan file (SH-EX-O1), told apart by their format; two
      // settings files, two plan files or a plan file alone get one line that says what to pick, and a pick holding a
      // file in neither format keeps "Not a settings file" (`sortPicked`).
      const picked = await Promise.all(files.map(async (file) => { const bytes = new Uint8Array(await file.arrayBuffer()); return { bytes, text: new TextDecoder().decode(bytes) }; }));
      const sorted = sortPicked(picked);
      if (!sorted.ok) { setProblem(sorted.error); return; }
      const { settings: main, plan } = sorted.value;
      const read = await readSettingsFile(main.text, env.digest);
      if (id !== job.current) return;
      if (!read.ok) { setProblem(read.error); return; }
      if (read.value.demo && !demo) { setProblem(LOAD_WORDS.demo); return; }
      let file: SettingsFile = read.value;
      if (plan) {
        const manifest = readPlanManifest(plan.text);
        if (!manifest.ok) { setProblem(manifest.error); return; }
        const bound = bindPlanTemplate(file, await env.digest(main.bytes), manifest.value);
        if (id !== job.current) return;
        if (!bound.ok) { setProblem(bound.error); return; }
        file = bound.value;
      } else if (isTemplateShaped(file)) { setProblem(LOAD_WORDS.templateNeedsPlan); return; }
      const setup = await setupOf(file, listings, thumbnail);
      if (id !== job.current) return;
      if (!setup.ok) { setProblem(setup.error); return; }
      // SH-218 rail 2: the file's own choices, as decoded, before anything is repriced or asked for.
      if (optionsCheck) {
        const verdict = await optionsCheck(setup.value.file.spec);
        if (id !== job.current) return;
        if (verdict !== 'ok') { setProblem(verdict === 'off' ? CREATE_OFF : CREATE_UNAVAILABLE); return; }
      }
      if (setup.value.info.items > 0 || setup.value.starters > 0) { setIds((setup.value.v2.shop?.collections ?? []).map(() => '')); setPending(setup.value); }
      else await finish(id, setup.value, new Map(), null);
    });
  };
  const onStarters = () => {
    const setup = pending;
    if (!setup) return;
    run(async (id) => {
      const filled = withStarters(setup, ids, listings);
      if (!filled.ok) { setProblem(filled.error); return; }
      await finish(id, filled.value, new Map(), null);
    });
  };
  const onItems = (event: ChangeEvent<HTMLInputElement>) => {
    const files = takeFiles(event);
    const setup = pending;
    if (files.length === 0 || !setup) return;
    run(async (id) => {
      // A kit's template takes exactly the plan its plan file names (SH-EX-O1).
      const planProblem = await templatePlanProblem(setup, files, env.digest);
      if (id !== job.current) return;
      if (planProblem) { setProblem(planProblem); return; }
      const itemFiles = new Map<string, Blob>();
      // Read without salts: the new box's own are made only once its pictures are verified (finishLoad).
      const art = await readArt(files, { env: { ...env, salt: () => ZERO32 }, onItemFile: (sha256, file) => itemFiles.set(sha256.toLowerCase(), file) });
      if (id === job.current) await finish(id, setup, itemFiles, art);
    });
  };
  const cancel = () => { job.current += 1; setPending(null); setIds([]); setBusy(false); setProblem(null); };
  const rows = pending?.starters ? pending.v2.shop?.collections ?? [] : [];
  return (
    <div className="sh-v2-load" data-load-settings="">
      {pending && pending.starters > 0 ? (
        // The file commits a shop's starter items only by hash: their ids, typed per collection, must rebuild it.
        // Enter in an ids field loads them (never the step's Next, which the page's form would take).
        <div className="sh-v2-load__items" role="group" aria-labelledby="create-load-starters-label" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onStarters(); } }}>
          <span className="sh-newbox-label" id="create-load-starters-label">{`Starter items · ${pending.starters}`}</span>
          {rows.map((row, i) => (
            <TextField
              key={i}
              id={`create-load-starters-${i}`}
              label={`Collection ${i + 1} · ${short(row.address)}`}
              value={ids[i] ?? ''}
              placeholder="1, 2, 5-9"
              spellCheck={false}
              onChange={(text) => { setProblem(null); setIds((before) => before.map((value, j) => (j === i ? text : value))); }}
            />
          ))}
          <div className="sh-newbox-pick">
            <button type="button" className="sh-button" data-busy={busy || undefined} disabled={busy} onClick={onStarters}>{busy ? 'Reading…' : 'Load'}</button>
            <button type="button" className="sh-button" onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : pending ? (
        <div className="sh-v2-load__items">
          {/* R74-ART: a setup with 3D models takes its numbered models (1.glb …) with its pictures. */}
          <span className="sh-newbox-label" id="create-load-items-label">{`${pending.info.models ? 'Item pictures + models' : 'Item pictures'} · ${pending.info.items}`}</span>
          <div className="sh-newbox-pick">
            <label className="sh-button sh-newbox-pick__button" data-busy={busy || undefined}>
              <input id="create-load-items" type="file" multiple accept={ITEM_FILE_TYPES} className="sh-newbox-file" aria-labelledby="create-load-items-label create-load-items-files" disabled={busy} onChange={onItems} />
              <span id="create-load-items-files">{busy ? 'Reading…' : pending.info.models ? 'Images + models + traits' : 'Images + traits'}</span>
            </label>
            <label className="sh-button sh-newbox-pick__button">
              <input type="file" multiple className="sh-newbox-file" aria-labelledby="create-load-items-label create-load-items-folder" disabled={busy} {...({ webkitdirectory: '' } as Record<string, string>)} onChange={onItems} />
              <span id="create-load-items-folder">Folder</span>
            </label>
            <button type="button" className="sh-button" onClick={cancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="sh-newbox-pick">
          <label className="sh-button sh-newbox-pick__button" data-busy={busy || undefined}>
            <input id="create-load-settings" type="file" multiple accept=".json,application/json" className="sh-newbox-file" aria-labelledby="create-load-settings-action" disabled={busy} onChange={onFile} />
            <span id="create-load-settings-action">{busy ? 'Reading…' : 'Load settings'}</span>
          </label>
        </div>
      )}
      {/* The words in one span: the line is a flex row, so the file name's own span stays inside the sentence. */}
      {problem ? <p className="sh-newbox-error" role="alert" data-load-problem=""><span aria-hidden="true">!</span> <span>{problemText(problem)}</span></p> : null}
    </div>
  );
}

/** The short line on each step a loaded setup keeps, with Start over; on Basics also what stays editable. */
export function LoadedNote({ info, first = false, onStartOver }: { info: LoadedInfo; first?: boolean; onStartOver: () => void }) {
  return (
    <div className="sh-v2-loaded" data-loaded-setup="">
      <p className="sh-v2-loaded__line">
        {LOADED_LINE}
        {first && info.items > 0 ? <span className="sh-v2-loaded__count">{` ${info.items} ${info.items === 1 ? 'item' : 'items'}${info.hidden ? ', hidden' : ''}${info.models ? ', 3D' : ''}`}</span> : null}
        {first ? <span className="sh-newbox-note">{LOADED_EDITABLE}</span> : null}
        {first && info.note ? <span className="sh-newbox-note" role="status">{info.note}</span> : null}
      </p>
      <button type="button" className="sh-button" onClick={onStartOver}>Start over</button>
    </div>
  );
}
