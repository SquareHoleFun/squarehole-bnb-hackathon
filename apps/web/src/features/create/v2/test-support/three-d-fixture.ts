/**
 * R74-ART (SH-CREATE-ITEM-MODELS): a small open collection with a 3D model per item, for Load settings in the unit tests
 * and the browser suite (e2e/create-v2-models.spec.ts). Its settings file (`three-d-boxspec-v2.json`, beside this file)
 * is the page's own Download BoxSpec of these items, built and checked fresh by three-d-fixture.test.ts. TEST DATA ONLY:
 * sample pictures, placeholder models (no geometry) and the sample listings' ETH. Relative imports only, so the browser
 * suite can build the same files.
 */
import { makePng } from '../../../../../../../packages/artwork/src/test-support/images';
import { glbOf } from '../../test-support/models';

/** Ten items: a box holds ten at least. */
export const THREE_D_COUNT = 10;
/** The committed settings file's name, in this folder. */
export const THREE_D_FIXTURE = 'three-d-boxspec-v2.json';

export interface FixtureFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

const ids = (): number[] => Array.from({ length: THREE_D_COUNT }, (_, i) => i + 1);

/** The item files as a creator adds them: 1.png … 10.png, their models 1.glb … 10.glb and traits.csv. */
export function threeDItemFiles({ models = true }: { readonly models?: boolean } = {}): FixtureFile[] {
  const traits = ['id,Roof', ...ids().map((id) => `${id},${id % 2 ? 'Red' : 'Teal'}`)].join('\n');
  return [
    ...ids().map((id) => ({ name: `${id}.png`, mimeType: 'image/png', bytes: makePng({ width: 40 + id, height: 40 + id, decodable: true }) })),
    ...(models ? ids().map((id) => ({ name: `${id}.glb`, mimeType: 'model/gltf-binary', bytes: glbOf(id, { bin: 64 }) })) : []),
    { name: 'traits.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode(traits) },
  ];
}

/** The logo and the collection cover the file commits (processed pictures, kept as given). */
export const threeDLogo = (): Uint8Array => makePng({ width: 300, height: 300, decodable: true });
export const threeDCover = (): Uint8Array => makePng({ width: 301, height: 301, decodable: true });
/** The fixture's fixed public salts (an open collection's are public; a loaded setup gets new ones). */
export const threeDSalt = (id: number): `0x${string}` => `0x${id.toString(16).padStart(2, '0').repeat(32)}`;
