/**
 * SH-192 (BOXSPEC-AUTOSAVE): what this browser keeps of a box's reveal data (reveal-keep.ts), built from the spec the
 * run creates (its own bytes, never the page's later choices) and the draft's art, only when that art commits exactly
 * the spec's reveal root (and, for open art, its list id). Pure: no storage, no network.
 *
 * - Open art: the BoxSpec file without its picture bytes: format `squarehole.boxspec/2`, specHash, encoded, spec, an
 *   empty `pictures` list and the reveal list with every salt, the same frame Download BoxSpec writes (model.ts
 *   `boxSpecFrame`). packages/chain/scripts/reveal-open-v2.ts `readOpenBoxSpec` reads it as it reads the full file.
 * - Hidden art: the reveal file (create-model.ts `revealFile`), which the box page's "Load reveal file" reads.
 */
import { zeroHash, type Hex } from 'viem';
import { ArtMode, type BoxSpecV1 } from '@squarehole/box-spec';
import { revealFile, revealList, type ArtCommitment, type ArtState } from '../create-model';
import { boxSpecFrame } from './model';
import type { RecipeCtx } from './recipes';
import { specHashV2, type BoxSpecV2 } from './spec-types';
import type { KeptArtMode } from './reveal-keep';

/** Whether creating this spec commits a reveal root (a collection, open or hidden); a token box commits none. */
export const commitsReveal = (spec: Pick<BoxSpecV2, 'revealRoot'>): boolean => spec.revealRoot.toLowerCase() !== zeroHash;

export interface RevealData {
  readonly artMode: KeptArtMode;
  readonly specHash: Hex;
  readonly revealRoot: Hex;
  readonly n: number;
  readonly fileName: string;
  readonly text: string;
}

export interface RevealDataInput {
  /** The spec the run creates (create-send.ts `specOfRun`). */
  readonly spec: BoxSpecV2;
  readonly art: ArtState | null;
  /** The draft's commitment of that art (create-model.ts `commitArt`), for the draft's art mode. */
  readonly commitment: ArtCommitment | null;
  readonly ctx: Pick<RecipeCtx, 'pricing' | 'listings'>;
  /** Hidden art's reveal file names its collection by the v1 spec the page builds (create-model.ts `buildSpec`). */
  readonly v1Spec: () => BoxSpecV1;
}

/** The reveal data for this spec, or null when the draft's art is not the art the spec commits (or there is none). */
export function revealDataOf({ spec, art, commitment, ctx, v1Spec }: RevealDataInput): RevealData | null {
  if (!commitsReveal(spec) || !art || !commitment) return null;
  if (commitment.revealRoot.toLowerCase() !== spec.revealRoot.toLowerCase() || commitment.n !== art.items.length || BigInt(commitment.n) !== BigInt(spec.n)) return null;
  const base = { specHash: specHashV2(spec).toLowerCase() as Hex, revealRoot: spec.revealRoot.toLowerCase() as Hex, n: commitment.n };
  if (Number(spec.artMode) === ArtMode.OPEN) {
    if (commitment.revealListId.toLowerCase() !== spec.revealListId.toLowerCase()) return null;
    const frame = boxSpecFrame(spec, ctx, revealList(art, commitment.packed), false);
    return { ...base, artMode: 'open', fileName: frame.name.replace(/-boxspec-v2\.json$/, '-reveal-data-v2.json'), text: `${frame.head}${frame.tail}` };
  }
  if (Number(spec.artMode) === ArtMode.HIDDEN) {
    const file = revealFile(v1Spec(), art, commitment);
    return { ...base, artMode: 'hidden', fileName: file.name, text: file.text };
  }
  return null;
}
