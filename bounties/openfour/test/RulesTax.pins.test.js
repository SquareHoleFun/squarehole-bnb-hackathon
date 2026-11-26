// SH-287 fix round, pins of the rules template on a local fork of BSC Testnet:
//   - the valid rule sets are one answer: creator 10000, burn 10000, pile 10000 and a two-rule set, each signed by the
//     signing function (the service's), created by Core and made by createRules(): the splitter holds exactly the
//     non-zero rules, and a pile exists only with a pile part;
//   - the first tax without createRules(): with a wallet-like gas limit and a generous one, what the trader pays and
//     where the tax waits; nothing is lost once createRules() runs;
//   - the clone's other entry points: updateShares does nothing, receive() refuses native coin for a non-WBNB quote,
//     flush() moves only the quote coin to the splitter, onERC20TaxReceived accepts only the token or ForwardVault.
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, loadFork } = require("../lib/openfour");
const { at, deploy, registerPilePreset, sent } = require("../lib/pile-preset");
const { createTaxPileToken } = require("../lib/pile-tax");
const { loadConfig } = require("../sign/service");
const { signCreate } = require("../sign/sign-create");

const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // PancakeSwap V2 router, BSC Testnet
const G = { gasLimit: 12_000_000n };
const RULES = "tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)";
const TAX_ABI = [
  "function founder() view returns (address)", "function feeFounder() view returns (uint256)", "function feeToFounder() view returns (uint256)",
  "function feeAccumulated() view returns (uint256)", "function totalTaxCollected() view returns (uint256)",
  "event FeeDispatchDeferred(uint8 indexed kind, uint256 amount, bytes reason)",
];
const devWallet = (i, p) => ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(p);
const why = (p) => p.then(() => "(no revert)", (e) => String(e.reason || e.shortMessage || e.message));
const rulesData = (creator, c, p, b) => ethers.AbiCoder.defaultAbiCoder().encode([RULES], [[creator, c, p, b]]);

