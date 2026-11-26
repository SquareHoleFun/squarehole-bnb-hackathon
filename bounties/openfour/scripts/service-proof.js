// Rehearsal only (local fork): the signing service started through its production factory from the rehearsal's own
// records, after `pile.js set-signer`. A visitor creates a launch with its signature; the clock is the one given at
// construction (a second argument to sign() changes nothing). Then each startup refusal with its exact fixed text,
// written out here: no password file, a wrong password, reversed raise bounds, the run wallet's own keystore, a preset record of another Registry, a template this run did not
// deploy, a registration record pointing at another Registry transaction, a registration record naming another
// preset, and a deployment file with Core and Tools swapped.
// usage: node scripts/service-proof.js <records folder> <service keystore> <service password file> <quote>
//          <expected service address> <run wallet keystore> <run wallet password file>
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { createSignService } = require("../sign/service");

// The startup texts, written out here (not read from the module), so a changed text fails the proof.
const TEXT = {
  KEY_FILES: "the signer needs a keystore and a password file",
  KEYSTORE: "keystore: decryption failed",
  RUN_WALLET: "this keystore holds the run wallet's key: the service needs a key of its own",
  RECORDS: "the run's records are missing, unreadable or not all of one run and copy",
  ANCHOR: "the deployment is not confirmed on chain as this run's copy",
  PRESET: "the Registry's preset is not the one this run's recorded upsertPreset transaction wrote",
  TEMPLATE: "the template is not the one this run deployed",
  CONFIG: "the presets are not open, or their schemas lack a field the signer sets, or the settings are invalid",
  TAX_RULES: "the rules template is not the one this run deployed and launched with",
};
const RULES_TUPLE = "tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)";

// SH-287 (SERVICE_PROOF_RULES=1, after the rules steps): the service with `taxRules: true` signs a tax-rules request; a
// visitor creates with it; the clone holds exactly the requested rules with the visitor as the creator payee. Without
// the option the kind is refused; a rules template record this run did not deploy stops the start.
async function rulesProof([outDir, keystore, passwordFile, quote, expected]) {
  const rpc = process.env.RPC_URL;
  const base = { rpc, keystore, passwordFile, quotes: [quote] };
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const plain = await createSignService({ ...base, outDir });
  const visitor = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'/0/4296").connect(provider);
  await provider.send("anvil_setBalance", [visitor.address, "0x56bc75e2d63100000"]);
  const body = { kind: "tax-rules", creator: visitor.address, name: "Visitor Rules", symbol: "VRULE", quote, raiseAmount: "0.3", taxBuyBps: 300, taxSellBps: 300, creatorBps: 1000, pileBps: 6000, burnBps: 3000 };
  let code = null;
  try {
    await plain.sign(body);
  } catch (e) {
    code = e.code;
  }
  if (code !== "BAD_KIND") throw new Error(`without taxRules the kind was not refused (${code})`);
  console.log("== without taxRules: the tax-rules kind is refused (BAD_KIND)");
  const s = await createSignService({ ...base, outDir, taxRules: true });
  if (s.address !== ethers.getAddress(expected)) throw new Error("the service key is not the expected one");
  const a = await s.sign(body);
  const fork = JSON.parse(fs.readFileSync(path.join(outDir, "fork-deployment.json"), "utf8"));
  const rules = JSON.parse(fs.readFileSync(path.join(outDir, "tax-rules-template.json"), "utf8"));
  const core = new ethers.Contract(fork.addresses.core, ["function createToken(bytes,bytes) payable returns (address)", "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)"], visitor);
  const rec = await (await core.createToken(a.createArgs, a.signature, { gasLimit: 12_000_000n })).wait();
  const ev = rec.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenCreated");
  const fv = await new ethers.Contract(ev.args.token, ["function founder() view returns (address)"], provider).founder();
  const forward = new ethers.Contract(fv, ["function template() view returns (address)", "function clonedVault() view returns (address)"], provider);
  const clone = new ethers.Contract(await forward.clonedVault(), ["function creator() view returns (address)", "function creatorBps() view returns (uint16)", "function pileBps() view returns (uint16)", "function burnBps() view returns (uint16)"], provider);
  const got = [await forward.template(), await clone.creator(), await clone.creatorBps(), await clone.pileBps(), await clone.burnBps()].map(String);
  const want = [ethers.getAddress(rules.template), visitor.address, "1000", "6000", "3000"];
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`the visitor's launch holds ${got}, not ${want}`);
  console.log(`== a visitor created a tax-rules launch with the service's signature (token ${ev.args.token}): template ${got[0]}, creator ${got[1]}, parts ${got.slice(2).join("/")}`);
  const dir = path.join(path.dirname(outDir), `${path.basename(outDir)}-other-rules-template`);
  fs.cpSync(outDir, dir, { recursive: true });
  const f = path.join(dir, "tax-rules-template.json");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.template = fork.addresses.tools; // has code; same run; not this run's deployment
  fs.writeFileSync(f, JSON.stringify(j));
  await refused("a rules template this run did not deploy", { ...base, outDir: dir, taxRules: true }, "TAX_RULES");
  console.log("OK service-proof rules");
}

const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat

