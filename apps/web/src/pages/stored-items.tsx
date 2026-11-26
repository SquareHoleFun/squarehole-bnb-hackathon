import type { StoredItem } from '../features/legal';

const STORE_LABEL = {
  localStorage: 'Local storage',
  sessionStorage: 'Session storage (this tab)',
  IndexedDB: 'IndexedDB database',
  cookie: 'Cookie',
} as const;

/** The items the app keeps in this browser (privacy.ts `STORED_ON_DEVICE`), as the privacy notice and the test network notice list them. */
export function StoredItems({ items }: { items: readonly StoredItem[] }) {
  return (
    <ul className="sh-legal__bullets">
      {items.map((item) => (
        <li key={`${item.store}:${item.key}`}>
          {item.what}{' '}
          <span className="sh-legal__meta">
            ({STORE_LABEL[item.store]} <code>{item.key}</code>)
          </span>
        </li>
      ))}
    </ul>
  );
}
