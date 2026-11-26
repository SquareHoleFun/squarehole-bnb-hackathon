export const DEFAULT_PICTURES_FILE: string;
export interface WithheldEntry { readonly id: string; readonly reason: 'illegal' | 'legal-notice'; readonly since: string }
export interface WithheldPictures {
  has(id: string): boolean;
  snapshot(): { readonly version: 1; readonly hashes: readonly string[] };
}
export function validPictureId(id: unknown): id is string;
export function validReason(reason: unknown): reason is WithheldEntry['reason'];
export function parsePictures(text: string): WithheldEntry[];
export function createWithheldPictures(options?: { file?: string; now?: () => number; warn?: (message: string) => void }): WithheldPictures;
