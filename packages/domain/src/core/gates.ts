/**
 * The fourteen v2 gates (square-hole-core-v2/decisions/gates.json; written "v2-G01".."v2-G14" in our docs, because
 * older ADRs reuse G01–G08 with the first handoff's meanings). A gate is CLOSED only by an accepted ADR with evidence
 * (v2 docs/11: "Do not leave an unapproved default in code and mark the gate closed"). A founder answer that is not
 * yet recorded that way is ANSWERED, which still blocks live use.
 */
import { z } from 'zod';

export const CORE_GATE_IDS = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14'] as const;
export type GateId = (typeof CORE_GATE_IDS)[number];

export interface CoreGate {
  readonly id: GateId;
  /** Title as in v2 decisions/gates.json. */
  readonly title: string;
  /**
   * The gate blocks something that moves or promises money ("blocks" in gates.json). G12 (live market-cap
   * leaderboard) and G13 (art publication) do not. A live-ready manifest needs every gate closed either way.
   */
  readonly moneyMoving: boolean;
}

const gate = (id: GateId, title: string, moneyMoving = true): CoreGate => Object.freeze({ id, title, moneyMoving });

export const CORE_GATES: readonly CoreGate[] = Object.freeze([
  gate('G01', 'Chain, Q and real routes'),
  gate('G02', 'Funding target reference'),
  gate('G03', 'Genesis, curve, graduation and failure'),
  gate('G04', 'Empty vault'),
  gate('G05', 'Exact fee incidence and precision'),
  gate('G06', 'Unsolicited transfers and custody controls'),
  gate('G07', 'Revenue temporal model'),
  gate('G08', 'Selection, reveal and rarity'),
  gate('G09', 'Core privileges and recovery'),
  gate('G10', 'Dependencies and independent review'),
  gate('G11', 'Claim settlement and fees'),
  gate('G12', 'Metrics and data coverage', false),
  gate('G13', 'Artwork and on-chain publication', false),
  gate('G14', 'Actual launch-scale tests and authorization'),
]);

export function isGateId(value: unknown): value is GateId {
  return typeof value === 'string' && (CORE_GATE_IDS as readonly string[]).includes(value);
}

export function coreGate(id: GateId): CoreGate {
  const found = CORE_GATES.find((entry) => entry.id === id);
  if (!found) throw new RangeError(`Unknown gate ${id}`);
  return found;
}

// --- Gate records (in a manifest) -----------------------------------------------------------------------------------

export type GateRecord =
  | { readonly id: GateId; readonly status: 'OPEN' }
  /** A founder answer (DECISION-LOG row, e.g. "F23") not yet accepted as an ADR with traces and tests. */
  | { readonly id: GateId; readonly status: 'ANSWERED'; readonly founderRows: readonly string[] }
  | { readonly id: GateId; readonly status: 'CLOSED'; readonly adr: string; readonly evidence: readonly string[] };

export const ADR_PATTERN = /^ADR-[0-9]{4}$/;
export const FOUNDER_ROW_PATTERN = /^F[0-9]{2,3}$/;

/** A short reference to a document (repo path, anchor or URL). Not free text. */
export const refField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s]+$/, 'must be a single reference without spaces');

export const gateIdField = z.enum(CORE_GATE_IDS);

export const gateRecordSchema: z.ZodType<GateRecord> = z.discriminatedUnion('status', [
  z.strictObject({ id: gateIdField, status: z.literal('OPEN') }),
  z.strictObject({ id: gateIdField, status: z.literal('ANSWERED'), founderRows: z.array(z.string().regex(FOUNDER_ROW_PATTERN)).min(1) }),
  z.strictObject({ id: gateIdField, status: z.literal('CLOSED'), adr: z.string().regex(ADR_PATTERN), evidence: z.array(refField).min(1) }),
]);
