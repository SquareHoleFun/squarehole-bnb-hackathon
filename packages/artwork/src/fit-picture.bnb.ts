/**
 * SH-258 round 3: the BNB Chain testnet build's FIT icon module (apps/web/build/bnb-variants.ts takes this file in place
 * of fit-picture.ts). Only box 0's spec commits that icon; there is no box 0 there, so no bytes are carried. Same
 * exports.
 */
export const FIT_ICON_SHA256 = '0x2aa8e531b2837be0a979b85b772ae4a5f286bbbd19b3d1be36804c146da69c93' as const;
export const fitPictureBytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(0));
