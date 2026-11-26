// SH-287, their token with our rules: OpenFour's Bonding Tax V1 preset (TaxToken) with its founder tax routed through
// the Royalty ForwardVault into our RulesTaxVault template, which feeds one RuleSplitter with the creator's rules
// (creator 20%, pile 50%, buy and burn 30%). On a local fork of BSC Testnet: the rules fixed in the signed create
// arguments, a bad rule set refusing the creation, curve tax shared (the burn part owed while the token has no pool),
// graduation to PancakeSwap V2, DEX tax shared with the owed burn bought and sent to the dead address, the pile
// redeemable, and no call able to change the rules. Both quote paths. Run with scripts/test-local.sh.
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, DEAD, PHASE, loadFork } = require("../lib/openfour");
const { at, deploy, sent } = require("../lib/pile-preset");
const { createTaxPileToken } = require("../lib/pile-tax");

const FORK_JSON = process.env.FORK_JSON || "out/fork-deployment.local.json";
const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // PancakeSwap V2 router, BSC Testnet
const FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17"; // PancakeSwap V2 factory, BSC Testnet
const TAX_ABI = [
  "function founder() view returns (address)",
  "function feeFounder() view returns (uint256)",
  "function feeAccumulated() view returns (uint256)",
  "function tokenAccumulated() view returns (uint256)",
  "function totalTaxCollected() view returns (uint256)",
];
const FORWARD_ABI = ["function clonedVault() view returns (address)", "function template() view returns (address)"];
const G = { gasLimit: 12_000_000n }; // TaxToken runs swaps inside try/catch: explicit limits (only gas used is paid)
const ROUTER_ABI = ["function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)"];
const RULES = "tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)";
const PARTS = [2000n, 5000n, 3000n]; // creator, pile, buy and burn
const KIND = { CREATOR: 1n, PILE: 2n, BUY_BURN: 3n };

const devWallet = (i, p) => ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(p);
const rulesData = (creator, [c, p, b]) => ethers.AbiCoder.defaultAbiCoder().encode([RULES], [[creator, c, p, b]]);

