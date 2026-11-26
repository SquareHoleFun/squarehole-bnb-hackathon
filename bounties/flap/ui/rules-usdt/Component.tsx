import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Square Hole: a creation form and a sale page for one of our rules curve launcher factories on BSC Testnet
// (bounties/flap/src/RulesCurveLauncherFactory.sol and RulesTokenCurveLauncherFactory.sol). Built from Flap's launcher-config-preview/v1 template;
// see bounties/flap/ui/README.md for the template commit, the checks and the ZIP.
// Amounts are bigint in logic and decimal strings at the host boundary (wei, base units, seconds).

type Messages = Record<string, string>;
type Identity = Readonly<{ chainId: number; factoryAddress: string }>;
type Wallet = Readonly<{
  account: string | null;
  chainId: number | null;
  pendingHash?: string | null;
  connect(): void;
  switchChain(): Promise<void>;
}>;
type Action = "complete" | "claim" | "unwind";
type Submission = { status: "success" | "pending" | "reverted" | "unverified"; hash: string; launcherAddress?: string };
type AbiParameter = { name: string; type: string; components?: readonly AbiParameter[] };
type Host = Readonly<{
  wallet?: Wallet;
  quote?(): Promise<string | null>;
  encode?(parameters: readonly AbiParameter[], values: readonly unknown[]): string;
  findSalt?(): Promise<string>;
  submit?(input: { kind: "create"; configuration: string; valueWei: string }
    | { kind: "action"; action: Action; valueWei?: string }): Promise<Submission>;
  checkReceipt?(hash: string): Promise<Submission>;
  refresh?(): void;
  redirect?(path: string): boolean;
  openLauncher?(address: string): void;
}>;
type ConfigProps = {
  context: Readonly<{ identity: Identity; locale: string; previewOnly?: boolean }>;
  messages: Messages;
  host?: Host;
};
type Snapshot = Readonly<{
  raised?: string | null;
  target?: string | null;
  deadline?: string | null;
  launched?: boolean | null;
  token?: string | null;
  predictedToken?: string | null;
  costToComplete?: string | null;
  holderCount?: string | null;
  creator?: string | null;
  pileVault?: string | null;
  bought?: string | null;
  claimable?: string | null;
  owed?: string | null;
}>;
type DetailProps = {
  context: Readonly<{
    identity: Identity;
    locale: string;
    previewOnly?: boolean;
    launcherAddress: string | null;
    snapshot: Snapshot | null;
  }>;
  messages: Messages;
  host?: Host;
};

// ── This factory ───────────────────────────────────────────────────────────────────────────────────────────────────
// The only lines in which rules-bnb and rules-usdt differ (bounties/flap/ui/test/rules-ui.test.mjs checks it).
// Keep them aligned with manifest.json and bounties/flap/deployments/97-v2-rules-usdt.json.
const factoryAddress = "0x61873ad21f3e471910c976ef7993ed40b399eec0";
// complete(maxCost) takes an argument and the quote needs an approval: Flap's host cannot send it, so buying is on our page.
const buyRestHere = false;
// The entry's defaults in the quote (bounties/flap/script/CreateRulesSale.s.sol, VARIANT=usdt).
const defaultRaise = "1700";
const defaultDepth = "11600";
// The largest raise the factory accepts: a V2 reserve holds 112 bits (RulesTokenCurveLauncherFactory.checkConfig).
const raiseCap: bigint | null = 2n ** 112n - 1n;
// ── End of the factory's lines ─────────────────────────────────────────────────────────────────────────────────────

const chainId = 97;
// The Pool Launch Portal and the tax-token implementation it clones (bounties/flap/script/CreateRulesSale.s.sol).
const portalAddress = "0x000042108465206185a077edc3f3fd2b49060000";
const tokenImplementation = "0x7777c57ff7dc441c1715b2e36fa581c48b782222";
// Our own launch pages (hackathon/public/README.md). Shown as text: Flap's template forbids raw off-site links.
const ourSite = "https://138-197-196-174.sslip.io/launches/";

const addressPattern = /^0x(?!0{40}$)[0-9a-f]{40}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const unsigned = /^(0|[1-9][0-9]{0,77})$/;
const wad = 10n ** 18n;

// The factory's bounds (RulesCurveLauncherFactory.sol): duration 5 minutes to 30 days, curve fee at most 5%, each tax
// 0 or 1% to 10%, burned part below 100%, tax for at least a day.
const maxHours = 720n;
const maxFeeBps = 500n;
const minTaxBps = 100n;
const maxTaxBps = 1000n;
const maxTaxSeconds = 4_294_967_295n;
// The curve's bounds (checkConfig and curveFor): the pool gets at least one whole token, the raise is the target
// within one millionth, and the supply (sale plus pool) is 100 to 10^15 whole tokens.
const minPoolToken = wad;
const raiseToleranceDivisor = 1_000_000n;
const minSupply = 100n * wad;
const maxSupply = 10n ** 15n * wad;

