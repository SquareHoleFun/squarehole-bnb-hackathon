/**
 * SH-251: whether Create shows its way to the examples, in ONE place. The founder (desk, 23 November 2026 13:47): the
 * examples are shown inside the app, at `EXAMPLES_PATH`, which SH-252 builds. On since both tasks
 * are merged (24 November 2026): Create shows three ways in. Off, it shows the switch between the steps and the
 * picture alone.
 */
// SH-324: on both test networks. A BNB Chain testnet build carries the page's BNB version (build/testnet-output.ts lays
// build/examples-bnb over it and fails without it); until then (SH-258) it left the way out, as the page said ETH.
export const EXAMPLES_IN_APP: boolean = true;
export const EXAMPLES_PATH = '/examples';
