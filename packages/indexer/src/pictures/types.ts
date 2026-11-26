import { z } from 'zod';

export const arweaveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const pictureCopiesSchema = z.strictObject({
  logo: z.strictObject({ arweaveId: arweaveIdSchema }).optional(),
  cover: z.strictObject({ arweaveId: arweaveIdSchema }).optional(),
}).refine(value => value.logo !== undefined || value.cover !== undefined);
export type PictureCopies = z.infer<typeof pictureCopiesSchema>;
export interface PictureSpec { readonly coverSha256: string; readonly collectionCoverSha256: string }

/** Arweave tags use lowercase SHA-256 without the chain's 0x prefix. Zero means no commitment. */
export function pictureHash(value: string): string | null {
  const hash = value.toLowerCase().replace(/^0x/, '');
  return /^[a-f0-9]{64}$/.test(hash) && hash !== '0'.repeat(64) ? hash : null;
}