// The factory decodes `abi.decode(data, (CurveConfig))` (RulesCurveLauncher.sol, struct CurveConfig).
const configParameters: readonly AbiParameter[] = [
  { name: "config", type: "tuple", components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "meta", type: "string" },
    { name: "salt", type: "bytes32" },
    { name: "saleTokens", type: "uint256" },
    { name: "targetRaise", type: "uint256" },
    { name: "virtualBnb", type: "uint256" },
    { name: "duration", type: "uint64" },
    { name: "tradeFeeBps", type: "uint16" },
    { name: "buyTaxBps", type: "uint16" },
    { name: "sellTaxBps", type: "uint16" },
    { name: "burnShareBps", type: "uint16" },
    { name: "taxDuration", type: "uint32" },
  ] },
];

type Config = {
  name: string; symbol: string; meta: string; saleTokens: bigint; targetRaise: bigint; virtualBnb: bigint;
  duration: bigint; tradeFeeBps: bigint; buyTaxBps: bigint; sellTaxBps: bigint; burnShareBps: bigint; taxDuration: bigint;
};

function configValues(c: Config, salt: string): readonly unknown[] {
  return [{
    name: c.name, symbol: c.symbol, meta: c.meta, salt,
    saleTokens: c.saleTokens, targetRaise: c.targetRaise, virtualBnb: c.virtualBnb, duration: c.duration,
    tradeFeeBps: c.tradeFeeBps, buyTaxBps: c.buyTaxBps, sellTaxBps: c.sellTaxBps,
    burnShareBps: c.burnShareBps, taxDuration: c.taxDuration,
  }];
}

// ── Amounts ────────────────────────────────────────────────────────────────────────────────────────────────────────

function asUnits(value: string | null | undefined) {
  return typeof value === "string" && unsigned.test(value) ? BigInt(value) : null;
}

function decimalAmount(value: bigint) {
  const fraction = (value % wad).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / wad).toString() + (fraction ? "." + fraction : "");
}

/** A decimal with up to 18 places into base units, or null. */
function parseAmount(text: string) {
  const match = /^([0-9]{1,16})(?:\.([0-9]{1,18}))?$/.exec(text.trim());
  return match ? BigInt(match[1]) * wad + BigInt((match[2] ?? "").padEnd(18, "0")) : null;
}

/** A percent with up to two places into basis points, or null. */
function parsePercent(text: string) {
  const match = /^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  return match ? BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0")) : null;
}

function parseWhole(text: string) {
  return /^[0-9]{1,6}$/.test(text.trim()) ? BigInt(text.trim()) : null;
}

function percentText(bps: bigint) {
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return (bps / 100n).toString() + (fraction ? "." + fraction : "") + "%";
}

// ── The token address: keccak-256 and CREATE2 ──────────────────────────────────────────────────────────────────────
// A sale needs a salt whose token address ends in 7777 (RulesCurveLauncherFactory.checkConfig). The Portal makes the
// token as an OpenZeppelin EIP-1167 clone with CREATE2, so the address is computed here exactly as the factory's
// predictToken does, and a salt is mined when the host's salt does not fit this token implementation.

const roundLow = [0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002,
  0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008];
const roundHigh = [0, 0, 0x80000000, 0x80000000, 0, 0, 0x80000000, 0x80000000, 0, 0, 0, 0, 0, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x80000000, 0, 0x80000000, 0x80000000, 0x80000000, 0, 0x80000000];
const piLanes = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const rhoShifts = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

function permute(s: Uint32Array) {
  const c = new Uint32Array(10);
  const row = new Uint32Array(10);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const next = (x + 1) % 5, prev = (x + 4) % 5;
      const low = c[2 * prev] ^ ((c[2 * next] << 1) | (c[2 * next + 1] >>> 31));
      const high = c[2 * prev + 1] ^ ((c[2 * next + 1] << 1) | (c[2 * next] >>> 31));
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= low; s[2 * (x + y) + 1] ^= high; }
    }
    let low = s[2], high = s[3];
    for (let t = 0; t < 24; t++) {
      const j = piLanes[t], r = rhoShifts[t];
      const keepLow = s[2 * j], keepHigh = s[2 * j + 1];
      if (r < 32) {
        s[2 * j] = (low << r) | (high >>> (32 - r));
        s[2 * j + 1] = (high << r) | (low >>> (32 - r));
      } else {
        s[2 * j] = (high << (r - 32)) | (low >>> (64 - r));
        s[2 * j + 1] = (low << (r - 32)) | (high >>> (64 - r));
      }
      low = keepLow; high = keepHigh;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 10; x++) row[x] = s[2 * y + x];
      for (let x = 0; x < 5; x++) {
        const a = (x + 1) % 5, b = (x + 2) % 5;
        s[2 * (y + x)] = row[2 * x] ^ (~row[2 * a] & row[2 * b]);
        s[2 * (y + x) + 1] = row[2 * x + 1] ^ (~row[2 * a + 1] & row[2 * b + 1]);
      }
    }
    s[0] ^= roundLow[round];
    s[1] ^= roundHigh[round];
  }
}

