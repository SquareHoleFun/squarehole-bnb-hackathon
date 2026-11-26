import type { TradeSlotProps } from '../core/v2/TradeSlotMount';
import { ALPHA_ON } from '../alpha-sepolia/alpha-on';
import { MadeWalletResume } from './made-wallet';
import { TradeBox } from './TradeBox';

/**
 * F156 (SH-ALPHA-BUILD-SWITCH, SH-ALPHA-TRADE-BOX, SH-ALPHA-TEST-COINS): the Sepolia alpha's trade folder, as the site
 * loads it. Three doors open this one module, each lazily and behind `import.meta.env.SH_SEPOLIA_TRADE`, and with the
 * join page's door into Privy's loader they are the only ways into the folder (build-target.test.ts,
 * no-trade-source.test.ts):
 * - features/core/v2/TradeSlotMount.tsx, the v2 box page's slot: the default export, the buy/sell box (TradeBox.tsx,
 *   work package G phase 1);
 * - routes.tsx, the test-coin page's route: `TestCoinPage` (TestCoinPage.tsx, phase 2);
 * - shell/AlphaWelcomeMount.tsx, the app's pages: `AlphaWelcome`, the alpha's welcome step and its "Set me up" (F166,
 *   SH-ALPHA-ONBOARDING).
 * The doors share this module, so the trade code stays one lazily loaded chunk whichever page asks for it first. Every
 * module it needs sits inside this folder or packages/chain/src/trade-sepolia/.
 *
 * `TRADE_SLOT_MARKER` is how `pnpm check:production` (production-check.ts, the `trade` rule) finds this module in a
 * build: the mainnet build must not hold it at all, and the Sepolia build must hold it in a lazily loaded chunk only.
 * Keep it here, exported, whatever the slot grows into.
 */
export const TRADE_SLOT_MARKER = 'sh-trade-slot-f156';

export { TestCoinPage } from './TestCoinPage';
export { AlphaWelcome } from './AlphaWelcome';

export default function TradeSlot(props: TradeSlotProps) {
  // F161 (4): a device that connected the wallet Privy made gets it back without a window (made-wallet.ts); only where
  // the test network has the alpha (SH-258; SH-275: alpha-on.ts).
  return <>{ALPHA_ON ? <MadeWalletResume /> : null}<TradeBox {...props} /></>;
}
