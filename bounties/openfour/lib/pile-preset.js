// The Pile Bonding preset's steps, shared by the tests and the scripts: register the preset on a developer-owned
// OpenFour copy, create a token with it, trade, redeem. Plain ethers v6 with Hardhat's compiled artifacts, so the
// same code runs inside `hardhat test` and from `node -r ./scripts/signer-preload.js scripts/<step>.js`.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ABI, TRADE_MODULE_KEY_SOURCE, encodeCreateArgs, presetSchemas, signCreate } = require("./openfour");

const ROOT = path.resolve(__dirname, "..");

function artifact(name) {
  const candidates = [
    path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`),
    path.join(ROOT, "artifacts", "fee-rules-core", "src", `${name}.sol`, `${name}.json`),
    path.join(ROOT, "artifacts", "openfour-kit", "developer", "startup", "contracts", "helpers", `${name}.sol`, `${name}.json`),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  const stack = [path.join(ROOT, "artifacts", "contracts")];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === `${name}.json`) return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error(`artifact ${name} not found: run npx hardhat compile`);
}

async function deploy(name, signer, args = [], overrides = {}) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, overrides);
  await c.waitForDeployment();
  return c;
}

function at(name, address, runner) {
  return new ethers.Contract(address, artifact(name).abi, runner);
}

async function sent(txPromise) {
  const rec = await (await txPromise).wait();
  if (!rec || rec.status !== 1) throw new Error("transaction failed");
  return rec;
}

/// Registers `module.trade.pile` and the Pile Bonding preset on the copy in `fork` (its Registry owner signs).
/// Every slot but Trade is the copy's standard bonding preset (bondingV1): token, vault, curve, migrate, token impl.
async function registerPilePreset({ fork, owner, presetId, maxFeeBps = 1000, overrides = {} }) {
  const registry = new ethers.Contract(fork.addresses.registry, ABI.registry, owner);
  const feeRouter = new ethers.Contract(fork.addresses.feeRouter, ABI.feeRouter, owner);
  const bondingId = BigInt(fork.presets.bondingV1);
  const bonding = await registry.getPreset(bondingId);
  const author = await owner.getAddress();

  const impl = await deploy("PileTradeModule", owner, [], overrides);
  const moduleKey = ethers.keccak256(ethers.toUtf8Bytes(TRADE_MODULE_KEY_SOURCE));
  const moduleTx = await sent(registry.upsertModule(
    moduleKey, await impl.getAddress(), 3,
    { moduleId: moduleKey, version: "1.0.0", name: "PileTradeModule", description: "Trade fee paid into a pile every holder can redeem", author, feeShareBps: 0 },
    true, overrides,
  ));

  const validator = await deploy("PilePresetValidator", owner, [bonding.validator, maxFeeBps], overrides);
  const preset = {
    id: presetId,
    name: "Pile Bonding",
    description: "Bonding launch whose trading fee fills a pile every holder can redeem; rules fixed at creation",
    version: "1.0.0",
    active: true,
    createEnabled: true,
    validator: await validator.getAddress(),
    tokenModuleId: bonding.tokenModuleId,
    vaultModuleId: bonding.vaultModuleId,
    curveModuleId: bonding.curveModuleId,
    tradeModuleId: moduleKey,
    migrateModuleId: bonding.migrateModuleId,
    tokenImplId: bonding.tokenImplId,
    customDataId: bonding.customDataId,
    author,
  };
  const presetTx = await sent(registry.upsertPreset(preset, overrides));

  // The same protocol fee settings as the standard bonding preset, as the kit's register.js does.
  let feeTx = null;
  const cfg = await feeRouter.presetFeeConfig(bondingId);
  if (cfg.active) {
    feeTx = await sent(feeRouter.setPresetFeeConfig(presetId, {
      protocolFeeBps: cfg.protocolFeeBps, developerFeePoolBps: cfg.developerFeePoolBps,
      maxProtocolDevFeeBps: cfg.maxProtocolDevFeeBps, maxTaxBps: cfg.maxTaxBps, maxTaxTiers: cfg.maxTaxTiers,
      active: true, partnerProtocolShareBps: cfg.partnerProtocolShareBps,
    }, overrides));
  }
  return {
    presetId: presetId.toString(),
    tradeModuleKey: moduleKey,
    tradeModuleImplementation: await impl.getAddress(),
    tradeModuleBeacon: await registry.getModuleBeacon(moduleKey),
    validator: await validator.getAddress(),
    innerValidator: bonding.validator,
    txs: { module: moduleTx.hash, preset: presetTx.hash, presetFee: feeTx ? feeTx.hash : null },
  };
}

/// Creates a Pile Bonding token. `coreSigner` holds Core.signer (on a developer-owned copy: the deployer) and signs
/// the creation for `creator`, who sends it. Returns the addresses OpenFour reported plus the token's pile.
async function createPileToken({ fork, presetId, coreSigner, creator, quoteAsset, form, overrides = {} }) {
  const provider = creator.provider;
  const chainId = (await provider.getNetwork()).chainId;
  const core = new ethers.Contract(fork.addresses.core, ABI.core, creator);
  const tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
  const schemas = await presetSchemas(tools, presetId);
  const latest = await provider.getBlock("latest");
  const createArgs = encodeCreateArgs({
    requestId: BigInt(latest.timestamp) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    presetId: BigInt(presetId),
    validTimestamp: BigInt(latest.timestamp) + 3600n,
    quoteAsset,
    form,
    schemas,
  });
  const signature = await signCreate(coreSigner, chainId, await creator.getAddress(), createArgs);
  await core.createToken.staticCall(createArgs, signature, overrides);
  const rec = await sent(core.createToken(createArgs, signature, overrides));
  let created;
  for (const log of rec.logs) {
    try {
      const parsed = core.interface.parseLog(log);
      if (parsed && parsed.name === "TokenCreated") created = parsed.args;
    } catch {
      /* another contract's log */
    }
  }
  if (!created) throw new Error("TokenCreated missing");
  const trade = at("PileTradeModule", created.tradeModule, provider);
  return {
    token: created.token,
    vault: created.vault,
    tradeModule: created.tradeModule,
    curveModule: created.curveModule,
    migrateModule: created.migrateModule,
    pile: await trade.pile(),
    quoteAsset: created.quoteAsset,
    createTx: rec.hash,
    createGas: rec.gasUsed,
    schemas,
  };
}

module.exports = { artifact, at, createPileToken, deploy, registerPilePreset, sent };
