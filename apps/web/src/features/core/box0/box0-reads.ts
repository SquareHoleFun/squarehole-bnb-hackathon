/**
 * Box 0's public reads for its action panel (SH-BOX0-ACTIONS): the tickets' phase and word, the latest block's time, the
 * vault's quote for one draw, and, for a connected address, its placeholders' numbers and approvals, its open draws
 * and its stream share. Plain RPC reads of public state: no wallet is asked anything (the address is the one the app
 * already shows as connected). The ids come from the indexer's wallet answer and this session's own draws.
 */
import { boxItemStreamAbi, boxTicketsAbi, boxVaultAbi } from '@squarehole/chain/abi';
import { createPublicClient, encodeFunctionData, erc20Abi, http, zeroAddress, type Address, type Hex } from 'viem';
import { PHASE, TAKE_DELAY, type DrawRead, type PlaceholderRead } from './box0-model';
import type { Box0Roles } from './box0-send';
import { findTakeable, takeSearchStart, takeSpan, type TakeCandidate } from './box0-terminal';

export interface Box0Reads {
  readonly phase: number;
  readonly wordAcceptedAt: bigint;
  readonly now: bigint;
  /** The vault's quote for one draw (principal + 1% fee); null when it refuses (no hidden item). */
  readonly quote: bigint | null;
  readonly placeholders: readonly PlaceholderRead[];
  readonly draws: readonly DrawRead[];
  /** The stream's `owedOf(address)`, each held item's `pendingOf`, and the T it holds. */
  readonly owed: bigint;
  readonly items: readonly bigint[];
  readonly pending: readonly bigint[];
  readonly held: bigint;
  /** SH-BOX0-EXITS: the tickets' q, when the graduation word was requested, and when terminal mode began (0: never). */
  readonly slots: bigint;
  readonly wordRequestedAt: bigint;
  readonly terminalAt: bigint;
  /**
   * The queue's head is dead: `enterTerminal` would succeed now (simulated; a public eth_call, no wallet). Read only to
   * keep a draw that would revert `QueueDead` off the page; the page never sends `enterTerminal` (F142).
   */
  readonly headDead: boolean;
  /** Terminal mode: what one ticket's release pays now (`quoteHandBack(1)`, net); null otherwise or when it refuses. */
  readonly refund: bigint | null;
  /** Terminal mode, from TAKE_DELAY: one hidden item a take by number may name; null when none is found. */
  readonly take: TakeCandidate | null;
}

export interface Box0Holdings {
  readonly tickets: readonly bigint[];
  readonly draws: readonly bigint[];
  readonly items: readonly bigint[];
}

export const NO_HOLDINGS: Box0Holdings = Object.freeze({ tickets: [], draws: [], items: [] });

const clients = new Map<string, ReturnType<typeof createPublicClient>>();
const clientOf = (rpcUrl: string) => {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
    clients.set(rpcUrl, client);
  }
  return client;
};

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n);

type Client = ReturnType<typeof createPublicClient>;
interface StatusRead {
  readonly slots?: unknown;
  readonly wordRequestedAt?: unknown;
  readonly wordAcceptedAt?: unknown;
  readonly terminalAt?: unknown;
  readonly drawsSettled?: unknown;
}

const ENTER_TERMINAL: Hex = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'enterTerminal' });

/**
 * SH-BOX0-EXITS: what the ways out of a stopped draw need. Public reads only. Whether the queue's head is dead is the
 * contract's own `_head` (private): the page simulates `enterTerminal` (eth_call) instead of mirroring it, and never
 * sends it (F142). Any read that fails leaves its exit off (never on).
 */
