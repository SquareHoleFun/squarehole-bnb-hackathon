import { rememberedHere } from '../wallet/injected-adapter';

export const MADE_WALLET_ID = 'privy';
const MEMORY = `provided:${MADE_WALLET_ID}`;

/** Whether this device remembers the made wallet as the wallet it connected (and its address). */
export function rememberedMadeWallet(remembered = rememberedHere()): `0x${string}` | null {
  return remembered?.provider === MEMORY ? remembered.address : null;
}
