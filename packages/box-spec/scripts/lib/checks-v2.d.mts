/** Types for checks-v2.mjs's boolean folding (ticket M1-10-b): each takes and returns true, false or an expression. */
export type Folded = boolean | string;
export declare function AND(xs: readonly Folded[]): Folded;
export declare function OR(xs: readonly Folded[]): Folded;
export declare function NOT(x: Folded): Folded;