async function readExits(client: Client, roles: Box0Roles, phase: number, status: StatusRead, now: bigint, quote: bigint | null) {
  const s = { slots: big(status.slots), wordRequestedAt: big(status.wordRequestedAt), terminalAt: big(status.terminalAt) };
  const tickets = { address: roles.tickets, abi: boxTicketsAbi } as const;
  let headDead = false;
  if (phase === PHASE.AwaitingWord || phase === PHASE.Drawing) {
    try {
      await client.call({ to: roles.tickets, data: ENTER_TERMINAL });
      headDead = true;
    } catch {
      headDead = false;
    }
  }
  if (phase !== PHASE.Terminal) return { ...s, headDead, refund: null, take: null };
  const refund = await client.readContract({ address: roles.vault, abi: boxVaultAbi, functionName: 'quoteHandBack', args: [1n] }).then(([principal, fee]) => principal - fee, () => null);
  let take: TakeCandidate | null = null;
  if (quote !== null && now >= s.terminalAt + TAKE_DELAY) {
    try {
      const [word, firstId, size] = await Promise.all([
        client.readContract({ ...tickets, functionName: 'graduationWord' }),
        client.readContract({ ...tickets, functionName: 'firstId' }),
        client.readContract({ ...tickets, functionName: 'collectionSize' }),
      ]);
      const counts = { slots: s.slots, wordAcceptedAt: big(status.wordAcceptedAt), drawsSettled: big(status.drawsSettled) };
      // A random start: takes stay in the pool, so a walk from index 0 would stop finding one after 64 of them.
      take = await findTakeable(counts, { word, firstId, size }, {
        positionAt: (index) => client.readContract({ ...tickets, functionName: 'poolPositionAt', args: [index] }),
        isHidden: (id) => client.readContract({ address: roles.vault, abi: boxVaultAbi, functionName: 'isHidden', args: [id] }),
      }, undefined, takeSearchStart(takeSpan(counts, size)));
    } catch {
      take = null;
    }
  }
  return { ...s, headDead, refund, take };
}

export async function readBox0(rpcUrl: string, roles: Box0Roles, account: Address | null, holdings: Box0Holdings): Promise<Box0Reads> {
  const client = clientOf(rpcUrl);
  const tickets = { address: roles.tickets, abi: boxTicketsAbi } as const;
  const stream = { address: roles.stream, abi: boxItemStreamAbi } as const;
  const [phase, status, block, quote] = await Promise.all([
    client.readContract({ ...tickets, functionName: 'phase' }),
    client.readContract({ ...tickets, functionName: 'status' }),
    client.getBlock({ blockTag: 'latest' }),
    client.readContract({ address: roles.vault, abi: boxVaultAbi, functionName: 'quoteTake', args: [1n] }).then(([principal, fee]) => principal + fee, () => null),
  ]);
  const exits = await readExits(client, roles, Number(phase), status, block.timestamp, quote);
  const base = { phase: Number(phase), wordAcceptedAt: big(status.wordAcceptedAt), now: block.timestamp, quote, ...exits };
  if (account === null) return { ...base, placeholders: [], draws: [], owed: 0n, items: [], pending: [], held: 0n };
  const [placeholders, draws, owed, pending, held] = await Promise.all([
    // The indexer's list can be a block behind: a placeholder opened since then reverts NonexistentToken here, and is
    // left out rather than failing every read of the panel (review of SH-BOX0-ACTIONS).
    Promise.all(holdings.tickets.map(async (id): Promise<PlaceholderRead | null> => {
      try {
        const [number, approved] = await Promise.all([client.readContract({ ...tickets, functionName: 'numberOf', args: [id] }), client.readContract({ ...tickets, functionName: 'getApproved', args: [id] })]);
        return { id, number, approved: approved === zeroAddress ? null : approved };
      } catch {
        return null;
      }
    })).then((list) => list.filter((p): p is PlaceholderRead => p !== null)),
    Promise.all(holdings.draws.map(async (id): Promise<DrawRead> => {
      const d = await client.readContract({ ...tickets, functionName: 'drawTicket', args: [id] });
      return { id, drawer: d.drawer, status: Number(d.status), itemId: d.itemId, fallbackAt: d.revealFallbackAt };
    })),
    client.readContract({ ...stream, functionName: 'owedOf', args: [account] }),
    // A pending share is booked to the item's recorded owner (`_credit`): it counts for this claim only when that is us.
    Promise.all(holdings.items.map(async (id) => {
      const [owner, amount] = await client.readContract({ ...stream, functionName: 'pendingOf', args: [id] });
      return owner.toLowerCase() === account.toLowerCase() ? amount : 0n;
    })),
    client.readContract({ address: roles.token, abi: erc20Abi, functionName: 'balanceOf', args: [roles.stream] }),
  ]);
  // Only the drawer's own draws (an id from this session is checked here too).
  const mine = draws.filter((d) => d.drawer.toLowerCase() === account.toLowerCase());
  return { ...base, placeholders, draws: mine, owed, items: holdings.items, pending, held };
}
