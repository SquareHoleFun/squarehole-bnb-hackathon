// The add-on path: a token of OpenFour's own Bonding Tax V1 preset whose founder tax (100%) goes through the Royalty
// ForwardVault into a PileTaxVault clone and on into the token's pile.
"use strict";

const { ethers } = require("ethers");
const { ABI, encodeCreateArgs, presetSchemas, signCreate } = require("./openfour");
const { sent } = require("./pile-preset");

const FORWARD_VAULT_TYPE_ID = ethers.keccak256(ethers.toUtf8Bytes("SafuSkill.ForwardVault.v1"));

/// `form`: name, symbol, maxSupply, saleAmount, raiseAmount (whole tokens), buyFeeRate, sellFeeRate (bps, the
/// TaxToken's own limits apply). Founder share is fixed at 100 and every other share at 0, so all tax reaches the pile.
/// `initData`: the template clone's own parameters ("0x" for PileTaxVault; abi.encode(Rules) for RulesTaxVault).
async function createTaxPileToken({ fork, coreSigner, creator, quoteAsset, template, form, initData = "0x", overrides = {} }) {
  const provider = creator.provider;
  const chainId = (await provider.getNetwork()).chainId;
  const presetId = BigInt(fork.presets.bondingTaxV1);
  const core = new ethers.Contract(fork.addresses.core, ABI.core, creator);
  const tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
  const schemas = await presetSchemas(tools, presetId);
  const latest = await provider.getBlock("latest");
  const createArgs = encodeCreateArgs({
    requestId: BigInt(latest.timestamp) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    presetId,
    validTimestamp: BigInt(latest.timestamp) + 3600n,
    quoteAsset,
    schemas,
    form: {
      ...form,
      founder: await creator.getAddress(),
      rateFounder: "100",
      rateHolder: "0",
      rateBurn: "0",
      rateLiquidity: "0",
      minShare: form.minShare || "10000",
      taxVaultTypeId: FORWARD_VAULT_TYPE_ID,
      taxVaultInitParams: ethers.AbiCoder.defaultAbiCoder().encode(["(address,bytes)"], [[template, initData]]),
    },
  });
  const signature = await signCreate(coreSigner, chainId, await creator.getAddress(), createArgs);
  await core.createToken.staticCall(createArgs, signature, overrides);
  const rec = await sent(core.createToken(createArgs, signature, overrides));
  for (const log of rec.logs) {
    try {
      const parsed = core.interface.parseLog(log);
      if (parsed && parsed.name === "TokenCreated") {
        return { token: parsed.args.token, vault: parsed.args.vault, quoteAsset: parsed.args.quoteAsset, createTx: rec.hash, createGas: rec.gasUsed };
      }
    } catch {
      /* another contract's log */
    }
  }
  throw new Error("TokenCreated missing");
}

module.exports = { FORWARD_VAULT_TYPE_ID, createTaxPileToken };
