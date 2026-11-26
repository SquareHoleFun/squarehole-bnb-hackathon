// The creation signer as a service object, for the HTTP wrapper (its routes and rate limits are the host's):
//
//   const { createSignService } = require("./sign/service");
//   const s = await createSignService({ rpc, outDir, keystore, passwordFile, quotes, raiseMin, raiseMax });
//   const answer = await s.sign(requestBody);            // throws SignRefused (err.code, err.message) on a refusal
//
// It reads its key only from an encrypted keystore with a password file (the key of its own: it signs nothing but
// creation requests and never needs coins; never the run wallet's), the copy from the real run's records in `outDir`
// as ONE identity: the deployment object the anchor (lib/anchor.js) validated on chain, and every companion record
// checked against that same object. The preset is proven by decoding the run's recorded upsertPreset transaction and
// comparing its whole tuple with the Registry's; the template and the tax preset by the run's receipts; every quote
// coin answers decimals() = 18; the schemas hold every field the signer sets. It refuses to start otherwise, and
// unless Core's signer IS this key (the copy's owner sets it once: pile.js set-signer). A refusal at startup is a
// StartupRefused with a fixed text per stage (STAGES below); no provider or file-system message passes through.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { missingSchemaField, raiseBounds, signCreate } = require("./sign-create");
const { anchored } = require("../lib/anchor");

const TOOLS_ABI = [
  "function getPresetEncodeSchemas(uint256) view returns (tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params),tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params),tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params),tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params),tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params),tuple(string kind,uint8 version,tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)[] params))",
];
const PRESET_TUPLE = "tuple(uint256 id, string name, string description, string version, bool active, bool createEnabled, address validator, bytes32 tokenModuleId, bytes32 vaultModuleId, bytes32 curveModuleId, bytes32 tradeModuleId, bytes32 migrateModuleId, bytes32 tokenImplId, bytes32 customDataId, address author)";
const PRESET_FIELDS = ["id", "name", "description", "version", "active", "createEnabled", "validator", "tokenModuleId", "vaultModuleId",
  "curveModuleId", "tradeModuleId", "migrateModuleId", "tokenImplId", "customDataId", "author"];
const REGISTRY_ABI = [`function getPreset(uint256) view returns (${PRESET_TUPLE})`];
const UPSERT = new ethers.Interface([`function upsertPreset(${PRESET_TUPLE} preset)`]);
const CORE_ABI = ["function signer() view returns (address)"];

async function schemasOf(tools, presetId) {
  const names = ["token", "vault", "curve", "trade", "migrate", "customData"];
  const all = await tools.getPresetEncodeSchemas(presetId);
  return Object.fromEntries(names.map((n, i) => [n, Array.from(all[i].params).map((p) => ({
    name: p.name, abiType: p.abiType, decimals: Number(p.decimals), optional: Boolean(p.optional), defaultValue: p.defaultValue,
  }))]));
}

/// The fixed text of each startup stage: what a refusal at startup says, and all it says.
const STAGES = {
  KEY_FILES: "the signer needs a keystore and a password file",
  KEYSTORE: "keystore: decryption failed",
  RUN_WALLET: "this keystore holds the run wallet's key: the service needs a key of its own",
  RECORDS: "the run's records are missing, unreadable or not all of one run and copy",
  CHAIN: "the endpoint is not the chain the run was made on, or did not answer",
  ANCHOR: "the deployment is not confirmed on chain as this run's copy",
  ANCHOR_UNSURE: "the deployment could not be confirmed now (a lookup failed or found no receipt): try again",
  PRESET: "the Registry's preset is not the one this run's recorded upsertPreset transaction wrote",
  TEMPLATE: "the template is not the one this run deployed",
  TAX_LAUNCH: "the tax preset or template is not the one of this run's tax launch",
  TAX_RULES: "the rules template is not the one this run deployed and launched with",
  TAX_RULES_RECORDS: "taxRules: true needs the rules launch's three records: finish scripts/rules-run.sh first, or start without taxRules",
  QUOTES: "every quote coin must be a contract on this chain with decimals() = 18",
  CONFIG: "the presets are not open, or their schemas lack a field the signer sets, or the settings are invalid",
  CORE_SIGNER: "Core's signer is not this key: the copy's owner runs pile.js set-signer with this key's address first",
};

