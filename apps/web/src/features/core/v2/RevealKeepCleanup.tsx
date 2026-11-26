/** Device-wide reveal-copy cleanup after terms acceptance, independent of route and connected wallet. */
import { useEffect } from 'react';
import { forgetKeptCopy, listKept, retryAbandonedKept, type KeptReveal } from '../../create/v2/reveal-keep';
import { useTermsAccess } from '../../legal/terms-access';
import { BUILD_CORE } from '../useCore';
import { completedReveal } from './reveal-finalized';
import { sourceV2, type V2Source } from './indexer-v2';

export { completedReveal } from './reveal-finalized';

export const CLEANUP_MS = 30_000;

/** A failed read/delete leaves the record available for the next pass, including after a reload. */
export async function reconcileRevealCopies(
  complete: (copy: KeptReveal) => Promise<boolean>,
  forget = forgetKeptCopy,
): Promise<void> {
  await retryAbandonedKept();
  for (const copy of await listKept()) {
    try {
      if ((copy.abandoned && !copy.owners?.length) || await complete(copy)) await forget(copy);
    } catch {
      // Retain uncertain/incomplete copies. Retry on the next pass.
    }
  }
}

function knownSources(): readonly V2Source[] {
  return (['local', 'sepolia'] as const).flatMap((id) => {
    try { const source = sourceV2(id, BUILD_CORE); return source ? [source] : []; }
    catch { return []; }
  });
}

export function RevealKeepCleanup({ complete }: { readonly complete?: (copy: KeptReveal) => Promise<boolean> }) {
  const accepted = useTermsAccess();
  useEffect(() => {
    if (!accepted) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sources = knownSources();
    const check = complete ?? (async (copy: KeptReveal) => {
      const source = sources.find((entry) => entry.manifest.chainId === copy.chainId);
      return source ? completedReveal(copy, source) : false;
    });
    const tick = async () => {
      await reconcileRevealCopies(check).catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void tick(), CLEANUP_MS);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [complete, accepted]);
  return null;
}
