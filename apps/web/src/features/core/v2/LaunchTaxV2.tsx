import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { routerSweepCallV2 } from '../../../../../../packages/chain/src/core/v2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { inboxIO, inboxTargetV2, readLaunchTaxV2 } from './inbox-upkeep';
import { usePress } from './InboxV2';

/**
 * SH-RC7-SITE-INBOX (KF-5): launch tax the launch router still holds after graduation (it becomes the pool's depth) or
 * failure (it joins the claim pot). Anyone may sweep it; every claim and our keeper try too. Shown only while the
 * sweep's own dry run moves some P now, with the amount it would move; the wallet only on a press.
 */
export function LaunchTaxV2({ source, view, p, disabled }: { source: V2Source; view: V2Snapshot; p: (amount: bigint) => string; disabled: boolean }) {
  const press = usePress(source, view, disabled);
  const target = useMemo(() => { try { return inboxTargetV2(source, view); } catch { return null; } }, [source, view]);
  const io = useMemo(() => inboxIO(source), [source]);
  const due = !disabled && target?.launchRouter !== undefined && (view.graduated || view.failed !== null);
  const query = useQuery({ queryKey: ['v2-launch-tax', source.manifest.chainId, target?.launchRouter, view.block.toString()],
    queryFn: () => (target ? readLaunchTaxV2(io, target) : null), enabled: due, retry: false, staleTime: Infinity });
  const amount = due ? query.data ?? null : null;
  if (amount === null || !target) return null;
  const into = view.failed ? 'the claim pot' : 'the pool’s depth';
  return <section className="sh-panel" aria-label="Launch tax"><h2>Launch tax</h2>
    <p className="sh-v2-value">{p(amount)}</p>
    <p>{`Waits to move into ${into}. Anyone may move it.`}</p>
    <div className="sh-v2-actions">
      <button type="button" className="sh-button" disabled={disabled || press.busy} onClick={() => press.begin({ question: `Move ${p(amount)} into ${into}?`, call: routerSweepCallV2(target) })}>Move</button>
      {press.ui}
    </div>
  </section>;
}