/// A refusal at startup: a fixed stage code and its fixed text.
class StartupRefused extends Error {
  constructor(code) {
    super(STAGES[code]);
    this.code = code;
  }
}

/// Runs one stage; any failure inside it becomes that stage's fixed text.
async function stage(code, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StartupRefused) throw e;
    throw new StartupRefused(code);
  }
}

/// Every quote coin: an address with code on this chain whose decimals() is 18. Returns them checksummed.
async function checkQuotes(provider, quotes) {
  if (!Array.isArray(quotes) || !quotes.length) throw new Error("no quote coins");
  const out = [];
  for (const q of quotes) {
    if (typeof q !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q)) throw new Error("a quote coin is not an address");
    const a = ethers.getAddress(q.toLowerCase());
    if ((await provider.getCode(a)) === "0x") throw new Error(`no code at the quote coin ${a}`);
    const d = await new ethers.Contract(a, ["function decimals() view returns (uint8)"], provider).decimals();
    if (d !== 18n) throw new Error(`the quote coin ${a} has ${d} decimals: only 18-decimal quote coins are signed`);
    out.push(a);
  }
  return out;
}

/// The signing configuration, read from the chain: our preset id, the tax preset id with our template, the schemas.
async function loadConfig({ provider, addresses, presetId, taxPresetId, template, rulesTemplate, quotes, raiseMin = "0.1", raiseMax = "2" }) {
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 97n) throw new Error(`chain ${chainId}: the signer serves BSC Testnet (97) only`);
  if ((await provider.getCode(template)) === "0x") throw new Error(`no template at ${template}`);
  const registry = new ethers.Contract(addresses.registry, REGISTRY_ABI, provider);
  for (const id of [presetId, taxPresetId]) {
    const p = await registry.getPreset(id);
    if (p.id === 0n || !p.active || !p.createEnabled) throw new Error(`preset ${id} is not registered and open on this copy`);
  }
  const tools = new ethers.Contract(addresses.tools, TOOLS_ABI, provider);
  const kinds = {
    preset: { presetId: String(presetId), schemas: await schemasOf(tools, presetId) },
    tax: { presetId: String(taxPresetId), template: ethers.getAddress(template), schemas: await schemasOf(tools, taxPresetId) },
  };
  // SH-287: the tax-rules kind is offered only when a rules template is configured.
  if (rulesTemplate !== undefined) {
    if ((await provider.getCode(rulesTemplate)) === "0x") throw new Error(`no rules template at ${rulesTemplate}`);
    kinds["tax-rules"] = { presetId: String(taxPresetId), template: ethers.getAddress(rulesTemplate), schemas: kinds.tax.schemas };
  }
  // The fields the signer sets must exist in the schemas, or a wrong preset could silently drop them.
  const missing = missingSchemaField(kinds);
  if (missing) throw new Error(`the schema lacks ${missing}, which the signer sets`);
  const raiseWei = raiseBounds(raiseMin, raiseMax); // parsed once, here; reversed or unreadable bounds stop the start
  return { chainId: chainId.toString(), core: addresses.core, quotes: await checkQuotes(provider, quotes), raiseMin, raiseMax, raiseWei, kinds };
}

function loadKey(keystore, passwordFile) {
  if (typeof keystore !== "string" || !keystore || typeof passwordFile !== "string" || !passwordFile) throw new StartupRefused("KEY_FILES");
  try {
    return ethers.Wallet.fromEncryptedJsonSync(fs.readFileSync(keystore, "utf8"), fs.readFileSync(passwordFile, "utf8").replace(/\r?\n$/, ""));
  } catch {
    throw new StartupRefused("KEYSTORE");
  }
}

function sameCopy(a, b) {
  return Boolean(a && b && a.registry && a.endpoint === b.endpoint && a.chainId === b.chainId && a.block1Hash === b.block1Hash
    && a.signer === b.signer && a.registry === b.registry);
}

