/**
 * TEST ONLY (SH-EXISTING-NFTS-E08C): the words the add-on's pages and sources never use (the ticket's list: verified,
 * trusted, draw, reveal, payout, earnings, buy, sell, swap), as whole words in any case with their usual forms.
 */
export const FORBIDDEN = /\b(verified|unverified|trusted|untrusted|draws?|drawn|drawing|reveal(?:s|ed|ing)?|payouts?|earnings?|buy(?:s|ing|ers?)?|sell(?:s|ing|ers?)?|swap(?:s|ped|ping)?)\b/i;
