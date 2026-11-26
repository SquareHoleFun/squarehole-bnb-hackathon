import { Navigate, useLocation } from 'react-router';
import { boxPath } from '../features/boxes/box-id';
import { launchRecord } from '../features/boxes/box-sources';
import { FEED_WORDS } from '../features/boxes/feed-words';
import { useBoxSources } from '../features/boxes/useBoxSources';
import { useDataSource } from '../features/data-source';
import { LiveLine } from '../shell/PartFailed';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';


/**
 * `/misfits` and `/fit`: the box of this data source's FIT market (`/box/<chain>-<token>`), keeping the query (a Demo
 * `?scenario=`). Without a market on this source, says so instead of guessing one.
 */
export function LaunchRedirect() {
  const { search } = useLocation();
  const source = useDataSource();
  const sources = useBoxSources();
  usePageTitle('FIT · not available');
  // Box 0 by its row (S10a § 6: never a name): the core v1 box 0 of this source, else the launch market's box.
  const box0 = sources.boxes.find((box) => box.row?.row.isBox0 === true);
  if (box0) return <Navigate replace to={`${boxPath(box0.id)}${search}`} />;
  // SH-246 (review C2): box 0's own feed, apart from the v2 boxes the merged sources may already hold (a Retry of box
  // 0's feed reads it again while those stay listed).
  const v1 = sources.v1 ?? null;
  // While the source's rows are read, box 0 may still come: wait before falling back to a launch market's box.
  if (sources.launch && sources.core.status !== 'loading' && v1?.loading !== true) return <Navigate replace to={`${boxPath(launchRecord(sources.launch).id)}${search}`} />;
  if (sources.core.status === 'loading' || v1?.loading === true) {
    return (
      <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
        <div className="sh-page__header">
          <PageHeading>Reading box 0…</PageHeading>
        </div>
      </section>
    );
  }
  // Box 0's feed could not be read: plain words and Retry (before: the read's raw reason), never a guess in its place.
  if (v1 !== null && !v1.answered && v1.error !== null) {
    const retry = sources.retry;
    return (
      <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
        <div className="sh-page__header">
          <PageHeading>FIT · The Misfits</PageHeading>
        </div>
        <div className="sh-panel sh-part-failed" data-box0="unread">
          <LiveLine text={FEED_WORDS.box} />
          {retry ? <button type="button" className="sh-button" onClick={() => { document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true }); retry(); }}>{FEED_WORDS.retry}</button> : null}
        </div>
      </section>
    );
  }
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>FIT · The Misfits</PageHeading>
      </div>
      <div className="sh-panel sh-box-empty">
        <p>{sources.core.status === 'awaiting-broadcast' || sources.core.status === 'error' || sources.core.status === 'invalid' ? sources.core.reason : sources.missing}</p>
        <p>{`Nothing on ${source.dataLabel} is shown as FIT in its place.`}</p>
      </div>
    </section>
  );
}

export default LaunchRedirect;
