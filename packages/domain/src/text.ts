/**
 * Untrusted display text (names, tickers, descriptions, NFT attributes). Lengths count Unicode code points like
 * JSON Schema `maxLength`. Control characters and bidirectional overrides/isolates are rejected: they can hide or
 * reorder identity text (AGENTS.md "Security boundaries": tickers, names and images are not authority).
 */

// Matching control characters is the point of these two patterns.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const WHITESPACE = /\s/u;

export interface TextRule {
  min: number;
  max: number;
  /** Allow whitespace inside the value (names, descriptions). Tickers pass false. */
  innerSpaces: boolean;
  /** Allow "\n" (descriptions only). */
  newlines: boolean;
}

export const codePointLength = (value: string): number => [...value].length;

/** The first problem with `value` under `rule`, or null. Total: never throws, any input type accepted. */
export function textIssue(value: unknown, rule: TextRule): string | null {
  if (typeof value !== 'string') return 'must be a string';
  const length = codePointLength(value);
  if (length < rule.min || length > rule.max) return `must be ${rule.min}-${rule.max} characters`;
  if ((rule.newlines ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(value)) return 'must not contain control characters';
  if (BIDI.test(value)) return 'must not contain bidirectional override or isolate characters';
  if (length > 0 && value.trim().length === 0) return 'must not be only whitespace';
  if (value !== value.trim() && !rule.newlines) return 'must not start or end with whitespace';
  if (!rule.innerSpaces && WHITESPACE.test(value)) return 'must not contain whitespace';
  return null;
}