/** keccak-256 of up to 135 bytes (one block, which is all this page hashes). */
function keccak(bytes: Uint8Array) {
  const s = new Uint32Array(50);
  const block = new Uint8Array(136);
  block.set(bytes);
  block[bytes.length] ^= 0x01;
  block[135] ^= 0x80;
  for (let i = 0; i < 136; i++) s[i >> 2] ^= block[i] << (8 * (i & 3));
  permute(s);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (s[i >> 2] >>> (8 * (i & 3))) & 0xff;
  return out;
}

function fromHex(hex: string) {
  const digits = hex.slice(2);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array) {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

const cloneCode = (() => {
  const code = new Uint8Array(55);
  code.set(fromHex("0x3d602d80600a3d3981f3363d3d373d3d3d363d73"), 0);
  code.set(fromHex(tokenImplementation), 20);
  code.set(fromHex("0x5af43d82803e903d91602b57fd5bf3"), 40);
  return keccak(code);
})();

/** The token address the Portal creates for `salt` (lower case). */
function predictToken(salt: string) {
  const input = new Uint8Array(85);
  input[0] = 0xff;
  input.set(fromHex(portalAddress), 1);
  input.set(fromHex(salt), 21);
  input.set(cloneCode, 53);
  return toHex(keccak(input).slice(12));
}

function fitsToken(salt: string) {
  return hashPattern.test(salt) && predictToken(salt).endsWith("7777");
}

/** keccak256(abi.encode(seed, i)) for i = 0, 1, ... until the token address ends in 7777 (about 65,536 tries). */
async function mineSalt(seed: Uint8Array) {
  const word = new Uint8Array(64);
  word.set(seed.slice(0, 32), 0);
  for (let i = 0; i < 4_000_000; i++) {
    word[60] = (i >>> 24) & 0xff; word[61] = (i >>> 16) & 0xff; word[62] = (i >>> 8) & 0xff; word[63] = i & 0xff;
    const salt = toHex(keccak(word));
    if (fitsToken(salt)) return salt;
    if (i % 4096 === 4095) await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("saltUnavailable");
}

/** A seed for mining when the host gives no salt: the time, a random number and the account. */
function freshSeed(account: string) {
  const text = String(Date.now()) + ":" + String(Math.random()) + ":" + account;
  const bytes = new Uint8Array(Math.min(text.length, 135));
  for (let i = 0; i < bytes.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return keccak(bytes);
}

function unixNow() {
  return BigInt(Math.floor(Date.now() / 1000));
}

// ── Shared look ────────────────────────────────────────────────────────────────────────────────────────────────────

const ink = "#1d1a16";
const paper = "#fbf7ef";
const line = "#d9cfbd";
const deep = "#2b2118";
const gold = "#e2a72e";
const soft = "#6b5f50";
const shell: CSSProperties = {
  color: ink, background: paper, border: "1px solid " + line, borderRadius: 16, overflow: "hidden",
  fontFamily: "system-ui, -apple-system, \"Segoe UI\", sans-serif", lineHeight: 1.5, colorScheme: "light",
};
const inset = "clamp(16px, 4vw, 30px)";
const body: CSSProperties = { padding: inset, display: "grid", gap: 20, minWidth: 0 };
const columns: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 14 };
const input: CSSProperties = {
  boxSizing: "border-box", width: "100%", minWidth: 0, minHeight: 44, padding: "9px 11px", fontSize: 16, font: "inherit",
  color: ink, background: "#fffdf8", border: "1px solid #bfb29c", borderRadius: 8,
};
const muted: CSSProperties = { margin: 0, color: soft, fontSize: 13 };
const alert: CSSProperties = { margin: 0, color: "#8a2a1c", fontSize: 13 };
const value: CSSProperties = { margin: "3px 0 0", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" };
const copyable: CSSProperties = { ...value, userSelect: "all", fontFamily: "ui-monospace, monospace", fontSize: 13 };

function buttonStyle(disabled: boolean, secondary = false): CSSProperties {
  return {
    minHeight: 44, padding: "8px 18px", borderRadius: 10, font: "inherit", fontSize: 15, fontWeight: 700,
    border: secondary ? "1px solid " + line : 0, background: secondary ? "transparent" : deep,
    color: secondary ? ink : "#fff8ea", opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer",
  };
}

function Header({ title, intro, badge }: { title: string; intro: string; badge?: string }) {
  return (
    <header style={{ padding: inset, background: deep, color: "#fff8ea", borderBlockStart: "5px solid " + gold,
      display: "flex", gap: 12, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: "clamp(24px, 5vw, 36px)", lineHeight: 1.15 }}>{title}</h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, color: "#e9dcc4" }}>{intro}</p>
      </div>
      {badge && <span style={{ padding: "4px 11px", border: "1px solid " + gold, borderRadius: 20, fontSize: 13, whiteSpace: "nowrap" }}>{badge}</span>}
    </header>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5, minWidth: 0, alignContent: "start" }}>
      <span style={{ fontWeight: 700, fontSize: 14 }}>{label}</span>
      {children}
      {hint && <span style={muted}>{hint}</span>}
    </label>
  );
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ minWidth: 0 }}><dt style={muted}>{label}</dt><dd style={value}>{children}</dd></div>;
}

