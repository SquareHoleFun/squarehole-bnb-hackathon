// The two pieces, step by step, on a developer-owned OpenFour copy (BSC Testnet, or a local fork of it):
//
//   node -r ./scripts/signer-preload.js scripts/pile.js <step> [value] --expect-signer 0x... [--launch preset|tax|tax-rules] [--action <id>]
//
// Setup (each runs once per copy; a rerun finishes what an earlier run started, then prints what exists):
//   mock-quote | tax-template | register | create (the preset launch) | create-tax (the tax launch)
//   tax-rules-template | create-tax-rules (SH-287: the tax launch whose tax is shared by the creator's rules: RULES =
//   "<creator bps>,<pile bps>,<buy and burn bps>", default 2000,5000,3000, the creator part paid to this wallet)
// Actions (need --action <id>, a name of your own per intended action, e.g. tax-buy-1; rerunning the same id never
//   repeats it: the plan (amounts, bounds, checks) is fixed the first time under out/actions/, each transaction has a
//   stable id under out/ops/, and a finished action prints "done before"):
//   wrap <bnb>          turn tBNB into WBNB (to use WBNB as a quote coin)
//   buy <tokens>  sell <tokens>  graduate <budget per round>   (--launch preset|tax)
//   dex-sell <tokens>  dex-buy <quote>                           (after graduation, on PancakeSwap V2)
//   settle                                                       (tax launch: pay tax due into the pile now)
//   distribute                                                   (--launch tax-rules: share the splitter's income)
//   redeem <tokens|all>
// Other: status (--launch), resolve <operation> (after you looked up a reverted or conflicting operation),
//   set-signer --keystore <service keystore> --password-file <its password file> (after the scripted launches:
//   Core's creation signer becomes the signing service's key, its address derived here by decrypting that keystore);
//   set-signer <address> only for a key without a keystore file here (a hardware or foreign key).
//   set-signer --back-to-wallet --round <n>: Core's signer back to this wallet, for a scripted launch (then set-signer
//   --keystore ... --round <n> hands it to the service's key again). --round <n> (2 and up) makes each handover of a
//   later round its own operation; round 1 is the first handover (no --round).
//
// Every action: bounds from a quote of the net output (or the maximum cost), above zero, fixed before any approval;
// approvals of the exact amount, any remainder revoked afterwards; destination, amount, approval and bound printed
// first; "verified" only after the action's own checks (tokens or coins received, events, the tax books, the phase).
// A line "OK ..." ends every successful command; anything else ends with "stopped: ..." and a nonzero exit code
// (see lib/run.js). Quote coins must have 18 decimals.
// Environment: RPC_URL, the keystore pair (see the preload), QUOTE (else out/mock-quote.json's coin), NAME, SYMBOL,
// MAX_SUPPLY, SALE_AMOUNT, RAISE_AMOUNT (whole tokens), BUY_FEE_BPS, SELL_FEE_BPS (preset, default 100/100),
// TAX_BUY_BPS, TAX_SELL_BPS (tax launch, default 300/300), PRESET_ID, SLIPPAGE_BPS (default 100 = 1%), RULES
// (create-tax-rules). OPENFOUR_DRY=1: the step's next transaction is built and simulated, never signed or sent; no
// plan or record is written; the last line is "DRY <operation>".
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ABI, DEAD, PHASE, TRADE_MODULE_KEY_SOURCE, encodeCreateArgs, presetSchemas, signCreate } = require("../lib/openfour");
const { artifact } = require("../lib/pile-preset");
const { validRules } = require("../sign/sign-create");
const { FORWARD_VAULT_TYPE_ID } = require("../lib/pile-tax");
const { CHECK_KINDS, LOCAL, OUT, arg, call, openOps, preflight, readOp, readOut, resolve, sameCopy, send, stop, testKeyAddresses, verified, writeAtomic, writeOut } = require("../lib/run");
const { anchored } = require("../lib/anchor");

const ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // PancakeSwap V2 router, BSC Testnet
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
];
const TAX_ABI = [
  "function founder() view returns (address)",
  "function buyFeeRate() view returns (uint256)",
  "function sellFeeRate() view returns (uint256)",
  "function feeFounder() view returns (uint256)",
  "function feeToFounder() view returns (uint256)",
  "function feeAccumulated() view returns (uint256)",
  "function tokenAccumulated() view returns (uint256)",
  "function minDispatch() view returns (uint256)",
  "function minDispatchQuote() view returns (uint256)",
];
const EVENTS = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Redeemed(address indexed holder, address indexed to, uint256 tokensIn, uint256 assetOut)",
  "event FeeDispatched(uint256 amountFounder, uint256 amountHolder, uint256 amountBurn, uint256 amountLiquidity)",
  "event FeeDispatchDeferred(uint8 indexed kind, uint256 amount, bytes reason)",
  "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)",
]);
// The tax token runs swaps inside try/catch during transfers, and a gas estimate can settle on the cheaper catch
// branch: its transactions carry fixed limits. Worst cost at 0.1 gwei: 8M = 0.0008 BNB, 12M = 0.0012 BNB.
const TAX_GAS = 8_000_000n;
const CREATE_TAX_GAS = 12_000_000n;
const BPS = 10_000n;
const SLIPPAGE = BigInt(process.env.SLIPPAGE_BPS || "100");
const PRESET_ID = BigInt(process.env.PRESET_ID || "1778027700001");
const ACTIONS = path.join(OUT, "actions");

function positional() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--back-to-wallet") continue; // the one flag without a value
    if (process.argv[i].startsWith("--")) i++;
    else out.push(process.argv[i]);
  }
  return out;
}

function units(text, what) {
  let v;
  try {
    v = ethers.parseUnits(String(text), 18);
  } catch {
    stop(`${what}: not an amount: ${text}`, 2);
  }
  if (v <= 0n) stop(`${what} must be above zero`, 2);
  return v;
}

const fmt = (v) => ethers.formatUnits(v, 18);
const str = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

function lowerBound(net, what) {
  if (net <= 0n) stop(`${what}: the quote is zero; nothing sent`);
  const bound = (net * (BPS - SLIPPAGE)) / BPS;
  if (bound <= 0n) stop(`${what}: the bound rounds to zero (net ${net}); nothing sent`);
  return bound;
}

