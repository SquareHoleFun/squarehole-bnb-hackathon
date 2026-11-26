// Offline, deterministic TS/Solidity differential corpus. Run from the repository root with Node 24.
import { writeFileSync, readFileSync } from 'node:fs';
import { loadBoxSpecLibrary } from '../../../../../../box-spec/scripts/lib/load-generated.mjs';

const lib = await loadBoxSpecLibrary();
const { BOX_0_MISFITS } = await import('../../../../../../box-spec/src/generated/fixtures.v1.ts');
let state = 0x5539b0n;
function random(n) {
  state ^= state << 13n;
  state ^= state >> 17n;
  state ^= state << 5n;
  state &= 0xffffffffn;
  return Number(state % BigInt(n)); // indexes and byte counts only; raw amounts below remain bigint
}
const pick = (xs) => xs[random(xs.length)];
const hash = () => `0x${Array.from({ length: 32 }, () => random(256).toString(16).padStart(2, '0')).join('')}`;
const zero = `0x${'00'.repeat(32)}`;
const addressZero = `0x${'00'.repeat(20)}`;
const text = (n) => String.fromCharCode(65 + random(26)).repeat(n);
const hex = (s) => `0x${Buffer.from(s).toString('hex')}`;
const descTable = (n) => `0x01${n.toString(16).padStart(4, '0')}${'41'.repeat(n)}00`;
const edition = (label, count) => ({ id: 3, params: lib.encodeEditionSpecialsParams({ label, count }) });
const placeholders = (key, value) => ({ id: 1, params: lib.encodePlaceholdersParams({
  placeholderName: 'P', placeholderSymbol: 'P', placeholderDescription: '', hiddenDescription: '', hiddenSvg: '<svg/>',
  [key]: value,
}) });

