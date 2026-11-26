import { alphaChain } from './chains.mjs';

export const xIdPattern = /^[1-9][0-9]{0,19}$/;
// The sender's refusals that belong to the claimant's address, not the person (SH-181 af2). alpha-api releases a claim
// refused with exactly one of these reasons and no transaction, so the person can claim again with a plain wallet.
export const ADDRESS_REFUSALS = Object.freeze(['address needs too much gas for the starter', 'address cannot receive the starter']);

/** The v1 signed text is shared by intake and the independent sender. */
export function claimMessage({ handle, xId, address, id, requestedAt, origin }, chainId = 11155111) {
  if (chainId !== 11155111) {
    // SH-275: the same text with the chain's coin and network (chains.mjs); Sepolia's line below is unchanged.
    const { coin, network } = alphaChain(chainId);
    return `Square Hole alpha claim\n\nI link my X account @${handle} (X ID ${xId}) to wallet ${address}.\nI request starter ${coin} on ${network} (chain ${chainId}).\nClaim ID: ${id}\nTime: ${requestedAt}\nSite: ${origin}`;
  }
  return `Square Hole alpha claim\n\nI link my X account @${handle} (X ID ${xId}) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${id}\nTime: ${requestedAt}\nSite: ${origin}`;
}

export function matchesClaimMessage(claim, chainId = 11155111) {
  // Handle and site are display context, not authorization. All queue fields must occupy their exact slots;
  // substring checks can accidentally match an X ID inside another field or accept extended tokens.
  const handle = claim.message.match(/^Square Hole alpha claim\n\nI link my X account @([A-Za-z0-9_]{1,15}) /)?.[1];
  const origin = claim.message.match(/\nSite: (https:\/\/[a-z0-9.-]+)$/)?.[1];
  try { return Boolean(handle && origin && new URL(origin).origin === origin
    && claim.message === claimMessage({ ...claim, handle, origin }, chainId)); } catch { return false; }
}