function logsOf(receipt, address) {
  const out = [];
  for (const log of receipt.logs) {
    if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const ev = EVENTS.parseLog(log);
      if (ev) out.push({ ...ev, address: log.address });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

async function main() {
  if (SLIPPAGE < 1n || SLIPPAGE > 1000n) stop("SLIPPAGE_BPS must be 1 to 1000", 2);
  const [step, value] = positional();
  if (!step) stop("usage: pile.js <step> [value] --expect-signer 0x... [--launch preset|tax|tax-rules] [--action <id>]", 2);
  const ctx = await preflight();
  const { provider, wallet } = ctx;
  readOut("fork-started.json", ctx.identity, { copy: false });
  readOut("fork-deployment.json", ctx.identity, { copy: false });
  // The same deployment anchor as kit.js: this attempt's copy, checked on the chain, before anything else.
  const anchor = await anchored(provider, OUT, ctx.identity, null);
  if (anchor.inconclusive) stop(`inconclusive: ${anchor.reason}. Retry later, or on the other endpoint`, 3);
  if (!anchor.d) stop(`out/fork-deployment.json is not this attempt's copy (${anchor.reason}): move it away first`, 2);
  // From here on only the object the anchor validated (its Registry, Core, Tools, presets), never another read.
  const fork = anchor.d;
  ctx.identity = { ...ctx.identity, registry: fork.run.registry };
  const registry = new ethers.Contract(fork.addresses.registry, ABI.registry, wallet);
  const core = new ethers.Contract(fork.addresses.core, [...ABI.core, "function signer() view returns (address)", "function setSigner(address)"], wallet);
  const tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
  if ((await registry.owner()) !== wallet.address) stop(`the copy at ${fork.addresses.registry} is not owned by ${wallet.address}`, 2);
  if (["create", "create-tax", "create-tax-rules"].includes(step) && (await core.signer()) !== wallet.address) stop(`Core's signer is not ${wallet.address}: this wallet cannot sign creations any more`, 2);
  if (step === "resolve") return resolve(ctx, value || stop("resolve <operation>", 2));

  const erc20 = (address) => new ethers.Contract(address, ABI.erc20, wallet);
  /// The last line of every successful command is exactly "OK <marker>"; details go on the line before.
  const ok = (marker, detail) => {
    if (detail) console.log(detail);
    console.log(`OK ${marker}`);
  };
  const which = arg("--launch");
  const action = arg("--action");
  const tradeSteps = ["buy", "sell", "graduate", "dex-sell", "dex-buy", "settle", "redeem", "distribute"];
  let prefix = null;
  if (["mock-quote", "tax-template", "tax-rules-template", "set-signer"].includes(step)) prefix = step;
  else if (step === "register") prefix = "register.";
  else if (step === "create") prefix = "launch-preset.";
  else if (step === "create-tax") prefix = "launch-tax.";
  else if (step === "create-tax-rules") prefix = "launch-tax-rules.";
  else if (step === "wrap" || tradeSteps.includes(step)) {
    if (!action || !/^[a-z0-9-]{1,40}$/.test(action)) stop("give the action an id: --action <lower-case letters, digits, dashes>", 2);
    if (step !== "wrap" && !["preset", "tax", "tax-rules"].includes(which)) stop("give the launch: --launch preset|tax|tax-rules", 2);
    prefix = step === "wrap" ? `wrap.${action}.` : `${which}.${action}.`;
  } else if (step !== "status") stop(`unknown step ${step}`, 2);

  // Every check an operation needs is stored with it, so any invocation can run it.
  async function runCheck(rec, receipt) {
    const c = rec.check || { kind: "none" };
    if (!CHECK_KINDS.includes(c.kind)) stop(`${rec.opId}: no recognised check (${c.kind}); it cannot be verified`);
    const me = wallet.address;
    const sum = (evs, pred) => evs.filter(pred).reduce((a, e) => a + e.args.value, 0n);
    if (c.kind === "deploy" && (!receipt.contractAddress || (await provider.getCode(receipt.contractAddress)) === "0x")) stop(`${rec.opId}: no contract was created`);
    if (c.kind === "approve") {
      const ev = logsOf(receipt, c.token).find((e) => e.name === "Approval" && e.args.owner === me && e.args.spender === c.spender);
      if (!ev || ev.args.value !== BigInt(c.amount)) stop(`${rec.opId}: the approval is not exactly ${c.amount}`);
    }
    if (c.kind === "created") {
      const ev = logsOf(receipt, fork.addresses.core).find((e) => e.name === "TokenCreated");
      if (!ev || ev.args.presetId !== BigInt(c.presetId) || ev.args.creator !== me) stop(`${rec.opId}: no TokenCreated of preset ${c.presetId} by the signer`);
    }
    if (c.kind === "wrap") {
      const ev = logsOf(receipt, c.token).find((e) => e.name === "Deposit" && e.args.dst === me);
      if (!ev || ev.args.wad !== BigInt(c.amount)) stop(`${rec.opId}: the deposit is not exactly ${c.amount}`);
    }
    if (c.kind === "tokens-in") {
      const got = sum(logsOf(receipt, c.token), (e) => e.name === "Transfer" && e.args.to === me);
      if (c.exact ? got !== BigInt(c.exact) : got < BigInt(c.min)) stop(`${rec.opId}: received ${got} of ${c.token}, wanted ${c.exact ? `exactly ${c.exact}` : `at least ${c.min}`}`);
      console.log(`  received ${fmt(got)} (${c.token})`);
    }
    if (c.kind === "sell") {
      const out = sum(logsOf(receipt, c.token), (e) => e.name === "Transfer" && e.args.from === me);
      let got = sum(logsOf(receipt, c.quote), (e) => e.name === "Transfer" && e.args.to === me);
      // With WBNB as the quote, Core pays sell proceeds in native tBNB: the signer's native balance change in the
      // sell's block (gas added back) counts too.
      if (c.native) {
        // Read at the receipt's block and the block before (this signer sends one transaction at a time).
        const [after, before] = await Promise.all([provider.getBalance(me, receipt.blockNumber), provider.getBalance(me, receipt.blockNumber - 1)])
          .catch(() => stop(`${rec.opId}: this endpoint has no balance history for block ${receipt.blockNumber}; look the sell up and check its native payment by hand`));
        got += after - before + receipt.gasUsed * receipt.gasPrice;
      }
      if (out !== BigInt(c.amount) || got < BigInt(c.min)) stop(`${rec.opId}: sold ${out} (wanted ${c.amount}), received ${got} (wanted at least ${c.min})`);
      console.log(`  sold ${fmt(out)}, received ${fmt(got)} quote`);
    }
    if (c.kind === "redeem") {
      const ev = logsOf(receipt, c.pile).find((e) => e.name === "Redeemed" && e.args.holder === me);
      const dead = sum(logsOf(receipt, c.token), (e) => e.name === "Transfer" && e.args.to === DEAD);
      if (!ev || ev.args.tokensIn !== BigInt(c.amount) || ev.args.assetOut < BigInt(c.min) || dead < BigInt(c.amount)) {
        stop(`${rec.opId}: redemption not as planned (${ev ? `${ev.args.tokensIn} in, ${ev.args.assetOut} out` : "no Redeemed event"}, ${dead} to the dead address)`);
      }
      console.log(`  handed in ${fmt(ev.args.tokensIn)}, received ${ev.args.assetOut} (at least ${c.min})`);
    }
    if (c.kind === "settle" && c.due && !logsOf(receipt, c.token).some((e) => e.name === "FeeDispatched")) stop(`${rec.opId}: tax was due but none was dispatched`);
    if (c.kind === "module" && (await registry.getModuleImplementation(c.key)) !== c.impl) stop(`${rec.opId}: the Registry does not show module ${c.key} -> ${c.impl}`);
    if (c.kind === "preset") {
      const bad = await presetDiffers(c);
      if (bad) stop(`${rec.opId}: the Registry's preset ${c.presetId} differs from what was written (${bad})`);
    }
    if (c.kind === "preset-fee") {
      const bad = await feeDiffers(c);
      if (bad) stop(`${rec.opId}: the FeeRouter's configuration differs from what was written (${bad})`);
    }
    if (c.kind === "pile") {
      const bad = await pileDiffers(c);
      if (bad) stop(`${rec.opId}: ${bad}`);
    }
    if (c.kind === "signer" && (await core.signer()) !== c.address) stop(`${rec.opId}: Core's signer is not ${c.address}`);
    if (c.kind === "rules") {
      const bad = await rulesDiffer(c);
      if (bad) stop(`${rec.opId}: ${bad}`);
    }
    if (c.kind === "distribute") {
      // From the receipt: the income recognised in this call was assigned in full to the rules' parts.
      const split = new ethers.Contract(c.splitter, artifact("RuleSplitter").abi, provider);
      const evs = receipt.logs.filter((l) => l.address === c.splitter).map((l) => split.interface.parseLog(l)).filter(Boolean);
      const income = evs.filter((e) => e.name === "IncomeRecognised").reduce((a, e) => a + e.args.amount, 0n);
      const parts = evs.filter((e) => e.name === "PartOwed").reduce((a, e) => a + e.args.part, 0n);
      if (income !== parts) stop(`${rec.opId}: income ${income} recognised but ${parts} assigned to the rules`);
      for (const e of evs) if (e.name !== "PartOwed") console.log(`  ${e.name}(${e.args.map(String).join(", ")})`);
    }
    if (c.tax) await taxBooks(c.tax, receipt, rec.opId);
  }
  // Read-backs of the setup writes, the WHOLE tuple each wrote; used after the write and on the already-present path.
  const PRESET_FIELDS = ["validator", "tokenModuleId", "vaultModuleId", "curveModuleId", "tradeModuleId", "migrateModuleId", "tokenImplId", "customDataId", "author"];
  async function presetDiffers(c) {
    const p = await registry.getPreset(BigInt(c.presetId));
    if (p.id === 0n || !p.active || !p.createEnabled) return "not registered and open";
    const k = PRESET_FIELDS.find((f) => String(p[f]) !== String(c.fields[f]));
    return k ? `${k}: ${p[k]}, written ${c.fields[k]}` : null;
  }
  const FEE_FIELDS = ["protocolFeeBps", "developerFeePoolBps", "maxProtocolDevFeeBps", "maxTaxBps", "maxTaxTiers", "partnerProtocolShareBps"];
  async function feeDiffers(c) {
    const f = await new ethers.Contract(fork.addresses.feeRouter, ABI.feeRouter, provider).presetFeeConfig(BigInt(c.presetId));
    if (!f.active) return "not active";
    const k = FEE_FIELDS.find((x) => String(f[x]) !== String(c.cfg[x]));
    return k ? `${k}: ${f[k]}, written ${c.cfg[k]}` : null;
  }
  async function pileDiffers(c) {
    const clone = new ethers.Contract(c.clone, artifact("PileTaxVault").abi, provider);
    const pl = await clone.pile();
    if (pl === ethers.ZeroAddress) return "the clone has no pile";
    const fr = new ethers.Contract(pl, artifact("FeeRules").abi, provider);
    if ((await fr.token()) !== c.token || (await fr.asset()) !== c.quote || JSON.stringify(await fr.excludedHolders()) !== JSON.stringify([c.vault])) {
      return "the clone's pile is not the token's pile, in its quote coin, with the vault excluded";
    }
    return null;
  }
  /// The clone's rules as created: the clone holds the creator's rules; its splitter has exactly the non-zero rules in the
  /// order creator, pile, buy and burn (the pile is the token's, in its quote coin, with the vault excluded).
  async function rulesDiffer(c) {
    const clone = new ethers.Contract(c.clone, artifact("RulesTaxVault").abi, provider);
    const sp = await clone.splitter();
    if (sp === ethers.ZeroAddress) return "the clone has no splitter";
    const r = c.rules;
    if ((await clone.creator()) !== r.creator || Number(await clone.creatorBps()) !== r.creatorBps || Number(await clone.pileBps()) !== r.pileBps || Number(await clone.burnBps()) !== r.burnBps) {
      return "the clone's rules are not the ones in the create arguments";
    }
    const pl = await clone.pile();
    if (r.pileBps === 0) {
      if (pl !== ethers.ZeroAddress) return "a pile exists although the pile part is 0";
    } else {
      const fr = new ethers.Contract(pl, artifact("FeeRules").abi, provider);
      if ((await fr.token()) !== c.token || (await fr.asset()) !== c.quote || JSON.stringify(await fr.excludedHolders()) !== JSON.stringify([c.vault])) {
        return "the clone's pile is not the token's pile, in its quote coin, with the vault excluded";
      }
    }
    const split = new ethers.Contract(sp, artifact("RuleSplitter").abi, provider);
    const want = [[1n, r.creatorBps, r.creator], [2n, r.pileBps, pl], [3n, r.burnBps, c.router]].filter((x) => x[1] !== 0).map((x) => [x[0], BigInt(x[1]), x[2]]);
    const got = [];
    for (let i = 0; i < Number(await split.ruleCount()); i++) got.push(Array.from(await split.rule(i)));
    if ((await split.token()) !== c.token || (await split.asset()) !== c.quote || JSON.stringify(got.map(String)) !== JSON.stringify(want.map(String))) {
      return "the splitter's token, coin or rules are not the creator's";
    }
    return null;
  }
  /// The tax books of ONE transaction, from its receipt: no deferral, and the founder tax it dispatched is exactly the
  /// quote coin that arrived at the pile in it (ForwardVault -> clone -> pile).
  async function taxBooks(t, receipt, what) {
    const own = logsOf(receipt, t.token);
    const deferred = own.find((e) => e.name === "FeeDispatchDeferred");
    if (deferred) stop(`${what}: the token DEFERRED its tax work (kind ${deferred.args.kind}, amount ${deferred.args.amount}); the tax is not in the pile`);
    const founder = own.filter((e) => e.name === "FeeDispatched").reduce((a, e) => a + e.args.amountFounder, 0n);
    const arrived = logsOf(receipt, t.quote).filter((e) => e.name === "Transfer" && e.args.to === t.pile).reduce((a, e) => a + e.args.value, 0n);
    if (founder !== arrived) stop(`${what}: the token dispatched ${founder} of founder tax in this transaction, but ${arrived} reached the pile`);
    console.log(`  tax books of this transaction agree: ${founder} dispatched = ${arrived} into the pile`);
  }
  async function act(opId, description, build, opts = {}) {
    const { receipt, rec } = await send(ctx, opId, description, build, opts);
    if (rec.status === "verified") {
      console.log(`verified before: ${opId}`);
      return receipt;
    }
    await runCheck(rec, receipt);
    verified(rec);
    console.log(`  verified ${opId}`);
    return receipt;
  }

  // Open operations outside this request are finished and verified first; then this request is NOT run (exit 4).
  if (prefix) {
    const others = openOps(ctx.identity).filter((r) => !r.opId.startsWith(prefix));
    if (others.length) {
      for (const r of others) {
        await act(r.opId, r.description, null);
        console.log(`finished and verified an earlier operation: ${r.opId}`);
      }
      stop(`"${step}" was NOT run: earlier operations were finished first (above); rerun the same command`, 4);
    }
  }

  async function deploy(opId, name, args, what) {
    const a = artifact(name);
    const receipt = await act(opId, `deploy ${name}${what ? ` (${what})` : ""}`,
      async () => new ethers.ContractFactory(a.abi, a.bytecode, wallet).getDeployTransaction(...args), { check: { kind: "deploy" } });
    return receipt.contractAddress;
  }
  async function quote18(address) {
    const d = await erc20(address).decimals();
    if (d !== 18n) stop(`the quote coin ${address} has ${d} decimals: only 18-decimal quote coins are supported`, 2);
  }
  /// The approval of an action: never once its spend exists (a restart resumes the spend); otherwise as the plan decided
  /// (`plan.approve`: false only when the allowance already read exactly the amount when the plan was made).
  async function approveExact(opId, spendOp, approve, token, spender, amount, label) {
    if (readOp(spendOp) || !approve) return;
    await act(opId, `approve exactly ${fmt(amount)} of ${label} (${token}) to ${spender}`,
      async () => call(ctx, erc20(token), "approve", [spender, amount]), { check: { kind: "approve", token, spender, amount: amount.toString() } });
  }
  const needsApproval = async (token, spender, amount) => (await erc20(token).allowance(wallet.address, spender)) !== amount;
  async function revokeLeftover(opId, token, spender, label) {
    if (readOp(opId) || (await erc20(token).allowance(wallet.address, spender)) > 0n) {
      await act(opId, `revoke the remaining approval of ${label} to ${spender}`,
        async () => call(ctx, erc20(token), "approve", [spender, 0n]), { check: { kind: "approve", token, spender, amount: "0" } });
    }
  }
  function quoteAddress() {
    if (process.env.QUOTE) return ethers.getAddress(process.env.QUOTE);
    const mock = readOut("mock-quote.json", ctx.identity, { optional: true });
    if (mock) return mock.quote;
    stop("set QUOTE (an 18-decimal ERC-20) or run mock-quote first", 2);
  }
  function createdEvent(receipt) {
    const ev = logsOf(receipt, fork.addresses.core).find((e) => e.name === "TokenCreated");
    if (!ev) stop("TokenCreated missing from the creation receipt");
    return ev.args;
  }
  async function createArgsFor(presetId, quote, form) {
    const latest = await provider.getBlock("latest");
    const createArgs = encodeCreateArgs({
      requestId: BigInt(latest.timestamp) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      presetId, validTimestamp: BigInt(latest.timestamp) + 3600n, quoteAsset: quote, form,
      schemas: await presetSchemas(tools, presetId),
    });
    return { createArgs, signature: await signCreate(wallet, 97n, wallet.address, createArgs) };
  }
  /// The plan of an action: fixed the first time, read back afterwards (a different step or value for the same id is refused).
  function plan(id, request, compute) {
    const file = path.join(ACTIONS, `${id}.json`);
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!sameCopy(p.run, ctx.identity)) stop(`out/actions/${id}.json belongs to another run or copy: move it away first`, 2);
      if (JSON.stringify(p.request) !== JSON.stringify(request)) stop(`action ${id} was planned as ${JSON.stringify(p.request)}: give a new --action id for a different request`, 2);
      return p;
    }
    return compute().then((p) => {
      const out = { run: ctx.identity, request, ...str(p) };
      if (process.env.OPENFOUR_DRY !== "1") writeAtomic(file, out); // a dry run fixes no plan
      return out;
    });
  }
  /// Marks a graduation round finished (no "OK" line: only the whole action ends with one).
  function finishRound(r) {
    const file = path.join(ACTIONS, `${r}.json`);
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!sameCopy(p.run, ctx.identity)) stop(`out/actions/${r}.json belongs to another run or copy`, 2);
    p.done = true;
    writeAtomic(file, p);
    console.log(`round ${r} bought`);
  }
  /// Completes an action: only when every allowance it used reads zero (else stop), then "OK <id>".
  async function done(id, detail, allowances = []) {
    for (const [token, spender] of allowances) {
      const left = await erc20(token).allowance(wallet.address, spender);
      if (left !== 0n) stop(`${id}: ${left} of ${token} is still approved to ${spender}; the action is not complete. Rerun the same command`);
    }
    const file = path.join(ACTIONS, `${id}.json`);
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!sameCopy(p.run, ctx.identity)) stop(`out/actions/${id}.json belongs to another run or copy`, 2);
    p.done = true;
    writeAtomic(file, p);
    ok(id, detail);
  }


  if (step === "set-signer") {
    // After the scripted launches: hand creation signing to the signing service's own key (sign/README.md). The
    // target comes from the service's keystore (decrypted here, only its address kept), or for a key without a file
    // here, as an address. Each target is its own operation; OK only after Core's signer reads the requested address.
    const ks = arg("--keystore");
    const pw = arg("--password-file");
    const round = arg("--round");
    if (round !== undefined && !/^([2-9]|[1-9][0-9])$/.test(round)) stop("--round <n>: a whole number from 2 to 99 (round 1 is the first handover, without --round)", 2);
    const back = process.argv.includes("--back-to-wallet");
    let target;
    if (back) {
      // For a scripted launch only: the run wallet signs creations again until the next set-signer of this round.
      if (ks !== undefined || pw !== undefined || value || round === undefined) stop("set-signer --back-to-wallet --round <n>, with no keystore and no address", 2);
      target = wallet.address;
    } else if (ks !== undefined || pw !== undefined) {
      if (!ks || !pw || value) stop("set-signer --keystore <service keystore> --password-file <its password file>, with no address", 2);
      try {
        target = ethers.Wallet.fromEncryptedJsonSync(fs.readFileSync(ks, "utf8"), fs.readFileSync(pw, "utf8").replace(/\r?\n$/, "")).address;
      } catch {
        stop("service keystore: decryption failed", 2);
      }
      console.log(`the service keystore's address: ${target}`);
    } else {
      if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) stop("set-signer --keystore <service keystore> --password-file <its password file> (or set-signer <0x address> for a key without a keystore here)", 2);
      target = ethers.getAddress(value.toLowerCase());
    }
    if (!back && target === wallet.address) stop("the signing service needs a key of its own, not this wallet", 2);
    if (!LOCAL && testKeyAddresses().has(target)) stop(`${target} is a public test key: not for a real run`, 2);
    const opId = round === undefined ? `set-signer.${target.toLowerCase()}` : `set-signer.r${round}.${target.toLowerCase()}`;
    if (back && readOp(opId) && readOp(opId).status === "verified") {
      // A rerun after the round closed (the service's key set again in the same round, later): nothing to do.
      const dir = path.join(OUT, "ops");
      const closed = fs.readdirSync(dir).filter((f) => f.startsWith(`set-signer.r${round}.`) && f !== `${opId}.json`)
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
        .some((r) => r.status === "verified" && r.nonce > readOp(opId).nonce);
      if (closed) return ok("set-signer", `round ${round}: the handback and the service's key again were done before; nothing sent`);
    }
    if (readOp(opId) || (await core.signer()) !== target) {
      await act(opId, `Core.setSigner(${target})`, async () => call(ctx, core, "setSigner", [target]), { check: { kind: "signer", address: target } });
    }
    if ((await core.signer()) !== target) stop(`Core's signer reads ${await core.signer()}, not ${target}${readOp(opId) ? `: ${opId} was done before; a new handover needs a new --round` : ""}`);
    return ok("set-signer", back ? `Core's signer is this wallet ${target} again: the signing service's signatures are refused until set-signer --keystore ... --round ${round}` : `Core's signer is ${target}; this wallet no longer signs creations`);
  }

  if (step === "mock-quote") {
    const had = readOut("mock-quote.json", ctx.identity, { optional: true });
    if (had) return ok("mock-quote", `exists: ${had.quote}; nothing sent`);
    const quote = await deploy("mock-quote", "MockERC20", [], "1,000,000 QUOTE to the signer");
    writeOut("mock-quote.json", ctx.identity, { quote });
    return ok("mock-quote", `${quote}`);
  }

  if (step === "tax-template") {
    const had = readOut("tax-template.json", ctx.identity, { optional: true });
    if (had) return ok("tax-template", `exists: ${had.template}; nothing sent`);
    const template = await deploy("tax-template", "PileTaxVault", []);
    writeOut("tax-template.json", ctx.identity, { template });
    return ok("tax-template", `${template}`);
  }

  if (step === "tax-rules-template") {
    const had = readOut("tax-rules-template.json", ctx.identity, { optional: true });
    if (had) return ok("tax-rules-template", `exists: ${had.template}; nothing sent`);
    const template = await deploy("tax-rules-template", "RulesTaxVault", [ROUTER], `buy and burn on the PancakeSwap V2 router ${ROUTER}`);
    writeOut("tax-rules-template.json", ctx.identity, { template, router: ROUTER });
    return ok("tax-rules-template", `${template}`);
  }

  if (step === "create-tax-rules") {
    const had = readOut("launch-tax-rules.json", ctx.identity, { optional: true });
    if (had) return ok("create-tax-rules", `the rules launch exists: token ${had.token}, splitter ${had.splitter}, pile ${had.pile}; nothing sent`);
    const { template } = readOut("tax-rules-template.json", ctx.identity);
    const parts = String(process.env.RULES || "2000,5000,3000").split(",").map((x) => (/^\d{1,5}$/.test(x) ? Number(x) : NaN));
    if (parts.length !== 3 || !validRules(parts[0], parts[1], parts[2])) {
      stop("RULES=<creator bps>,<pile bps>,<buy and burn bps>: whole numbers from 0 to 10000 summing to 10000 (a part of 0: that rule is not there)", 2);
    }
    const rules = { creator: wallet.address, creatorBps: parts[0], pileBps: parts[1], burnBps: parts[2] };
    // The launch's name, symbol and picture link, within the signing service's own rules (sign/sign-create.js).
    const name = process.env.NAME || "Rules Tax Demo";
    const symbol = process.env.SYMBOL || "RTAX";
    const tokenUri = process.env.TOKEN_URI || "";
    if (!/^[A-Za-z0-9 .-]{1,32}$/.test(name) || name.trim() !== name) stop("NAME: 1 to 32 letters, digits, spaces, dots or dashes", 2);
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) stop("SYMBOL: 1 to 10 capital letters or digits", 2);
    if (tokenUri.length > 200 || (tokenUri !== "" && !/^(https|ipfs):\/\/[\x21-\x7e]+$/.test(tokenUri))) stop("TOKEN_URI: empty, or https:// or ipfs:// and at most 200 characters", 2);
    const initData = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)"], [[rules.creator, rules.creatorBps, rules.pileBps, rules.burnBps]]);
    const presetId = BigInt(fork.presets.bondingTaxV1);
    const receipt = await act("launch-tax-rules.create", `Core.createToken(Bonding Tax V1 + ForwardVault -> rules template ${template}, rules ${parts.join("/")})`, async () => {
      const quote = quoteAddress();
      await quote18(quote);
      const { createArgs, signature } = await createArgsFor(presetId, quote, {
        name, symbol, tokenUri,
        maxSupply: process.env.MAX_SUPPLY || "1000000000", saleAmount: process.env.SALE_AMOUNT || "800000000",
        raiseAmount: process.env.RAISE_AMOUNT || "1", buyFeeRate: process.env.TAX_BUY_BPS || "300", sellFeeRate: process.env.TAX_SELL_BPS || "300",
        founder: wallet.address, rateFounder: "100", rateHolder: "0", rateBurn: "0", rateLiquidity: "0", minShare: "10000",
        taxVaultTypeId: FORWARD_VAULT_TYPE_ID,
        taxVaultInitParams: ethers.AbiCoder.defaultAbiCoder().encode(["(address,bytes)"], [[template, initData]]),
      });
      console.log(`creating "${name}" (${symbol}) with quote ${quote}${tokenUri ? `, picture ${tokenUri}` : ""}`);
      return call(ctx, core, "createToken", [createArgs, signature]);
    }, { gasLimit: CREATE_TAX_GAS, check: { kind: "created", presetId: presetId.toString() } });
    const ev = createdEvent(receipt);
    const forwardVault = await new ethers.Contract(ev.token, TAX_ABI, provider).founder();
    const clone = new ethers.Contract(await new ethers.Contract(forwardVault, ["function clonedVault() view returns (address)"], provider).clonedVault(), artifact("RulesTaxVault").abi, wallet);
    const rulesCheck = { kind: "rules", clone: await clone.getAddress(), token: ev.token, vault: ev.vault, quote: ev.quoteAsset, router: ROUTER, rules: { ...rules } };
    if (readOp("launch-tax-rules.create-rules") || (await clone.splitter()) === ethers.ZeroAddress) {
      await act("launch-tax-rules.create-rules", `RulesTaxVault(${await clone.getAddress()}).createRules()`, async () => call(ctx, clone, "createRules", []), { check: rulesCheck });
    }
    const bad = await rulesDiffer(rulesCheck);
    if (bad) stop(bad);
    writeOut("launch-tax-rules.json", ctx.identity, {
      kind: "tax-rules", token: ev.token, vault: ev.vault, quote: ev.quoteAsset, forwardVault, taxVaultClone: await clone.getAddress(),
      splitter: await clone.splitter(), pile: await clone.pile(), template, rules, createTx: receipt.hash,
      name: ev.name, symbol: ev.symbol, tokenUri: ev.tokenMetaUri,
    });
    return ok("create-tax-rules", `token ${ev.token} "${ev.name}" (${ev.symbol}), picture "${ev.tokenMetaUri}", quote ${ev.quoteAsset}, splitter ${await clone.splitter()}, pile ${await clone.pile()}`);
  }

  if (step === "register") {
    const had = readOut("preset-registration.json", ctx.identity, { optional: true });
    if (had) return ok("register", `preset ${had.presetId} registered already; nothing sent`);
    const bondingId = BigInt(fork.presets.bondingV1);
    const bonding = await registry.getPreset(bondingId);
    const impl = await deploy("register.trade-impl", "PileTradeModule", []);
    const key = ethers.keccak256(ethers.toUtf8Bytes(TRADE_MODULE_KEY_SOURCE));
    const current = await registry.getModuleImplementation(key);
    if (readOp("register.upsert-module") || current === ethers.ZeroAddress) {
      await act("register.upsert-module", `Registry.upsertModule(${TRADE_MODULE_KEY_SOURCE} -> ${impl})`, async () => call(ctx, registry, "upsertModule", [
        key, impl, 3, { moduleId: key, version: "1.0.0", name: "PileTradeModule", description: "Trade fee paid into a pile every holder can redeem", author: wallet.address, feeShareBps: 0 }, true,
      ]), { check: { kind: "module", key, impl } });
    } else if (current !== impl) {
      stop(`${TRADE_MODULE_KEY_SOURCE} already points at ${current} on this copy, not at ${impl}: not overwritten`, 2);
    }
    const validator = await deploy("register.validator", "PilePresetValidator", [bonding.validator, 1000], `inner ${bonding.validator}, max 1000 bps`);
    const preset = {
      id: PRESET_ID, name: "Pile Bonding",
      description: "Bonding launch whose trading fee fills a pile every holder can redeem; rules fixed at creation",
      version: "1.0.0", active: true, createEnabled: true, validator,
      tokenModuleId: bonding.tokenModuleId, vaultModuleId: bonding.vaultModuleId, curveModuleId: bonding.curveModuleId,
      tradeModuleId: key, migrateModuleId: bonding.migrateModuleId, tokenImplId: bonding.tokenImplId,
      customDataId: bonding.customDataId, author: wallet.address,
    };
    const presetCheck = { kind: "preset", presetId: PRESET_ID.toString(), fields: Object.fromEntries(PRESET_FIELDS.map((f) => [f, String(preset[f])])) };
    const existing = await registry.getPreset(PRESET_ID);
    if (readOp("register.upsert-preset") || existing.id === 0n) {
      await act("register.upsert-preset", `Registry.upsertPreset(${PRESET_ID}, Pile Bonding)`, async () => call(ctx, registry, "upsertPreset", [preset]), { check: presetCheck });
    } else {
      const bad = await presetDiffers(presetCheck);
      if (bad) stop(`preset ${PRESET_ID} exists on this copy with another configuration (${bad}): not overwritten`, 2);
    }
    const feeRouter = new ethers.Contract(fork.addresses.feeRouter, ABI.feeRouter, wallet);
    const cfg = await feeRouter.presetFeeConfig(bondingId);
    const feeCheck = { kind: "preset-fee", presetId: PRESET_ID.toString(), cfg: Object.fromEntries(FEE_FIELDS.map((f) => [f, cfg[f].toString()])) };
    if (!readOp("register.preset-fee") && cfg.active && (await feeRouter.presetFeeConfig(PRESET_ID)).active) {
      const bad = await feeDiffers(feeCheck);
      if (bad) stop(`preset ${PRESET_ID}'s fee configuration exists with other values (${bad}): not overwritten`, 2);
    }
    if (readOp("register.preset-fee") || (cfg.active && !(await feeRouter.presetFeeConfig(PRESET_ID)).active)) {
      await act("register.preset-fee", `FeeRouter.setPresetFeeConfig(${PRESET_ID}) = Bonding V1's`, async () => call(ctx, feeRouter, "setPresetFeeConfig", [PRESET_ID, {
        protocolFeeBps: cfg.protocolFeeBps, developerFeePoolBps: cfg.developerFeePoolBps, maxProtocolDevFeeBps: cfg.maxProtocolDevFeeBps,
        maxTaxBps: cfg.maxTaxBps, maxTaxTiers: cfg.maxTaxTiers, active: true, partnerProtocolShareBps: cfg.partnerProtocolShareBps,
      }]), { check: feeCheck });
    }
    const presetBad = await presetDiffers(presetCheck);
    if ((await registry.getModuleImplementation(key)) !== impl || presetBad) stop(`the Registry does not show the preset as registered (${presetBad || "module"})`);
    writeOut("preset-registration.json", ctx.identity, { presetId: PRESET_ID.toString(), tradeModuleImplementation: impl, validator, innerValidator: bonding.validator });
    return ok("register", `preset ${PRESET_ID}, module ${impl}, validator ${validator}`);
  }

  if (step === "create") {
    const had = readOut("launch-preset.json", ctx.identity, { optional: true });
    if (had) return ok("create", `the preset launch exists: token ${had.token}, pile ${had.pile}; nothing sent`);
    const reg = readOut("preset-registration.json", ctx.identity);
    // A recorded creation is looked up before anything new is built.
    const receipt = await act("launch-preset.create", "Core.createToken(Pile Bonding)", async () => {
      const quote = quoteAddress();
      await quote18(quote);
      const { createArgs, signature } = await createArgsFor(BigInt(reg.presetId), quote, {
        name: process.env.NAME || "Pile Demo", symbol: process.env.SYMBOL || "PILE",
        maxSupply: process.env.MAX_SUPPLY || "1000000000", saleAmount: process.env.SALE_AMOUNT || "800000000",
        raiseAmount: process.env.RAISE_AMOUNT || "1", buyFeeBps: process.env.BUY_FEE_BPS || "100", sellFeeBps: process.env.SELL_FEE_BPS || "100",
      });
      console.log(`creating with quote ${quote}`);
      return call(ctx, core, "createToken", [createArgs, signature]);
    }, { check: { kind: "created", presetId: reg.presetId } });
    const ev = createdEvent(receipt);
    const trade = new ethers.Contract(ev.tradeModule, artifact("PileTradeModule").abi, provider);
    writeOut("launch-preset.json", ctx.identity, {
      kind: "preset", token: ev.token, vault: ev.vault, quote: ev.quoteAsset, tradeModule: ev.tradeModule, pile: await trade.pile(), createTx: receipt.hash,
    });
    return ok("create", `token ${ev.token}, quote ${ev.quoteAsset}, pile ${await trade.pile()}`);
  }

  if (step === "create-tax") {
    const had = readOut("launch-tax.json", ctx.identity, { optional: true });
    if (had) return ok("create-tax", `the tax launch exists: token ${had.token}, pile ${had.pile}; nothing sent`);
    const { template } = readOut("tax-template.json", ctx.identity);
    const presetId = BigInt(fork.presets.bondingTaxV1);
    const receipt = await act("launch-tax.create", `Core.createToken(Bonding Tax V1 + ForwardVault -> template ${template})`, async () => {
      const quote = quoteAddress();
      await quote18(quote);
      const { createArgs, signature } = await createArgsFor(presetId, quote, {
        name: process.env.NAME || "Pile Tax Demo", symbol: process.env.SYMBOL || "PTAX",
        maxSupply: process.env.MAX_SUPPLY || "1000000000", saleAmount: process.env.SALE_AMOUNT || "800000000",
        raiseAmount: process.env.RAISE_AMOUNT || "1", buyFeeRate: process.env.TAX_BUY_BPS || "300", sellFeeRate: process.env.TAX_SELL_BPS || "300",
        founder: wallet.address, rateFounder: "100", rateHolder: "0", rateBurn: "0", rateLiquidity: "0", minShare: "10000",
        taxVaultTypeId: FORWARD_VAULT_TYPE_ID,
        taxVaultInitParams: ethers.AbiCoder.defaultAbiCoder().encode(["(address,bytes)"], [[template, "0x"]]),
      });
      console.log(`creating with quote ${quote}`);
      return call(ctx, core, "createToken", [createArgs, signature]);
    }, { gasLimit: CREATE_TAX_GAS, check: { kind: "created", presetId: presetId.toString() } });
    const ev = createdEvent(receipt);
    const forwardVault = await new ethers.Contract(ev.token, TAX_ABI, provider).founder();
    const clone = new ethers.Contract(await new ethers.Contract(forwardVault, ["function clonedVault() view returns (address)"], provider).clonedVault(), artifact("PileTaxVault").abi, wallet);
    const pileCheck = { kind: "pile", clone: await clone.getAddress(), token: ev.token, vault: ev.vault, quote: ev.quoteAsset };
    if (readOp("launch-tax.create-pile") || (await clone.pile()) === ethers.ZeroAddress) {
      await act("launch-tax.create-pile", `PileTaxVault(${await clone.getAddress()}).createPile()`, async () => call(ctx, clone, "createPile", []), { check: pileCheck });
    }
    const pileBad = await pileDiffers(pileCheck);
    if (pileBad) stop(pileBad);
    const pileAddr = await clone.pile();
    writeOut("launch-tax.json", ctx.identity, {
      kind: "tax", token: ev.token, vault: ev.vault, quote: ev.quoteAsset, forwardVault, taxVaultClone: await clone.getAddress(), pile: pileAddr, template, createTx: receipt.hash,
    });
    return ok("create-tax", `token ${ev.token}, quote ${ev.quoteAsset}, pile ${pileAddr}`);
  }

  if (step === "wrap") {
    const id = `wrap.${action}`;
    const p = await plan(id, { step, value }, async () => ({ amount: units(value, "tBNB to wrap") }));
    if (p.done) return ok(id, "done before; nothing sent");
    const wbnb = new ethers.Contract(fork.addresses.wbnb, ["function deposit() payable"], wallet);
    await act(`${id}.deposit`, `WBNB.deposit ${fmt(BigInt(p.amount))} tBNB -> WBNB ${fork.addresses.wbnb}`,
      async () => ({ ...(await call(ctx, wbnb, "deposit", [])), value: BigInt(p.amount) }), { check: { kind: "wrap", token: fork.addresses.wbnb, amount: p.amount } });
    return done(id, `${fmt(BigInt(p.amount))} tBNB is now WBNB`);
  }

  const launch = which ? readOut(`launch-${which}.json`, ctx.identity) : stop("give the launch: --launch preset|tax", 2);
  const isTax = launch.kind === "tax" || launch.kind === "tax-rules";
  // Where the token's founder tax arrives: the pile (tax launch) or the splitter (rules launch).
  const taxSink = launch.kind === "tax-rules" ? launch.splitter : launch.pile;
  await quote18(launch.quote);
  const token = new ethers.Contract(launch.token, [...ABI.erc20, ...TAX_ABI], wallet);
  const pile = new ethers.Contract(launch.pile, artifact("FeeRules").abi, wallet);
  const vault = new ethers.Contract(launch.vault, ABI.vault, provider);
  const gas = isTax ? TAX_GAS : undefined;
  const taxSpec = isTax ? { tax: { token: launch.token, pile: taxSink, quote: launch.quote } } : {};
  const phase = async () => PHASE[Number(await vault.phase())];
  const id = `${which}.${action}`;
  async function dispatchDue() {
    if (!isTax) return false;
    const fee = await token.feeAccumulated();
    return (await token.feeToFounder()) > 0n
      || ((await phase()) === "Migrated" && (await token.tokenAccumulated()) > (await token.minDispatch()))
      || (fee > 0n && fee >= (await token.minDispatchQuote()));
  }

  async function splitterStatus() {
    const split = new ethers.Contract(launch.splitter, artifact("RuleSplitter").abi, provider);
    const rules = [];
    for (let i = 0; i < Number(await split.ruleCount()); i++) {
      const [kind, bps, target] = await split.rule(i);
      rules.push({ kind: ["", "creator", "pile", "buy-and-burn"][Number(kind)], bps: Number(bps), target, owed: (await split.owed(i)).toString(), delivered: (await split.delivered(i)).toString(), burned: (await split.burned(i)).toString() });
    }
    return { splitter: launch.splitter, splitterPending: (await split.pending()).toString(), rules, deadTokens: (await token.balanceOf(DEAD)).toString() };
  }

  if (step === "distribute") {
    if (launch.kind !== "tax-rules") stop("distribute is for the rules launch (--launch tax-rules)", 2);
    const p = await plan(id, { step, launch: which }, async () => ({}));
    if (p.done) return ok(id, "done before; nothing sent");
    const split = new ethers.Contract(launch.splitter, artifact("RuleSplitter").abi, wallet);
    await act(`${id}.distribute`, `RuleSplitter(${launch.splitter}).distribute(): pending ${await split.pending()} shared by the creator's rules`,
      async () => call(ctx, split, "distribute", []), { gasLimit: TAX_GAS, check: { kind: "distribute", splitter: launch.splitter } });
    return done(id, `distributed; ${JSON.stringify(await splitterStatus())}`);
  }

  const hasPile = launch.pile !== ethers.ZeroAddress; // a rules launch with a pile part of 0 has no pile
  if (step === "redeem" && !hasPile) stop("this rules launch has no pile (its pile part is 0): nothing to redeem", 2);

  if (step === "status") {
    const one = ethers.parseUnits("1", 18);
    const circ = hasPile ? await pile.circulatingSupply() : 0n;
    console.log(JSON.stringify({
      launch: which, token: launch.token, quote: launch.quote, pile: launch.pile, phase: await phase(),
      ...(hasPile ? {
        pile_balance: (await pile.pile()).toString(), totalReceived: (await pile.totalReceived()).toString(),
        totalPaidOut: (await pile.totalPaidOut()).toString(), circulatingSupply: circ.toString(),
        redeemPerToken: circ >= one ? (await pile.quoteRedeem(one)).toString() : "0",
      } : {}),
      taxWaitingInQuote: isTax ? (await token.feeAccumulated()).toString() : undefined,
      taxWaitingInTokens: isTax ? (await token.tokenAccumulated()).toString() : undefined,
      signerTokens: (await token.balanceOf(wallet.address)).toString(),
      ...(launch.kind === "tax-rules" ? await splitterStatus() : {}),
    }, null, 2));
    return console.log(`OK status ${which}`);
  }

  if (step === "buy") {
    const p = await plan(id, { step, value, launch: which }, async () => {
      const amount = units(value, "tokens to buy");
      const est = await tools.estimateBuy.staticCall(launch.token, wallet.address, amount, 0n, "0x");
      if (est.userPays <= 0n || est.tokenAmount !== amount) stop(`no quote for ${fmt(amount)} tokens (pays ${est.userPays}, tokens ${est.tokenAmount})`);
      const maxPay = (est.userPays * (BPS + SLIPPAGE)) / BPS;
      return { amount, maxPay, quoted: est.userPays, approve: await needsApproval(launch.quote, fork.addresses.core, maxPay) };
    });
    if (p.done) return ok(id, "done before; nothing sent");
    await approveExact(`${id}.approve`, `${id}.buy`, p.approve, launch.quote, fork.addresses.core, BigInt(p.maxPay), "quote");
    await act(`${id}.buy`, `Core.buy ${fmt(BigInt(p.amount))} tokens, paying at most ${fmt(BigInt(p.maxPay))} quote (quoted ${fmt(BigInt(p.quoted))})`,
      async () => call(ctx, core, "buy", [launch.token, BigInt(p.amount), BigInt(p.maxPay), 0n, "0x"]), { gasLimit: gas, check: { kind: "tokens-in", token: launch.token, exact: p.amount, ...taxSpec } });
    await revokeLeftover(`${id}.revoke`, launch.quote, fork.addresses.core, "quote");
    return done(id, `bought ${fmt(BigInt(p.amount))} tokens`, [[launch.quote, fork.addresses.core]]);
  }

  if (step === "sell") {
    const p = await plan(id, { step, value, launch: which }, async () => {
      const amount = units(value, "tokens to sell");
      const est = await tools.estimateSell.staticCall(launch.token, wallet.address, amount, 0n, "0x");
      return { amount, minOut: lowerBound(est.userReceives, "sell"), quoted: est.userReceives, approve: await needsApproval(launch.token, fork.addresses.core, amount) };
    });
    if (p.done) return ok(id, "done before; nothing sent");
    await approveExact(`${id}.approve`, `${id}.sell`, p.approve, launch.token, fork.addresses.core, BigInt(p.amount), "tokens");
    const native = launch.quote.toLowerCase() === fork.addresses.wbnb.toLowerCase() ? { native: true } : {};
    await act(`${id}.sell`, `Core.sell ${fmt(BigInt(p.amount))} tokens for at least ${fmt(BigInt(p.minOut))} quote (quoted ${fmt(BigInt(p.quoted))})`,
      async () => call(ctx, core, "sell", [launch.token, BigInt(p.amount), BigInt(p.minOut), 0n, "0x"]), { gasLimit: gas, check: { kind: "sell", token: launch.token, quote: launch.quote, amount: p.amount, min: p.minOut, ...native, ...taxSpec } });
    await revokeLeftover(`${id}.revoke`, launch.token, fork.addresses.core, "tokens");
    return done(id, `sold ${fmt(BigInt(p.amount))} tokens`, [[launch.token, fork.addresses.core]]);
  }

  if (step === "graduate") {
    const p = await plan(id, { step, value, launch: which }, async () => ({ budget: units(value, "budget per round") }));
    if (p.done) return ok(id, "done before; nothing sent");
    const budget = BigInt(p.budget);
    for (let k = 1; k <= 20; k++) {
      const r = `${id}.r${k}`;
      const started = fs.existsSync(path.join(ACTIONS, `${r}.json`));
      if (!started && (await phase()) === "Migrated") break;
      const rp = await plan(r, { round: k }, async () => {
        const est = await tools.estimateBuyByBudget.staticCall(launch.token, wallet.address, budget, 0n, "0x");
        if (est.userPays <= 0n) stop(`graduate round ${k}: no quote for a budget of ${fmt(budget)}`);
        return { minOut: lowerBound(est.tokenAmount, `graduate round ${k}`), quoted: est.tokenAmount, approve: await needsApproval(launch.quote, fork.addresses.core, budget) };
      });
      if (rp.done) continue;
      await approveExact(`${r}.approve`, `${r}.buy`, rp.approve, launch.quote, fork.addresses.core, budget, "quote");
      await act(`${r}.buy`, `Core.buyByBudget at most ${fmt(budget)} quote for at least ${fmt(BigInt(rp.minOut))} tokens (quoted ${fmt(BigInt(rp.quoted))})`,
        async () => call(ctx, core, "buyByBudget", [launch.token, budget, BigInt(rp.minOut), 0n, "0x"]), { gasLimit: gas, check: { kind: "tokens-in", token: launch.token, min: rp.minOut, ...taxSpec } });
      finishRound(r);
    }
    await revokeLeftover(`${id}.revoke`, launch.quote, fork.addresses.core, "quote");
    const now = await phase();
    if (now !== "Migrated") stop(`graduate: the token is in phase ${now} with ${fmt(await vault.remainingForSale())} tokens left for sale: NOT graduated; rerun the same command with a larger budget under a new --action id`);
    return done(id, "graduated: phase Migrated", [[launch.quote, fork.addresses.core]]);
  }

  if (step === "settle") {
    if (!isTax) stop("settle is for the tax launch", 2);
    const p = await plan(id, { step, launch: which }, async () => ({ due: await dispatchDue() }));
    if (p.done) return ok(id, "done before; nothing sent");
    if (!p.due) {
      if (await dispatchDue()) stop(`${id}: tax became due after the plan said none was; give a new --action id`);
      return done(id, "no tax was due");
    }
    await act(`${id}.settle`, `token.transfer(self, 0): the token pays the tax due into ${taxSink}`,
      async () => call(ctx, token, "transfer", [wallet.address, 0n]), { gasLimit: gas, check: { kind: "settle", token: launch.token, due: true, ...taxSpec } });
    return done(id, `tax paid into the pile; pile ${await pile.pile()}`);
  }

  if (step === "dex-sell" || step === "dex-buy") {
    const sell = step === "dex-sell";
    const p = await plan(id, { step, value, launch: which }, async () => {
      if ((await phase()) !== "Migrated") stop(`${step}: the token has not graduated`, 2);
      const amount = units(value, sell ? "tokens to sell" : "quote to spend");
      const rate = isTax ? await (sell ? token.sellFeeRate() : token.buyFeeRate()) : 0n;
      const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
      const route = sell ? [launch.token, launch.quote] : [launch.quote, launch.token];
      const out = (await router.getAmountsOut(sell ? amount - (amount * rate) / BPS : amount, route))[1];
      const net = sell ? out : out - (out * rate) / BPS;
      return { amount, route, rate, net, minOut: lowerBound(net, step), settleFirst: sell && (await dispatchDue()), approve: await needsApproval(sell ? launch.token : launch.quote, ROUTER, amount) };
    });
    if (p.done) return ok(id, "done before; nothing sent");
    if (p.settleFirst) {
      // The sell would run the pending tax swap first and move the price: the tax is paid in first, checked.
      await act(`${id}.settle`, "token.transfer(self, 0): pay the tax due into the pile before the sell",
        async () => call(ctx, token, "transfer", [wallet.address, 0n]), { gasLimit: gas, check: { kind: "settle", token: launch.token, due: true, ...taxSpec } });
    }
    const amount = BigInt(p.amount);
    await approveExact(`${id}.approve`, `${id}.swap`, p.approve, sell ? launch.token : launch.quote, ROUTER, amount, sell ? "tokens" : "quote");
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    await act(`${id}.swap`, `PancakeSwap ${sell ? "sell" : "buy"}: ${fmt(amount)} in, at least ${fmt(BigInt(p.minOut))} out (net ${fmt(BigInt(p.net))}, tax ${p.rate} bps)`,
      async () => call(ctx, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [amount, BigInt(p.minOut), p.route, wallet.address, BigInt((await provider.getBlock("latest")).timestamp) + 600n]),
      { gasLimit: gas, check: { kind: "tokens-in", token: sell ? launch.quote : launch.token, min: p.minOut, ...taxSpec } });
    await revokeLeftover(`${id}.revoke`, sell ? launch.token : launch.quote, ROUTER, sell ? "tokens" : "quote");
    const waiting = isTax ? ` (tax waiting in the token: ${fmt(await token.tokenAccumulated())} tokens; the next ordinary transfer, a redemption or settle pays it into the pile)` : "";
    return done(id, `swapped ${fmt(amount)}${waiting}`, [[sell ? launch.token : launch.quote, ROUTER]]);
  }

  if (step === "redeem") {
    const p = await plan(id, { step, value, launch: which }, async () => {
      const balance = await token.balanceOf(wallet.address);
      const amount = value === "all" ? balance : units(value, "tokens to hand in");
      if (amount <= 0n || amount > balance) stop(`redeem: ${fmt(amount)} tokens asked, ${fmt(balance)} held`, 2);
      const min = await pile.quoteRedeem(amount);
      if (min <= 0n) stop(`redeem: ${fmt(amount)} tokens quote zero from the pile; nothing sent`);
      return { amount, min, approve: await needsApproval(launch.token, launch.pile, amount) };
    });
    if (p.done) return ok(id, "done before; nothing sent");
    await approveExact(`${id}.approve`, `${id}.redeem`, p.approve, launch.token, launch.pile, BigInt(p.amount), "tokens");
    await act(`${id}.redeem`, `pile.redeem ${fmt(BigInt(p.amount))} tokens for at least ${p.min} quote from ${launch.pile}`,
      async () => call(ctx, pile, "redeem", [BigInt(p.amount), BigInt(p.min)]),
      { gasLimit: gas, check: { kind: "redeem", pile: launch.pile, token: launch.token, amount: p.amount, min: p.min, ...taxSpec } });
    await revokeLeftover(`${id}.revoke`, launch.token, launch.pile, "tokens");
    return done(id, `redeemed ${fmt(BigInt(p.amount))} tokens; pile now ${await pile.pile()}`, [[launch.token, launch.pile]]);
  }
}

main().catch((e) => stop(e.shortMessage || e.message || String(e)));
