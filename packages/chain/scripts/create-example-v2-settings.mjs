import './register-ts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';
const { decodeBoxSpecV2, encodeBoxSpecV2, validateBoxSpecV2, MAX_N } = await import('../../box-spec/src/generated/box-spec.v2.ts');
const { pileConfigV2 } = await import('../src/core/v2/m3-spec-v2.ts');
const { glbSha256, MAX_RAW_BLOCK_BYTES } = await import('../../artwork/src/misfits-commitment.ts');
const { canonicalJson } = await import('../../artwork/src/manifest.ts');
const stringify = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
const sha = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
/** R74-ART: the serving type of a model entry (Create's Download BoxSpec, `apps/web/src/features/create/art-files.ts` MODEL_TYPE). */
const MODEL_TYPE = 'model/gltf-binary';
/** The longest base64 of one raw block: a longer string is refused before it is decoded. */
const MAX_BLOCK_BASE64 = Math.ceil(MAX_RAW_BLOCK_BYTES / 3) * 4;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const HASH = /^0x[0-9a-f]{64}$/;

/**
 * R74-ART (SH-CREATE-ITEM-MODELS): a 3D collection's GLBs, as Create's Download BoxSpec and the kit builder write them
 * (`models`, between `pictures` and `revealList`; absent without models, as in every older file). Each entry is typed
 * `model/gltf-binary`, its base64 canonical and at most one raw block (checked before decoding), its bytes a
 * self-contained binary glTF 2.0 file whose sha256 is the one given (artwork `glbSha256`, the site viewer's rules), and
 * each model once. Returns their sha256s.
 */
function readModels(models) {
  if (models === undefined) return new Set();
  assert.ok(Array.isArray(models) && models.length > 0 && models.length <= MAX_N, 'settings models');
  const seen = new Set();
  for (const m of models) {
    assert.ok(m !== null && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).every(k => ['type', 'sha256', 'base64'].includes(k)), 'settings fields must be public');
    assert.equal(m.type, MODEL_TYPE, 'settings model type');
    assert.ok(typeof m.sha256 === 'string' && HASH.test(m.sha256), 'settings model hash');
    assert.ok(typeof m.base64 === 'string' && m.base64.length <= MAX_BLOCK_BASE64, 'settings model size');
    const bytes = Buffer.from(m.base64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= MAX_RAW_BLOCK_BYTES, 'settings model size');
    assert.equal(bytes.toString('base64'), m.base64, 'settings model base64');
    let checked;
    try { checked = glbSha256(bytes); } catch { assert.fail('settings model must be a self-contained GLB'); }
    assert.equal(checked, m.sha256, 'settings model hash');
    assert.ok(!seen.has(m.sha256), 'settings model repeated');
    seen.add(m.sha256);
  }
  return seen;
}

export function readExampleSettings(text) {
  const s = JSON.parse(text);
  assert.ok(Object.keys(s).every(k => ['format', 'specHash', 'encoded', 'spec', 'pictures', 'models', 'revealList'].includes(k)), 'settings fields must be public');
  assert.equal(s.format, 'squarehole.boxspec/2', 'settings format');
  assert.ok(!s.demo, 'settings must not be a demo');
  assert.equal(keccak256(s.encoded), s.specHash, 'settings hash');
  const spec = decodeBoxSpecV2(s.encoded);
  assert.equal(encodeBoxSpecV2(spec), s.encoded, 'canonical settings encoding');
  assert.deepEqual(JSON.parse(stringify(spec)), s.spec, 'settings JSON and ABI disagree');
  assert.ok(Array.isArray(s.pictures), 'settings pictures required');
  for (const p of s.pictures) {
    assert.ok(Object.keys(p).every(k => ['role', 'sha256', 'base64'].includes(k)), 'settings fields must be public');
    assert.ok(['logo', 'collection cover', 'banner', 'teaser', 'item'].includes(p.role), 'settings picture role');
    assert.equal(typeof p.base64, 'string', 'settings picture bytes');
    const bytes = Buffer.from(p.base64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 1_048_576, 'settings picture size');
    assert.equal(bytes.toString('base64'), p.base64, 'settings picture base64');
    assert.equal(sha(bytes), p.sha256, 'settings picture hash');
  }
  assert.ok(s.pictures.some(p => p.role === 'logo' && p.sha256 === spec.coverSha256), 'settings logo missing');
  if (spec.boxType === 1) assert.ok(s.pictures.some(p => p.role === 'collection cover' && p.sha256 === spec.collectionCoverSha256), 'settings collection cover missing');
  const models = readModels(s.models);
  if (spec.artMode === 2) {
    assert.equal(s.revealList, null, 'hidden settings must not publish the reveal');
    assert.ok(s.pictures.every(p => p.role !== 'item'), 'hidden settings must not publish item pictures');
    assert.equal(models.size, 0, 'hidden settings must not publish item models');
  }
  // R74-ART: open art's public list, when the file has it, is the one its spec commits (revealListId), and the file carries
  // exactly the models that list names (none for 2D art), so every nonzero model hash can be published and revealed.
  // Without that list a file carries no models.
  const list = spec.artMode === 1 && s.revealList !== null && s.revealList !== undefined ? s.revealList : null;
  if (list !== null) {
    assert.ok(typeof list === 'object' && !Array.isArray(list) && Array.isArray(list.items), 'settings reveal list');
    assert.equal(sha(Buffer.from(canonicalJson(list))), spec.revealListId.toLowerCase(), 'settings reveal list hash');
    assert.ok(list.items.every(item => item !== null && typeof item === 'object' && typeof item.modelSha256 === 'string' && /^0x[0-9a-fA-F]{64}$/.test(item.modelSha256)), 'settings reveal list models');
  }
  const listed = new Set((list?.items ?? []).map(item => item.modelSha256.toLowerCase()).filter(hash => hash !== ZERO_HASH));
  assert.ok(listed.size === models.size && [...listed].every(hash => models.has(hash)), 'settings models must be the reveal list’s');
  return spec;
}


export function assertRecipeSettings(spec, expected, listing) {
  // L1 owns text, processed pictures, opening and their commitments; recipe economics must survive its serializer.
  for (const key of ['boxType', 'pricing', 'raise', 'tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'n', 'firstId', 'layout', 'gradLayout', 'launchFormat', 'deadlineDays',
    'buyers', 'sellers', 'artMode', 'creatorBuy', 'marketplaceOwner', 'creatorFeeRecipient', 'pickFeeBps']) {
    assert.deepEqual(spec[key], expected[key], `settings recipe mismatch: ${key}`);
  }
  for (const addon of expected.addOns) {
    const actual = spec.addOns.find(a => a.id === addon.id);
    // Placeholder copy and SVG are L1's public art, like the description and picture hashes.
    if (addon.id === 1) assert.ok(actual, 'settings placeholder required');
    else assert.deepEqual(actual, addon, `settings add-on ${addon.id}`);
  }
  if (spec.boxType === 5) assert.deepEqual(pileConfigV2(spec.contentsParams), pileConfigV2(expected.contentsParams), 'settings pile');
  else assert.equal(spec.contentsParams, expected.contentsParams, 'settings contents');
  assert.ok(spec.addOns.every(a => expected.addOns.some(e => e.id === a.id) || a.id === 6), 'unexpected settings add-on');
  assert.equal(validateBoxSpecV2(spec, { listing }).reason, 0, 'invalid final settings');
}
