/**
 * Optional paid AI artwork jobs (SH-011; C07; 01-PRODUCT Step 2 "request a priced AI job, approve previews"; 06 "optional
 * artwork service … server-side provider credentials stay server-side").
 *
 * The browser talks to an AI service only through this adapter. A real adapter would be a client of a server-side
 * broker that holds the provider credentials (ART-05): its configuration is a broker URL, never a key. Before anything
 * is charged, the broker must return an explicit quote — total, asset, expiry, failure and refund policy — and the
 * person approves that exact quote (ART-04). Generated images and attributes then go through the same pipeline as an
 * upload (processImage, parseAttributes), so model output cannot change financial configuration (ART-03) or start a
 * transaction (ART-06).
 *
 * No provider is configured in this build: `createUnconfiguredAiArtworkProvider` is the only adapter. It reports
 * "unavailable" and invents no price and no duration (REFERENCE_OVERRIDES: "$0.50 per image" and "~2 minutes" are
 * superseded; absent configuration shows unavailable).
 */
import { isAddress, isIsoTimestamp, isRawAmount, isZeroAddress, parseIsoTimestamp, type AssetIdentity, type RawAmount } from '@squarehole/domain';

export type AiProviderStatus =
  | { readonly state: 'unavailable'; readonly reason: 'not_configured' | 'provider_unavailable'; readonly message: string }
  | { readonly state: 'available'; readonly providerName: string };

export interface AiJobRequest {
  readonly prompt: string;
  readonly itemCount: number;
}

/** ART-04: what a person must see and approve before a paid job starts. */
export interface AiJobQuote {
  readonly quoteId: string;
  readonly providerName: string;
  readonly itemCount: number;
  /** The explicit total charge, in one asset, as a raw amount. */
  readonly price: { readonly asset: AssetIdentity; readonly totalRaw: RawAmount };
  readonly expiresAt: string;
  /** The provider's own estimate, or null. Never invented by the app. */
  readonly estimatedDuration: string | null;
  readonly failurePolicy: string;
  readonly refundPolicy: string;
}

export interface AiArtworkProvider {
  /** False when no broker is configured (this build). */
  readonly configured: boolean;
  status(signal?: AbortSignal): Promise<AiProviderStatus>;
  /** Rejects with `AiArtworkUnavailableError` when unavailable. A quote is never a charge. */
  requestQuote(request: AiJobRequest, signal?: AbortSignal): Promise<AiJobQuote>;
}

export class AiArtworkUnavailableError extends Error {
  readonly code = 'ai_unavailable';
  constructor(message = 'AI artwork generation is unavailable: no provider is configured.') {
    super(message);
    this.name = 'AiArtworkUnavailableError';
  }
}

const NOT_CONFIGURED_MESSAGE =
  'No AI artwork provider is configured for this demo, so there is no quote, no price and no time estimate, and nothing can be charged. Upload artwork you made elsewhere instead.';

/** The only adapter in this build: always unavailable, holds no configuration and no credential. */
export function createUnconfiguredAiArtworkProvider(): AiArtworkProvider {
  return Object.freeze({
    configured: false,
    async status(): Promise<AiProviderStatus> {
      return { state: 'unavailable', reason: 'not_configured', message: NOT_CONFIGURED_MESSAGE };
    },
    async requestQuote(): Promise<AiJobQuote> {
      throw new AiArtworkUnavailableError();
    },
  });
}

/** Paths of the problems that make a quote unusable at `now` (ISO time). Empty = the quote may be shown for approval. */
export function aiJobQuoteIssues(quote: AiJobQuote, now: string): string[] {
  const issues: string[] = [];
  if (typeof quote.quoteId !== 'string' || quote.quoteId.trim() === '') issues.push('quoteId');
  if (typeof quote.providerName !== 'string' || quote.providerName.trim() === '') issues.push('providerName');
  if (!Number.isSafeInteger(quote.itemCount) || quote.itemCount < 1) issues.push('itemCount');
  const asset = quote.price?.asset;
  if (!asset || !isAddress(asset.address) || isZeroAddress(asset.address) || !Number.isSafeInteger(asset.chainId) || asset.chainId < 1) {
    issues.push('price.asset');
  }
  if (!isRawAmount(quote.price?.totalRaw) || BigInt(quote.price.totalRaw) === 0n) issues.push('price.totalRaw');
  if (!isIsoTimestamp(quote.expiresAt) || !isIsoTimestamp(now) || parseIsoTimestamp(quote.expiresAt) <= parseIsoTimestamp(now)) issues.push('expiresAt');
  if (quote.estimatedDuration !== null && (typeof quote.estimatedDuration !== 'string' || quote.estimatedDuration.trim() === '')) {
    issues.push('estimatedDuration');
  }
  if (typeof quote.failurePolicy !== 'string' || quote.failurePolicy.trim() === '') issues.push('failurePolicy');
  if (typeof quote.refundPolicy !== 'string' || quote.refundPolicy.trim() === '') issues.push('refundPolicy');
  return issues;
}
