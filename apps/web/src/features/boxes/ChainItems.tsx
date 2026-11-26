/**
 * Revealed chain items (MF23): canonical reveals read from the indexer, with pictures, avatars and a 3D viewer.
 * Kept apart from ContentsPanel so the creation page's sources never hold a network call (create-safety.test.ts);
 * the creation preview never renders these (a draft has no chain row).
 */
import { useEffect, useState } from 'react';
import { parseItemView, type CoreItemView } from '@squarehole/indexer/client';
import { useCoreSource } from '../core/useCore';
import { WithheldTile } from '../pictures/WithheldTile';
import { ipfsPictureId, pictureIds, useWithheld } from '../pictures/withheld';
import { ItemModelView } from '../scene/ItemModelView';
import type { BoxRecord } from './box-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** Chain records are deliberately separate from examples and the unrevealed placeholder. */
export function ChainItems({ record, ids }: { record: BoxRecord; ids?: readonly string[] }) {
  const core = useCoreSource();
  const origin = core.status === 'ready' && core.chainId === record.chainId && core.network === record.row?.network ? core.indexerOrigin : null;
  return origin && record.row && !(DEMO_BUILD && record.demo) ? <RevealedItems key={`${origin}/${record.id}/${ids?.join(',') ?? 'all'}`} record={record} origin={origin} ids={ids} /> : <p className="sh-muted">Item art is unavailable.</p>;
}

const defaultFetch = (url: string, init?: RequestInit) => fetch(url, init);

/** A page of canonical reveals, refreshed to discard orphan records. Raw gateway URLs never enter the DOM. */
export function RevealedItems({ record, origin, ids, fetcher = defaultFetch }: { record: BoxRecord; origin: string; ids?: readonly string[]; fetcher?: typeof defaultFetch }) {
  const [items, setItems] = useState<readonly CoreItemView[] | null>(null);
  const [after, setAfter] = useState('0');
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const selected = ids?.join(',') ?? null;
  const row = record.row?.row;
  const base = `${origin}/v1/boxes/${record.chainId}/${record.token?.toLowerCase()}/items`;
  useEffect(() => {
    if (!row) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      try {
        const read = async (url: string) => {
          const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
          if (!response.ok) throw new Error('item read failed');
          return response.json() as Promise<unknown>;
        };
        const owned = selected?.split(',').filter((id) => /^[1-9][0-9]{0,77}$/.test(id) && BigInt(id) > BigInt(after)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
        const page: { items?: unknown; next?: unknown } = owned
          ? { items: await Promise.all(owned.slice(0, 24).map((id) => read(`${base}/${id}`))), next: owned.length > 24 ? owned[23] : null }
          : await read(`${base}?after=${after}&limit=24`) as { items?: unknown; next?: unknown };
        if (!Array.isArray(page.items) || page.items.length > 100) throw new Error('bad item page');
        const parsed = page.items.map((item: unknown) => parseItemView(item, row));
        if (stopped) return;
        setItems(parsed.filter((item) => item.revealed && (selected === null || selected.split(',').includes(item.id))));
        setNext(typeof page.next === 'string' && /^[1-9][0-9]{0,77}$/.test(page.next) ? page.next : null);
        setFailed(false);
      } catch {
        if (!stopped) { setItems([]); setNext(null); setFailed(true); }
      } finally { if (!stopped) timer = setTimeout(() => void read(), 12000); }
    };
    void read();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [row, base, after, selected, fetcher]);
  return <div className="sh-box-card-block">
    <h3>Revealed items</h3>
    {items === null ? <p>Reading items…</p> : failed ? <p>Item art is unavailable.</p> : items.length === 0 ? <p>No revealed items yet.</p> : null}
    <ul className="sh-box-item-grid">{items?.map((item) => <li key={`${item.id}-${item.art?.image?.sha256}-${item.art?.model?.sha256}`}><RevealedItem item={item} base={base} /></li>)}</ul>
    {after !== '0' ? <button type="button" onClick={() => { setItems(null); setAfter('0'); }}>First items</button> : null}
    {next ? <button type="button" onClick={() => { setItems(null); setAfter(next); }}>Next items</button> : null}
  </div>;
}

/**
 * A missing reveal-time pin may become available at the next indexed head. SH-WITHHELD-SITE (F157 (3)): the picture's
 * id (`ipfs:` + its raw CID, as the indexer's art route checks it) is checked against our withheld list before the
 * <img> is made: nothing is asked while the list is read, a listed picture is never asked and shows the neutral tile,
 * and a shown one turns into the tile when the list names it later.
 */
function ItemPicture({ src, alt, at, cid, avatar = false }: { src: string; alt: string; at: string; cid: string; avatar?: boolean }) {
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const verdict = useWithheld(pictureIds(ipfsPictureId(cid)));
  if (verdict === 'withheld') return <WithheldTile className={avatar ? 'sh-box-item__avatar' : 'sh-withheld--square'} label={`${alt}, picture withheld`} />;
  if (verdict === 'checking' || failedAt === at) return null;
  return <img className={avatar ? 'sh-box-item__avatar' : undefined} src={src} width={avatar ? 64 : 512} height={avatar ? 64 : 512}
    alt={alt} loading="lazy" decoding="async" onError={() => setFailedAt(at)} />;
}

function RevealedItem({ item, base }: { item: CoreItemView; base: string }) {
  const [model, setModel] = useState(false);
  const [failed, setFailed] = useState(false);
  const art = item.art;
  const url = (role: 'image' | 'avatar' | 'model') => `${base}/${item.id}/art/${role}`;
  const modelHash = art?.model?.sha256;
  // The shared viewer (scene/ItemModelView.tsx): loaded on the press from the indexer's model route, aborted and
  // disposed on Close.
  return <article className="sh-box-item">
    <h4>#{item.id}</h4>
    {art?.image ? <ItemPicture src={url('image')} alt={`Item #${item.id}`} at={item.asOf.hash} cid={art.image.cid} /> : null}
    {art?.avatar ? <ItemPicture src={url('avatar')} alt={`Avatar for #${item.id}`} at={item.asOf.hash} cid={art.avatar.cid} avatar /> : null}
    <dl>{item.traits.map((trait) => <div key={trait.trait_type}><dt>{trait.trait_type}</dt><dd>{trait.value}</dd></div>)}</dl>
    {art?.model ? <button type="button" aria-label={`${model ? 'Close' : 'View'} 3D model for #${item.id}`} onClick={() => { setFailed(false); setModel(!model); }}>{model ? 'Close 3D' : 'View 3D'}</button> : null}
    {model && modelHash ? <ItemModelView url={url('model')} sha256={modelHash} className="sh-box-item__model" label={`3D model for #${item.id}`} onOutcome={(outcome) => { if (outcome === 'failed') setFailed(true); }} /> : null}
    {failed ? <p>3D model unavailable. The picture remains available.</p> : null}
  </article>;
}