async function refused(what, opts, code) {
  try {
    await createSignService(opts);
  } catch (e) {
    if (e.code !== code || e.message !== TEXT[code]) throw new Error(`${what}: refused with another code or text: ${e.code} ${e.message}`);
    console.log(`== ${what}: refused ("${e.message}")`);
    return;
  }
  throw new Error(`${what}: the service started`);
}

async function main() {
  if (process.env.OPENFOUR_LOCAL_FORK !== "1") throw new Error("local fork only");
  if (process.env.SERVICE_PROOF_RULES === "1") return rulesProof(process.argv.slice(2));
  const [outDir, keystore, passwordFile, quote, expected, runKeystore, runPasswordFile] = process.argv.slice(2);
  if (!runPasswordFile) throw new Error("usage: see the head of this file");
  const rpc = process.env.RPC_URL;
  const base = { rpc, keystore, passwordFile, quotes: [quote] };
  await refused("no password file", { ...base, outDir, passwordFile: undefined }, "KEY_FILES");
  await refused("a wrong password", { ...base, outDir, passwordFile: keystore }, "KEYSTORE");
  await refused("raise bounds the wrong way round", { ...base, outDir, raiseMin: "2", raiseMax: "0.1" }, "CONFIG");
  await refused("the run wallet's own keystore", { ...base, outDir, keystore: runKeystore, passwordFile: runPasswordFile }, "RUN_WALLET");

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const now = (await provider.getBlock("latest")).timestamp;
  const s = await createSignService({ ...base, outDir, testClock: () => now });
  if (s.address !== ethers.getAddress(expected)) throw new Error("the service key is not the expected one");
  if (s.sign.length !== 1) throw new Error("sign takes more than the body");
  const visitor = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'/0/4295").connect(provider);
  await provider.send("anvil_setBalance", [visitor.address, "0x56bc75e2d63100000"]);
  const body = { kind: "preset", creator: visitor.address, name: "Visitor Pile", symbol: "VPILE", quote, raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 100 };
  const a = await s.sign(body, 1); // the second argument is ignored: the clock is the one given at construction
  if (a.validUntil !== now + 600) throw new Error(`validUntil ${a.validUntil}, not the construction clock's ${now + 600}`);
  console.log(`== sign(body, 1) signed with the construction clock: valid until ${a.validUntil}`);
  const fork = JSON.parse(fs.readFileSync(path.join(outDir, "fork-deployment.json"), "utf8"));
  const core = new ethers.Contract(fork.addresses.core, ["function createToken(bytes,bytes) payable returns (address)"], visitor);
  const rec = await (await core.createToken(a.createArgs, a.signature)).wait();
  if (rec.status !== 1) throw new Error("the visitor's creation failed");
  console.log(`== a visitor created a launch with the service's signature (tx ${rec.hash})`);

  // Foreign record sets, in copies of the records folder.
  const copy = (name) => {
    const dir = path.join(path.dirname(outDir), `${path.basename(outDir)}-${name}`);
    fs.cpSync(outDir, dir, { recursive: true });
    return dir;
  };
  const edit = (dir, file, fn) => {
    const f = path.join(dir, file);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    fn(j);
    fs.writeFileSync(f, JSON.stringify(j));
  };
  const other = copy("other-registry");
  edit(other, "preset-registration.json", (r) => { r.run.registry = fork.addresses.tools; }); // has code; not this copy's Registry
  await refused("a preset record of another Registry", { ...base, outDir: other }, "RECORDS");

  const tdir = copy("other-template");
  edit(tdir, "tax-template.json", (t) => { t.template = fork.addresses.tools; }); // has code; same run; not this run's deployment
  await refused("a template this run did not deploy", { ...base, outDir: tdir }, "TEMPLATE");

  // Another of the run's own transactions to the Registry (upsertModule): from the wallet, to the Registry, mined,
  // but not the upsertPreset of this preset.
  const upsertModule = JSON.parse(fs.readFileSync(path.join(outDir, "ops", "register.upsert-module.json"), "utf8"));
  const odir = copy("other-registry-call");
  edit(odir, path.join("ops", "register.upsert-preset.json"), (o) => { o.hash = upsertModule.hash; });
  await refused("a registration record pointing at the run's upsertModule transaction", { ...base, outDir: odir }, "PRESET");

  // The kit's own open preset named as ours: the recorded upsertPreset wrote another id.
  const pdir = copy("other-preset");
  edit(pdir, "preset-registration.json", (r) => { r.presetId = String(fork.presets.bondingV1); });
  edit(pdir, path.join("ops", "register.upsert-preset.json"), (o) => { o.check.presetId = String(fork.presets.bondingV1); });
  await refused("a registration record naming the kit's own preset", { ...base, outDir: pdir }, "PRESET");

  const sdir = copy("swapped");
  edit(sdir, "fork-deployment.json", (f) => { [f.addresses.core, f.addresses.tools] = [f.addresses.tools, f.addresses.core]; });
  await refused("a deployment file with Core and Tools swapped", { ...base, outDir: sdir }, "ANCHOR");
  console.log("OK service-proof");
}

main().catch((e) => {
  console.error(`stopped: ${e.message || e}`);
  process.exit(1);
});