describe("Rules tax vault: rule sets, the first tax, the clone's entry points", function () {
  let provider, fork, owner, alice, bob, core, tools, wbnb, template;

  before(async function () {
    if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
    provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
    fork = loadFork(process.env.FORK_JSON);
    owner = devWallet(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider); // Core's signer on the test copy
    [alice, bob] = [4280, 4281].map((i) => devWallet(i, provider));
    for (const w of [owner, alice, bob]) await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
    core = new ethers.Contract(fork.addresses.core, ABI.core, provider);
    tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
    wbnb = new ethers.Contract(fork.addresses.wbnb, [...ABI.erc20, "function deposit() payable"], provider);
    for (const w of [alice, bob]) {
      await sent(wbnb.connect(w).deposit({ value: ethers.parseUnits("50", 18) }));
      await sent(wbnb.connect(w).approve(fork.addresses.core, ethers.MaxUint256));
    }
    template = await deploy("RulesTaxVault", owner, [ROUTER]);
  });

  const cloneOf = async (token) => {
    const t = new ethers.Contract(token, [...ABI.erc20, ...TAX_ABI], provider);
    const fv = new ethers.Contract(await t.founder(), ["function clonedVault() view returns (address)"], provider);
    return { t, forward: await fv.getAddress(), clone: at("RulesTaxVault", await fv.clonedVault(), provider) };
  };

  it("each valid rule set signed by the signing function is created by Core; the splitter holds exactly its non-zero rules", async function () {
    const reg = await registerPilePreset({ fork, owner, presetId: 1778027700003n }); // the configuration also needs our preset
    const config = await loadConfig({
      provider, addresses: fork.addresses, presetId: BigInt(reg.presetId), taxPresetId: BigInt(fork.presets.bondingTaxV1),
      template: await template.getAddress(), rulesTemplate: await template.getAddress(), quotes: [fork.addresses.wbnb],
    });
    const sets = [[10000, 0, 0], [0, 0, 10000], [0, 10000, 0], [4000, 0, 6000], [0, 7000, 3000], [5000, 5000, 0], [2000, 5000, 3000]];
    for (const [c, p, b] of sets) {
      const now = (await provider.getBlock("latest")).timestamp;
      const a = await signCreate(config, owner, {
        kind: "tax-rules", creator: alice.address, name: "Rule Set", symbol: "RSET", quote: fork.addresses.wbnb, raiseAmount: "0.3",
        taxBuyBps: 300, taxSellBps: 300, creatorBps: c, pileBps: p, burnBps: b,
      }, now);
      const rec = await sent(core.connect(alice).createToken(a.createArgs, a.signature, G));
      const ev = rec.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenCreated");
      const { clone } = await cloneOf(ev.args.token);
      await sent(clone.connect(bob).createRules());
      const split = at("RuleSplitter", await clone.splitter(), provider);
      const pile = await clone.pile();
      const got = [];
      for (let i = 0; i < Number(await split.ruleCount()); i++) got.push(Array.from(await split.rule(i)).map(String));
      const want = [[1, c, alice.address], [2, p, pile], [3, b, ROUTER]].filter((x) => x[1] !== 0).map((x) => x.map(String));
      console.log(`      ${c}/${p}/${b}: rules ${JSON.stringify(got.map((r) => r.slice(0, 2)))}, pile ${pile === ethers.ZeroAddress ? "none" : pile}`);
      expect(got).to.deep.equal(want);
      expect(pile === ethers.ZeroAddress).to.equal(p === 0);
      // The buy-and-burn rule, when there is one, is always the last (lane f's factory takes no other order).
      const burnAt = got.findIndex((r) => r[0] === "3");
      if (b !== 0) expect(burnAt, "buy and burn last").to.equal(got.length - 1);
    }
  });

  it("the first tax without createRules(): the trader's transaction succeeds, the tax waits in the token, nothing is lost", async function () {
    const l = await createTaxPileToken({
      fork, coreSigner: owner, creator: owner, quoteAsset: fork.addresses.wbnb, template: await template.getAddress(),
      form: { name: "First Tax", symbol: "FIRST", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: "5", buyFeeRate: "300", sellFeeRate: "300" },
      initData: rulesData(owner.address, 2000, 5000, 3000), overrides: G,
    });
    const { t, clone } = await cloneOf(l.token);
    const buy = async (trader, tokens, gasLimit) => {
      const amt = ethers.parseUnits(tokens, 18);
      const est = await tools.estimateBuy.staticCall(l.token, trader.address, amt, 0n, "0x");
      const args = [l.token, amt, (est.userPays * 10100n) / 10000n, 0n, "0x"];
      const limit = gasLimit === "wallet" ? ((await core.connect(trader).buy.estimateGas(...args)) * 12n) / 10n : gasLimit;
      const rec = await sent(core.connect(trader).buy(...args, { gasLimit: limit }));
      const deferred = rec.logs.filter((x) => x.address === l.token).map((x) => { try { return t.interface.parseLog(x); } catch { return null; } }).filter((e) => e && e.name === "FeeDispatchDeferred");
      return { limit, used: rec.gasUsed, deferred: deferred.length };
    };
    const r1 = await buy(alice, "20000000", "wallet"); // its tax is credited; the next transfer pays it out
    const r2 = await buy(bob, "20000000", "wallet"); // pays the first buy's tax to the founder: the clone's first tax
    console.log(`      wallet-like limits: buy 1 limit ${r1.limit} used ${r1.used}; buy 2 limit ${r2.limit} used ${r2.used}, deferred events ${r2.deferred}; splitter ${await clone.splitter()}; waiting for the founder ${await t.feeToFounder()}`);
    const r3 = await buy(alice, "20000000", 12_000_000n);
    console.log(`      generous limit: buy 3 used ${r3.used}, deferred events ${r3.deferred}; splitter ${await clone.splitter()}; waiting for the founder ${await t.feeToFounder()}`);
    const madeInTrade = (await clone.splitter()) !== ethers.ZeroAddress;
    if (!madeInTrade) await sent(clone.connect(bob).createRules());
    await sent(t.connect(bob).transfer(bob.address, 0n, G)); // the next transfer pays what waited
    const split = await clone.splitter();
    const inSplitter = await wbnb.balanceOf(split);
    console.log(`      ${madeInTrade ? "a trade created the rules" : "createRules() by anyone"}; then the splitter holds ${inSplitter} = founder tax ${await t.feeFounder()}; still waiting ${await t.feeToFounder()}; collected ${await t.totalTaxCollected()}, pending ${await t.feeAccumulated()}`);
    expect(await t.feeToFounder(), "no founder tax left waiting").to.equal(0n);
    expect(inSplitter, "every unit paid to the founder is in the splitter").to.equal(await t.feeFounder());
    expect((await t.feeFounder()) + (await t.feeAccumulated())).to.equal(await t.totalTaxCollected());
  });

  it("refuses the clone itself as the creator payee, and a quote coin whose deposit() mints nothing", async function () {
    const maker = await deploy("CloneMaker", owner);
    const cloneOfTemplate = async () => {
      const rec = await sent(maker.clone(await template.getAddress()));
      return at("RulesTaxVault", maker.interface.parseLog(rec.logs.find((x) => x.address === maker.target)).args.clone, owner);
    };
    const quote = await deploy("MockERC20", owner);
    const c1 = await cloneOfTemplate();
    expect(await why(c1.initialize.staticCall(alice.address, await quote.getAddress(), owner.address, [], rulesData(await c1.getAddress(), 2000, 5000, 3000))))
      .to.equal("RulesTaxVault: the clone cannot be the creator payee");
    await sent(c1.initialize(alice.address, await quote.getAddress(), owner.address, [], rulesData(await c1.getAddress(), 0, 7000, 3000))); // no creator part: no payee
    expect(await c1.creator()).to.equal(ethers.ZeroAddress);
    const fake = await deploy("MockFakeWrap", owner);
    const c2 = await cloneOfTemplate();
    await sent(c2.initialize(alice.address, await fake.getAddress(), owner.address, [], rulesData(owner.address, 2000, 5000, 3000)));
    const reason = await why(provider.call({ from: alice.address, to: await c2.getAddress(), value: 1000n }));
    console.log(`      the clone as payee: refused; native to a clone whose quote's deposit() mints nothing: ${reason}`);
    expect(reason).to.contain("the quote coin did not wrap the native coin");
  });

  it("the clone's other entry points: updateShares does nothing, onERC20TaxReceived only from the token or ForwardVault, flush only to the splitter, native refused for an ERC-20 quote", async function () {
    const quote = await deploy("MockERC20", owner);
    await sent(quote.connect(owner).transfer(alice.address, ethers.parseUnits("1000", 18)));
    const l = await createTaxPileToken({
      fork, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(), template: await template.getAddress(),
      form: { name: "Pins", symbol: "PINS", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: "100", buyFeeRate: "300", sellFeeRate: "300" },
      initData: rulesData(owner.address, 2000, 5000, 3000), overrides: G,
    });
    const { clone } = await cloneOf(l.token);
    await sent(clone.connect(bob).createRules());
    const split = await clone.splitter();
    const state = async () => [await clone.creator(), await clone.creatorBps(), await clone.pileBps(), await clone.burnBps(), await clone.splitter(), await clone.pile(), await clone.owner()].map(String);
    const before = await state();
    const u = await sent(clone.connect(owner).updateShares(owner.address, alice.address, 1n, 2n)); // as the creator
    expect(u.logs.length).to.equal(0);
    expect(await state()).to.deep.equal(before);
    expect(await why(clone.connect(alice).onERC20TaxReceived.staticCall(await quote.getAddress(), 1n))).to.equal("BaseTaxVault: unauthorized caller");
    const native = await why(provider.call({ from: alice.address, to: await clone.getAddress(), value: 1n }));
    expect(native).to.contain("native coin needs a wrapped-native quote");
    await sent(quote.connect(alice).transfer(await clone.getAddress(), 12345n));
    const s0 = await quote.balanceOf(split);
    await sent(clone.connect(bob).flush());
    expect((await quote.balanceOf(split)) - s0).to.equal(12345n);
    expect(await quote.balanceOf(await clone.getAddress())).to.equal(0n);
    console.log("      updateShares: no effect; onERC20TaxReceived by a stranger: refused; native to an ERC-20 clone: refused; flush: 12345 to the splitter");
  });
});
