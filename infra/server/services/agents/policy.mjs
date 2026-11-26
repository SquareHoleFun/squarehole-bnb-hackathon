export const SEPOLIA = 11155111;
export const WEEKLY_CAP = 300000000n;
export const AI_DISCLOSURE = 'I am an AI assistant for the Lake House mock rental.';
export const MAX_OUTPUT_TOKENS = 2048;
export function requireThat(ok, message = 'agents policy refused') { if (!ok) throw new Error(message); }
export const raw = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
export const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
export const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
export const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max;
/** Dollars in billionths: prices and balances never pass through floating point. */
export function usd(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,9})?$/.test(value));
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
}
export function validateConfig(c) {
  requireThat(exact(c, ['version', 'chainId', 'safe', 'module', 'token', 'inbox', 'pricingReviewed', 'manager', 'bookkeeper'])
    && c.version === 1 && c.chainId === String(SEPOLIA) && c.pricingReviewed === true);
  for (const key of ['safe', 'module', 'token', 'inbox']) requireThat(address(c[key]));
  requireThat(exact(c.manager, ['model', 'address', 'weeklyCapRaw', 'payees', 'inputUsdPerMillion', 'outputUsdPerMillion'])
    && c.manager.model === 'claude-haiku-4-5-20251001' && address(c.manager.address)
    && raw(c.manager.weeklyCapRaw) && BigInt(c.manager.weeklyCapRaw) > 0n && BigInt(c.manager.weeklyCapRaw) <= WEEKLY_CAP
    && exact(c.manager.payees, ['cleaner', 'repairs']) && Object.values(c.manager.payees).every(address));
  requireThat(exact(c.bookkeeper, ['model', 'inputUsdPerMillion', 'outputUsdPerMillion']) && c.bookkeeper.model === 'claude-sonnet-5-5');
  for (const role of [c.manager, c.bookkeeper]) requireThat(usd(role.inputUsdPerMillion) > 0n && usd(role.outputUsdPerMillion) > 0n);
  return c;
}
export function validateJobs(jobs) {
  requireThat(Array.isArray(jobs) && jobs.length <= 1000);
  const ids = new Set(), months = new Set();
  for (const job of jobs) {
    requireThat(id(job?.id) && !ids.has(job.id)); ids.add(job.id);
    if (job.kind === 'guest') requireThat(exact(job, ['id', 'kind', 'guestId', 'message']) && id(job.guestId) && text(job.message, 8192));
    else if (job.kind === 'expense') requireThat(exact(job, ['id', 'kind', 'message']) && text(job.message, 8192));
    else {
      requireThat(exact(job, ['id', 'kind', 'month', 'incomeRaw', 'expensesRaw']) && job.kind === 'month'
        && /^\d{4}-(0[1-9]|1[0-2])$/.test(job.month) && !months.has(job.month)
        && raw(job.incomeRaw) && raw(job.expensesRaw));
      months.add(job.month);
    }
  }
  return jobs;
}
export function validateDecision(d, job, c) {
  if (job.kind === 'guest') requireThat(exact(d, ['action', 'text']) && d.action === 'reply' && text(d.text, 12000));
  else if (job.kind === 'expense') requireThat(exact(d, ['action', 'payee', 'amountRaw']) && d.action === 'pay'
    && Object.hasOwn(c.manager.payees, d.payee) && raw(d.amountRaw) && BigInt(d.amountRaw) > 0n
    && BigInt(d.amountRaw) <= BigInt(c.manager.weeklyCapRaw));
  else requireThat(exact(d, ['action', 'markdown']) && d.action === 'statement' && text(d.markdown, 20000));
  return d;
}
export function callCost(role, input, output) {
  return (input * usd(role.inputUsdPerMillion) + output * usd(role.outputUsdPerMillion) + 999999n) / 1000000n;
}
