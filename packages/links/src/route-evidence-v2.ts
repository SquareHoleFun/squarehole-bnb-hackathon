/**
 * Route evidence per TEMPLATE and Q CLASS (`squarehole.route-evidence/v2`, S10a § 6; BC-070's rule, BC-099): one
 * recorded external test of a route (e.g. `BOX-SEP-UNI`) on one box of a template priced in one Q class covers every box
 * of that template and Q class: a new box needs no record of its own. The tested box's token, quote and pool stay in
 * the record as its example. A `fail` record never enables anything. v1 records (`squarehole.route-evidence/v1`, per
 * exact pair) keep their own loader (route-evidence.ts). The repository ships no record (no route has been tested; BC-070
 * in S0, the Sepolia life run BC-071).
 */
import { isAddress, isIsoTimestamp, parseIsoTimestamp, type Address, type TxHash } from '@squarehole/domain';
import { z } from 'zod';

export const ROUTE_EVIDENCE_V2_SCHEMA = 'squarehole.route-evidence/v2';

const address = z.string().refine(isAddress, 'must be a 0x-prefixed 20-byte address').transform((value) => value as Address);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value');
const txHash = bytes32.transform((value) => value as TxHash);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u.test(value), 'no control or bidi characters');

const recordSchema = z
  .strictObject({
    schema: z.literal(ROUTE_EVIDENCE_V2_SCHEMA),
    routeId: z.string().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'must be a route template id'),
    chainId: z.number().int().min(1),
    providerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(['execution', 'discovery', 'explorer']),
    /** The factory's template id (BC-013) the route was tested on. */
    templateId: bytes32,
    qClass: z.enum(['NATIVE_ETH', 'ERC20', 'FIT', 'BOX_T']),
    /** The box the test used (its token, quote and pool), kept as the example. */
    example: z.strictObject({ token: address, quote: address, poolId: bytes32 }),
    result: z.enum(['pass', 'fail']),
    testedAt: z.string().refine(isIsoTimestamp, 'must be an ISO timestamp'),
    testedBy: text(64),
    frontend: z.strictObject({ build: text(120), testnetMode: z.boolean().nullable(), universalRouterVersion: text(16).nullable(), routerAddress: address.nullable() }),
    transactions: z.array(txHash).max(50),
    evidenceRecord: z.string().regex(/^docs\/evidence\/[A-Za-z0-9._/-]+\.md$/, 'must be a docs/evidence/*.md path'),
    notes: text(1000).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.result === 'pass' && record.transactions.length === 0) ctx.addIssue({ code: 'custom', path: ['transactions'], message: 'a passing test records its transactions' });
    if (record.result === 'pass' && record.chainId === 11_155_111 && record.providerId === 'uniswap-web' && record.frontend.testnetMode !== true) {
      ctx.addIssue({ code: 'custom', path: ['frontend', 'testnetMode'], message: 'a Sepolia Uniswap pass must record Testnet mode on' });
    }
  });

export type RouteEvidenceV2 = z.output<typeof recordSchema>;

export function parseRouteEvidenceV2(input: unknown): RouteEvidenceV2 {
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

/** The newest PASSING record for this route, chain, provider and kind, and this template and Q class; or null. */
export function passingEvidenceV2(
  records: readonly RouteEvidenceV2[],
  route: { readonly routeId: string; readonly chainId: number; readonly providerId: string; readonly kind: string },
  box: { readonly templateId: string; readonly qClass: string },
): RouteEvidenceV2 | null {
  const matching = records.filter(
    (r) =>
      r.result === 'pass' &&
      r.routeId === route.routeId &&
      r.chainId === route.chainId &&
      r.providerId === route.providerId &&
      r.kind === route.kind &&
      r.templateId.toLowerCase() === box.templateId.toLowerCase() &&
      r.qClass === box.qClass,
  );
  return matching.sort((a, b) => parseIsoTimestamp(b.testedAt) - parseIsoTimestamp(a.testedAt))[0] ?? null;
}
