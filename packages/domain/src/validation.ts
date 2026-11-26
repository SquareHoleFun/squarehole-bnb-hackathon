/**
 * Shared zod plumbing for the ADR-0008 validators. Guards return `GuardIssue`s (see guards.ts) and are reported
 * through `reportIssues`; parse helpers turn zod errors into ordered `ValidationIssue`s.
 */
import { z } from 'zod';
import { DECIMAL_AMOUNT_PATTERN, RAW_AMOUNT_PATTERN } from './amounts';
import { DataValidationError, type ValidationIssue } from './errors';
import type { GuardIssue } from './guards';
import { isAddress, isPairId } from './ids';
import type { SafeParseResult } from './schemas';
import { textIssue, type TextRule } from './text';
import { isIsoTimestamp } from './time';
import type { Address, PairId, TxHash } from './types';

/** Untrusted display text under `rule` (one issue at most). */
export const textField = (rule: TextRule) =>
  z.string().superRefine((value, ctx) => {
    const issue = textIssue(value, rule);
    if (issue !== null) ctx.addIssue({ code: 'custom', message: issue });
  });

export const addressField = z.string().refine(isAddress, 'must be a 0x-prefixed 20-byte hex address').transform((value) => value as Address);
export const txHashField = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex hash').transform((value) => value as TxHash);
export const pairIdField = z
  .string()
  .refine(isPairId, 'must be "<chainId>:<0x address>" with a positive chain id')
  .transform((value) => value as PairId);
export const rawAmountField = z.string().regex(RAW_AMOUNT_PATTERN, 'must be an unsigned decimal integer string');
export const decimalAmountField = z.string().regex(DECIMAL_AMOUNT_PATTERN, 'must be a non-negative decimal string');
export const isoTimestampField = z.string().refine(isIsoTimestamp, 'must be YYYY-MM-DDTHH:MM:SS[.mmm] with Z or ±HH:MM');
export const chainIdField = z.number().int().min(1);

export function reportIssues(ctx: z.RefinementCtx, issues: readonly GuardIssue[], prefix: readonly (string | number)[] = []): void {
  for (const issue of issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...prefix, ...issue.path] });
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

export function safeParseWith<T>(schema: z.ZodType<T>, input: unknown): SafeParseResult<T> {
  const result = schema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: issuesOf(result.error) };
}

/** Throws `DataValidationError` listing every issue. */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown, subject: string): T {
  const result = safeParseWith(schema, input);
  if (!result.ok) throw new DataValidationError(subject, result.issues);
  return result.value;
}

/** Guards are TOTAL: zod may run them on partially malformed values, so they check shapes before use. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