function isHash(text: unknown): text is string {
  return typeof text === "string" && hashPattern.test(text);
}

function supported(identity: Identity) {
  return identity.chainId === chainId && identity.factoryAddress.toLowerCase() === factoryAddress;
}

function errorText(cause: unknown, m: Messages) {
  const known: Record<string, string> = {
    walletRejected: m.notSent, walletBusy: m.busyElsewhere, simulationFailed: m.refused,
    creationFeeChanged: m.costChanged, saltUnavailable: m.failed, receiptUnavailable: m.checkLater,
  };
  return cause instanceof Error && Object.hasOwn(known, cause.message) ? known[cause.message] : m.failed;
}

/** A refused creation: the factory's own reason when the host passes it on (a name or symbol on the Portal's
 * anti-scam list, RulesCurveLauncherFactory.checkConfig), otherwise the reasons the form cannot check itself. */
function createErrorText(cause: unknown, m: Messages) {
  const text = cause instanceof Error ? cause.message : "";
  if (text.includes("name on the Portal's anti-scam list")) return m.nameListed;
  if (text.includes("symbol on the Portal's anti-scam list")) return m.symbolListed;
  return text === "simulationFailed" ? m.createRefused : errorText(cause, m);
}

function ReceiptLine({ receipt, m }: { receipt: Submission | null; m: Messages }) {
  if (!receipt) return null;
  const words = { success: m.done, pending: m.waiting, reverted: m.reverted, unverified: m.unconfirmed };
  return <p role="status" style={muted}>{words[receipt.status]}</p>;
}

// ── The creation form ──────────────────────────────────────────────────────────────────────────────────────────────

// The entry's own defaults (bounties/app/src/lib/flap.ts CREATE_DEFAULTS, bounties/flap/script/CreateRulesSale.s.sol).
const initialForm = {
  name: "", symbol: "", target: defaultRaise, hours: "48", buyTax: "3", sellTax: "5",
  saleTokens: "600000000", depth: defaultDepth, fee: "1", burn: "20", taxDays: "365",
};
type Form = typeof initialForm;
type FormKey = keyof Form;

/** The factory's curveFor in bigint (CurveMath.sol: virtualTokens rounds down, reserve up, poolToken down). */
function curveFor(saleTokens: bigint, targetRaise: bigint, virtualBnb: bigint) {
  const virtualTokens = (virtualBnb + targetRaise) * saleTokens / targetRaise;
  if (virtualTokens <= saleTokens) return null;
  const left = virtualTokens - saleTokens;
  const raise = (virtualBnb * virtualTokens + left - 1n) / left - virtualBnb;
  const poolToken = left * raise / (virtualBnb + raise);
  return { virtualTokens, raise, poolToken, totalSupply: saleTokens + poolToken };
}

type Refusal = { field: FormKey; reason?: string };

/** The curve checks of the factory's checkConfig, in its order; the reason names a message. */
function curveRefusal(c: Config): Refusal | null {
  const curve = curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
  if (curve === null) return { field: "depth", reason: "curveSteep" };
  if (curve.poolToken < minPoolToken || curve.raise === 0n) return { field: "depth", reason: "poolSmall" };
  if (raiseCap !== null && curve.raise > raiseCap) return { field: "target", reason: "raiseTooBig" };
  const off = curve.raise > c.targetRaise ? curve.raise - c.targetRaise : c.targetRaise - curve.raise;
  if (off > c.targetRaise / raiseToleranceDivisor) return { field: "target", reason: "raiseOff" };
  if (curve.totalSupply < minSupply || curve.totalSupply > maxSupply) return { field: "saleTokens", reason: "supplyRange" };
  return null;
}

