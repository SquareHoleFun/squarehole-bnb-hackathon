import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IN_APP_TRADING } from '../../pages/about-content';
import { ABOUT_FACTS } from '../../pages/about-facts';
import { PRIVACY_NOTICE, allPrivacyText } from './privacy';
import { PRODUCTION_PRIVACY_NOTICE } from './privacy-production';
import { TERMS_DOCUMENT, TERMS_GATE, TERMS_VERSION } from './terms';
import { RESTRICTED_COUNTRIES, eligibilityBullet, placeholders, placeholdersIn, restrictedCountryClause, termsTextOf } from './terms-common';
import { PRODUCTION_TERMS } from './terms-production';
import { appCopyFraming, unnegatedReturnFraming } from './wording';

/**
 * The production Terms and privacy notice (SH-V2-FE7): a DRAFT FOR COUNSEL with no Demo, based on the counsel pack's
 * draft-6 and the founder decisions since. vitest always runs the development modules, so these tests read the
 * production text from its own module; the production build's smoke test renders it (e2e/production).
 */
const { gate, document } = PRODUCTION_TERMS;
const sections = document.sections;
const terms = () => termsTextOf(gate, document);
const notice = () => allPrivacyText(PRODUCTION_PRIVACY_NOTICE, []);
const all = () => [...terms(), ...notice()].join(' ');
const section = (n: string) => sections.find((candidate) => candidate.n === n);
const clause = (n: string) => section(n.split('.')[0] ?? '')?.clauses.find((candidate) => candidate.n === n);
const item = (n: string, letter: string) => clause(n)?.items?.find((candidate) => candidate.text.startsWith(`(${letter})`))?.text ?? '';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('production Terms of Use (SH-V2-FE7, DRAFT FOR COUNSEL)', () => {
  it('is a dated production draft with its own version, and the development build keeps its own draft (draft-7 since SH-V2-FE11)', () => {
    // SH-V2-FE9 (F131), SH-V2-FE10 (F133, F134) and SH-V21-RC5-INT (F136, the failed-box claim) changed the text: each is a
    // new version that asks for acceptance again.
    expect(PRODUCTION_TERMS.version).toBe('2026-10-15-production-draft-4');
    expect(PRODUCTION_TERMS.date).toBe('2026-10-15');
    expect(document.versionLine).toBe('Version 2026-10-15-production-draft-4 · Draft of 15 October 2026');
    expect(TERMS_VERSION).toBe('2026-10-11-draft-7');
    expect(TERMS_GATE.bullets).not.toEqual(gate.bullets);
    expect(TERMS_DOCUMENT.sections).not.toBe(sections);
    // The draft status stays in words until counsel signs off; the placeholder makes that a launch item.
    expect(gate.status.startsWith('Draft Terms, not yet reviewed by a lawyer. [FOUNDER + COUNSEL: delete this line')).toBe(true);
    expect(document.status.startsWith('DRAFT pending legal review. It may change, and you will be asked to accept the final version. [FOUNDER + COUNSEL:')).toBe(true);
    expect(document.closing.startsWith('DRAFT pending legal review. It may change before it is final. [FOUNDER + COUNSEL: delete this line')).toBe(true);
    expect(all()).not.toMatch(/not in force|not legal advice/i);
    // e2e never imports src: its production acceptance record must carry this version.
    expect(readFileSync(join(ROOT, 'apps/web/e2e/terms-state.ts'), 'utf8')).toContain(`export const PRODUCTION_TERMS_VERSION = '${PRODUCTION_TERMS.version}';`);
    // The production smoke reads the date the Terms show from there too, so a new version cannot leave it behind.
    expect(readFileSync(join(ROOT, 'apps/web/e2e/terms-state.ts'), 'utf8')).toContain(`export const PRODUCTION_TERMS_DATE_TEXT = '${PRODUCTION_TERMS.dateText}';`);
  });

  it('has no Demo, mock or test-build wording, no first-handoff pairs and no Binds', () => {
    const text = all();
    expect(text).not.toMatch(/(?<![A-Za-z])(?:demo|mock)s?(?![a-z])/i);
    expect(text).not.toMatch(/test build|this build|test chains only|test pairs?|right now this is|local development chain/i);
    expect(text).not.toMatch(/\bBinds?\b|planned design|not deployed\)/);
    expect(text).not.toMatch(/\brefunds?\b|\brefunded\b/i);
    expect(gate.bullets).toHaveLength(8);
  });

  it('numbers sections 1 to 18 and the clauses of Section 5 from 5.1 to 5.23, with unique anchors', () => {
    expect(sections.map((candidate) => candidate.n)).toEqual(Array.from({ length: 18 }, (_, index) => String(index + 1)));
    for (const candidate of sections) {
      expect(candidate.id).toBe(`terms-${candidate.n}`);
      const numbers = candidate.clauses.flatMap((entry) => (entry.n ? [entry.n] : []));
      expect(new Set(numbers).size, candidate.n).toBe(numbers.length);
      for (const n of numbers) expect(n.startsWith(`${candidate.n}.`), n).toBe(true);
    }
    expect(section('5')?.clauses.flatMap((entry) => (entry.n ? [entry.n] : []))).toEqual(Array.from({ length: 23 }, (_, index) => `5.${index + 1}`));
    for (const candidate of sections.flatMap((entry) => entry.clauses)) {
      const letters = (candidate.items ?? []).map((entry) => /^\(([a-z]+)\)/.exec(entry.text)?.[1]);
      const expected = letters.map((_, index) => (index < 26 ? String.fromCharCode(97 + index) : `${String.fromCharCode(97 + index - 26)}`.repeat(2)));
      expect(letters, candidate.n ?? candidate.text.slice(0, 30)).toEqual(expected);
    }
  });

  it('points every internal cross-reference at a clause (and item) that exists', () => {
    const references = new Set<string>();
    for (const text of terms()) {
      // "5.8", "5.13(b)", "(5.4(e))", "Section 5.3": a section number then a clause number, never an amount ("4.25 ETH").
      for (const match of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\(([a-z]{1,2})\))?(?!\d|\.\d)(?!%| ETH| times| minutes| gwei)/g)) references.add(match[0]);
    }
    const missing = [...references].filter((reference) => {
      const [, n, letter] = /^(\d{1,2}\.\d{1,2})(?:\(([a-z]{1,2})\))?$/.exec(reference) ?? [];
      if (!n || !clause(n)) return true;
      return letter !== undefined && item(n, letter) === '';
    });
    expect(missing.filter((reference) => !reference.startsWith('0.'))).toEqual([]);
    for (const expected of ['5.17(c)', '5.19(e)', '5.18(b)', '5.20(b)', '5.4(b)', '5.15']) expect(references.has(expected), expected).toBe(true);
  });

  it('builds the restricted-country text of the gate and of §4.2(a) from the one list both texts share', () => {
    expect(RESTRICTED_COUNTRIES.map((country) => country.short)).toEqual(['the US', 'Canada', 'the UK']);
    expect(gate.bullets[2]).toBe(eligibilityBullet());
    expect(clause('4.2')?.items?.[0]?.text).toBe(restrictedCountryClause());
    expect(gate.checkbox).toBe(TERMS_GATE.checkbox);
  });

  it('keeps every disclosure of the development text that still applies, word for word or as the evidence table says', () => {
    const text = all();
    for (const kept of [
      'Nothing here is an offer, a recommendation or advice.',
      'Square Hole is not registered or licensed by any financial regulator.',
      'You can lose everything. Most launches never complete.',
      'Holding FIT pays you nothing. Burns are not a promise, and no one owes you anything because of them.',
      'give no right to any future token.',
      'Your wallet, your decisions, your taxes. Transactions cannot be undone',
      'Nothing in the Services is an offer or a request to buy or sell any security, derivative or other financial product, anywhere.',
      'Square Hole is not registered, licensed or authorised by any financial regulator in any country (Section 3).',
      'using them gives no right to any future token or allocation.',
      'You can lose everything you put into any token, NFT or transaction connected with Square Hole (Section 6).',
      'Burns and other mechanisms written into the smart contracts are not promises. Nobody owes you anything because of them',
      'The smart contracts have not been audited by an outside firm.',
      'have no value. We do not exchange them for anything of value.',
      'gives you no right to any future token, NFT, allocation or airdrop. Nothing you do on a test network carries over to a production network.',
      'Nothing in the Services promises any launch, release or date.',
      '**No custody.** We never hold your tokens, NFTs, funds or keys.',
      // F135 (SH-V2-FE10): "never asks your wallet for anything" became "never opens your wallet or asks you to approve
      // anything", with the silent reconnect after it (5.2(c)).
      '**No accounts.** You do not sign up. Browsing never opens your wallet or asks you to approve anything.',
      'The FIT contract has no function to create more, so the supply can never go above that number.',
      '**FIT holders receive no payouts.** No fee, burn or other mechanism pays or credits anything to anyone because they hold FIT.',
      'FIT sent to a "dead" address such as 0x…dEaD is not burned: it still counts in the supply.',
      'It is not income, interest, a dividend or a return on anything, and it gives nobody a right to any amount. Square Hole pays nothing: only the contract does, and it can fail.',
      'A burn only lowers the number of tokens that exist. It pays nobody and gives nobody a right to anything.',
      'Nobody promises that burns will happen, how large or how frequent they will be, or that they will bring profit, yield, return, income, a price rise or price support.',
      'Market prices can fall to zero however many tokens are burned.',
      '**Locked FIT is not a deposit.**',
      '**The last Misfit** can never leave the vault.',
      'Every burn of FIT, by anyone, lowers the quote.',
      'What such a send delivers can be lost for good. Nobody, including Square Hole, can recover it.',
      'Our policy bars everyone who holds or can see the reveal data from drawing',
      'Teaser art is for illustration. It does not tell you what any Misfit will be.',
      'Owning one changes no fee and gives no extra rights.',
      'We do not block access by IP address or location',
      'you confirm that you are at least 18 and not a Restricted User',
      'We will never ask for your recovery phrase or private keys. Anyone who does is not us.',
      'Statements by any regulator or its staff, including staff guidance on token buybacks or burns, do not approve Square Hole',
      'The Services are provided "as is" and "as available".',
      'Changing these Terms does not change the code of any deployed smart contract.',
    ]) {
      expect(text, kept).toContain(kept);
    }
    // Every risk heading of draft-5's 6.1 survives; the two that described a pool open to others now describe it closed.
    const risks = (clause('6.1')?.items ?? []).map((entry) => /^\([a-z]+\) \*\*([^*]+)\*\*/.exec(entry.text)?.[1] ?? '');
    for (const heading of ['Total loss.', 'Curve order and bots.', 'Failed launches.', 'Smart contracts.', 'Placeholders and reveals.', 'The quote and the fees.', 'Price impact.', 'Irreversible transactions.', 'Wallets and keys.', 'Regulatory change.', 'Tax.', 'Fakes.', 'Test networks.', 'Random draws.', 'What the vault holds.', 'Timing games.', 'The closed pool.', 'Trading elsewhere.']) {
      expect(risks, heading).toContain(heading);
    }
    expect(risks).toHaveLength(29);
  });

  it('describes the product as built: claim-only payouts, failed-box claims without expiry, one fee choice per side, the two wallets and the inbox (F119–F138); no platform cap (F213)', () => {
    expect(item('5.18', 'a')).toContain('nothing is sent to you automatically');
    expect(item('5.18', 'a')).toContain('Nobody, including Square Hole, claims it for you or pushes it to you.');
    expect(item('5.18', 'a')).toContain('"Claim all" lists the claims your wallet has; each transaction still needs your signature.');
    // F136 (RC5-A; DRAFT FOR COUNSEL, not yet seen by counsel): no expiry, no sweep, the unclaimed share locked for good.
    // The rc5 fix round: the pot goes to no Square Hole wallet; the capped closing payment is the one payment from it
    // other than a claim, and can reach our keeper; a failed box sends nothing more to the conversion wallet.
    expect(item('5.19', 'e')).toContain('Claims never close. Nothing in the pot is moved to the FIT buy-back wallet or to any other Square Hole wallet; the only payment from it other than a claim is the capped closing payment in (b), to whoever closes the box, which can be one of our keepers (5.4(c)).');
    // RC6 part 2 (F138; DRAFT FOR COUNSEL): every box has an inbox; no conversion wallet; a failed box's other tokens go to the payee.
    expect(item('5.19', 'e')).toContain('Tokens other than the pricing token in a failed box’s inbox go only to the creator’s payout address (5.17(f)).');
    expect(all()).not.toMatch(/conversion wallet|three wallets/);
    expect(item('5.19', 'e')).not.toContain('Nothing is moved to the FIT buy-back wallet');
    expect(item('5.17', 'f')).toContain('Every box other than box 0 has an inbox contract that receives its royalties and any token anyone sends it.');
    // Part 2 fix round (review finding, high): the receiver splits inbox pricing tokens like buyers' fees
    // (ReceiverBooksV21.split), so FIT's and Square Hole's fee shares of them reach the two wallets.
    expect(item('5.17', 'f')).toContain('Pricing tokens that reach the inbox, including what it gets for its sales, go into the box: they are held until graduation and from then on split like buyers’ fees, so FIT’s 2/15 and Square Hole’s 1/15 of them are paid to the FIT buy-back wallet and the platform wallet as fee shares (5.17(c)); if the box fails first, the held ones join the claim pot.');
    expect(clause('5.4')?.items?.find((candidate) => candidate.text.startsWith('(b)'))?.bullets?.join(' ')).toContain('Those shares include 2/15 and 1/15 of the pricing tokens that reach a box’s inbox, from royalties, gifts or its sales; no other token sent to a box reaches a Square Hole wallet (5.17(f)).');
    expect(all()).not.toMatch(/never reach a Square Hole wallet|No Square Hole wallet receives or handles/);
    // R1-1: the inbox registers its orders without ComposableCoW's broadcast; only a posted offer is open.
    expect(item('5.17', 'f')).toContain('An offer is open only once someone posts it to the CoW Protocol’s order book. Anyone may renew and post these offers; our keepers may do so, posting only when the CoW Protocol quotes the sale at a fee of about 5% of it or less, and we may stop (5.4(c)).');
    // The observed clock (BoxRoyaltyRouterV2._observe): a dust-leaving sale and repeated dust views keep it.
    expect(item('5.17', 'f')).toContain('The 30 days start when a public call sees the token in the inbox after it held none, and start again when one sees a sale that leaves at least one whole lot, or sees the balance pass one lot other than by a sale that leaves less than a lot; until a public call sees the token, its 30 days have not started, so the wait can be longer.');
    expect(item('5.17', 'f')).toContain('is offered for the pricing token on the CoW Protocol in whole lots of a fixed size, at most 20 lots an hour, at whatever price its solvers find: there is no minimum price, and nobody has to buy.');
    expect(item('5.17', 'f')).toContain('A token on the sale list that sells nothing for 30 days, and any other token (the box’s own token and other boxes’ tokens included), can be taken as it is by the creator’s payout address, and by nobody else.');
    expect(item('5.17', 'f')).toContain('Once a box has failed, its inbox offers nothing for sale: its tokens other than the pricing token can be taken at once by the creator’s payout address, and its pricing tokens join the claim pot (5.19). No other part of this money, and no token other than the pricing token, reaches a Square Hole wallet.');
    expect(item('5.19', 'e')).toContain('The share of tokens nobody hands in stays locked in the box forever. Money that arrives after the last holder’s claim stays locked forever too, and so does money other than inbox pricing tokens that arrives after the creator’s claim.');
    // F137: the plain hook's sale fee in the box's token, burned until graduation, then sold by the box in its own pool.
    expect(item('5.17', 'a')).toContain('a sale pays it in the box’s token, on the tokens sold. Until graduation, and in a box that fails, the sale fees are burned. After graduation, the box sells its sale fees for the pricing token in its own pool');
    expect(item('5.19', 'e')).toContain('You can claim through a block explorer even if the Services are unavailable.');
    expect(item('5.19', 'd')).toContain('divided by the tokens still counted, rounded down. The count is fixed when the box fails and falls only as tokens are handed in.');
    expect(item('5.19', 'd')).toContain('Money that reaches the pot later is shared by the claims made after it arrives; earlier claims get no share of it.');
    // RC6 (F137, F138): every holder claim moves the inbox's pricing tokens and the fee contract's money in first.
    expect(item('5.19', 'd')).toContain('Each holder’s claim first moves the pricing tokens waiting in the box’s inbox and the money held in the box’s fee contract into the pot, so that claim shares them; anyone can also move them with those contracts’ public functions. If a move fails, the claim pays from the pot alone, except that the last tokens still counted cannot be claimed while pricing tokens wait in the inbox.');
    expect(item('5.19', 'd')).not.toContain('joins the pot only when anyone calls its public collect');
    // INBOX af2: the no-buyer remainder plus later inbox pricing tokens, claimable again.
    expect(item('5.19', 'd')).toContain('the creator can claim the remainder fixed at the failure, after the closing payment, without expiry; pricing tokens that later reach the pot from the box’s inbox are added to it and can be claimed too, and nobody else can claim them.');
    expect(item('5.19', 'c')).toContain('FIT’s 2/15 and Square Hole’s 1/15 of the fees charged before the failure, including the split of the graduation reserve, are still paid');
    expect(item('5.19', 'c')).toContain('the money held for buy-backs, for adding to the pool and for items');
    expect(all()).not.toMatch(/one year|within a year|claims close|\bsweep|one closing price/i);
    expect(item('5.17', 'b')).toContain('A side cannot be split between choices, and no cap applies to it.');
    expect(item('5.17', 'c')).toContain('What happens next is done by us, not by code.');
    expect(item('5.17', 'c')).toContain('needs two of three signatures (the bot, the founder and a backup key)');
    // F213 (SH-245 T1, T1b, T1c, T2): Square Hole keeps its whole 1/15 of other boxes' fees; no cap policy is named.
    expect(item('5.17', 'd')).toBe('(d) **Square Hole’s part.** The platform wallet receives Square Hole’s whole 1/15 of every other box’s fees (5.17(c)), and Square Hole keeps it.');
    expect(all()).not.toMatch(/Square Hole’s cap|keeping to the cap|capped part|is our policy, not code|Square Hole’s share is capped \(5|16 ETH|from all boxes together/);
    expect(item('6.1', 'cc')).toContain('stay locked in the box forever. Nobody can take them out, including Square Hole (5.19(e)).');
    expect(item('6.1', 'cc')).toContain('the share of tokens nobody hands in and money that arrives after its last claim stay locked in the box forever.');
    expect(gate.bullets[3]).toContain('its holders can claim what is left, with no time limit; it is often far below what they paid, and the share nobody claims stays locked for good.');
    expect(document.readFirst.bullets).toContain('Outside box 0, nothing is sent to you: every payout waits until you claim it. The claim of a failed box never closes, but the share nobody claims stays locked for good (Sections 5.18 and 5.19).');
    // Box 0's stream: anyone may start a claim for its owner (5.12(c)), so the claim-only line names the other boxes.
    expect(item('5.12', 'c')).toContain('Anyone can start a claim for you, and it pays only you.');
    // Review FE7: what a failed box's tax becomes, the raise per listing, the gate's off-chain parts, the shop's curator.
    expect(gate.bullets[5]).toContain('It stays in the box and never goes to Square Hole. If the box fails, it joins the holders’ claim, and the share nobody claims stays locked for good.');
    expect(item('5.16', 'c')).toContain('Each box raises the amount the list names for its pricing token when the box is created (for ETH, 4.206980085 ETH at the date of these Terms)');
    expect(gate.bullets[4]).toContain('(for box 0, owners of Misfits outside the vault)');
    expect(gate.bullets[4]).toContain('and part goes to Square Hole. For boxes other than box 0, buying FIT is done by us, not by code.');
    expect(item('5.16', 'b')).toContain('in a shop, its curator can add collections (5.21(a))');
    expect(item('5.17', 'a')).toContain('if the box fails first, it joins the claim pot, 5.19(c)');
    expect(all()).not.toMatch(/Every box raises the same amount/);
    // F129: the edition size is the founder's to set; F120: no converter contract and no ETH-in helper remain.
    expect(item('5.6', 'a')).toContain('[FOUNDER: the final number of Misfits');
    expect(all()).not.toMatch(/4,269|4,200|converter|helper contract|humble creator|"eat"/i);
  });

  it('carries the release’s own figures', () => {
    const text = all();
    const pips = (value: number) => `${String(value / 10_000)}%`;
    for (const figure of [
      ABOUT_FACTS.raise,
      `${pips(ABOUT_FACTS.taxTable[0] ?? 0)} in the first step`,
      `${pips(ABOUT_FACTS.taxTable.at(-1) ?? 0)} in the last step`,
      `up to ${ABOUT_FACTS.taxFirst} of what is sent`,
      `For ${ABOUT_FACTS.window.replace(' min', ' minutes')} after a box opens`,
      `${ABOUT_FACTS.deadlines.slice(0, -1).join(', ')} or ${String(ABOUT_FACTS.deadlines.at(-1))} days`,
      `${ABOUT_FACTS.picks.slice(0, -1).join(', ')} or ${String(ABOUT_FACTS.picks.at(-1))}, as the creator chose`,
      `at most ${ABOUT_FACTS.stepTicks} ticks`,
      `${ABOUT_FACTS.fitSupply} FIT`,
      `a draw fee of ${ABOUT_FACTS.draw} of the quote`,
      `a premium of ${ABOUT_FACTS.pick} of the quote`,
      `a give-back fee of ${ABOUT_FACTS.giveBack} of the quote`,
    ]) {
      expect(text, figure).toContain(figure);
    }
    expect(item('5.19', 'b')).toContain('14 days after its planned opening');
    expect(item('5.19', 'b')).toContain('graduation has not succeeded 7 days later');
  });

  it('never presents burns, buy-backs, payouts or fee shares as yield, return, profit, value or growth (SEC staff FAQ Q2.5)', () => {
    const text = all();
    expect(text).not.toMatch(/\bAPY\b|\bAPR\b|passive income|number go up|to the moon|deflationary/i);
    expect(text).not.toMatch(/all fees are burned/i);
    expect(unnegatedReturnFraming([...terms(), ...notice()])).toEqual([]);
    expect(appCopyFraming([...terms(), ...notice()])).toEqual([]);
    expect(text).not.toMatch(/swap[- ]?backs?/i);
    expect(text).not.toMatch(/\btiers?\b/i);
    expect(text).not.toMatch(/shelf/i);
    expect(unnegatedReturnFraming([...terms(), ...notice()], /\bmint\w*/i)).toEqual([]);
    expect(item('5.10', 'e')).toMatch(/^\(e\) \*\*Give back\.\*\*/);
  });

  it('marks every fact it does not have with a placeholder: 55 in the Terms, 5 in the privacy notice (the evidence lists each)', () => {
    const inTerms = placeholdersIn(terms());
    const inNotice = placeholdersIn(notice());
    expect(inTerms).toHaveLength(55);
    expect(inNotice).toHaveLength(5);
    const owners = (list: readonly string[]) => list.reduce<Record<string, number>>((counts, entry) => {
      const owner = /^\[([A-Z +]+?)(?::|\s(?=[a-z]))/.exec(entry)?.[1] ?? '?';
      return { ...counts, [owner]: (counts[owner] ?? 0) + 1 };
    }, {});
    // SH-V2-FE10: 5.4(f)'s "[FOUNDER: how]" is answered (F133), and 8.4 gains the Icons check (F134 R46E).
    // SH-TERMS-ACCURACY: 5.17(c) gains the platform wallet's three signers, which F151 R68-SAFE leaves unnamed.
    expect(owners(inTerms)).toEqual({ COUNSEL: 42, FOUNDER: 5, 'FOUNDER + COUNSEL': 3, ENGINEERING: 5 });
    expect(owners(inNotice)).toEqual({ 'FOUNDER + COUNSEL': 1, COUNSEL: 3, ENGINEERING: 1 });
    // The gate: the sign-off and box 0's mainnet addresses, nothing else (SH-V2-FE9: the network itself is known, F131).
    expect(placeholdersIn([gate.status, ...gate.bullets])).toEqual([
      '[FOUNDER + COUNSEL: delete this line once counsel has approved the final text (counsel pack, Question 1).]',
      '[FOUNDER: box 0’s mainnet addresses once deployed (counsel pack, Question 1).]',
    ]);
    for (const text of [...terms(), ...notice()]) {
      expect(text.split('**').length % 2, text).toBe(1);
      expect((text.match(/\[/g) ?? []).length, text).toBe((text.match(/\]/g) ?? []).length);
      expect(text.replace(placeholders(), '')).not.toMatch(/\[|\]/);
    }
  });

  it('carries the founder’s facts of desk round 45 (F131, SH-V2-FE9) and keeps open only what they leave open', () => {
    // R45A: mainnet only, Sepolia on a separate test site; only box 0's addresses wait (gate 7, Read this first 3, 5.3(a)).
    const mainnet = 'At squarehole.fun, Square Hole runs on Ethereum mainnet only.';
    const addresses = '[FOUNDER: box 0’s mainnet addresses once deployed (counsel pack, Question 1).]';
    const testSite = 'The Sepolia test network has a separate test site.';
    expect(gate.bullets[6]).toBe(`${mainnet} ${addresses} ${testSite} On a test network, tokens have no value and give no right to any future token.`);
    for (const text of [document.readFirst.bullets[2] ?? '', item('5.3', 'a')]) {
      for (const part of [mainnet, addresses, testSite]) expect(text, part).toContain(part);
    }
    expect(all()).not.toMatch(/the networks this site serves|7ua|pages\.dev/);
    // R45B: the official addresses.
    expect(clause('1.2')?.text).toContain('the website at squarehole.fun, to squarehole.xyz and squarehole.fit, which redirect to it,');
    expect(clause('1.2')?.text).toContain('These are our official web addresses.');
    // R45C: the launch transactions, and no buying or selling; closing is not an app action (no button in 5.19(b)).
    const offered = clause('5.1')?.text ?? '';
    // SH-V2-FE10 (review): every transaction the app as built offers, beyond R45C's list where the build has the button:
    // closing a box (V2Actions), the item ledger's sync (ItemPayoutsV2), the pile's seed return (CoinPileV2), approvals.
    for (const action of ['creating a box;', 'claiming amounts a contract holds for your address (5.18), one by one or with "Claim all"', 'bringing a box’s item ledger up to date before an item claim (5.18(c));', 'closing a box that can be closed (5.19(b))', 'in a failed box, handing in your box tokens for your share of its pot (5.19(d));', 'if the box fails, returning the pile’s seed to its creator (5.21(b));', 'drawing a box’s NFTs from its vault and handing them back (5.10);', 'and the token approvals some of these need first.', 'The app offers no buying or selling (5.2(a)).']) {
      expect(offered, action).toContain(action);
    }
    expect(offered).not.toMatch(/picking|opening/);
    expect(item('5.19', 'b')).toContain('Anyone can then close it, through the Services or by calling its contracts,');
    expect(all()).not.toContain('"Close box" button');
    // R45D: no give-back-and-sell route today, possibly in a later version (About & risks says "None today").
    expect(item('5.2', 'a')).toContain('A combined route that gives an NFT back and sells the released tokens in one step is not offered today; it may come in a later version (3.5).');
    const risksPage = readFileSync(join(ROOT, 'apps/web/src/pages/RisksPage.tsx'), 'utf8');
    // SH-ALPHA-NOTICE: the strip's line follows the build (about-content.ts); without the trade code it says None today.
    expect(risksPage).toContain('<dt>In-app trading</dt>\n              <dd>{IN_APP_TRADING}</dd>');
    expect(IN_APP_TRADING).toBe('None today');
    expect(risksPage).not.toContain('now or later');
    // R45E was answered by F133 (the test below); R45F and R45G are written in, each with a counsel check.
    expect(item('5.4', 'f')).toContain('it does not trade the tokens of its own boxes, and FIT in its wallets moves only through our published daily bot (5.17(c)). [COUNSEL: check this policy');
    expect(clause('8.4')?.text).toContain('While you own a Misfit, you may use that Misfit, its picture and its 3D model, for personal and commercial purposes, including creating a box around it; the Square Hole name and logo stay Square Hole’s (8.5). [COUNSEL: check this licence.]');
    // R45J: the official channels.
    expect(clause('18.1')?.text).toBe('Questions about these Terms or the Services: hello@squarehole.fun. Our official channels: Telegram (https://t.me/+uB8u32UmcEBkOTA0) and X (https://x.com/squarehole_).');
    // Kept open: the edition size (F129), the engineering checks and the draft lines until counsel signs off.
    expect(item('5.6', 'a')).toContain('[FOUNDER: the final number of Misfits');
    // No answered item is still asked.
    expect(all()).not.toMatch(/confirm which of these|give-back-and-sell route will ever|confirm the official|licence for holders of Misfits|the trading policy that applies|Web Analytics is off|name the forwarding service|providers the app will use/);
  });

  it('applies F133 and desk round 46 (F134, SH-V2-FE10): our boxes listed by address, the policy’s scope, the coin pile, the Icons licence', () => {
    const own = item('5.4', 'f');
    // F133: never a mark; listed by contract address on About & risks and on X, box 0 first; the purpose; no approval.
    expect(own).toContain('No badge or label in the feed or on a box’s page says that a box is Square Hole’s own;');
    expect(own).toContain('Instead, the About & risks page lists them with their contract addresses, box 0 first, and we post the same addresses on X (18.1).');
    expect(own).toContain('The list discloses which boxes are Square Hole’s own and lets you check a box’s real contract address against copies (6.1(n)); it is not an approval of any box.');
    // The feed's "Featured" pin on box 0 (F46) is said for what it is (review FE10).
    expect(own).toContain('the feed shows box 0 first, marked "Featured", which is its place in the feed, not an approval.');
    expect(item('6.1', 'n')).toContain('About & risks lists the addresses of Square Hole’s own boxes (5.4(f)).');
    expect(all()).not.toMatch(/\[FOUNDER: how\]|The Services mark the boxes/);
    // R46D: the policy covers Square Hole itself; whether the team needs a rule stays with counsel.
    expect(own).toContain('Our policy, which covers Square Hole itself: it does not trade the tokens of its own boxes');
    expect(own).toContain('[COUNSEL: check this policy, and whether the founder and the people working with Square Hole need a rule too (Question 23).]');
    // R46C: the coin-pile hand-in is one of the app's transactions, as 5.21(b) describes it.
    expect(clause('5.1')?.text).toContain('after graduation, handing in box tokens to a box’s coin pile, which burns them, for your share of the pile,');
    expect(item('5.21', 'b')).toContain('anyone can hand in box tokens, which are burned, and receive exactly the pile multiplied by the tokens handed in and divided by the supply');
    // R46E: the 69 Icons carry the Misfit licence, building a box around one included; counsel checks the wording.
    const licence = clause('8.4')?.text ?? '';
    expect(licence).toContain('including creating a box around it');
    expect(licence).toContain('The 69 Icons (5.6(e)) are Misfits like any other and carry the same licence. It covers their art, not any brand they bring to mind. [COUNSEL: check the Icons wording.]');
    expect(item('5.6', 'e')).toContain('owning one gives no right in any brand');
    // R46F: the server's provider is not called "paid".
    expect(notice().join(' ')).toContain('Our server reads mainnet through its own provider; that does not involve your browser.');
    expect(notice().join(' ')).not.toMatch(/\bpaid provider\b/);
  });

  it('says what the silent reconnect does (F135): remembered on this device, asked without opening the wallet, forgotten on Disconnect', () => {
    expect(item('5.2', 'c')).toContain('If you connected a browser wallet on this device, the app remembers it here and, when you come back, asks that wallet, without opening it, whether it still shares your address; Disconnect makes it forget.');
    expect(item('5.2', 'c')).toContain('A wallet request that needs your approval only happens after you choose to connect and start an action.');
    expect(all()).not.toContain('Browsing never asks your wallet for anything');
    const wallets = PRODUCTION_PRIVACY_NOTICE.sections.find((entry) => entry.id === 'privacy-wallets')?.paragraphs?.join(' ') ?? '';
    expect(wallets).toContain('For a browser wallet it also keeps a record of the wallet and your address on this device; when you come back, it asks that wallet, without opening it, whether it still shares your address, and if so shows you connected. Disconnect removes that record.');
  });

  it('gives box 0 alone the RANDAO backup, with the rule BoxBackedSource fixes, and every other box drand alone (F143, SH-TERMS-ACCURACY)', () => {
    // The numbers come from the contract: a start after 5 days and until 5 days 18 hours, the block 256 later, and the
    // proof window of EIP-2935's 8,191 blocks (about 27 hours at 12 seconds).
    const backed = readFileSync(join(ROOT, 'packages/contracts/src/box/randomness/BoxBackedSource.sol'), 'utf8');
    for (const constant of ['uint256 public constant BACKUP_AFTER = 5 days;', 'uint256 public constant LATEST_START = 5 days + 18 hours;', 'uint256 public constant TARGET_BLOCKS = 256;', 'uint256 public constant HISTORY_WINDOW = 8191;', 'if (postedAt != 0) revert RoundAlreadyPosted(round);', 'if (b.startedAt != 0) revert BackupAlreadyStarted(round);']) {
      expect(backed, constant).toContain(constant);
    }
    // Box 0's factory pins that source; core v2's factory admits only the pinned DrandSource, which has no backup.
    expect(readFileSync(join(ROOT, 'packages/contracts/src/box/BoxFactoryV1.sol'), 'utf8')).toContain('if (!BackedSourcePins.isPinned(randomness_)) revert SourceNotPinned(randomness_);');
    expect(readFileSync(join(ROOT, 'packages/contracts/src/box-v2/BoxFactoryV2.sol'), 'utf8')).toContain('!DrandSourcePins.isPinned(r.randomness)');
    const random = item('5.11', 'b');
    expect(random).toContain('Box 0 has one backup, fixed in its contracts: if a drand round it asked for is still not posted on chain 5 days after the round was due, anyone can start the backup for that round, until 5 days 18 hours after it was due.');
    expect(random).toContain('Until someone does, anyone can still post the drand round, and whichever comes first counts.');
    expect(random).toContain('The backup is Ethereum’s own random number (RANDAO) of the block 256 blocks after the start, about 51 minutes later (the backup block). It becomes the round’s number once anyone posts the backup block’s data, which is possible for about 27 hours after that block.');
    expect(random).toContain('A round’s backup can start only once, and a round on its backup never uses drand’s number, even if drand’s is posted later.');
    expect(random).toContain('The validator that proposes the block just before the backup block can still choose between two numbers, by publishing its own block or not;');
    expect(random).toContain('If nobody posts the backup block’s data in time, the safety net of 5.11(f) applies. Every other box uses drand alone, with no backup.');
    expect(item('6.1', 'e')).toContain('Draws depend on random numbers from drand. Only box 0 has a backup, and only after 5 days: someone must start it and post the backup block’s data, and a validator can influence its number (5.11(b)).');
    expect(all()).not.toMatch(/There is no backup source|from drand, with no backup/);
  });

  it('gives the platform wallet two of three signatures, as F151 R68-SAFE decided for mainnet, and waits for its signers (SH-TERMS-ACCURACY)', () => {
    const decisions = readFileSync(join(ROOT, 'docs/decisions/DECISION-LOG.md'), 'utf8');
    expect(decisions).toContain('R68-SAFE "2of3": the mainnet platform Safe is 2-of-3 (Sepolia stays 1-of-1).');
    const parts = item('5.17', 'c');
    expect(parts).toContain('The platform wallet also needs two of three signatures [FOUNDER: who its three signers are on mainnet (F151 R68-SAFE set two of three and named none)].');
    // The FIT buy-back wallet's three stay named (F121, F122 R36I).
    expect(parts).toContain('The FIT buy-back wallet needs two of three signatures (the bot, the founder and a backup key)');
    expect(all()).not.toMatch(/founder alone signs|alone signs for the platform wallet/i);
  });

  it('names all three policies the code allows for items still in the vault: keep, burn and the box’s own pool (Depth; SH-TERMS-ACCURACY)', () => {
    // RecipeTypes.sol's three policies, all three admitted by the validator; Depth's share goes to the receiver's
    // pool bucket, Burn's to its buy-back (core v2.1 step 5).
    expect(readFileSync(join(ROOT, 'packages/contracts/src/box-v2/interfaces/RecipeTypes.sol'), 'utf8')).toContain('enum ItemsInsidePolicy { None, Keep, BuyBackBurn, Depth }');
    expect(readFileSync(join(ROOT, 'packages/contracts/src/box-v2/BoxSpecV2.sol'), 'utf8')).toContain('|| _pw(br.destParams, 0) == ITEMS_INSIDE_POLICY_DEPTH)) return (REASON_NOT_OFFERED, base + 4);');
    expect(readFileSync(join(ROOT, 'packages/contracts/src/box-v2/libraries/ReceiverBooksV21.sol'), 'utf8')).toContain('st._p[policy == 3 ? POOL : BUY_BACK] += retained;');
    expect(item('5.17', 'b')).toContain('For items still in the vault, the creator also chose whether their shares wait for the item’s next owner, buy the box’s token and burn it, or are added to the box’s own pool.');
    // The same words as the side's own pool choice.
    expect(item('5.17', 'b')).toContain('add it to the box’s own pool;');
  });

  it('ties every draft marker to the counsel sign-off: none may outlive it (review FE7)', () => {
    // While a sign-off placeholder stands, the text says "draft" everywhere it does today. Once counsel signs off and the
    // placeholders go, this test fails until the version, the version line, the closing line and the notice drop "draft"
    // too (the pages show their "Draft" chip only while the status line says DRAFT).
    const signOffs = placeholdersIn([gate.status, document.status, document.closing, PRODUCTION_PRIVACY_NOTICE.status]).filter((entry) => entry.includes('once counsel has approved'));
    const markers = [PRODUCTION_TERMS.version, document.versionLine, document.closing, gate.status, document.status, PRODUCTION_PRIVACY_NOTICE.status, PRODUCTION_PRIVACY_NOTICE.versionLine];
    if (signOffs.length > 0) {
      expect(signOffs).toHaveLength(4);
      for (const marker of markers) expect(marker, marker).toMatch(/draft/i);
    } else {
      for (const marker of markers) expect(marker, marker).not.toMatch(/draft|not yet reviewed/i);
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(PRODUCTION_TERMS)).toBe(true);
    expect(Object.isFrozen(gate.bullets)).toBe(true);
    expect(Object.isFrozen(section('5')?.clauses)).toBe(true);
    expect(Object.isFrozen(clause('5.4')?.items?.[1]?.bullets)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_PRIVACY_NOTICE.sections[1]?.bullets)).toBe(true);
  });

  it('keeps words the browser audits forbid in controls out of the gate controls and section titles', () => {
    for (const label of [gate.checkbox, gate.accept, gate.decline, gate.reviewAgain, gate.fullTermsLink]) expect(label, label).not.toMatch(/\b(buy|sell|swap)\b|amount/i);
    for (const entry of sections) expect(entry.title, entry.title).not.toMatch(/\b(buy|sell|swap)\b/i);
  });
});

