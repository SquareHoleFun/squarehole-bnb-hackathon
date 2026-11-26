/** Internal pure part of reveal-open-v2. No salts are generated or rewritten. */
import { z } from 'zod';
import { keccak256, sha256, type Hex } from 'viem';
import { decodeBoxSpecV2, encodeBoxSpecV2, MAX_N } from '@squarehole/box-spec/v2';
import { boxLeaf, buildBoxTree } from '@squarehole/domain/box-commitment';
import { canonicalJson } from '@squarehole/domain/canonical-json';
import { checkReveal } from './reveal-check';

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v as Hex);
const itemSchema = z.strictObject({ id: decimal, traitsPacked: decimal, imageSha256: hash, avatarSha256: hash, modelSha256: hash, salt: hash });
const listSchema = z.strictObject({ format: z.literal('squarehole.box-reveal-list/1'), n: decimal, items: z.array(z.unknown()).min(1).max(MAX_N) });
const fileSchema = z.object({ format: z.literal('squarehole.boxspec/2'), demo: z.literal(false).optional(),
  encoded: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/), specHash: hash, spec: z.unknown(), revealList: z.unknown() });

/** State read by the caller from the intended collection; root is always required on the public browser path. */
export interface OpenRevealCommitmentV2 {
  readonly root: Hex;
  readonly size?: bigint;
  readonly firstId?: bigint;
  readonly specHash?: Hex;
}

// Equivalent to the Node tool's specJson + deepEqual, including wallet address casing and key-order independence.
function specJson(value: unknown): string | undefined {
  return JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string' && ['token', 'marketplaceOwner', 'creatorFeeRecipient'].includes(key)) return v.toLowerCase();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return v;
  });
}

/**
 * One compact UTF-8 buffer for the list digest. Only one item's canonical string exists at a time; never stringify
 * the whole saved file/list for hashing. These schema fields are ASCII. viem's SHA-256 is browser safe.
 */
function listDigest(list: { format: string; n: string; items: readonly z.infer<typeof itemSchema>[] }, maxBytes?: number) {
  const prefix = `{"format":${JSON.stringify(list.format)},"items":[`;
  const suffix = `],"n":${JSON.stringify(list.n)}}`;
  let length = prefix.length + suffix.length + list.items.length - 1;
  for (const item of list.items) length += canonicalJson(item).length;
  checkReveal(maxBytes === undefined || length <= maxBytes, 'reveal list exceeds raw IPFS block limit');
  const bytes = new Uint8Array(length);
  const encoder = new TextEncoder();
  let offset = 0;
  const write = (text: string) => { offset += encoder.encodeInto(text, bytes.subarray(offset)).written; };
  write(prefix);
  list.items.forEach((item, index) => { if (index) write(','); write(canonicalJson(item)); });
  write(suffix);
  return sha256(bytes);
}

/** Internal unbound variant retained for the legacy Node reader, which reads chain state after parsing. */
export function validateOpenBoxSpecV2(input: unknown, options: { commitment?: OpenRevealCommitmentV2; maxListBytes?: number } = {}) {
  const file = fileSchema.parse(input);
  const spec = decodeBoxSpecV2(file.encoded as Hex);
  checkReveal(encodeBoxSpecV2(spec).toLowerCase() === file.encoded.toLowerCase(), 'noncanonical spec encoding');
  checkReveal(specJson(spec) === specJson(file.spec), 'displayed spec differs from encoded spec');
  checkReveal(keccak256(file.encoded as Hex) === file.specHash.toLowerCase(), 'spec hash mismatch');
  checkReveal(spec.artMode === 1, 'only open art may be published');
  checkReveal(spec.n > 0 && spec.n <= MAX_N && spec.firstId === 1n, 'app collection must use ids 1..N');
  if (options.commitment) {
    const expected = options.commitment;
    checkReveal(hash.parse(expected.root).toLowerCase() === spec.revealRoot.toLowerCase(), 'on-chain revealRoot mismatch');
    checkReveal(expected.size === undefined || expected.size === BigInt(spec.n), 'on-chain size mismatch');
    checkReveal(expected.firstId === undefined || expected.firstId === spec.firstId, 'on-chain firstId mismatch');
    checkReveal(expected.specHash === undefined || hash.parse(expected.specHash).toLowerCase() === file.specHash.toLowerCase(), 'on-chain specHash mismatch');
  }
  const raw = listSchema.parse(file.revealList);
  checkReveal(raw.n === String(spec.n), 'list size mismatch');
  checkReveal(raw.items.length === spec.n, 'incomplete reveal list');
  // Parse one row at a time. Own immutable rows, without copying their string bytes or cloning a full file.
  const list = Object.freeze({ format: raw.format, n: raw.n, items: Object.freeze(raw.items.map(item => Object.freeze(itemSchema.parse(item)))) });
  checkReveal(listDigest(list, options.maxListBytes) === spec.revealListId.toLowerCase(), 'list hash mismatch');
  const tree = buildBoxTree(list.items.map((item, i) => {
    checkReveal(item.id === String(i + 1), 'list ids must be ordered 1..N');
    return boxLeaf({ ...item, id: i + 1, traitsPacked: BigInt(item.traitsPacked) }, spec.n);
  }), spec.n);
  checkReveal(tree.root === spec.revealRoot.toLowerCase(), 'list root mismatch');
  return { spec, specHash: file.specHash, list, tree,
    // Only the CLI publishing path requests a complete string, for its unchanged reveal-list.json output.
    get revealListBytes() { return canonicalJson(list); },
  };
}
