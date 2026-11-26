/**
 * T06 test data, Node only (it reads files): real one-of-a-kind items from the repository's kits, a Rent Free house and a
 * Bag Holders bag (3D under founder R74-ART: a picture and a self-contained GLB each, from their committed samples), and
 * the items of Create's 3D settings fixture (T01, `three-d-boxspec-v2.json`: pictures and placeholder models without
 * geometry, the page's own Download BoxSpec). Relative imports only, so the browser suite (e2e) builds the same files.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glbSha256, sha256Hex } from '../../../../../../../packages/artwork/src/misfits-commitment';

type Hash = `0x${string}`;

export interface ItemArtFixture {
  readonly name: string;
  readonly picture: Uint8Array;
  readonly pictureSha256: Hash;
  readonly model: Uint8Array;
  readonly modelSha256: Hash;
}

/** The repository's root, from this file (apps/web/src/features/core/v2/test-support). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, path)));
const hashOf = (bytes: Uint8Array): Hash => `0x${sha256Hex(bytes).replace(/^0x/, '').toLowerCase()}`;

function kitItem(name: string, kit: string, id: number): ItemArtFixture {
  const picture = read(`examples/boxes/${kit}/unique/samples/picture-${id}.png`);
  const model = read(`examples/boxes/${kit}/unique/samples/model-${id}.glb`);
  // The viewer's rules (a self-contained binary glTF 2.0 of one raw block): the hash is the one the chain commits.
  return { name, picture, pictureSha256: hashOf(picture), model, modelSha256: glbSha256(model) as Hash };
}

/** Rent Free house #1 and Bag Holders bag #1, as their kits commit them. */
export const rentFreeItem = (): ItemArtFixture => kitItem('Rent Free #1', 'rent-free', 1);
export const bagHoldersItem = (): ItemArtFixture => kitItem('Bag Holders #1', 'bag-holders', 1);

interface ThreeDFile {
  readonly pictures: readonly { readonly sha256: string; readonly base64: string }[];
  readonly models: readonly { readonly sha256: string; readonly base64: string }[];
  readonly revealList: { readonly items: readonly { readonly id: string; readonly imageSha256: string; readonly modelSha256: string }[] };
}

/** Item `id` of Create's 3D fixture (T01): its picture and its placeholder model (a valid GLB with no scene to draw). */
export function threeDFixtureItem(id: number): ItemArtFixture {
  const file = JSON.parse(new TextDecoder().decode(read('apps/web/src/features/create/v2/test-support/three-d-boxspec-v2.json'))) as ThreeDFile;
  const entry = file.revealList.items.find((item) => item.id === String(id));
  if (!entry) throw new Error(`three-d fixture: no item ${id}`);
  const bytesOf = (list: ThreeDFile['models'], sha256: string): Uint8Array => {
    const found = list.find((asset) => asset.sha256.toLowerCase() === sha256.toLowerCase());
    if (!found) throw new Error(`three-d fixture: no file ${sha256}`);
    return Uint8Array.from(Buffer.from(found.base64, 'base64'));
  };
  const picture = bytesOf(file.pictures, entry.imageSha256);
  const model = bytesOf(file.models, entry.modelSha256);
  return { name: `Create 3D fixture #${id}`, picture, pictureSha256: entry.imageSha256.toLowerCase() as Hash, model, modelSha256: entry.modelSha256.toLowerCase() as Hash };
}
