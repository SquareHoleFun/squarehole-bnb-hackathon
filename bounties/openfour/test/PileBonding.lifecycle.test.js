// The complete life of a Pile Bonding token on a developer-owned OpenFour copy, on a local fork of BSC Testnet:
// preset registered, token created with a quote coin of our own, buys and sells on the curve with the fee arriving in
// the pile to the last unit, redemptions paid to the last unit, graduation to PancakeSwap V2, the pile still
// redeemable afterwards, and no call of ours able to change the rules.
//
// Run with scripts/test-local.sh: it starts anvil on a fork, brings the copy up with the kit's own fork-deploy tool
// (out/fork-deployment.local.json), then runs `hardhat test --network localfork`.
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, DEAD, PHASE, TRADE_MODULE_KEY_SOURCE, loadFork } = require("../lib/openfour");
const { at, createPileToken, deploy, registerPilePreset, sent } = require("../lib/pile-preset");

const FORK_JSON = process.env.FORK_JSON || "out/fork-deployment.local.json";
const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const BPS = 10_000n;
const BUY_FEE_BPS = 100n; // 1%
const SELL_FEE_BPS = 200n; // 2%

function devWallet(index, provider) {
  return ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(provider);
}

describe("Pile Bonding on a developer-owned OpenFour copy (local fork of BSC Testnet)", function () {
  let provider, fork, owner, alice, bob, carol;
  let core, tools, quote, reg, launch, token, vault, pile, trade;
  const ledger = { feesIn: 0n, paidOut: 0n };

  before(async function () {
    if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
    provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
    fork = loadFork(FORK_JSON);
    owner = devWallet(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider); // the copy's deployer
    [alice, bob, carol] = [4243, 4244, 4245].map((i) => devWallet(i, provider));
    for (const w of [owner, alice, bob, carol]) {
      await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
    }
    core = new ethers.Contract(fork.addresses.core, ABI.core, provider);
    tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
  });

  it("is our copy: the deployer owns the Registry and is Core's signer", async function () {
    const registry = new ethers.Contract(fork.addresses.registry, ABI.registry, provider);
    expect(await registry.owner()).to.equal(owner.address);
    expect(await core.signer()).to.equal(owner.address);
  });

  it("registers module.trade.pile and the Pile Bonding preset", async function () {
    reg = await registerPilePreset({ fork, owner, presetId: 1778027700001n });
    const registry = new ethers.Contract(fork.addresses.registry, ABI.registry, provider);
    const p = await registry.getPreset(reg.presetId);
    const bonding = await registry.getPreset(fork.presets.bondingV1);
    expect(p.active && p.createEnabled).to.equal(true);
    expect(p.tradeModuleId).to.equal(ethers.keccak256(ethers.toUtf8Bytes(TRADE_MODULE_KEY_SOURCE)));
    for (const slot of ["tokenModuleId", "vaultModuleId", "curveModuleId", "migrateModuleId", "tokenImplId", "customDataId"]) {
      expect(p[slot]).to.equal(bonding[slot]);
    }
    expect(await registry.getModuleImplementation(reg.tradeModuleKey)).to.equal(reg.tradeModuleImplementation);
  });

  it("refuses a creation whose fee is out of bounds (the validator)", async function () {
    quote = await deploy("MockERC20", owner); // a quote coin of our own: 1,000,000 QUOTE to the owner
    const cases = [
      [{ buyFeeBps: "1001", sellFeeBps: "0" }, "PileValidator: fee too high"],
      [{ buyFeeBps: "0", sellFeeBps: "1001" }, "PileValidator: fee too high"],
      [{ buyFeeBps: "0", sellFeeBps: "0" }, "PileValidator: no fee"],
    ];
    for (const [form, want] of cases) {
      let reason = "";
      try {
        await createPileToken({
          fork, presetId: reg.presetId, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(),
          form: { name: "Bad", symbol: "BAD", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: "100", ...form },
        });
      } catch (e) {
        reason = String(e.reason || e.shortMessage || e.message);
      }
      console.log(`      ${JSON.stringify(form)} refused: ${reason}`);
      expect(reason, `creation with ${JSON.stringify(form)}`).to.equal(want);
    }
  });

  it("creates a token whose raise is in our own coin, with its pile bound to it", async function () {
    launch = await createPileToken({
      fork, presetId: reg.presetId, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(),
      form: {
        name: "Pile Demo", symbol: "PILE", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: "100",
        buyFeeBps: BUY_FEE_BPS.toString(), sellFeeBps: SELL_FEE_BPS.toString(),
      },
    });
    console.log(`      created ${launch.token} (gas ${launch.createGas}), pile ${launch.pile}`);
    token = new ethers.Contract(launch.token, ABI.erc20, provider);
    vault = new ethers.Contract(launch.vault, ABI.vault, provider);
    pile = at("FeeRules", launch.pile, provider);
    trade = at("PileTradeModule", launch.tradeModule, provider);
    expect(await pile.token()).to.equal(launch.token);
    expect(await pile.asset()).to.equal(await quote.getAddress());
    expect(await pile.pile()).to.equal(0n);
    expect(await trade.boundToken()).to.equal(launch.token);
    expect(await trade.buyFeeBps()).to.equal(BUY_FEE_BPS);
    expect(await trade.sellFeeBps()).to.equal(SELL_FEE_BPS);
    const [, tag] = await trade.descriptor();
    expect(tag).to.equal(TRADE_MODULE_KEY_SOURCE);
    expect(PHASE[Number(await vault.phase())]).to.equal("Trading");
    // Traders get some of our coin.
    for (const w of [alice, bob, carol]) await sent(quote.connect(owner).transfer(w.address, ethers.parseUnits("1000", 18)));
  });

  async function buy(trader, amount) {
    const est = await tools.estimateBuy.staticCall(launch.token, trader.address, amount, 0n, "0x");
    await sent(quote.connect(trader).approve(fork.addresses.core, ethers.MaxUint256));
    const before = await pile.pile();
    const raised = await vault.totalRaised();
    await sent(core.connect(trader).buy(launch.token, amount, (est.userPays * 10100n) / 10000n, 0n, "0x"));
    const delta = (await pile.pile()) - before;
    const realised = (await vault.totalRaised()) - raised; // the curve quote the vault booked for this trade
    return { est, delta, realised };
  }

  it("pays the buy fee into the pile, to the last unit", async function () {
    for (const [trader, amount] of [[alice, "40000000"], [bob, "25000000"], [carol, "10000000"]]) {
      const { est, delta, realised } = await buy(trader, ethers.parseUnits(amount, 18));
      const expected = (realised * BUY_FEE_BPS) / BPS;
      console.log(`      buy ${amount}: realised curve quote ${realised} (estimated ${est.curveQuote}), pile +${delta} (expected ${expected})`);
      expect(delta).to.equal(expected);
      ledger.feesIn += delta;
    }
    expect(await pile.pile()).to.equal(ledger.feesIn);
  });

  it("pays the sell fee into the pile, to the last unit", async function () {
    const amount = ethers.parseUnits("5000000", 18);
    await sent(token.connect(bob).approve(fork.addresses.core, ethers.MaxUint256));
    const est = await tools.estimateSell.staticCall(launch.token, bob.address, amount, 0n, "0x");
    const before = await pile.pile();
    const raised = await vault.totalRaised();
    await sent(core.connect(bob).sell(launch.token, amount, (est.userReceives * 9900n) / 10000n, 0n, "0x"));
    const delta = (await pile.pile()) - before;
    const realised = raised - (await vault.totalRaised());
    const expected = (realised * SELL_FEE_BPS) / BPS;
    console.log(`      sell 5000000: realised curve quote ${realised} (estimated ${est.curveQuote}), pile +${delta} (expected ${expected})`);
    expect(delta).to.equal(expected);
    ledger.feesIn += delta;
    expect(await pile.totalReceived()).to.equal(ledger.feesIn);
  });

  async function redeem(holder, amount) {
    const pileBefore = await pile.pile();
    const circ = await pile.circulatingSupply();
    const expected = amount === circ ? pileBefore : (pileBefore * amount) / circ;
    expect(await pile.quoteRedeem(amount)).to.equal(expected);
    await sent(token.connect(holder).approve(launch.pile, amount));
    const qBefore = await quote.balanceOf(holder.address);
    const deadBefore = await token.balanceOf(DEAD);
    await sent(pile.connect(holder).redeem(amount, expected));
    expect((await quote.balanceOf(holder.address)) - qBefore).to.equal(expected);
    expect((await token.balanceOf(DEAD)) - deadBefore).to.equal(amount);
    expect(await pile.pile()).to.equal(pileBefore - expected);
    ledger.paidOut += expected;
    return { expected, circ };
  }

  async function inHands() {
    let sum = 0n;
    for (const w of [owner, alice, bob, carol]) sum += await token.balanceOf(w.address);
    return sum;
  }

  it("counts as circulating only the tokens SOLD during the curve (the vault is excluded)", async function () {
    expect(await pile.excludedHolders()).to.deep.equal([launch.vault]);
    const circ = await pile.circulatingSupply();
    const unsold = await token.balanceOf(launch.vault);
    console.log(`      circulating ${circ} = tokens in traders' hands; the vault holds ${unsold} unsold and reserved`);
    expect(circ).to.equal(await inHands());
  });

  it("redeems during the curve: pile x tokens / circulating, to the last unit, tokens burned", async function () {
    const amount = (await token.balanceOf(alice.address)) / 4n;
    const { expected, circ } = await redeem(alice, amount);
    console.log(`      alice hands in ${amount} of ${circ} circulating, receives ${expected}`);
    expect(expected).to.be.greaterThan(0n);
    expect(await pile.totalPaidOut()).to.equal(ledger.paidOut);
  });

  it("graduates: buys to the end of the sale migrate the token to PancakeSwap V2", async function () {
    let rounds = 0;
    while (!(await vault.isSoldOut()) && rounds < 6) {
      rounds += 1;
      const budget = ethers.parseUnits("60", 18);
      const est = await tools.estimateBuyByBudget.staticCall(launch.token, carol.address, budget, 0n, "0x");
      if (est.tokenAmount === 0n) break;
      const before = await pile.pile();
      const raised = await vault.totalRaised();
      await sent(core.connect(carol).buyByBudget(launch.token, budget, (est.tokenAmount * 99n) / 100n, 0n, "0x"));
      const delta = (await pile.pile()) - before;
      const realised = (await vault.totalRaised()) - raised;
      console.log(`      buyByBudget round ${rounds}: realised curve quote ${realised}, pile +${delta}`);
      expect(delta).to.equal((realised * BUY_FEE_BPS) / BPS);
      ledger.feesIn += delta;
    }
    const phase = PHASE[Number(await vault.phase())];
    console.log(`      phase ${phase} after ${rounds} rounds; vault holds ${await token.balanceOf(launch.vault)} tokens`);
    expect(phase).to.equal("Migrated");
    expect(await pile.totalReceived()).to.equal(ledger.feesIn);
  });

  it("after graduation the curve is closed, and the pile stays redeemable to the last unit", async function () {
    let closed = "(no revert)";
    try {
      await core.connect(alice).buy.staticCall(launch.token, ethers.parseUnits("1", 18), ethers.parseUnits("1", 18), 0n, "0x");
    } catch (e) {
      closed = String(e.reason || e.data || e.shortMessage);
    }
    console.log(`      a curve buy after migration is refused: ${closed}`);
    // CoreErrBadPhase(): OpenFour's Core error for a trade outside the Trading phase (kit scripts/abi/IOpenFourErrors.json).
    expect(closed).to.equal(ethers.id("CoreErrBadPhase()").slice(0, 10));
    // After migration the vault is (near) empty and the PancakeSwap V2 pair holds the liquidity tokens: those count
    // as circulating, since anyone can buy them.
    const factory = new ethers.Contract("0x6725F303b657a9451d8BA641348b6761A6CC7a17", ["function getPair(address,address) view returns (address)"], provider);
    const pair = await factory.getPair(launch.token, await quote.getAddress());
    const inPair = pair === ethers.ZeroAddress ? 0n : await token.balanceOf(pair);
    const circ = await pile.circulatingSupply();
    console.log(`      after migration: circulating ${circ} = hands ${await inHands()} + pair ${pair} ${inPair}; vault ${await token.balanceOf(launch.vault)}`);
    expect(pair).to.not.equal(ethers.ZeroAddress);
    expect(circ).to.equal((await inHands()) + inPair);
    for (const holder of [bob, carol, alice]) {
      const bal = await token.balanceOf(holder.address);
      const { expected } = await redeem(holder, bal);
      console.log(`      ${holder.address.slice(0, 8)} hands in all ${bal}, receives ${expected}`);
    }
    expect(await pile.totalReceived()).to.equal(ledger.feesIn);
    expect(await pile.totalPaidOut()).to.equal(ledger.paidOut);
    expect(await pile.pile()).to.equal(ledger.feesIn - ledger.paidOut);
  });

  it("no call of ours can change the rules afterwards", async function () {
    // The module, the validator and the pile expose no state-changing function but these.
    const writes = (name) => at(name, ethers.ZeroAddress, null).interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name).sort();
    expect(writes("PileTradeModule")).to.deep.equal(["init"]);
    expect(writes("PilePresetValidator")).to.deep.equal([]);
    expect(writes("FeeRules")).to.deep.equal(["redeem", "redeemTo", "sync"]);
    // init cannot run twice, not even by the copy's owner.
    let again = "(no revert)";
    try {
      await trade.connect(owner).init.staticCall(launch.token, owner.address, ethers.AbiCoder.defaultAbiCoder().encode(["uint16", "uint16"], [1000, 1000]), "9");
    } catch (e) {
      again = String(e.reason || e.shortMessage);
    }
    expect(again).to.equal("Initializable: contract is already initialized");
    expect(await trade.buyFeeBps()).to.equal(BUY_FEE_BPS);
    expect(await trade.sellFeeBps()).to.equal(SELL_FEE_BPS);
    expect(await trade.pile()).to.equal(launch.pile);
  });

  it("Core's signer: only the owner can change it; then only the new signer's creation signatures are accepted", async function () {
    const service = devWallet(4280, provider); // a signing key of its own: it holds no coins
    const coreRW = new ethers.Contract(fork.addresses.core, ["function setSigner(address)", "function signer() view returns (address)"], provider);
    const why = async (p) => {
      try {
        await p;
      } catch (e) {
        return String(e.reason || e.data || e.shortMessage);
      }
      return "(no revert)";
    };
    const notOwner = await why(coreRW.connect(alice).setSigner.staticCall(service.address));
    console.log(`      setSigner by a non-owner is refused: ${notOwner}`);
    // BasicAccessControlDenied(bytes32 role, address account) from the kit's Core ABI, naming the caller.
    expect(notOwner.slice(0, 10)).to.equal(ethers.id("BasicAccessControlDenied(bytes32,address)").slice(0, 10));
    expect(notOwner.toLowerCase()).to.contain(alice.address.slice(2).toLowerCase());
    await sent(coreRW.connect(owner).setSigner(service.address));
    expect(await coreRW.signer()).to.equal(service.address);
    const form = { name: "Signed", symbol: "SGN", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: "100", buyFeeBps: "100", sellFeeBps: "100" };
    const old = await why(createPileToken({ fork, presetId: reg.presetId, coreSigner: owner, creator: bob, quoteAsset: await quote.getAddress(), form }));
    console.log(`      a creation signed by the old signer is refused: ${old}`);
    expect(old).to.equal("SignatureVerifier: invalid signature");
    const made = await createPileToken({ fork, presetId: reg.presetId, coreSigner: service, creator: bob, quoteAsset: await quote.getAddress(), form });
    console.log(`      a creation signed by the new signer for bob, sent by bob: token ${made.token}`);
    expect(made.token).to.match(/^0x[0-9a-fA-F]{40}$/);
    await sent(coreRW.connect(owner).setSigner(owner.address)); // back, for the runs that follow
    expect(await coreRW.signer()).to.equal(owner.address);
  });
});
