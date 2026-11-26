import { isCreateOptionKey, type CreateOptionKey } from './keys';

export const CREATE_OPTIONS_MAX_BYTES = 32 * 1024;
export const CREATE_OPTIONS_MAX_ENTRIES = 128;
export const CREATE_OPTIONS_MAX_KEY_LENGTH = 96;
export const CANONICAL_ADDRESS = /^0x[0-9a-f]{40}(?![\s\S])/;
const HASH = /^0x[0-9a-f]{64}(?![\s\S])/;

export interface CreateOptionsRelease {
  readonly chainId: number;
  readonly factory: string;
  readonly registry: string;
  readonly versionCodeHash: string;
}
export interface CreateOptionsDocument extends CreateOptionsRelease {
  readonly schema: 1;
  readonly revision: number;
  readonly off: readonly { readonly key: CreateOptionKey; readonly issueId?: string }[];
}
export type CreateOptionsParseResult =
  | { readonly ok: true; readonly document: CreateOptionsDocument }
  | { readonly ok: false; readonly reason: string };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const refuse = (reason: string): CreateOptionsParseResult => ({ ok: false, reason });

/** Parse the whole decoded UTF-8 body. Missing keys mean on only after this succeeds for the intended release. */
export function parseCreateOptions(text: string, expected?: CreateOptionsRelease): CreateOptionsParseResult {
  // Fast length guard also avoids allocating for arbitrarily large input. TextEncoder is a browser API.
  if (text.length > CREATE_OPTIONS_MAX_BYTES || new TextEncoder().encode(text).length > CREATE_OPTIONS_MAX_BYTES) return refuse('document exceeds 32 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
    // Schema strings cannot contain whitespace. Keep field order, but refuse lossy or escaped JSON spellings.
    if (JSON.stringify(value) !== text.replace(/[ \t\r\n]/g, '')) return refuse('document must be plain JSON, no repeated or escaped members');
  } catch { return refuse('invalid JSON'); }
  if (!object(value) || !exact(value, ['schema', 'chainId', 'factory', 'registry', 'versionCodeHash', 'revision', 'off'])) return refuse('document fields must match schema 1 exactly');
  if (value.schema !== 1) return refuse('unsupported schema');
  if (!positiveInteger(value.chainId)) return refuse('chainId must be a positive safe integer');
  if (!positiveInteger(value.revision)) return refuse('revision must be a positive safe integer');
  for (const field of ['factory', 'registry'] as const) {
    if (typeof value[field] !== 'string' || value[field].length !== 42 || !CANONICAL_ADDRESS.test(value[field])) return refuse(`${field} must be a canonical lowercase address`);
  }
  if (typeof value.versionCodeHash !== 'string' || value.versionCodeHash.length !== 66 || !HASH.test(value.versionCodeHash)) return refuse('versionCodeHash must be a canonical lowercase hash');
  if (!Array.isArray(value.off) || value.off.length > CREATE_OPTIONS_MAX_ENTRIES) return refuse('off must be a list of at most 128 entries');
  const seen = new Set<string>();
  for (const entry of value.off) {
    if (!object(entry) || !exact(entry, Object.hasOwn(entry, 'issueId') ? ['key', 'issueId'] : ['key'])) return refuse('off entry fields must be key and optional issueId only');
    if (typeof entry.key !== 'string' || !isCreateOptionKey(entry.key)) return refuse('unknown or invalid option key');
    if (seen.has(entry.key)) return refuse('duplicate option key');
    seen.add(entry.key);
    if (Object.hasOwn(entry, 'issueId') && (typeof entry.issueId !== 'string' || entry.issueId.length < 1 || entry.issueId.length > 96 || /[^a-z0-9-]/.test(entry.issueId))) return refuse('issueId must be 1 to 96 lowercase ASCII letters, digits or hyphens');
  }
  if (expected && (['chainId', 'factory', 'registry', 'versionCodeHash'] as const).some(field => value[field] !== expected[field])) return refuse('document release pins do not match');
  return { ok: true, document: value as unknown as CreateOptionsDocument };
}
