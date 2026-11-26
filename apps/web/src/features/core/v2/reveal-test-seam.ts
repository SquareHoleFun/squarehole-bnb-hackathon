/** Production has no override registry or installer. Vitest replaces this module in tests only. */
import type { CoreV2SubmitOptions } from '../../../../../../packages/chain/src/write/executor';
import type { createRevealRPC } from './reveal-rpc';
import type { RevealProgressStore, RevealLock } from './reveal-items-store';
import type { RevealClock } from './reveal-clock';
import type { Eip1193Request } from '../../../../../../packages/chain/src/write/eip1193';
import type { Hex } from 'viem';
export interface RevealTestOverrides { authorized?: boolean; rpc?: Eip1193Request; send?: (options: CoreV2SubmitOptions) => Promise<Hex>;
  session?: { adapter: ReturnType<typeof createRevealRPC>; store: RevealProgressStore; lock: RevealLock | null;
    clock: RevealClock; press: () => boolean; poll?: boolean; fetch?: typeof fetch };
}
export const revealTestOverride: (target: object) => RevealTestOverrides | undefined = () => undefined;
