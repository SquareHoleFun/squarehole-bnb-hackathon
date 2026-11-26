// SH-255 round 3b (G1): the failed box's exact claim line as the page prints it in Claim details (V2BoxPage.tsx
// ClosingCardV2): the pot in the price coin, its coin, then the coins left. One builder for the chain helper and the
// unit test that holds it to the page.
import { formatUnits } from 'viem';

/** `Claim pot <pot> <coin> · <left> coins left`; `decimals` the price coin's, the coins left in the box token (18). */
export const claimPotLine = ({ pot, left, decimals, coin }) => `Claim pot ${formatUnits(pot, decimals)} ${coin} · ${formatUnits(left, 18)} coins left`;
