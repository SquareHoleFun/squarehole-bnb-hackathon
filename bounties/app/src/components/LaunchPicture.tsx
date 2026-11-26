/**
 * SH-294: a launch's picture where the launch page shows the launch: its home row, its page's header. The link is the
 * launch's own: a Flap sale's config `meta` (the caller passes it), or an OpenFour token's link from Core's
 * creation event or the deployment file. Both use the platform's picture checks (lib/pictures/read.tsx).
 */
import type { Address } from 'viem';
import { useApp, useChainRead } from '../lib/app-context';
import { fourPictureLink, readLaunchEvents } from '../lib/launch-events';
import { LaunchPictureImg } from '../lib/pictures/read';

/** An OpenFour token's link, or null. */
export function useFourLink(token: Address): string | null {
  const { config } = useApp();
  const core = config.openfour?.core;
  const read = useChainRead(
    async (c) => {
      if (!core) return null;
      // SH-303: from the tab's one scan of the creation events (shared with the lists)
      return fourPictureLink(await readLaunchEvents(c, config), config, token);
    },
    [core, token],
  );
  return read.state === 'ok' ? read.value : null;
}

export function FourPicture({ token, size, className }: { token: Address; size: number; className?: string }) {
  return <LaunchPictureImg link={useFourLink(token)} size={size} className={className} />;
}
