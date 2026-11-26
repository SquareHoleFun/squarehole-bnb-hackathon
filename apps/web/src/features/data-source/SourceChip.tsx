import { useDataSource } from './data-source-context';

/**
 * The label of the data on a page (D07, UI-04): the chain's name for a chain source ("Local chain 31337", "Sepolia
 * testnet"). The sample data has no label (F130, founder 2026-10-11: no Demo badges; it supersedes "mock data stays
 * labelled Demo"); its name is said in Settings only.
 */
export function SourceChip() {
  const source = useDataSource();
  if (source.isDemo) return null;
  return (
    <span className="sh-chip sh-chip--pending" data-source={source.id}>
      {source.dataLabel}
    </span>
  );
}
