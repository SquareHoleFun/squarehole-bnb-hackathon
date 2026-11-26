/** Canonical string-only JSON for committed metadata and reveal lists. */
export type CanonicalValue = string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue | undefined };

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** RFC 8785 serialisation for string-only JSON trees. Throws TypeError on any other value. */
export function canonicalJson(value: CanonicalValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry: CanonicalValue) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as { readonly [key: string]: CanonicalValue | undefined };
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(byCodeUnits);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as CanonicalValue)}`).join(',')}}`;
  }
  throw new TypeError('canonical manifest values are strings, arrays and plain objects only');
}