function readForm(f: Form): { config: Config } | Refusal {
  const name = f.name.trim(), symbol = f.symbol.trim();
  if (!name || name.length > 64) return { field: "name" };
  if (!symbol || symbol.length > 16) return { field: "symbol" };
  const target = parseAmount(f.target);
  if (target === null || target === 0n) return { field: "target" };
  const hours = parseWhole(f.hours);
  if (hours === null || hours === 0n || hours > maxHours) return { field: "hours" };
  const buy = parsePercent(f.buyTax), sell = parsePercent(f.sellTax);
  if (buy === null || buy > maxTaxBps || (buy > 0n && buy < minTaxBps)) return { field: "buyTax" };
  if (sell === null || sell > maxTaxBps || (sell > 0n && sell < minTaxBps) || (buy === 0n && sell === 0n)) return { field: "sellTax" };
  // whole tokens, at most 16 digits; the supply bound (sale plus pool) is checked with the curve below
  const sale = /^[1-9][0-9]{0,15}$/.test(f.saleTokens.trim()) ? BigInt(f.saleTokens.trim()) * wad : null;
  if (sale === null) return { field: "saleTokens" };
  const depth = parseAmount(f.depth);
  if (depth === null || depth === 0n) return { field: "depth" };
  const fee = parsePercent(f.fee);
  if (fee === null || fee > maxFeeBps) return { field: "fee" };
  const burn = parsePercent(f.burn);
  if (burn === null || burn >= 10_000n) return { field: "burn" };
  const days = parseWhole(f.taxDays);
  if (days === null || days === 0n || days * 86_400n > maxTaxSeconds) return { field: "taxDays" };
  const config = {
    name, symbol, meta: "", saleTokens: sale, targetRaise: target, virtualBnb: depth, duration: hours * 3600n,
    tradeFeeBps: fee, buyTaxBps: buy, sellTaxBps: sell, burnShareBps: burn, taxDuration: days * 86_400n,
  };
  return curveRefusal(config) ?? { config };
}