describe('production privacy notice (SH-V2-FE7, DRAFT FOR COUNSEL)', () => {
  it('has the same four sections as the development notice, and no Demo or local chain', () => {
    expect(PRODUCTION_PRIVACY_NOTICE.sections.map((entry) => entry.id)).toEqual(PRIVACY_NOTICE.sections.map((entry) => entry.id));
    const text = notice().join(' ');
    expect(text).not.toMatch(/(?<![A-Za-z])(?:demo|mock)s?(?![a-z])|local chain|this build/i);
    expect(PRODUCTION_PRIVACY_NOTICE.versionLine).toBe('Draft of 11 October 2026');
  });

  it('names the host’s analytics, the mail route and the mainnet providers the founder gave (F131 R45H, R45I, R45K)', () => {
    const [host, server, providers, , , email] = PRODUCTION_PRIVACY_NOTICE.sections[1]?.bullets ?? [];
    expect(host).toContain('We also use Cloudflare Web Analytics, Cloudflare’s count of visits and page loads. [COUNSEL: Cloudflare’s role and how long it keeps these records.]');
    expect(PRODUCTION_PRIVACY_NOTICE.summary.bullets).toContain('Apart from Cloudflare Web Analytics, our host’s count of visits, the site contains no analytics, advertising or tracking code.');
    expect(email).toContain('Mail to hello@ or hi@ at squarehole.fun, squarehole.xyz or squarehole.fit is forwarded by Cloudflare Email Routing to a Gmail mailbox.');
    expect(email).toContain('[COUNSEL: how long we keep emails.]');
    expect(providers).toContain('On Ethereum mainnet the app reads the chain through Infura, with PublicNode as a fallback, and through our own indexer on our server (above).');
    // The indexer line says what the server line says (FE7's correction): it receives the wallet addresses shown.
    expect(providers).toContain('our indexer receives the wallet addresses whose boxes and claims the app shows');
    expect(server).toContain('so the server receives that wallet address together with your IP address and browser details');
    expect(notice().join(' ')).not.toMatch(/\[FOUNDER(?!\s\+\sCOUNSEL: delete "DRAFT)/);
  });

  it('says what the production app sends our server: the wallet addresses whose boxes and claims it shows (core-client loadWallet, claims-index)', () => {
    const text = notice().join(' ');
    expect(text).toContain('the server receives that wallet address together with your IP address and browser details');
    expect(text).not.toContain('It does not send your address to Square Hole.');
    for (const kept of [
      'Square Hole has no accounts and asks for no name, email address or other contact details.',
      // LINKS-WEB: the one thing the app sends: links a creator signs for a box they made.
      'The app keeps your choices on your device only, and sends none of them to us, except links you sign for a box you made.',
      'Wallet addresses and transactions are public on the blockchain, for anyone to see, for good.',
      'Our host sees your IP address with every page request, like any website.',
      // F131 R45H: Cloudflare Web Analytics is on, so the no-analytics line names it (the test above).
      'the site contains no analytics, advertising or tracking code.',
      'Wallet extensions run their own code in your browser.',
    ]) {
      expect(text, kept).toContain(kept);
    }
    expect(unnegatedReturnFraming(notice())).toEqual([]);
    expect(appCopyFraming(notice())).toEqual([]);
  });
});
