/** Test data for the v2 create flow: a valid build input for any § 8 configuration, and the page's stores seeded with it. */
import type { CreateForm } from '../../create-model';
import { updateDraft } from '../../draft';
import { COLLECTION_COVER, artOf, formOf, inputOf, itemFilesOf } from '../../test-support/fixtures';
import { forgetItemFiles, keepItemFiles } from '../../item-files';
import { applyConfiguration, type Configuration } from '../configurations';
import { CONFIGURATIONS } from './example-configurations';
import { DEMO_LISTINGS } from '../listings';
import { buildSpecV2, type BuildV2Input, type V2Choices } from '../model';
import type { BoxSpecV2 } from '../spec-types';
import { updateV2 } from '../v2-draft';

const FIRST = CONFIGURATIONS[0] as Configuration;

/** A complete, valid input (the rights ticked, the logo, art and collection cover read, the owner known). */
export function inputV2Of(config: Configuration = FIRST, v2: Partial<V2Choices> = {}, form: Partial<CreateForm> = {}): BuildV2Input {
  const applied = applyConfiguration(config);
  const merged = formOf({ ...applied.form, rights: true, ...form });
  const token = merged.contents === 'token';
  const art = token ? null : artOf();
  const base = inputOf({ form: merged, art, collectionCover: token ? null : COLLECTION_COVER });
  return { ...base, v2: { ...applied.v2, ...v2 }, listings: DEMO_LISTINGS };
}

export const sampleSpec = (): BoxSpecV2 => buildSpecV2(inputV2Of());

/** The page's draft and its v2 choices as a creator who picked `config` would leave them. */
export function seedV2(config: Configuration = FIRST): BuildV2Input {
  const input = inputV2Of(config);
  updateDraft((draft) => ({ ...draft, form: input.form, art: input.art, cover: input.cover, collectionCover: input.collectionCover ?? null, restored: false }));
  // The visit read these items' files (F-1: the BoxSpec file carries their bytes).
  if (input.art) keepItemFiles(itemFilesOf(input.art.items.length)); else forgetItemFiles();
  updateV2(() => input.v2);
  return input;
}
