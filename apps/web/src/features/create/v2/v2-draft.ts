/**
 * The v2 flow's own choices (pricing, recipes, humble cap, pick fee, deadline), kept beside v1's draft (draft.ts), which
 * holds what both flows share: names, logo, art, covers, page, open time, the creator buy and the rights box. SH-256:
 * they live in the draft store itself (draft.ts `currentMoney`, v2-stored.ts), saved in the same key as the draft's
 * choices (`sh.create.draft.v2`, already listed in the privacy notice), so a reload gives back the whole draft or a
 * clean start, never the names and items with these choices at their defaults. A loaded setup (TA-27,
 * load-settings.ts) is marked here and locks the draft in its own document; a fresh document never restores it (it
 * starts clean). Start over clears it.
 */
import { useSyncExternalStore } from 'react';
import { currentMoney, subscribeDraft, updateMoney } from '../draft';
import type { LoadedInfo } from './load-settings';
import type { V2Choices } from './model';
import { EMPTY_MONEY } from './v2-stored';

export const currentV2Choices = (): V2Choices => currentMoney().v2;
export const useV2Choices = (): V2Choices => useSyncExternalStore(subscribeDraft, currentV2Choices, currentV2Choices);

export function updateV2(change: (choices: V2Choices) => V2Choices): void {
  updateMoney((part) => {
    const v2 = change(part.v2);
    return v2 === part.v2 ? part : { ...part, v2 };
  });
}

/** The template this visit started from (F128), or null before any is chosen; stored with the choices. */
export const currentV2Template = (): string | null => currentMoney().template;
export const useV2Template = (): string | null => useSyncExternalStore(subscribeDraft, currentV2Template, currentV2Template);
export function setV2Template(id: string | null): void {
  updateMoney((part) => (part.template === id ? part : { ...part, template: id }));
}

/**
 * TA-27: the setup loaded from a settings file, or null; while one is loaded only the five choices change, and the
 * shared draft store keeps its parts whoever writes to it (draft.ts guard, load-settings.ts `lockedDraft`). SH-256: a
 * stored draft that carries a marker starts clean after a reload.
 */
export const currentV2Loaded = (): LoadedInfo | null => currentMoney().loaded;
export const useV2Loaded = (): LoadedInfo | null => useSyncExternalStore(subscribeDraft, currentV2Loaded, currentV2Loaded);
export function setV2Loaded(info: LoadedInfo | null): void {
  updateMoney((part) => ({ ...part, loaded: info }));
}

/** Start over: the defaults, no template and no loaded setup (the draft store unguarded again). */
export const clearV2 = (): void => updateMoney(() => EMPTY_MONEY);
export const resetV2ForTests = clearV2;
