/** Preserve the manifest's shape. Only the 35 listed model hashes can change on non-ARM platforms. */
export function reviewedManifestForPlatform<T>(id: string, reviewed: T, arch?: string): T;

interface ReviewedModels {
  items: Array<{ id: string; traits: { kind: string }; model: { sha256: string; bytes: number } }>;
}
/** Preserve exact recorded JSON formatting while translating only reviewed model hashes. */
export function reviewedJsonForPlatform(source: string, reviewed: ReviewedModels, arch?: string, hashPrefix?: '' | '0x'): string;
/** Reverse the four known zero signs in a copy of an Intel model. */
export function restoreReviewedNormalZeros(bytes: Buffer): Buffer;
/** Return bytes for strict comparison with an ARM sample, after checking the listed Intel hash. */
export function reviewedModelBytesForPlatform(name: string, bytes: Buffer, reviewed: ReviewedModels, arch?: string): Buffer;
