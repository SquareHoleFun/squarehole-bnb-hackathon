// The creation signer against the real Core of a developer-owned copy on a local fork: the owner hands Core's signer
// to a key of its own (no coins); a browser-like wallet asks for a signature and creates both launch kinds itself; a
// replay, an expired request and someone else using the visitor's signature are refused by Core.
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, loadFork } = require("../lib/openfour");
const { deploy, registerPilePreset, sent } = require("../lib/pile-preset");
const { loadConfig } = require("../sign/service");
const { signCreate } = require("../sign/sign-create");

const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const dev = (i, provider) => ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(provider);
const selector = (sig) => ethers.id(sig).slice(0, 10);

describe("the creation signer on a developer-owned copy (local fork)", function () {
  let provider, fork, owner, visitor, other, service, core, config, quote, template, presetId;

  before(async function () {
    if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
    provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
    fork = loadFork(process.env.FORK_JSON);
    owner = dev(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider);
    [visitor, other] = [4291, 4292].map((i) => dev(i, provider));
    for (const w of [owner, visitor, other]) await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
    service = ethers.Wallet.createRandom(); // the signing key: never funded, never sends
    core = new ethers.Contract(fork.addresses.core, [...ABI.core, "function setSigner(address)", "function signer() view returns (address)"], provider);
    const reg = await registerPilePreset({ fork, owner, presetId: 1778027700002n });
    template = await deploy("PileTaxVault", owner);
    quote = await deploy("MockERC20", owner);
    presetId = BigInt(reg.presetId);
    config = await loadConfig({
      provider, addresses: fork.addresses, presetId, taxPresetId: BigInt(fork.presets.bondingTaxV1),
      template: await template.getAddress(), quotes: [await quote.getAddress(), fork.addresses.wbnb],
    });
    await sent(core.connect(owner).setSigner(service.address));
    expect(await core.signer()).to.equal(service.address);
    expect(await provider.getBalance(service.address)).to.equal(0n);
  });

  after(async function () {
    if (core && owner) await sent(core.connect(owner).setSigner(owner.address)); // back, for the runs that follow
  });

  const now = async () => (await provider.getBlock("latest")).timestamp;
  const reason = async (p) => {
    try {
      await p;
    } catch (e) {
      return String(e.reason || e.data || e.shortMessage);
    }
    return "(no revert)";
  };
  const created = (rec) => rec.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenCreated");

  it("a visitor creates a Pile Bonding launch with the returned signature, from their own wallet", async function () {
    const a = await signCreate(config, service, {
      kind: "preset", creator: visitor.address, name: "Visitor Pile", symbol: "VPILE", quote: await quote.getAddress(), raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 100,
    }, await now());
    const rec = await sent(core.connect(visitor).createToken(a.createArgs, a.signature));
    const ev = created(rec);
    console.log(`      created ${ev.args.token} by ${ev.args.creator}, preset ${ev.args.presetId}`);
    expect(ev.args.creator).to.equal(visitor.address);
    expect(ev.args.presetId).to.equal(BigInt(config.kinds.preset.presetId));
    // The same signature again: Core refuses the used request id.
    expect(await reason(core.connect(visitor).createToken.staticCall(a.createArgs, a.signature))).to.equal(selector("CoreErrRequestAlreadyUsed()"));
  });

  it("a visitor creates a tax launch whose founder tax goes into our template", async function () {
    const a = await signCreate(config, service, {
      kind: "tax", creator: visitor.address, name: "Visitor Tax", symbol: "VTAX", quote: fork.addresses.wbnb, raiseAmount: "0.3", taxBuyBps: 300, taxSellBps: 300,
    }, await now());
    const rec = await sent(core.connect(visitor).createToken(a.createArgs, a.signature, { gasLimit: 12_000_000n }));
    const ev = created(rec);
    const forward = new ethers.Contract(await new ethers.Contract(ev.args.token, ["function founder() view returns (address)"], provider).founder(),
      ["function template() view returns (address)"], provider);
    console.log(`      created ${ev.args.token}; its ForwardVault clones ${await forward.template()}`);
    expect(ev.args.creator).to.equal(visitor.address);
    expect(await forward.template()).to.equal(await template.getAddress());
  });

  it("someone else cannot use the visitor's signature", async function () {
    const a = await signCreate(config, service, {
      kind: "preset", creator: visitor.address, name: "Not Yours", symbol: "NY", quote: await quote.getAddress(), raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 100,
    }, await now());
    expect(await reason(core.connect(other).createToken.staticCall(a.createArgs, a.signature))).to.equal("SignatureVerifier: invalid signature");
  });

  it("an expired request is refused", async function () {
    const a = await signCreate(config, service, {
      kind: "preset", creator: visitor.address, name: "Too Late", symbol: "LATE", quote: await quote.getAddress(), raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 100,
    }, (await now()) - 601);
    expect(await reason(core.connect(visitor).createToken.staticCall(a.createArgs, a.signature))).to.equal(selector("CoreErrRequestExpired()"));
  });

  it("a quote coin without 18 decimals is refused when the configuration loads", async function () {
    const six = await deploy("MockQuote6", owner);
    let err = null;
    try {
      await loadConfig({
        provider, addresses: fork.addresses, presetId, taxPresetId: BigInt(fork.presets.bondingTaxV1),
        template: await template.getAddress(), quotes: [fork.addresses.wbnb, await six.getAddress()],
      });
    } catch (e) {
      err = e;
    }
    expect(String(err && err.message)).to.equal(`the quote coin ${await six.getAddress()} has 6 decimals: only 18-decimal quote coins are signed`);
  });

  it("a signature of the copy's previous signer is refused", async function () {
    const a = await signCreate(config, owner, {
      kind: "preset", creator: visitor.address, name: "Old Key", symbol: "OLD", quote: await quote.getAddress(), raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 100,
    }, await now());
    expect(await reason(core.connect(visitor).createToken.staticCall(a.createArgs, a.signature))).to.equal("SignatureVerifier: invalid signature");
  });
});
