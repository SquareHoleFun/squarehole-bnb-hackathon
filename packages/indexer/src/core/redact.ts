/**
 * Keeps RPC keys out of the core service's logs. A keyed provider (the founder's Infura slot on the server) carries its
 * key in the URL's path (`https://sepolia.infura.io/v3/<key>`): the keyless check (core-config.ts) lets that through,
 * and viem's errors and the head feed's warnings print the URL in full. core-main.ts logs every configured RPC URL as
 * its origin only and passes console output through `urlRedactor`.
 */

/** Long path segments read as keys (an Infura key is 32 hex characters; `/sep` or `/v3` are not keys). */
const KEY_LIKE = 16;

/** `https://host/…` for a URL with a path, query or fragment; the origin alone otherwise. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasMore = (u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '';
    return `${u.protocol}//${u.host}${hasMore ? '/…' : ''}`;
  } catch {
    return '(unparsable URL)';
  }
}

/** Replaces each configured URL in a text by its redacted form, and any key-like path segment of them by `…`. */
export function urlRedactor(urls: readonly string[]): (text: string) => string {
  const pairs = new Map<string, string>();
  for (const url of urls) {
    const redacted = redactUrl(url);
    for (const form of [url, url.replace(/\/+$/, '')]) if (form !== redacted && form.length > 0) pairs.set(form, redacted);
    try {
      for (const segment of new URL(url).pathname.split('/')) if (segment.length >= KEY_LIKE) pairs.set(segment, '…');
    } catch {
      // an unparsable URL is refused by the config before it gets here
    }
  }
  const ordered = [...pairs.entries()].sort(([a], [b]) => b.length - a.length);
  return (text) => ordered.reduce((out, [from, to]) => out.split(from).join(to), text);
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

/** Routes the console's string and Error arguments through `redact`; returns a function that restores the console. */
export function redactConsole(redact: (text: string) => string, target: Pick<Console, ConsoleMethod> = console): () => void {
  const originals = METHODS.map((method) => [method, target[method]] as const);
  for (const [method, original] of originals) {
    target[method] = (...args: unknown[]) =>
      original.apply(
        target,
        args.map((arg) => (typeof arg === 'string' ? redact(arg) : arg instanceof Error ? redact(arg.stack ?? `${arg.name}: ${arg.message}`) : arg)),
      );
  }
  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}
