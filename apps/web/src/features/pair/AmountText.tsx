/**
 * An amount with its unit ("70.1864 AAPLx-DEMO"). The line may break between number and unit, never inside the unit
 * ("AAPLx-/DEMO"). Null renders "Not available" in words (FEED-06).
 */
export function AmountText({ value }: { value: string | null }) {
  if (value === null) return <span className="sh-na">Not available</span>;
  const space = value.lastIndexOf(' ');
  if (space <= 0) return <span className="sh-numeric">{value}</span>;
  return (
    <span className="sh-numeric">
      {value.slice(0, space)} <span className="sh-nowrap">{value.slice(space + 1)}</span>
    </span>
  );
}
