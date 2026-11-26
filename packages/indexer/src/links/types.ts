import type { BoxLinks } from '../../../chain/src/core/v2/box-links-v2';

/** Stored data uses decimal strings; all ordering/time arithmetic converts to bigint. */
export interface LinkRecord extends BoxLinks {
  readonly issuedAt: string;
  readonly signature: string;
  readonly signerKind: 'eoa' | 'erc1271';
  readonly verifiedBlock: string;
}
export interface LinkRow extends LinkRecord {
  readonly chainId: number;
  readonly token: string;
  readonly signer: string;
}
export type VisibleLinks = (BoxLinks & { readonly issuedAt: string }) | null;
export interface LinksView {
  readonly schema: 'sh.box-links.v1';
  readonly chainId: number;
  readonly token: string;
  readonly creator: string;
  readonly record: LinkRecord | null;
}
export interface LinksStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  get(chainId: number, token: string): Promise<LinkRow | null>;
  list(chainId: number): Promise<readonly LinkRow[]>;
  /** Returns the row actually kept, or null if an equal/newer timestamp already exists. */
  put(row: LinkRow): Promise<LinkRow | null>;
  close(): Promise<void>;
}
export const hasLinks = (row: BoxLinks): boolean => row.website !== '' || row.x !== '' || row.telegram !== '';
