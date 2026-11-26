import { z } from 'zod';
import { INBOX_CLAIM_NOTICE_V21 } from './inbox-v21';

const address = z.string().regex(/^0x[0-9a-f]{40}$/i).transform(s => s.toLowerCase() as `0x${string}`);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i).transform(s => s.toLowerCase() as `0x${string}`);
const raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(s => BigInt(s) < 2n ** 256n);
export const claimsAsOfSchemaV2 = z.object({ block: raw, hash, timestamp: raw, tier: z.literal('head') }).strict();
const payment = z.object({ block: raw, hash, txHash: hash, logIndex: z.number().int().nonnegative(), to: address, grossP: raw, tipP: raw }).strict();
/** Legacy P-suffixed amounts use raw units of asset; v2.1 holder/item rows may identify own T. */
const common = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(['claimable', 'pending', 'claimed']),
  wallet: address,
  box: z.object({ registry: address, boxId: raw, token: address }).strict(),
  roleAddress: address, asset: address, amountP: raw.nullable(),
  asOf: claimsAsOfSchemaV2,
  payout: z.enum(['unverified', 'available', 'unavailable', 'not_ready', 'paid']),
  payment: payment.nullable(),
});
const nullableRaw = raw.nullable();
/**
 * The P waiting in the inbox that a failed box's claim first moves into the pot. RC6-RR-INBOX: on a final holder share
 * or no-buyer creator row that P is part of the quoted amount, conditional on its intake. SH-RC7 item 29: such a row is
 * always priced; the merged coordinator quotes the final share with the inbox's readable P, so an unpriced one is refused.
 */
const collectFirst = z.object({ pendingP: raw.refine(s => BigInt(s) > 0n), message: z.literal(INBOX_CLAIM_NOTICE_V21) }).strict();
export const walletClaimSchemaV2 = z.discriminatedUnion('kind', [
  common.extend({ kind: z.literal('holder'), batchId: raw }).strict(),
  common.extend({ kind: z.literal('item'), itemId: raw, outsideP: nullableRaw, stashP: nullableRaw }).strict(),
  common.extend({ kind: z.literal('creator') }).strict(),
  common.extend({ kind: z.literal('no_buyer'), coinsT: z.literal('0'), pot: nullableRaw, collectFirst: collectFirst.optional() }).strict(),
  common.extend({ kind: z.literal('failure'), coinsT: raw, allowanceT: nullableRaw, pot: nullableRaw, tLeft: nullableRaw,
    collectFirst: collectFirst.optional(),
  }).strict(),
]).superRefine((row, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (row.kind === 'failure' && row.collectFirst) {
    if (row.status === 'claimed' || row.coinsT === '0' || row.coinsT !== row.tLeft || row.pot === null) bad('collect-first requires the final holder share');
    else if (row.amountP === null) bad('a collect-first final share carries its price');
    else if (BigInt(row.amountP) > BigInt(row.pot) + BigInt(row.collectFirst.pendingP)) bad('a priced final share cannot exceed its pot plus the inbox P');
  }
  if (row.kind === 'no_buyer' && row.collectFirst && (row.status !== 'claimable' || row.amountP === null || BigInt(row.amountP) < BigInt(row.collectFirst.pendingP))) {
    bad('a creator remainder includes the inbox P it names');
  }
  if (row.status === 'claimed') {
    if (!row.payment || row.payout !== 'paid' || row.amountP === null) bad('claimed requires a payment receipt');
    else {
      if (BigInt(row.payment.block) > BigInt(row.asOf.block)) bad('payment is after the snapshot');
      if (BigInt(row.payment.grossP) - BigInt(row.payment.tipP) !== BigInt(row.amountP)) bad('payment does not conserve its asset');
    }
  } else {
    if (row.payment !== null || row.payout === 'paid') bad('unpaid claim has a payment receipt');
    if (row.status === 'pending' ? row.amountP !== null || row.payout !== 'not_ready' : row.amountP === null || row.payout === 'not_ready') bad('claim amount disagrees with status');
  }
});
export const walletClaimsPageSchemaV2 = z.object({
  schema: z.literal('sh.core-claims.v2'), chainId: z.number().int().positive(), wallet: address,
  asOf: claimsAsOfSchemaV2, recentFromBlock: raw,
  items: z.array(walletClaimSchemaV2).max(100), next: z.string().min(1).max(2048).nullable(),
}).strict().superRefine((page, ctx) => {
  const ids = new Set<string>();
  for (const row of page.items) {
    if (row.wallet !== page.wallet || JSON.stringify(row.asOf) !== JSON.stringify(page.asOf)) ctx.addIssue({ code: 'custom', message: 'claim wallet or snapshot mismatch' });
    if (ids.has(row.id)) ctx.addIssue({ code: 'custom', message: 'duplicate claim' });
    ids.add(row.id);
  }
  if (BigInt(page.recentFromBlock) > BigInt(page.asOf.block)) ctx.addIssue({ code: 'custom', message: 'invalid payment window' });
});
export type ClaimsAsOfV2 = z.infer<typeof claimsAsOfSchemaV2>;
export type WalletClaimV2 = z.infer<typeof walletClaimSchemaV2>;
export type WalletClaimsPageV2 = z.infer<typeof walletClaimsPageSchemaV2>;