export function LauncherConfig({ context, messages: m, host }: ConfigProps) {
  const [form, setForm] = useState<Form>(initialForm);
  const [fee, setFee] = useState<string | null>(null);
  const [result, setResult] = useState<{ account: string; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const read = readForm(form);
  const config = "config" in read ? read.config : null;
  const wrongField = "field" in read ? read.field : null;
  const reason = "field" in read ? read.reason : undefined;
  const account = host?.wallet?.account?.toLowerCase() ?? null;
  const wrongChain = host?.wallet?.chainId !== chainId;
  const canCreate = supported(context.identity) && context.previewOnly !== true && !!host?.wallet && !!host?.quote
    && !!host?.encode && !!host?.submit;
  const ownResult = result && result.account === account ? result.receipt : null;
  const pendingHash = host?.wallet?.pendingHash;
  const receipt = isHash(pendingHash) && ownResult?.hash !== pendingHash ? { status: "pending" as const, hash: pendingHash } : ownResult;
  const waiting = receipt?.status === "pending" || receipt?.status === "unverified";
  const finished = receipt?.status === "success";
  const created = finished && typeof receipt?.launcherAddress === "string" && addressPattern.test(receipt.launcherAddress)
    ? receipt.launcherAddress : null;

  useEffect(() => {
    if (!canCreate) return;
    let live = true;
    host?.quote?.().then(q => { if (live && typeof q === "string" && unsigned.test(q)) setFee(q); }).catch(() => undefined);
    return () => { live = false; };
  }, [canCreate, host]);

  const update = (key: FormKey, text: string) => {
    setForm(current => ({ ...current, [key]: text }));
    setError(null);
  };

  async function create() {
    if (!canCreate || !config || lock.current || finished || waiting) return;
    if (!account) { host?.wallet?.connect(); return; }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (wrongChain) await host?.wallet?.switchChain();
      const quoted = await host?.quote?.();
      if (typeof quoted !== "string" || !unsigned.test(quoted)) { setError(m.failed); return; }
      if (quoted !== fee) { setFee(quoted); setError(m.costChanged); return; }
      let salt = host?.findSalt ? await host.findSalt().catch(() => "") : "";
      if (!fitsToken(salt)) {
        salt = await mineSalt(isHash(salt) ? fromHex(salt) : freshSeed(account));
      }
      const configuration = host?.encode?.(configParameters, configValues(config, salt));
      if (typeof configuration !== "string" || !/^0x[0-9a-f]*$/i.test(configuration)) { setError(m.failed); return; }
      const submitted = await host?.submit?.({ kind: "create", configuration, valueWei: quoted });
      if (submitted) setResult({ account, receipt: submitted });
    } catch (cause) {
      setError(createErrorText(cause, m));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function check() {
    if (!account || !receipt || !isHash(receipt.hash) || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const checked = await host?.checkReceipt?.(receipt.hash);
      if (checked) setResult({ account, receipt: checked });
    } catch (cause) {
      setError(errorText(cause, m));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const hint = (key: FormKey, text: string) => wrongField !== key ? text
    : reason ? m[reason] : form[key].trim() !== "" ? m.fix + " " + text : text;
  const field = (key: FormKey, label: string, help: string, mode: "text" | "decimal" | "numeric" = "decimal") => (
    <Field label={label} hint={hint(key, help)}>
      <input name={key} value={form[key]} inputMode={mode} autoComplete="off" aria-invalid={wrongField === key}
        style={input} onChange={event => update(key, event.target.value)} />
    </Field>
  );

  return (
    <section style={shell} aria-label={m.createTitle}>
      <Header title={m.createTitle} intro={m.createIntro} badge={m.network} />
      <div style={{ ...body, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", alignItems: "start" }}>
        <fieldset disabled={busy || waiting || finished} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14, minWidth: 0 }}>
          <div style={columns}>
            {field("name", m.name, m.nameHint, "text")}
            {field("symbol", m.symbol, m.symbolHint, "text")}
          </div>
          <div style={columns}>
            {field("target", m.target, m.targetHint)}
            {field("hours", m.hours, m.hoursHint, "numeric")}
          </div>
          <div style={columns}>
            {field("buyTax", m.buyTax, m.taxHint)}
            {field("sellTax", m.sellTax, m.taxHint)}
          </div>
          <details style={{ borderBlockStart: "1px solid " + line, paddingBlockStart: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>{m.more}</summary>
            <div style={{ ...columns, marginBlockStart: 12 }}>
              {field("saleTokens", m.saleTokens, m.saleTokensHint, "numeric")}
              {field("depth", m.depth, m.depthHint)}
              {field("fee", m.fee, m.feeHint)}
              {field("burn", m.burn, m.burnHint)}
              {field("taxDays", m.taxDays, m.taxDaysHint, "numeric")}
            </div>
          </details>
        </fieldset>

        <aside style={{ background: "#f3ead8", border: "1px solid " + line, borderRadius: 12, padding: "clamp(14px, 3vw, 22px)", display: "grid", gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>{m.summary}</h3>
          <dl style={{ margin: 0, display: "grid", gap: 11 }}>
            <Datum label={m.token}>{config ? config.name + " (" + config.symbol + ")" : m.unknown}</Datum>
            <Datum label={m.raise}>{config ? decimalAmount(config.targetRaise) + " " + m.coin : m.unknown}</Datum>
            <Datum label={m.forSale}>{config ? decimalAmount(config.saleTokens) : m.unknown}</Datum>
            <Datum label={m.deadline}>{config ? (config.duration / 3600n).toString() + " " + m.hoursAfter : m.unknown}</Datum>
            <Datum label={m.taxes}>{config ? m.buy + " " + percentText(config.buyTaxBps) + ", " + m.sell + " " + percentText(config.sellTaxBps)
              + ", " + (config.taxDuration / 86_400n).toString() + " " + m.days : m.unknown}</Datum>
            <Datum label={m.income}>{m.allToPile}</Datum>
            {canCreate && <Datum label={m.cost}>{fee !== null ? decimalAmount(BigInt(fee)) + " " + m.feeCoin : m.unknown}</Datum>}
          </dl>
          <p style={muted}>{m.rulesNote}</p>
          <p style={copyable}>{ourSite + "#/flap/create"}</p>
          {error && <p role="alert" style={alert}>{error}</p>}
          <ReceiptLine receipt={receipt} m={m} />
          {created && host?.openLauncher && (
            <button type="button" style={buttonStyle(false)} onClick={() => host?.openLauncher?.(created)}>{m.openSale}</button>
          )}
          {waiting && host?.checkReceipt && (
            <button type="button" disabled={busy} style={buttonStyle(busy, true)} onClick={() => void check()}>{m.checkAgain}</button>
          )}
          {!waiting && !finished && (
            canCreate
              ? <button type="button" disabled={busy || !config} style={buttonStyle(busy || !config)} onClick={() => void create()}>
                  {busy ? m.working : m.create}</button>
              : <p style={muted}>{m.previewOnly}</p>
          )}
        </aside>
      </div>
    </section>
  );
}

// ── The sale page ──────────────────────────────────────────────────────────────────────────────────────────────────

function deadlineText(seconds: bigint | null, locale: string, fallback: string) {
  if (seconds === null || seconds <= 0n || seconds > 253402300799n) return fallback;
  try {
    return Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(Number(seconds) * 1000) + " UTC";
  } catch {
    return fallback;
  }
}

export function Launcher({ context, messages: m, host }: DetailProps) {
  const [result, setResult] = useState<{ account: string; action: Action; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const lock = useRef(false);
  const { launcherAddress, snapshot, identity } = context;
  const raised = asUnits(snapshot?.raised);
  const target = asUnits(snapshot?.target);
  const deadline = asUnits(snapshot?.deadline);
  const cost = asUnits(snapshot?.costToComplete);
  const bought = asUnits(snapshot?.bought);
  const claimable = asUnits(snapshot?.claimable);
  const owed = asUnits(snapshot?.owed);
  const launched = snapshot?.launched === true;
  const [now, setNow] = useState(unixNow);
  // the clock moves the sale from selling to time ran out without a new snapshot
  useEffect(() => {
    const id = setInterval(() => setNow(unixNow()), 15_000);
    return () => clearInterval(id);
  }, []);
  const timeUp = snapshot?.launched === false && deadline !== null && now >= deadline;
  const selling = snapshot?.launched === false && deadline !== null && now < deadline;
  const token = launched ? snapshot?.token : snapshot?.predictedToken;
  const shown = launched ? target : raised;
  const progressBps = shown !== null && target !== null && target > 0n ? (shown >= target ? 10_000n : shown * 10_000n / target) : null;
  const status = launched ? m.launched : timeUp ? m.timeUp : selling ? m.selling : m.unknown;
  const account = host?.wallet?.account?.toLowerCase() ?? null;
  const wrongChain = host?.wallet?.chainId !== chainId;
  const canAct = supported(identity) && context.previewOnly !== true && !!host?.wallet && !!host?.submit;
  const own = result && result.account === account ? result : null;
  const pendingHash = host?.wallet?.pendingHash;
  const receipt = isHash(pendingHash) && own?.receipt.hash !== pendingHash ? { status: "pending" as const, hash: pendingHash } : own?.receipt ?? null;
  const waiting = receipt?.status === "pending" || receipt?.status === "unverified";
  // complete() takes every remaining sale token or reverts; 1% over the sale's own costToComplete() covers a sell-back
  // between this read and the block, and what is not needed comes back in the same transaction.
  const sendForRest = cost !== null && cost > 0n ? cost + cost / 100n : null;
  const ready: Record<Action, boolean> = {
    complete: buyRestHere && selling && sendForRest !== null,
    claim: launched && claimable !== null && claimable > 0n,
    unwind: timeUp && owed !== null && owed > 0n,
  };

  async function act(action: Action) {
    if (!canAct || !ready[action] || waiting || lock.current) return;
    if (!account) { host?.wallet?.connect(); return; }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (wrongChain) await host?.wallet?.switchChain();
      const valueWei = action === "complete" && sendForRest !== null ? sendForRest.toString() : undefined;
      const submitted = await host?.submit?.({ kind: "action", action, ...(valueWei === undefined ? {} : { valueWei }) });
      if (submitted) {
        setResult({ account, action, receipt: submitted });
        if (submitted.status === "success") host?.refresh?.();
      }
    } catch (cause) {
      setError(errorText(cause, m));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function check() {
    if (!account || !own || !receipt || !isHash(receipt.hash) || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const checked = await host?.checkReceipt?.(receipt.hash);
      if (checked) {
        setResult({ account, action: own.action, receipt: checked });
        if (checked.status === "success") host?.refresh?.();
      }
    } catch (cause) {
      setError(errorText(cause, m));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const actionButton = (action: Action, label: string) => (
    <button type="button" disabled={busy || waiting || !canAct} style={buttonStyle(busy || waiting || !canAct)}
      onClick={() => void act(action)}>{busy ? m.working : label}</button>
  );

  return (
    <section style={shell} aria-label={m.saleTitle}>
      <Header title={m.saleTitle} intro={m.saleIntro} badge={snapshot ? status : m.network} />
      <div style={body}>
        {!launcherAddress ? <p role="status" style={muted}>{m.noSale}</p> : (
          <>
            <div style={{ border: "1px solid " + line, borderRadius: 12, padding: "clamp(14px, 4vw, 24px)", background: "#f3ead8", display: "grid", gap: 12 }}>
              <p style={muted}>{launched ? m.raisedFinal : m.raisedSoFar}</p>
              <p style={{ ...value, fontSize: "clamp(24px, 6vw, 40px)", fontWeight: 750, lineHeight: 1.15 }}>
                {shown !== null ? decimalAmount(shown) + " " + m.coin : m.unknown}
              </p>
              {progressBps !== null && (
                <div role="progressbar" aria-label={m.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(progressBps) / 100}
                  style={{ height: 9, background: "#e2d5bd", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ width: (Number(progressBps) / 100) + "%", height: "100%", background: gold }} />
                </div>
              )}
              <p style={muted}>{m.of} {target !== null ? decimalAmount(target) + " " + m.coin : m.unknown}</p>
              {!snapshot && <p role="status" style={muted}>{m.noData}</p>}
            </div>

            <dl style={{ ...columns, margin: 0 }}>
              <Datum label={m.deadline}>{deadlineText(deadline, context.locale, m.unknown)}</Datum>
              <Datum label={m.buyers}>{asUnits(snapshot?.holderCount)?.toString() ?? m.unknown}</Datum>
              <Datum label={launched ? m.tokenLaunched : m.tokenToCome}>{token && addressPattern.test(token) ? token : m.unknown}</Datum>
              {account && <Datum label={m.yourTokens}>{bought !== null ? decimalAmount(bought) : m.unknown}</Datum>}
            </dl>

            {buyRestHere && selling && (
              <div style={{ display: "grid", gap: 10, borderBlockStart: "1px solid " + line, paddingBlockStart: 16 }}>
                <h3 style={{ margin: 0, fontSize: 17 }}>{m.restTitle}</h3>
                <dl style={{ ...columns, margin: 0 }}>
                  <Datum label={m.costNow}>{cost !== null ? decimalAmount(cost) + " " + m.coin : m.unknown}</Datum>
                  <Datum label={m.youSend}>{sendForRest !== null ? decimalAmount(sendForRest) + " " + m.coin : m.unknown}</Datum>
                </dl>
                <p style={muted}>{m.restNote}</p>
                <div>{actionButton("complete", m.buyRest)}</div>
              </div>
            )}

            {launched && claimable !== null && claimable > 0n && (
              <div style={{ display: "grid", gap: 10, borderBlockStart: "1px solid " + line, paddingBlockStart: 16 }}>
                <h3 style={{ margin: 0, fontSize: 17 }}>{m.claimTitle}</h3>
                <p style={value}>{decimalAmount(claimable)}</p>
                <div>{actionButton("claim", m.claim)}</div>
              </div>
            )}

            {timeUp && owed !== null && owed > 0n && (
              <div style={{ display: "grid", gap: 10, borderBlockStart: "1px solid " + line, paddingBlockStart: 16 }}>
                <h3 style={{ margin: 0, fontSize: 17 }}>{m.backTitle}</h3>
                <dl style={{ margin: 0 }}><Datum label={m.youPutIn}>{decimalAmount(owed) + " " + m.coin}</Datum></dl>
                <p style={muted}>{m.backNote}</p>
                <div>{actionButton("unwind", m.takeBack)}</div>
              </div>
            )}

            {error && <p role="alert" style={alert}>{error}</p>}
            <ReceiptLine receipt={receipt} m={m} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {waiting && host?.checkReceipt && (
                <button type="button" disabled={busy} style={buttonStyle(busy, true)} onClick={() => void check()}>{m.checkAgain}</button>
              )}
              {host?.refresh && <button type="button" disabled={busy} style={buttonStyle(busy, true)} onClick={() => host?.refresh?.()}>{m.refresh}</button>}
              {launched && token && addressPattern.test(token) && host?.redirect && (
                <button type="button" style={buttonStyle(false, true)}
                  onClick={() => setOpenFailed(host?.redirect?.("/bnb-testnet/" + token.toLowerCase()) !== true)}>{m.openToken}</button>
              )}
            </div>
            {openFailed && <p role="status" style={muted}>{m.openTokenFailed}</p>}

            <div style={{ display: "grid", gap: 6, borderBlockStart: "1px solid " + line, paddingBlockStart: 14 }}>
              <p style={muted}>{m.ourPage}</p>
              <p style={copyable}>{ourSite + "#/flap/" + launcherAddress.toLowerCase()}</p>
            </div>
          </>
        )}
        <details style={{ borderBlockStart: "1px solid " + line, paddingBlockStart: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>{m.addresses}</summary>
          <dl style={{ margin: "12px 0 0", display: "grid", gap: 10 }}>
            <Datum label={m.factory}>{identity.factoryAddress}</Datum>
            {launcherAddress && <Datum label={m.sale}>{launcherAddress}</Datum>}
            {snapshot?.creator && <Datum label={m.creator}>{snapshot.creator}</Datum>}
            {snapshot?.pileVault && <Datum label={m.pile}>{snapshot.pileVault}</Datum>}
          </dl>
        </details>
      </div>
    </section>
  );
}