function make(i) {
  const s = structuredClone(BOX_0_MISFITS);
  s.version = pick([1, 2]);
  s.n = pick([10, 11, 9999, 10000, 10 + random(9991)]);
  s.deadlineDays = s.version === 1 ? 0 : pick([30, 60, 90, 180]);
  s.tokenName = text(1 + random(32));
  s.tokenSymbol = text(1 + random(11));
  s.collectionName = text(1 + random(32));
  s.collectionSymbol = text(1 + random(11));
  s.description = text(pick([0, 1, 31, 32, 33, 1023, 1024]));
  s.artMode = 1;
  s.revealRoot = hash();
  s.revealListId = hash();
  s.generatorHash = hash();
  s.coverSha256 = hash();
  s.collectionCoverSha256 = hash();
  s.metadataTable = descTable(pick([0, 1, 31, 32, 33, 255]));
  s.qStream = 2;
  s.tStream = 1;
  s.addOns = [];
  // Every fourth case stays valid. The others mutate a rotating boundary family with random near-limit choices.
  if (i % 4 === 0) return lib.toBoxSpecV1Bytes(s);
  const family = Math.floor(i / 4) % 48;
  switch (family) {
    case 0: s.version = pick([0, 1, 2, 3, 65535]); break;
    case 1: s.n = pick([0, 9, 10, 10000, 10001, 0xffffffff]); break;
    case 2: s.tokenName = text(pick([0, 1, 31, 32, 33])); break;
    case 3: s.tokenSymbol = text(pick([0, 1, 10, 11, 12])); break;
    case 4: s.collectionName = text(pick([0, 1, 31, 32, 33])); break;
    case 5: s.collectionSymbol = text(pick([0, 1, 10, 11, 12])); break;
    case 6: s.description = text(pick([0, 1, 1023, 1024, 1025])); break;
    case 7: s.firstId = pick([0n, 1n, 2n, (1n << 256n) - 1n]); break;
    case 8: s.raise += pick([-1n, 0n, 1n]); break;
    case 9: s.q = pick([addressZero, `0x${'01'.repeat(20)}`]); break;
    case 10: s.boxType = pick([0, 1, 2, 3, 4, 255]); break;
    case 11: s.layout = pick([0, 1, 2, 255]); break;
    case 12: s.gradLayout = pick([0, 1, 2, 3, 255]); break;
    case 13: s.launchFormat = pick([0, 1, 2, 255]); break;
    case 14: s.openAt = pick([0, 1, 1788220799, 1788220800, 1788220801, 0xffffffff]); break;
    case 15: s.deadlineDays = pick([0, 29, 30, 60, 90, 180, 181, 65535]); break;
    case 16: s.qStream = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]); break;
    case 17: s.tStream = pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 255]); break;
    case 18: s.artMode = pick([0, 1, 2, 3, 255]); break;
    case 19: s[pick(['revealRoot', 'revealListId', 'coverSha256', 'collectionCoverSha256'])] = zero; break;
    case 20: s[pick(['marketplaceOwner', 'creatorFeeRecipient'])] = pick([addressZero, `0x${'12'.repeat(20)}`]); break;
    case 21: s.creatorBuy = pick([0n, 1n, s.raise - 1n, s.raise, s.raise + 1n, (1n << 256n) - 1n]); break;
    case 22: s.metadataTable = pick(['0x', descTable(24570), descTable(24571), descTable(24572), '0x01000011', '0x01000000ff']); break;
    case 23: s.metadataTable = `0x010001${pick(['00', '1f', '20', '22', '5c', '7e', '7f', '80', 'ff'])}00`; break;
    case 24: s.addOns = Array.from({ length: pick([0, 1, 7, 8, 9]) }, () => edition('X', 1)); break;
    case 25: s.addOns = [edition(text(pick([0, 1, 31, 32, 33])), pick([0, 1, s.n, s.n + 1, 0xffffffff]))]; break;
    case 26: s.addOns = [{ id: pick([0, 7, 65535]), params: '0x' }]; break;
    case 27: s.addOns = [{ id: 4, params: lib.encodeRoyaltiesParams({ bps: pick([0, 99, 100, 250, 500, 501, 65535]), destination: pick([0, 1, 2, 3, 4, 255]) }) }]; break;
    case 28: s.artMode = 2; s.revealListId = zero; s.addOns = [placeholders('hiddenSvg', text(pick([0, 1, 4095, 4096, 4097])))]; break;
    case 29: s.artMode = 2; s.revealListId = zero; s.addOns = [placeholders('hiddenDescription', text(pick([0, 1, 1023, 1024, 1025])))]; break;
    case 30: s.artMode = 2; s.revealListId = zero; s.addOns = [placeholders('placeholderName', text(pick([0, 1, 32, 33])))]; break;
    case 31: s.artMode = 2; s.revealListId = zero; s.addOns = [placeholders('placeholderSymbol', text(pick([0, 1, 11, 12])))]; break;
    case 32: s.artMode = 2; s.revealListId = zero; s.addOns = [placeholders('placeholderDescription', text(pick([0, 1, 1024, 1025])))]; break;
    case 33: s.addOns = [{ id: 6, params: lib.encodeCollectionMetadataParams({ bannerSha256: zero, teaserSha256s: Array.from({ length: pick([0, 1, 4, 5]) }, hash), externalLink: 'https://' + text(pick([0, 119, 120, 121])) }) }]; break;
    case 34: s.addOns = [{ id: 5, params: lib.encodeCreatorFeeCapParams({ capPerEpoch: pick([0n, 1n, 1_000_000_000_000_000_000n]), excess: pick([0, 1, 2, 3, 4, 255]) }) }]; break;
    case 35: s.addOns = [edition('Z', 1), { id: 2, params: '0x' }]; break;
    case 36: s.addOns = [{ id: pick([1, 2, 3, 4, 5, 6]), params: pick(['0x', '0xff', `0x${'00'.repeat(32)}`, `${edition('X', 1).params}00`]) }]; break;
    case 37: s.addOns = [{ id: 2, params: pick(['0x', '0x00']) }]; s.tStream = 4; break;
    case 38: {
      const b = lib.toBoxSpecV1Bytes(s);
      b[pick(['tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description'])] = pick(['0x00', '0x09', '0x1f', '0x22', '0x5c', '0x7f', '0x80', '0xff', hex('~')]);
      return b;
    }
    case 39: s.addOns = [{ id: 6, params: lib.encodeCollectionMetadataParams({ bannerSha256: hash(), teaserSha256s: [pick([zero, hash()])], externalLink: pick(['', 'https://ok', 'http://bad', 'https://"', 'https://\\', 'https://é']) }) }]; break;
    case 40: s.metadataTable = `0x010000${pick([0, 1, 15, 16, 17]).toString(16).padStart(2, '0')}`; {
      const types = parseInt(s.metadataTable.slice(-2), 16);
      s.metadataTable += '0141010141'.repeat(types);
      break;
    }
    case 41: {
      const length = pick([0, 1, 254, 255]);
      s.metadataTable = `0x01000001${length.toString(16).padStart(2, '0')}${'41'.repeat(length)}010141`;
      break;
    }
    case 42: {
      const count = pick([0, 1, 254, 255]);
      s.metadataTable = `0x010000010141${count.toString(16).padStart(2, '0')}${'0141'.repeat(count)}`;
      break;
    }
    case 43: {
      const length = pick([0, 1, 254, 255]);
      s.metadataTable = `0x01000001014101${length.toString(16).padStart(2, '0')}${'41'.repeat(length)}`;
      break;
    }
    case 44: {
      s.version = 2; s.deadlineDays = 30; s.qStream = 5; s.creatorFeeRecipient = s.marketplaceOwner;
      const capPerEpoch = pick([1n, 4n, 8n, 16n, 32n]) * 10n ** 18n + pick([-1n, 0n, 1n]);
      s.addOns = [{ id: 5, params: lib.encodeCreatorFeeCapParams({ capPerEpoch, excess: pick([1, 2, 3]) }) }];
      break;
    }
    case 45: {
      s.version = 2; s.deadlineDays = 30; s.boxType = 3;
      s.n = pick([0, 1]); s.collectionName = ''; s.collectionSymbol = '';
      s.artMode = 0; s.revealRoot = zero; s.revealListId = zero; s.generatorHash = zero;
      s.metadataTable = '0x'; s.collectionCoverSha256 = zero; s.marketplaceOwner = addressZero;
      break;
    }
    case 46: s.metadataTable = pick(['0x00', '0x01', '0x0100', '0x010000', '0x02000000', '0x01ffff00']); break;
    case 47: {
      s.version = 2; s.deadlineDays = 30; s.qStream = pick([5, 6]); s.tStream = pick([5, 6]);
      s.creatorFeeRecipient = s.marketplaceOwner;
      s.creatorBuy = pick([0n, 1n, s.raise - 1n, s.raise, s.raise + 1n]);
      break;
    }
  }
  return lib.toBoxSpecV1Bytes(s);
}

