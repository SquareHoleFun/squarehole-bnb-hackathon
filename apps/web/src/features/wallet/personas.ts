/**
 * Picker copy for the demo personas (ADR-0008 "Demo personas"). Qualitative on purpose: the numbers live in the
 * accounts fixture and are shown by the portfolio and rewards pages, so this text cannot drift from them.
 *
 * Two more personas come from the box mock-up (SH-BOX-UI-launch): wallet A during the curve and wallet B after
 * graduation. They hold Demo boxes (boxes/wallet-box.ts) and have no ledger in the accounts fixture, so the portfolio
 * and claims pages show them empty; the three older personas show an empty My Box. The picker offers Never held and
 * the two box wallets only (SH-V2-FE11): the other two held the first handoff's pairs, which no page shows any more.
 */
import type { Address, DemoPersona } from '@squarehole/domain';
import { DEMO_PERSONAS } from '@squarehole/providers';
import { createContext } from 'react';

/** A persona the demo wallet can connect as: the accounts fixture's three, or one of the two box wallets. */
export interface WalletPersona {
  readonly id: string;
  readonly label: string;
  readonly address: Address;
}

export interface PersonaCopy {
  readonly title: string;
  readonly description: string;
}

export const DEMO_WALLET_A = '0xDe00000000000000000000000000000000000A11' as Address;
export const DEMO_WALLET_B = '0xdE00000000000000000000000000000000000B22' as Address;

/** The box mock-up's two wallets (Demo). */
export const BOX_PERSONAS: readonly WalletPersona[] = Object.freeze([
  { id: 'box_wallet_a', label: 'Wallet A', address: DEMO_WALLET_A },
  { id: 'box_wallet_b', label: 'Wallet B', address: DEMO_WALLET_B },
]);

/** Every persona the demo wallet can connect as (the adapter's list), in the picker's order. */
export const WALLET_PERSONAS: readonly WalletPersona[] = Object.freeze([...(DEMO_PERSONAS as readonly DemoPersona[]), ...BOX_PERSONAS]);

/** The holders of the first handoff's pairs: their holdings show on no page since F134 R46B (SH-V2-FE11, FE10 point 3). */
const PAIR_HOLDERS: ReadonlySet<string> = new Set(['current_holder', 'past_holder']);

/** What the sample wallet's picker offers: every persona but the pair holders. */
export const PICKER_PERSONAS: readonly WalletPersona[] = Object.freeze(WALLET_PERSONAS.filter((persona) => !PAIR_HOLDERS.has(persona.id)));

/**
 * The picker's list (default PICKER_PERSONAS). Test seam: the first handoff's page tests, which mount those pages for
 * their own sake (src/test-support/legacy-pages.tsx), offer every persona again.
 */
export const PickerPersonasContext = createContext<readonly WalletPersona[]>(PICKER_PERSONAS);

const COPY: ReadonlyMap<string, PersonaCopy> = new Map([
  [
    'current_holder',
    {
      title: 'Current holder',
      description: 'Holds ORCHARD (whole NFTs plus a fraction), FRAME and ROUND. Has credited fees to claim and one settled claim.',
    },
  ],
  [
    'past_holder',
    {
      title: 'Past holder',
      description: 'Sold everything but still has credited, unclaimed fees, including one paid out in the pair’s own token.',
    },
  ],
  [
    'never_held',
    {
      title: 'Never held',
      description: 'A fresh account with no positions and nothing to claim.',
    },
  ],
  ['box_wallet_a', { title: 'Box wallet A', description: 'During the curve: FIT, two sealed Misfits and Clay Pots tokens. Opens My Box.' }],
  ['box_wallet_b', { title: 'Box wallet B', description: 'After graduation: Misfits, Toy Trains tokens and toy blocks, and FIT. Opens My Box.' }],
]);

/** Known personas get a title and description; any other fixture persona falls back to its own label. */
export function personaCopy(persona: WalletPersona): PersonaCopy {
  return COPY.get(persona.id) ?? { title: persona.label, description: 'Sample account.' };
}
