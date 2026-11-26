/** One-line JSON logs with every configured secret replaced, whatever carries it (an error, a URL, a field). */
export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const REDACTED = '[redacted]';

export function redact(text: string, secrets: readonly string[]): string {
  const sorted = [...secrets].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of sorted) {
    out = out.split(s).join(REDACTED);
    out = out.split(s.toLowerCase()).join(REDACTED);
  }
  return out;
}

const plain = (_key: string, value: unknown) => {
  if (typeof value === 'bigint') return value.toString();
  if (_key === 'error' || value instanceof Error) return { name: value instanceof Error ? value.constructor.name : 'UnknownError' };
  return value;
};

export function makeLogger(secrets: readonly string[], sink?: (line: string) => void): Logger {
  const write = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
    const line = redact(JSON.stringify({ time: new Date().toISOString(), level, msg, ...data }, plain), secrets);
    if (sink) sink(line);
    else if (level === 'error') console.error(line);
    else console.warn(line);
  };
  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}
