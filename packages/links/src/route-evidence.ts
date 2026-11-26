/**
 * Route evidence records (`squarehole.route-evidence/v1`, ADR-0012; EXT-05). A route may become `available` only
 * when a recorded external transaction test says it passed for the EXACT chain, token and quote. This module defines
 * the file format and a strict loader; the repository ships no evidence file (no route has been tested).
 *
 * A record documents one test of one route template (e.g. `SEP-UNI-SWAP-BUY`) against one pair: the frontend build,
 * whether Uniswap's Testnet mode was on, the Universal Router version and address, the transaction hashes and the
 * evidence document (docs/evidence/…). A `fail` record never enables anything; it is kept as history.
 */
import { isAddress, isIsoTimestamp, parseIsoTimestamp, sameAddress, type Address, type TxHash } from '@squarehole/domain';
import { z } from 'zod';

export const ROUTE_EVIDENCE_SCHEMA = 'squarehole.route-evidence/v1';

const address = z.string().refine(isAddress, 'must be a 0x-prefixed 20-byte address').transform((value) => value as Address);
const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte transaction hash')
  .transform((value) => value as TxHash);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value');
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u.test(value), 'no control or bidi characters');

const recordSchema = z
  .strictObject({
    schema: z.literal(ROUTE_EVIDENCE_SCHEMA),
    /** Route template id from the route research, e.g. SEP-UNI-SWAP-BUY. */
    routeId: z.string().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'must be a route template id'),
    chainId: z.number().int().min(1),
    providerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(['execution', 'discovery', 'explorer']),
    token: address,
    quote: address,
    poolId: bytes32,
    result: z.enum(['pass', 'fail']),
    testedAt: z.string().refine(isIsoTimestamp, 'must be an ISO timestamp'),
    /** Role of the tester (never a name or handle), e.g. "founder" or "integration lead". */
    testedBy: text(64),
    frontend: z.strictObject({
      build: text(120),
      testnetMode: z.boolean().nullable(),
      universalRouterVersion: text(16).nullable(),
      routerAddress: address.nullable(),
    }),
    transactions: z.array(txHash).max(50),
    /** Repository path of the evidence document. */
    evidenceRecord: z.string().regex(/^docs\/evidence\/[A-Za-z0-9._/-]+\.md$/, 'must be a docs/evidence/*.md path'),
    notes: text(1000).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.result === 'pass' && record.transactions.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['transactions'], message: 'a passing test records its transactions' });
    }
    if (record.result === 'pass' && record.chainId === 11_155_111 && record.providerId === 'uniswap-web' && record.frontend.testnetMode !== true) {
      ctx.addIssue({ code: 'custom', path: ['frontend', 'testnetMode'], message: 'a Sepolia Uniswap pass must record Testnet mode on' });
    }
    if (sameAddress(record.token, record.quote)) ctx.addIssue({ code: 'custom', path: ['quote'], message: 'token and quote differ' });
  });

export type RouteEvidenceRecord = z.output<typeof recordSchema>;

/** Strict parse of one evidence record. Throws with the first problems listed. */
export function parseRouteEvidence(input: unknown): RouteEvidenceRecord {
  const result = recordSchema.safeParse(input);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid route evidence record: ${summary}`);
  }
  return result.data;
}

export interface LoadedRouteEvidence {
  readonly records: readonly RouteEvidenceRecord[];
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
}

/** Loads many records (e.g. every JSON under a reviewed evidence directory); invalid ones are reported, never used. */
export function loadRouteEvidence(inputs: readonly unknown[]): LoadedRouteEvidence {
  const records: RouteEvidenceRecord[] = [];
  const rejected: { index: number; reason: string }[] = [];
  inputs.forEach((input, index) => {
    try {
      records.push(parseRouteEvidence(input));
    } catch (error) {
      rejected.push({ index, reason: error instanceof Error ? error.message : 'invalid' });
    }
  });
  return { records: Object.freeze(records), rejected: Object.freeze(rejected) };
}

/**
 * The newest PASSING record for exactly this route, chain, token and quote, or null. A link that names a pool (DEX
 * Screener's page of one v4 pool id) passes `pair.poolId` too: then the record must have tested that same pool, since
 * anyone can create a copy pool of the same token and quote.
 */
export function passingEvidenceFor(
  records: readonly RouteEvidenceRecord[],
  route: { readonly routeId: string; readonly chainId: number; readonly providerId: string; readonly kind: string },
  pair: { readonly token: string; readonly quote: string; readonly poolId?: string },
): RouteEvidenceRecord | null {
  const poolId = pair.poolId?.toLowerCase();
  const matching = records.filter(
    (record) =>
      record.result === 'pass' &&
      record.routeId === route.routeId &&
      record.chainId === route.chainId &&
      record.providerId === route.providerId &&
      record.kind === route.kind &&
      sameAddress(record.token, pair.token) &&
      sameAddress(record.quote, pair.quote) &&
      (poolId === undefined || record.poolId.toLowerCase() === poolId),
  );
  return matching.sort((a, b) => parseIsoTimestamp(b.testedAt) - parseIsoTimestamp(a.testedAt))[0] ?? null;
}