for (const quoteKind of ["erc20", "wbnb"]) {
  describe(`Rules tax vault (creator 20%, pile 50%, buy and burn 30%), quote ${quoteKind === "erc20" ? "an ERC-20 of our own" : "WBNB (native tax)"}`, function () {
    let provider, fork, owner, alice, bob, payee, core, tools, quote, template, launch, token, vault, forward, clone, splitter, pile;

    before(async function () {
      if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
      provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
      fork = loadFork(FORK_JSON);
      owner = devWallet(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider);
      [alice, bob, payee] = (quoteKind === "erc20" ? [4260, 4261, 4262] : [4263, 4264, 4265]).map((i) => devWallet(i, provider));
      for (const w of [owner, alice, bob]) await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
      core = new ethers.Contract(fork.addresses.core, ABI.core, provider);
      tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
      if (quoteKind === "erc20") {
        quote = await deploy("MockERC20", owner);
        for (const w of [alice, bob]) await sent(quote.connect(owner).transfer(w.address, ethers.parseUnits("1000", 18)));
      } else {
        quote = new ethers.Contract(fork.addresses.wbnb, [...ABI.erc20, "function deposit() payable"], provider);
        for (const w of [alice, bob]) await sent(quote.connect(w).deposit({ value: ethers.parseUnits("50", 18) }));
      }
      template = await deploy("RulesTaxVault", owner, [ROUTER]);
    });

    const form = (symbol) => ({ name: "Rules Tax", symbol, maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: quoteKind === "erc20" ? "100" : "5", buyFeeRate: "300", sellFeeRate: "300" });
    const why = async (p) => {
      try {
        await p;
      } catch (e) {
        return String(e.reason || e.shortMessage || e.message);
      }
      return "(no revert)";
    };

    it("refuses the creation itself when the parts do not sum to 10,000 or the creator part has no payee", async function () {
      for (const [data, label] of [[rulesData(payee.address, [2000n, 5000n, 2999n]), "parts 9,999"], [rulesData(ethers.ZeroAddress, PARTS), "no payee"]]) {
        const reason = await why(createTaxPileToken({
          fork, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(), template: await template.getAddress(), form: form("BAD"), initData: data, overrides: G,
        }));
        console.log(`      ${label}: refused (${reason.slice(0, 100)})`);
        expect(reason).to.not.equal("(no revert)");
      }
    });

    it("creates the token with the rules in its signed create arguments; createRules() makes the pile and the splitter", async function () {
      launch = await createTaxPileToken({
        fork, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(), template: await template.getAddress(),
        form: form("RTAX"), initData: rulesData(payee.address, PARTS), overrides: G,
      });
      token = new ethers.Contract(launch.token, [...ABI.erc20, ...TAX_ABI], provider);
      vault = new ethers.Contract(launch.vault, ABI.vault, provider);
      forward = new ethers.Contract(await token.founder(), FORWARD_ABI, provider);
      clone = at("RulesTaxVault", await forward.clonedVault(), provider);
      expect(await forward.template()).to.equal(await template.getAddress());
      expect([await clone.creator(), await clone.creatorBps(), await clone.pileBps(), await clone.burnBps()]).to.deep.equal([payee.address, ...PARTS]);
      expect(await clone.splitter()).to.equal(ethers.ZeroAddress);
      const rec = await sent(clone.connect(bob).createRules()); // anyone, once the token exists
      const ev = rec.logs.map((l) => { try { return clone.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "RulesCreated");
      splitter = at("RuleSplitter", ev.args.splitter, provider);
      pile = at("FeeRules", ev.args.pile, provider);
      console.log(`      token ${launch.token}; clone ${await clone.getAddress()}; splitter ${ev.args.splitter}; pile ${ev.args.pile}`);
      expect((await sent(clone.connect(alice).createRules())).logs.length).to.equal(0); // once
      expect(await splitter.ruleCount()).to.equal(3n);
      const rules = [];
      for (let i = 0; i < 3; i++) rules.push(Array.from(await splitter.rule(i)));
      expect(rules).to.deep.equal([[KIND.CREATOR, 2000n, payee.address], [KIND.PILE, 5000n, ev.args.pile], [KIND.BUY_BURN, 3000n, ROUTER]]);
      expect(await splitter.token()).to.equal(launch.token);
      expect(await splitter.asset()).to.equal(await quote.getAddress());
      expect(await pile.token()).to.equal(launch.token);
      expect(await pile.asset()).to.equal(await quote.getAddress());
      expect(await pile.excludedHolders()).to.deep.equal([launch.vault]);
      expect(await clone.owner()).to.equal(ethers.ZeroAddress);
    });

    async function settle() {
      // TaxToken pays pending tax inside ordinary transfers; a zero transfer to oneself makes it pay what is due now.
      await sent(token.connect(bob).transfer(bob.address, 0n, G));
      expect(await quote.balanceOf(await clone.getAddress())).to.equal(0n);
      expect(await provider.getBalance(await clone.getAddress())).to.equal(0n);
      expect(await quote.balanceOf(await forward.getAddress())).to.equal(0n);
    }

    // Reads every effect of one distribute(): what each rule received, from the chain.
    async function distribute() {
      const pending = await splitter.pending();
      const owedBefore = [await splitter.owed(0), await splitter.owed(1), await splitter.owed(2)];
      const p0 = await quote.balanceOf(payee.address);
      const r0 = await pile.totalReceived();
      const d0 = await token.balanceOf(DEAD);
      const rec = await sent(splitter.connect(alice).distribute(G)); // anyone
      const got = { creator: (await quote.balanceOf(payee.address)) - p0, pile: (await pile.totalReceived()) - r0, dead: (await token.balanceOf(DEAD)) - d0 };
      const owed = [await splitter.owed(0), await splitter.owed(1), await splitter.owed(2)];
      return { pending, owedBefore, got, owed, rec };
    }

    it("curve tax reaches the splitter in full; distribute pays the creator and the pile, the burn part stays owed (no pool yet)", async function () {
      await sent(quote.connect(alice).approve(fork.addresses.core, ethers.MaxUint256));
      await sent(quote.connect(bob).approve(fork.addresses.core, ethers.MaxUint256));
      for (const [trader, amount] of [[alice, "60000000"], [bob, "40000000"]]) {
        const amt = ethers.parseUnits(amount, 18);
        const est = await tools.estimateBuy.staticCall(launch.token, trader.address, amt, 0n, "0x");
        await sent(core.connect(trader).buy(launch.token, amt, (est.userPays * 10100n) / 10000n, 0n, "0x", G));
      }
      await settle();
      const income = await quote.balanceOf(await splitter.getAddress());
      expect(income, "every unit paid to the founder is in the splitter").to.equal(await token.feeFounder());
      const d = await distribute();
      const c = (income * PARTS[0]) / 10_000n;
      const p = (income * PARTS[1]) / 10_000n;
      console.log(`      income ${income}: creator +${d.got.creator}, pile +${d.got.pile}, burn owed ${d.owed[2]}, dead +${d.got.dead}`);
      expect(d.pending).to.equal(income);
      expect(d.got.creator).to.equal(c);
      expect(d.got.pile).to.equal(p);
      expect(d.owed).to.deep.equal([0n, 0n, income - c - p]); // the last rule takes the rounding units
      expect(d.got.dead).to.equal(0n);
      expect(await splitter.totalOwed()).to.equal(income - c - p);
      expect(await quote.balanceOf(await splitter.getAddress())).to.equal(income - c - p);
    });

    it("graduates; DEX tax is shared and the owed burn part buys the token on PancakeSwap and sends it to the dead address", async function () {
      for (let round = 0; round < 8 && !(await vault.isSoldOut()); round++) {
        await sent(core.connect(bob).buyByBudget(launch.token, ethers.parseUnits(quoteKind === "erc20" ? "60" : "4", 18), 0n, 0n, "0x", G));
      }
      expect(PHASE[Number(await vault.phase())]).to.equal("Migrated");
      const pair = await new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider).getPair(launch.token, await quote.getAddress());
      expect(pair).to.not.equal(ethers.ZeroAddress);
      const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
      const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 600n;
      const sellAmount = (await token.balanceOf(bob.address)) / 4n;
      await sent(token.connect(bob).approve(ROUTER, ethers.MaxUint256));
      await sent(router.connect(bob).swapExactTokensForTokensSupportingFeeOnTransferTokens(sellAmount, 1n, [launch.token, await quote.getAddress()], bob.address, deadline, G));
      await settle();
      const owedBurn = await splitter.owed(2);
      const d = await distribute();
      console.log(`      after graduation: new income ${d.pending}; creator +${d.got.creator}, pile +${d.got.pile}; burn spent ${owedBurn + d.pending - (d.pending * 7000n) / 10_000n - d.owed[2]} and ${d.got.dead} tokens reached the dead address`);
      expect(d.pending).to.be.greaterThan(0n);
      expect(d.got.creator).to.equal((d.pending * PARTS[0]) / 10_000n);
      expect(d.got.pile).to.equal((d.pending * PARTS[1]) / 10_000n);
      expect(d.owed[2], "the burn part, old and new, was spent").to.equal(0n);
      const inBuy = (await clone.queryFilter(clone.filters.TaxToSplitter(), d.rec.blockNumber, d.rec.blockNumber)).length;
      expect(inBuy, "no income reached the splitter during its pool buy (a pool buy does no tax work in the token)").to.equal(0);
      expect(d.got.dead).to.be.greaterThan(0n);
      expect(await splitter.burned(2)).to.equal(d.got.dead);
      expect(await splitter.totalOwed()).to.equal(0n);
    });

    it("the pile is redeemable: a holder hands tokens in and is paid to the last unit", async function () {
      const amount = (await token.balanceOf(alice.address)) / 3n;
      await settle();
      await sent(token.connect(alice).approve(await pile.getAddress(), amount));
      const expected = await pile.quoteRedeem(amount);
      expect(expected).to.be.greaterThan(0n);
      const q0 = await quote.balanceOf(alice.address);
      await sent(pile.connect(alice).redeem(amount, expected, G));
      const paid = (await quote.balanceOf(alice.address)) - q0;
      console.log(`      alice hands in ${amount}, paid ${paid}`);
      expect(paid).to.equal(expected);
    });

    it("the rules cannot change: the clone runs initialize once, has no owner, and its only writes move tax along the fixed rules", async function () {
      const writes = at("RulesTaxVault", ethers.ZeroAddress, null).interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f) => f.name).sort();
      expect(writes).to.deep.equal(["createRules", "flush", "initialize", "onERC20TaxReceived", "renounceOwnership", "transferOwnership", "updateShares"]);
      expect(await why(clone.connect(owner).initialize.staticCall(launch.token, await quote.getAddress(), owner.address, [], rulesData(owner.address, [10000n, 0n, 0n]))))
        .to.equal("Initializable: contract is already initialized");
      expect(await why(clone.connect(owner).transferOwnership.staticCall(owner.address))).to.equal("Ownable: caller is not the owner");
      const splitterWrites = at("RuleSplitter", ethers.ZeroAddress, null).interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name);
      expect(splitterWrites).to.deep.equal(["distribute"]);
    });
  });
}