/// Null when `data` is an upsertPreset call writing preset `expectedId` and the Registry's `onChain` tuple equals the
/// written one in all 15 fields (and is open); else the name of the first difference.
function presetMismatch(data, expectedId, onChain) {
  let call = null;
  try {
    call = UPSERT.parseTransaction({ data });
  } catch {
    call = null;
  }
  if (!call || call.name !== "upsertPreset") return "not an upsertPreset call";
  const written = call.args[0];
  if (written.id !== BigInt(expectedId)) return "id";
  const diff = PRESET_FIELDS.find((f) => String(written[f]) !== String(onChain[f]));
  if (diff) return diff;
  return onChain.active === true && onChain.createEnabled === true ? null : "not open";
}

/// The production factory: the key ONLY from a keystore and a password file (never the run wallet's); the copy ONLY
/// from the real run's records, as the one object the anchor validated, checked on chain. `testClock` (seconds) is for
/// the rehearsal; the service otherwise reads its own clock, and `sign` takes the request body and nothing else.
async function createSignService(options) {
  const { rpc, outDir, keystore, passwordFile, quotes, raiseMin, raiseMax, testClock, taxRules } = options || {};
  // Every step inside a stage: any failure, ours or a library's, leaves as that stage's fixed text and nothing else.
  const key = await stage("KEYSTORE", () => loadKey(keystore, passwordFile));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
  // The run's identity, to find its anchored deployment; refused at once when this key is the run wallet's.
  const { run, runSigner } = await stage("RECORDS", () => {
    const r = read("fork-deployment.json").run;
    if (!r || typeof r.signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.signer) || typeof r.block1Hash !== "string") throw new Error("no run");
    return { run: r, runSigner: ethers.getAddress(r.signer.toLowerCase()) };
  });
  if (key.address === runSigner) throw new StartupRefused("RUN_WALLET");
  const provider = await stage("CHAIN", async () => {
    const request = new ethers.FetchRequest(rpc);
    request.timeout = 45_000;
    const p = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
    if ((await p.getBlock(1)).hash !== run.block1Hash) throw new Error("another chain");
    return p;
  });
  // From here on only the object the anchor validated: its Registry, Core, Tools and presets.
  const anchor = await stage("ANCHOR_UNSURE", () => anchored(provider, outDir, run));
  if (!anchor.d) throw new StartupRefused(anchor.inconclusive ? "ANCHOR_UNSURE" : "ANCHOR");
  const d = anchor.d;
  const owners = await stage("ANCHOR", () => [d.run.signer, d.deployer].map((a) => ethers.getAddress(String(a).toLowerCase())));
  if (owners.includes(key.address)) throw new StartupRefused("RUN_WALLET");
  // The companion records, each of exactly that object's run and copy.
  const { reg, tpl, presetOp, templateOp, taxOp, rtpl, rulesTemplateOp, rulesOp } = await stage("RECORDS", () => {
    const op = (name) => {
      const o = read(path.join("ops", `${name}.json`));
      if (!sameCopy(o.run, d.run) || o.status !== "verified" || !/^0x[0-9a-fA-F]{64}$/.test(o.hash)) throw new Error("not verified");
      return o;
    };
    const r = { reg: read("preset-registration.json"), tpl: read("tax-template.json") };
    if (!sameCopy(r.reg.run, d.run) || !sameCopy(r.tpl.run, d.run)) throw new Error("another copy");
    if (taxRules !== undefined && taxRules !== true && taxRules !== false) throw new Error("taxRules");
    if (taxRules === true) {
      // SH-287: the rules template's records, of exactly this run and copy. Missing records have their own text: the
      // option was set before the rules run finished.
      for (const f of ["tax-rules-template.json", path.join("ops", "tax-rules-template.json"), path.join("ops", "launch-tax-rules.create.json")]) {
        if (!fs.existsSync(path.join(outDir, f))) throw new StartupRefused("TAX_RULES_RECORDS");
      }
      r.rtpl = read("tax-rules-template.json");
      if (!sameCopy(r.rtpl.run, d.run)) throw new Error("another copy");
      r.rulesTemplateOp = op("tax-rules-template");
      r.rulesOp = op("launch-tax-rules.create");
    }
    return { ...r, presetOp: op("register.upsert-preset"), templateOp: op("tax-template"), taxOp: op("launch-tax.create") };
  });
  // The preset: the run's recorded upsertPreset transaction, decoded, its whole tuple equal to the Registry's.
  const presetId = await stage("PRESET", async () => {
    const id = BigInt(reg.presetId);
    if (String(presetOp.check && presetOp.check.presetId) !== String(id)) throw new Error("record disagrees");
    const tx = await provider.getTransaction(presetOp.hash);
    const rp = await provider.getTransactionReceipt(presetOp.hash);
    if (!tx || !rp || rp.status !== 1 || tx.from !== d.run.signer || tx.to !== d.addresses.registry) throw new Error("not on chain as recorded");
    const onChain = await new ethers.Contract(d.addresses.registry, REGISTRY_ABI, provider).getPreset(id);
    if (presetMismatch(tx.data, id, onChain)) throw new Error("differs");
    return id;
  });
  const template = await stage("TEMPLATE", async () => {
    const t = ethers.getAddress(tpl.template);
    const rt = await provider.getTransactionReceipt(templateOp.hash);
    if (!rt || rt.status !== 1 || rt.from !== d.run.signer || rt.contractAddress !== t) throw new Error("not this run's");
    return t;
  });
  // A scripted tax launch's receipt: TokenCreated of the tax preset by the run's wallet on the anchored Core, and the
  // token's ForwardVault clones `tpl`. Throws otherwise.
  const taxId = BigInt(d.presets.bondingTaxV1);
  async function launchedWith(hash, tpl) {
    const rc = await provider.getTransactionReceipt(hash);
    const coreIface = new ethers.Interface(["event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)"]);
    const created = rc && rc.status === 1 ? rc.logs.filter((l) => l.address === d.addresses.core).map((l) => { try { return coreIface.parseLog(l); } catch { return null; } }).find((e) => e) : null;
    if (!created || created.args.presetId !== taxId || created.args.creator !== d.run.signer) throw new Error("not the run's tax launch");
    const fv = await new ethers.Contract(created.args.token, ["function founder() view returns (address)"], provider).founder();
    if ((await new ethers.Contract(fv, ["function template() view returns (address)"], provider).template()) !== tpl) throw new Error("another template");
  }
  // The tax preset and the template: those of the scripted tax launch.
  const taxPresetId = await stage("TAX_LAUNCH", async () => {
    await launchedWith(taxOp.hash, template);
    return taxId;
  });
  // SH-287: the rules template, when offered: deployed by the run's wallet as recorded, and cloned by the run's
  // scripted rules launch.
  const rulesTemplate = await stage("TAX_RULES", async () => {
    if (taxRules !== true) return undefined;
    const t = ethers.getAddress(rtpl.template);
    const rt = await provider.getTransactionReceipt(rulesTemplateOp.hash);
    if (!rt || rt.status !== 1 || rt.from !== d.run.signer || rt.contractAddress !== t) throw new Error("not this run's");
    await launchedWith(rulesOp.hash, t);
    return t;
  });
  await stage("QUOTES", () => checkQuotes(provider, quotes));
  const config = await stage("CONFIG", () => loadConfig({ provider, addresses: d.addresses, presetId, taxPresetId, template, rulesTemplate, quotes, raiseMin, raiseMax }));
  await stage("CORE_SIGNER", async () => {
    if ((await new ethers.Contract(d.addresses.core, CORE_ABI, provider).signer()) !== key.address) throw new Error("another signer");
  });
  const clock = await stage("CONFIG", () => {
    if (testClock !== undefined && typeof testClock !== "function") throw new Error("testClock");
    return testClock || (() => Math.floor(Date.now() / 1000));
  });
  return Object.freeze({
    address: key.address,
    config,
    sign: (body) => signCreate(config, key, body, clock()),
  });
}

module.exports = { PRESET_FIELDS, STAGES, StartupRefused, checkQuotes, createSignService, loadConfig, loadKey, presetMismatch };
