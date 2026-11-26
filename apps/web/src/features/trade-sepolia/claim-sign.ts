/**
 * F161 (4), SH-ALPHA-SITE, work package E: the one signature of a claim. The wallet signs the exact text our server
 * issued for this address (`GET /alpha/claim/message`), as an EIP-191 personal message: the text in UTF-8, sent as hex,
 * then the account (`personal_sign`). alpha-api checks it against the address (viem `verifyMessage`, EOA signatures of 65
 * bytes, a made wallet's included); the sender checks it again on its own (design § 6). One request after one press.
 */
import { isUserRejection, normalizeSignatureV, type Eip1193Request } from '@squarehole/chain/write/wallet';
import { toHex } from 'viem';

export type ClaimSignature =
  | { readonly ok: true; readonly signature: `0x${string}` }
  /** `declined`: the person said no in the wallet; `wallet`: it failed or answered with no 65-byte signature. */
  | { readonly ok: false; readonly reason: 'declined' | 'wallet' };

export async function signClaimText(request: Eip1193Request, account: string, text: string): Promise<ClaimSignature> {
  let answer: unknown;
  try {
    answer = await request({ method: 'personal_sign', params: [toHex(text), account] });
  } catch (error) {
    return { ok: false, reason: isUserRejection(error) ? 'declined' : 'wallet' };
  }
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(answer)) return { ok: false, reason: 'wallet' };
  return { ok: true, signature: normalizeSignatureV(answer as `0x${string}`) };
}
