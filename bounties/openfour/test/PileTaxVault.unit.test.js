// PileTaxVault on its own (clones made here, initialised by a test account in ForwardVault's place): exact
// reporting of what the pile receives, the whole native balance wrapped, native refused for a plain quote, createPile
// once and only after the token exists, the initialiser and ownership locked. On the local fork (WBNB is real there).
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { at, deploy, sent } = require("../lib/pile-preset");

const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";

async function reason(promise) {
  try {
    await promise;
  } catch (e) {
    return String(e.reason || e.shortMessage || e.message);
  }
  return "(no revert)";
}

describe("PileTaxVault on its own", function () {
  let provider, admin, holder, vaultAddr, template, maker, token;

  before(async function () {
    if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
    provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
    [admin, holder] = [4260, 4261].map((i) => ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(provider));
    for (const w of [admin, holder]) await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
    vaultAddr = ethers.Wallet.createRandom().address;
    template = await deploy("PileTaxVault", admin);
    maker = await deploy("CloneMaker", admin);
    token = await deploy("MockVaultToken", admin, [vaultAddr, ethers.parseUnits("1000", 18)]);
  });

  async function newClone(quote, tokenAddress = null) {
    const rec = await sent(maker.clone(await template.getAddress()));
    const c = at("PileTaxVault", maker.interface.parseLog(rec.logs[0]).args.clone, admin);
    await sent(c.initialize(tokenAddress || (await token.getAddress()), quote, admin.address, [], "0x"));
    return c;
  }

  it("initialises once, renounces ownership, and refuses a second initialise and any owner call by name", async function () {
    const c = await newClone(WBNB);
    expect(await c.owner()).to.equal(ethers.ZeroAddress);
    expect(await reason(c.initialize.staticCall(await token.getAddress(), WBNB, admin.address, [], "0x"))).to.equal("Initializable: contract is already initialized");
    expect(await reason(c.transferOwnership.staticCall(admin.address))).to.equal("Ownable: caller is not the owner");
    expect(await reason(template.initialize.staticCall(await token.getAddress(), WBNB, admin.address, [], "0x"))).to.equal("Initializable: contract is already initialized");
  });

  it("createPile: refused before the token has a vault; then once, and a second call returns the same pile without a new one", async function () {
    const early = await deploy("MockVaultToken", admin, [ethers.ZeroAddress, 1n]);
    const c0 = await newClone(WBNB, await early.getAddress());
    expect(await reason(c0.createPile.staticCall())).to.equal("PileTaxVault: token not created yet");
    const c = await newClone(WBNB);
    const r1 = await sent(c.connect(holder).createPile());
    const pile = await c.pile();
    expect(r1.logs.some((l) => l.address === (c.target) && c.interface.parseLog(l)?.name === "PileCreated")).to.equal(true);
    const r2 = await sent(c.connect(holder).createPile());
    expect(await c.pile()).to.equal(pile);
    expect(r2.logs.length, "no second PileCreated, no new contract").to.equal(0);
    const f = at("FeeRules", pile, provider);
    expect(await f.excludedHolders()).to.deep.equal([vaultAddr]);
    expect(await f.token()).to.equal(await token.getAddress());
    expect(await f.asset()).to.equal(WBNB);
  });

  it("reports exactly what the pile receives, also for a quote coin that charges a fee on transfers", async function () {
    const feeQuote = await deploy("MockFeeQuote", admin);
    const c = await newClone(await feeQuote.getAddress());
    await sent(c.createPile());
    const pile = await c.pile();
    await sent(feeQuote.transfer(await c.getAddress(), 10_000n)); // the clone gets 9,900 (1% burned on the way)
    expect(await feeQuote.balanceOf(await c.getAddress())).to.equal(9_900n);
    const rec = await sent(c.onERC20TaxReceived(await feeQuote.getAddress(), 9_900n)); // as ForwardVault would
    const ev = rec.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TaxToPile");
    expect(ev.args.sent).to.equal(9_900n);
    expect(ev.args.credited).to.equal(9_801n); // 1% of 9,900 burned again on the way to the pile
    expect(ev.args.pileAfter).to.equal(9_801n);
    expect(await feeQuote.balanceOf(pile)).to.equal(9_801n);
    expect(await feeQuote.balanceOf(await c.getAddress())).to.equal(0n);
    expect(await reason(c.connect(holder).onERC20TaxReceived.staticCall(await feeQuote.getAddress(), 1n))).to.equal("BaseTaxVault: unauthorized caller");
  });

  it("wraps its whole native balance on flush, including native that arrived without a call", async function () {
    const c = await newClone(WBNB);
    await sent(c.createPile());
    const pile = await c.pile();
    const wbnb = new ethers.Contract(WBNB, ["function balanceOf(address) view returns (uint256)"], provider);
    await provider.send("anvil_setBalance", [await c.getAddress(), "0x3e8"]); // 1,000 wei, no receive() call
    const before = await wbnb.balanceOf(pile);
    await sent(c.connect(holder).flush());
    expect((await wbnb.balanceOf(pile)) - before).to.equal(1_000n);
    expect(await provider.getBalance(await c.getAddress())).to.equal(0n);
    // Native that arrived without a call, then native tax by receive(): receive() must wrap both, not only msg.value.
    await provider.send("anvil_setBalance", [await c.getAddress(), "0x2bc"]); // 700 wei
    await sent(holder.sendTransaction({ to: await c.getAddress(), value: 500n }));
    expect((await wbnb.balanceOf(pile)) - before).to.equal(2_200n);
    expect(await provider.getBalance(await c.getAddress())).to.equal(0n);
  });

  it("refuses native coin when the quote coin is not the wrapped native coin", async function () {
    const plain = await deploy("MockERC20", admin);
    const c = await newClone(await plain.getAddress());
    await sent(c.createPile());
    expect(await reason(holder.call({ to: await c.getAddress(), value: 1n }))).to.equal("PileTaxVault: native coin needs a wrapped-native quote");
  });
});
