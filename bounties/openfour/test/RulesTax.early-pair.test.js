// SH-287, a stranger's PancakeSwap pair before the migration, on a local fork of BSC Testnet, both quote coins. The
// buy-and-burn rule buys through the token's one V2 pair with its quote coin. Can a holder create and fund that pair
// during the curve at a price of their choosing, so the splitter's buy pays them? No: OpenFour registers the pair's
// address for the token at creation (`migratedPools`, set before the pair even exists), and OpenFourToken
// `_blocksBeforeMigration` refuses every transfer to or from a registered pool until the migration. So the pair can be
// created but not funded with the token, and with the quote coin alone it mints no liquidity. The splitter's buy
// fails, the burn part stays owed, and the stranger gains nothing.
// And can that stranger block the migration, by leaving quote coin in the pair and calling sync() (reserves: 0 token,
// some quote)? The last case runs exactly that and then graduates; after the migration the splitter buys through the
// very pool the migration seeded.
// Run with TEST_FILES=test/RulesTax.early-pair.test.js scripts/test-local.sh.
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, DEAD, PHASE, loadFork } = require("../lib/openfour");
const { at, deploy, sent } = require("../lib/pile-preset");
const { createTaxPileToken } = require("../lib/pile-tax");

const MNEMONIC = "test test test test test test test test test test test junk"; // public: anvil and hardhat
const ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // PancakeSwap V2 router, BSC Testnet
const FACTORY = "0x6725F303b657a9451d8BA641348b6761A6CC7a17"; // PancakeSwap V2 factory, BSC Testnet
const G = { gasLimit: 12_000_000n };
const RULES = "tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)";
const TAX_ABI = ["function founder() view returns (address)", "function migratedPools(address) view returns (bool)"];
const PAIR_ABI = ["function mint(address) returns (uint256)", "function sync()", "function getReserves() view returns (uint112, uint112, uint32)", "function token0() view returns (address)"];
const devWallet = (i, p) => ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${i}`).connect(p);
const why = (p) => p.then(() => "(no revert)", (e) => String(e.reason || e.shortMessage || e.message));

for (const quoteKind of ["wbnb", "erc20"]) {
  describe(`Rules tax vault: a stranger's PancakeSwap pair before the migration (${quoteKind === "wbnb" ? "WBNB" : "an ERC-20 of our own"})`, function () {
    let provider, fork, owner, alice, bob, payee, core, tools, quote, q, factory, l, pairAddr, pair;

    before(async function () {
      if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
      provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
      fork = loadFork(process.env.FORK_JSON);
      owner = devWallet(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider);
      [alice, bob, payee] = (quoteKind === "wbnb" ? [4270, 4271, 4272] : [4273, 4274, 4275]).map((i) => devWallet(i, provider));
      for (const w of [owner, alice, bob]) await provider.send("anvil_setBalance", [w.address, "0x56bc75e2d63100000"]);
      core = new ethers.Contract(fork.addresses.core, ABI.core, provider);
      tools = new ethers.Contract(fork.addresses.tools, ABI.tools, provider);
      if (quoteKind === "wbnb") {
        quote = new ethers.Contract(fork.addresses.wbnb, [...ABI.erc20, "function deposit() payable"], provider);
        for (const w of [alice, bob]) await sent(quote.connect(w).deposit({ value: ethers.parseUnits("50", 18) }));
      } else {
        quote = await deploy("MockERC20", owner);
        for (const w of [alice, bob]) await sent(quote.connect(owner).transfer(w.address, ethers.parseUnits("1000", 18)));
      }
      q = await quote.getAddress();
      for (const w of [alice, bob]) await sent(quote.connect(w).approve(fork.addresses.core, ethers.MaxUint256));
      factory = new ethers.Contract(FACTORY, ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"], provider);
      const template = await deploy("RulesTaxVault", owner, [ROUTER]);
      l = await createTaxPileToken({
        fork, coreSigner: owner, creator: owner, quoteAsset: q, template: await template.getAddress(),
        form: { name: "Early Pair", symbol: "EARLY", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: quoteKind === "wbnb" ? "5" : "100", buyFeeRate: "300", sellFeeRate: "300" },
        initData: ethers.AbiCoder.defaultAbiCoder().encode([RULES], [[payee.address, 2000n, 5000n, 3000n]]), overrides: G,
      });
      l.tokenC = new ethers.Contract(l.token, [...ABI.erc20, ...TAX_ABI], provider);
      const forward = new ethers.Contract(await l.tokenC.founder(), ["function clonedVault() view returns (address)"], provider);
      l.clone = at("RulesTaxVault", await forward.clonedVault(), provider);
      await sent(l.clone.connect(bob).createRules());
      l.splitter = at("RuleSplitter", await l.clone.splitter(), provider);
      l.pile = at("FeeRules", await l.clone.pile(), provider);
    });

    async function curveBuy(trader, tokens) {
      const amt = ethers.parseUnits(tokens, 18);
      const est = await tools.estimateBuy.staticCall(l.token, trader.address, amt, 0n, "0x");
      await sent(core.connect(trader).buy(l.token, amt, (est.userPays * 10100n) / 10000n, 0n, "0x", G));
    }
    const reserves = async () => {
      const [r0, r1] = await pair.getReserves();
      return (await pair.token0()) === q ? { quote: r0, token: r1 } : { quote: r1, token: r0 };
    };

    it("the pair's address is registered for the token at creation, before the pair exists", async function () {
      expect(await factory.getPair(l.token, q)).to.equal(ethers.ZeroAddress);
      await curveBuy(alice, "20000000");
      await sent(factory.connect(alice).createPair(l.token, q)); // anyone can create it
      pairAddr = await factory.getPair(l.token, q);
      pair = new ethers.Contract(pairAddr, PAIR_ABI, alice);
      console.log(`      pair ${pairAddr} created by a stranger during the curve; registered for the token: ${await l.tokenC.migratedPools(pairAddr)}`);
      expect(await l.tokenC.migratedPools(pairAddr)).to.equal(true);
      expect(PHASE[Number(await new ethers.Contract(l.vault, ABI.vault, provider).phase())]).to.equal("Trading");
    });

    it("the stranger cannot fund it: the token refuses the transfer, and the quote coin alone mints no liquidity", async function () {
      expect(await why(l.tokenC.connect(alice).transfer.staticCall(pairAddr, ethers.parseUnits("1", 18), G))).to.equal("Token: pool transfer blocked before migration");
      await sent(quote.connect(alice).transfer(pairAddr, 1n)); // 1 wei of the quote coin
      const reason = await why(pair.mint.staticCall(alice.address, G));
      console.log(`      mint with the quote coin only: ${reason}`);
      expect(reason).to.not.equal("(no revert)");
    });

    it("distribute pays the creator and the pile exactly; the burn part stays owed and the pair gains nothing", async function () {
      await curveBuy(bob, "40000000");
      await sent(l.tokenC.connect(bob).transfer(bob.address, 0n, G)); // the token pays its pending tax
      const income = await l.splitter.pending();
      const pairQuote = await quote.balanceOf(pairAddr);
      const d0 = await l.tokenC.balanceOf(DEAD);
      const c0 = await quote.balanceOf(payee.address);
      await sent(l.splitter.connect(alice).distribute(G)); // the stranger calls it
      const c = (income * 2000n) / 10000n;
      const p = (income * 5000n) / 10000n;
      console.log(`      income ${income}: creator +${(await quote.balanceOf(payee.address)) - c0}, pile +${await l.pile.totalReceived()}, burn owed ${await l.splitter.owed(2)}; pair quote ${pairQuote} -> ${await quote.balanceOf(pairAddr)}`);
      expect(await quote.balanceOf(pairAddr), "the stranger's pair received nothing").to.equal(pairQuote);
      expect(await l.tokenC.balanceOf(DEAD)).to.equal(d0);
      expect((await quote.balanceOf(payee.address)) - c0).to.equal(c);
      expect(await l.pile.totalReceived()).to.equal(p);
      expect(await l.splitter.owed(2)).to.equal(income - c - p);
    });

    it("a stranger's sync() (reserves 0 token, 1 wei quote) and the migration; afterwards the splitter buys through the pool the migration seeded", async function () {
      await sent(pair.sync(G));
      const r0 = await reserves();
      console.log(`      after the stranger's sync: reserves token ${r0.token}, quote ${r0.quote}`);
      expect(r0.token).to.equal(0n);
      expect(r0.quote).to.equal(1n);
      const vault = new ethers.Contract(l.vault, ABI.vault, provider);
      let stop = "(no revert)";
      for (let round = 0; round < 8 && !(await vault.isSoldOut()); round++) {
        stop = await why(core.connect(bob).buyByBudget(l.token, ethers.parseUnits(quoteKind === "wbnb" ? "4" : "60", 18), 0n, 0n, "0x", G).then((tx) => tx.wait()));
        if (stop !== "(no revert)") break;
      }
      const phase = PHASE[Number(await vault.phase())];
      console.log(`      graduation: phase ${phase}${stop !== "(no revert)" ? `, stopped: ${stop}` : ""}`);
      expect(phase, "the stranger's sync does not block the migration").to.equal("Migrated");
      const r1 = await reserves();
      console.log(`      the pool after the migration: token ${r1.token}, quote ${r1.quote}; the factory's pair is the registered pool: ${(await factory.getPair(l.token, q)) === pairAddr && (await l.tokenC.migratedPools(pairAddr))}`);
      expect(await factory.getPair(l.token, q)).to.equal(pairAddr);
      expect(r1.token).to.be.greaterThan(0n);
      expect(r1.quote).to.be.greaterThan(1n);
      // A DEX sell for tax, then distribute: the owed burn buys on that pool.
      const router = new ethers.Contract(ROUTER, ["function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"], bob);
      await sent(l.tokenC.connect(bob).approve(ROUTER, ethers.MaxUint256));
      await sent(router.swapExactTokensForTokensSupportingFeeOnTransferTokens((await l.tokenC.balanceOf(bob.address)) / 4n, 1n, [l.token, q], bob.address, BigInt((await provider.getBlock("latest")).timestamp) + 600n, G));
      await sent(l.tokenC.connect(bob).transfer(bob.address, 0n, G));
      const d0 = await l.tokenC.balanceOf(DEAD);
      const before = await reserves();
      const rec = await sent(l.splitter.connect(alice).distribute(G));
      const after = await reserves();
      const pairLogs = rec.logs.filter((x) => x.address === pairAddr).length;
      console.log(`      burn: ${(await l.tokenC.balanceOf(DEAD)) - d0} tokens to the dead address; the pool's quote ${before.quote} -> ${after.quote}; ${pairLogs} logs of that pool in the transaction`);
      expect(await l.splitter.owed(2)).to.equal(0n);
      expect((await l.tokenC.balanceOf(DEAD)) - d0).to.be.greaterThan(0n);
      expect(after.quote).to.be.greaterThan(before.quote);
      expect(pairLogs).to.be.greaterThan(0);
    });
  });
}