// RLE packet: high bit => repeat next byte (low 7 bits + 1 times); otherwise copy that many literal bytes.
// Compression preserves the complete canonical ABI encoding, including invalid string bytes.
function compress(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    let n = 1;
    while (n < 128 && i + n < input.length && input[i + n] === input[i]) n++;
    if (n >= 3) { out.push(128 + n - 1, input[i]); i += n; continue; }
    const start = i++;
    while (i - start < 128 && i < input.length && !(input[i] === input[i + 1] && input[i] === input[i + 2])) i++;
    out.push(i - start - 1, ...input.subarray(start, i));
  }
  return Buffer.from(out);
}
function uint(x, size) { return Buffer.from(BigInt(x).toString(16).padStart(size * 2, '0'), 'hex'); }
const batches = [];
let accepted = 0;
const reasonCounts = {};
const unique = new Set();
for (let batch = 0; batch < 32; batch++) {
  const rows = [];
  for (let j = 0; j < 64; j++) {
    const s = make(batch * 64 + j);
    const encoded = lib.encodeBoxSpecV1Bytes(s);
    const { reason, field } = lib.validateBoxSpecV1Bytes(s, s.version === 2 ? lib.CONTEXT_V2 : lib.CONTEXT_V1);
    const specHash = lib.specHashOfEncoded(encoded);
    if (reason === 0) accepted++;
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    unique.add(specHash);
    const raw = Buffer.from(encoded.slice(2), 'hex');
    const packed = compress(raw);
    rows.push(Buffer.concat([uint(reason, 2), uint(field, 2), Buffer.from(specHash.slice(2), 'hex'), uint(raw.length, 3), uint(packed.length, 3), packed]));
  }
  batches.push(Buffer.concat(rows).toString('hex'));
}
if (unique.size !== 2048 || accepted < 512 || accepted > 1800) throw new Error('corpus diversity check failed');
for (let reason = 0; reason <= 20; reason++) if (!reasonCounts[reason]) throw new Error(`reason ${reason} absent`);
const output = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
// GENERATED by gen/AuditU9LaneGenerate.mjs; seed 0x5539b0; 2048 distinct specs; ${accepted} valid.
// Complete ABI specs stored in RLE form with TS verdict (reason, field) and canonical specHash.
abstract contract AuditU9LaneVectorsData {
    function _batch(uint256 index) internal pure returns (bytes memory) {
${batches.map((b, i) => `        if (index == ${i}) return hex"${b}";`).join('\n')}
        revert("batch out of range");
    }
}
`;
const target = new URL('../AuditU9LaneVectorsData.sol', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('generated vectors are stale');
} else writeFileSync(target, output);
process.stdout.write(`${JSON.stringify({ seed: '0x5539b0', count: unique.size, accepted, refused: 2048 - accepted, reasonCounts, bytes: Buffer.byteLength(output) })}\n`);
