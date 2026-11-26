// Safe artwork and metadata processing (SH-010) and the optional paid AI job adapter (SH-011); 06-ARCHITECTURE
// "packages/artwork/". Framework-free: the browser codec (createImageBitmap + canvas) lives in apps/web.
export { ACCEPTED_IMAGE_TYPES, ATTRIBUTE_LIMITS, DEMO_MAX_ITEMS, IMAGE_LIMITS, MAX_ITEM_ID } from './limits';
export {
  inspectImage,
  rejectionMessage,
  type ImageAccepted,
  type ImageFormat,
  type ImageInspection,
  type ImageLimits,
  type ImageMediaType,
  type ImageRejected,
  type ImageRejectionCode,
} from './sniff';
export {
  processImage,
  type DecodedImage,
  type ImageCodec,
  type ImageSource,
  type PipelineRejectionCode,
  type ProcessOptions,
  type ProcessResult,
  type ProcessedImage,
} from './pipeline';
export {
  checkCollection,
  compactIdRanges,
  itemIdFromFileName,
  normaliseItemId,
  type CollectionCheckInput,
  type CollectionImageRef,
  type CollectionReport,
  type ItemIdResult,
} from './collection';
export { parseAttributes, type Attribute, type AttributesOptions, type AttributesResult } from './attributes';
export { keccak256Hex, type Hex32 } from './hash';
export {
  MAX_RAW_BLOCK_BYTES,
  MISFITS_COUNT,
  MISFITS_MAX_GENESIS_TABLE_BYTES,
  MISFITS_MAX_TRAIT_TYPES,
  MISFITS_TABLE_VERSION,
  MISFITS_TREE_DEPTH,
  base32Lower,
  buildMisfitsTree,
  encodeLeafPreimage,
  encodeMetadataTable,
  generatorHashFromGitTree,
  glbSha256,
  misfitLeaf,
  packTraits,
  rawCidV1,
  sha256Hex,
  unpackTraits,
  verifyMisfitProof,
  type MetadataTable,
  type MisfitEntry,
  type MisfitsTree,
} from './misfits-commitment';
export {
  BOX_MAX_TABLE_BYTES,
  BOX_TREE_MAX_ITEMS,
  boxLeaf,
  boxTreeDepth,
  buildBoxTree,
  encodeBoxLeafPreimage,
  encodeBoxMetadataTable,
  verifyBoxProof,
  type BoxLeafEntry,
  type BoxTree,
} from './box-commitment';
export {
  MANIFEST_FORMAT,
  buildMetadataManifest,
  canonicalJson,
  manifestHash,
  type CanonicalValue,
  type ManifestImage,
  type ManifestItemInput,
  type MetadataManifest,
  type MetadataManifestInput,
} from './manifest';
export {
  AiArtworkUnavailableError,
  aiJobQuoteIssues,
  createUnconfiguredAiArtworkProvider,
  type AiArtworkProvider,
  type AiJobQuote,
  type AiJobRequest,
  type AiProviderStatus,
} from './ai-jobs';
