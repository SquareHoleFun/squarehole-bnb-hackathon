// The add-on: OpenFour's own Bonding Tax V1 preset (TaxToken) with its founder tax routed through the Royalty
// ForwardVault into our PileTaxVault template, which feeds a FeeRules pile. Unlike the Pile Bonding preset, the pile
// keeps growing after graduation, from the DEX transfer tax. Both quote paths: an ERC-20 of our own and WBNB
// (native tax). Run with scripts/test-local.sh (same fork and copy as the other test file).
"use strict";

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("ethers");
const { ABI, DEAD, PHASE, loadFork, coder } = require("../lib/openfour");
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
  "function feeToFounder() view returns (uint256)",
  "function dispatchTax()",
  "function canDispatchTax() view returns (bool)",
  "function minDispatch() view returns (uint256)",
  "function minDispatchQuote() view returns (uint256)",
  "function tokenHelper() view returns (address)",
  "event FeeDispatched(uint256 amountFounder, uint256 amountHolder, uint256 amountBurn, uint256 amountLiquidity)",
  "event FeeDispatchDeferred(uint8 indexed kind, uint256 amount, bytes reason)",
];
const FORWARD_ABI = ["function clonedVault() view returns (address)", "function template() view returns (address)"];
// TaxToken runs swaps inside try/catch during transfers; a gas estimate can settle on the cheaper catch branch and the
// mined transaction then runs short. Transactions that move the tax token carry an explicit limit (only gas used is paid).
const G = { gasLimit: 8_000_000n };
const ROUTER_ABI = [
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
];

function devWallet(index, provider) {
  return ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(provider);
}

for (const quoteKind of ["erc20", "wbnb"]) {
  describe(`Pile tax vault on OpenFour's Bonding Tax V1, quote ${quoteKind === "erc20" ? "an ERC-20 of our own" : "WBNB (native tax)"}`, function () {
    let provider, fork, owner, alice, bob, core, tools, quote, template, launch, token, tax, pile, vault, clone, forward;

    before(async function () {
      if (hre.network.name !== "localfork") throw new Error("run with scripts/test-local.sh: these tests need the local fork");
      provider = new ethers.JsonRpcProvider(hre.network.config.url, 97, { cacheTimeout: -1 });
      fork = loadFork(FORK_JSON);
      owner = devWallet(Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || 4242), provider);
      [alice, bob] = (quoteKind === "erc20" ? [4246, 4247] : [4248, 4249]).map((i) => devWallet(i, provider));
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
    });

    it("creates a TaxToken whose founder is ForwardVault, cloning our template into a pile", async function () {
      template = await deploy("PileTaxVault", owner);
      launch = await createTaxPileToken({
        fork, coreSigner: owner, creator: owner, quoteAsset: await quote.getAddress(), template: await template.getAddress(),
        form: { name: "Pile Tax", symbol: "PTAX", maxSupply: "1000000000", saleAmount: "800000000", raiseAmount: quoteKind === "erc20" ? "100" : "5", buyFeeRate: "300", sellFeeRate: "300" },
      });
      token = new ethers.Contract(launch.token, [...ABI.erc20, ...TAX_ABI], provider);
      vault = new ethers.Contract(launch.vault, ABI.vault, provider);
      forward = new ethers.Contract(await token.founder(), FORWARD_ABI, provider);
      clone = at("PileTaxVault", await forward.clonedVault(), provider);
      expect(await clone.pile()).to.equal(ethers.ZeroAddress);
      await sent(clone.connect(bob).createPile()); // anyone, once the token exists
      pile = at("FeeRules", await clone.pile(), provider);
      const again = await sent(clone.connect(alice).createPile()); // a second call: same pile, nothing created
      expect(again.logs.length).to.equal(0);
      expect(await clone.pile()).to.equal(await pile.getAddress());
      console.log(`      token ${launch.token}; founder (ForwardVault) ${await forward.getAddress()}; clone ${await clone.getAddress()}; pile ${await pile.getAddress()}`);
      expect(await forward.template()).to.equal(await template.getAddress());
      expect(await pile.token()).to.equal(launch.token);
      expect(await pile.asset()).to.equal(await quote.getAddress());
      expect(await pile.excludedHolders()).to.deep.equal([launch.vault]);
      expect(await clone.owner()).to.equal(ethers.ZeroAddress);
      expect(await clone.authorWallet()).to.equal(DEAD);
    });

    async function settle() {
      // TaxToken does its pending tax work inside ordinary transfers; a zero-amount transfer to oneself (anyone can
      // send one) makes it pay what is due now, through ForwardVault and the clone into the pile. Used here only to
      // read the books at a known point. (An explicit dispatchTax() defers the DEX swap on this fork:
      // "TransferHelper: TRANSFER_FROM_...".)
      const rec = await sent(token.connect(bob).transfer(bob.address, 0n, G));
      for (const log of rec.logs) {
        try {
          const ev = token.interface.parseLog(log);
          if (ev && ev.name.startsWith("FeeDispatch")) console.log(`      ${ev.name}(${ev.args.map(String).join(", ").slice(0, 120)})`);
        } catch { /* another contract's log */ }
      }
      const received = await pile.totalReceived();
      const founder = await token.feeFounder();
      expect(received, "everything paid to the founder is in the pile").to.equal(founder);
      expect(await quote.balanceOf(await forward.getAddress())).to.equal(0n);
      expect(await quote.balanceOf(await clone.getAddress())).to.equal(0n);
      expect(await provider.getBalance(await forward.getAddress()), "no native left in ForwardVault").to.equal(0n);
      expect(await provider.getBalance(await clone.getAddress()), "no native left in the clone").to.equal(0n);
      expect(await token.feeToFounder(), "no founder payout deferred").to.equal(0n);
      return { received, collected: await token.totalTaxCollected(), pending: await token.feeAccumulated() };
    }

    it("bonding-curve tax reaches the pile in full (no royalty), to the last unit", async function () {
      await sent(quote.connect(alice).approve(fork.addresses.core, ethers.MaxUint256));
      await sent(quote.connect(bob).approve(fork.addresses.core, ethers.MaxUint256));
      for (const [trader, amount] of [[alice, "60000000"], [bob, "40000000"]]) {
        const amt = ethers.parseUnits(amount, 18);
        const est = await tools.estimateBuy.staticCall(launch.token, trader.address, amt, 0n, "0x");
        await sent(core.connect(trader).buy(launch.token, amt, (est.userPays * 10100n) / 10000n, 0n, "0x", G));
      }
      const s = await settle();
      console.log(`      tax collected ${s.collected}, pending below the dispatch threshold ${s.pending}, in the pile ${s.received}`);
      expect(s.received + s.pending).to.equal(s.collected);
      expect(s.received).to.be.greaterThan(0n);
    });

    it("redeems during the curve: only sold tokens circulate; paid to the last unit", async function () {
      expect(await pile.circulatingSupply()).to.equal((await token.balanceOf(alice.address)) + (await token.balanceOf(bob.address)) + (await token.balanceOf(launch.token)));
      const amount = (await token.balanceOf(alice.address)) / 5n;
      const expected = await pile.quoteRedeem(amount);
      expect(expected).to.equal(((await pile.pile()) * amount) / (await pile.circulatingSupply()));
      await sent(token.connect(alice).approve(await pile.getAddress(), amount));
      const q0 = await quote.balanceOf(alice.address);
      const d0 = await token.balanceOf(DEAD);
      const h0 = await token.balanceOf(alice.address);
      await sent(pile.connect(alice).redeem(amount, expected, G));
      expect((await quote.balanceOf(alice.address)) - q0).to.equal(expected);
      expect((await token.balanceOf(DEAD)) - d0).to.equal(amount);
      expect(h0 - (await token.balanceOf(alice.address))).to.equal(amount);
    });

    it("graduates to PancakeSwap V2; DEX trades are taxed and the tax waits in the token", async function () {
      for (let round = 0; round < 8 && !(await vault.isSoldOut()); round++) {
        await sent(core.connect(bob).buyByBudget(launch.token, ethers.parseUnits(quoteKind === "erc20" ? "60" : "4", 18), 0n, 0n, "0x", G));
      }
      expect(PHASE[Number(await vault.phase())]).to.equal("Migrated");
      const before = await settle();
      const pair = await new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], provider).getPair(launch.token, await quote.getAddress());
      expect(pair).to.not.equal(ethers.ZeroAddress);
      // DEX trades through the PancakeSwap router: a sell and a buy, each taxed 3% in tokens.
      const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
      const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 600n;
      const sellAmount = (await token.balanceOf(bob.address)) / 4n;
      await sent(token.connect(bob).approve(ROUTER, ethers.MaxUint256));
      const t0 = await token.tokenAccumulated();
      await sent(router.connect(bob).swapExactTokensForTokensSupportingFeeOnTransferTokens(sellAmount, 1n, [launch.token, await quote.getAddress()], bob.address, deadline, G));
      const sellTax = (await token.tokenAccumulated()) - t0;
      console.log(`      DEX sell of ${sellAmount}: tax ${sellTax}`);
      expect(sellTax, "the sell is taxed 3% of the amount sold").to.equal((sellAmount * 300n) / 10_000n);
      await sent(quote.connect(alice).approve(ROUTER, ethers.MaxUint256));
      const a0 = await token.balanceOf(alice.address);
      const t1 = await token.tokenAccumulated();
      await sent(router.connect(alice).swapExactTokensForTokensSupportingFeeOnTransferTokens(ethers.parseUnits(quoteKind === "erc20" ? "5" : "0.2", 18), 1n, [await quote.getAddress(), launch.token], alice.address, deadline, G));
      const got = (await token.balanceOf(alice.address)) - a0;
      const buyTax = (await token.tokenAccumulated()) - t1;
      console.log(`      DEX buy: alice receives ${got}, tax ${buyTax}`);
      expect(buyTax, "the buy is taxed 3% of what leaves the pair").to.equal(((got + buyTax) * 300n) / 10_000n);
      expect(buyTax).to.be.greaterThan(0n);
      const taxTokens = await token.tokenAccumulated();
      console.log(`      DEX tax held as tokens: ${taxTokens} (threshold ${await token.minDispatch()}); pile ${before.received}`);
      expect(taxTokens).to.be.greaterThan(await token.minDispatch()); // pending: the next ordinary transfer pays it
    });

    it("with DEX tax pending, a redemption works in ONE transaction: paid on the pile as it was, the tax stays for the rest", async function () {
      const amount = (await token.balanceOf(alice.address)) / 2n;
      await sent(token.connect(alice).approve(await pile.getAddress(), amount));
      const pileBefore = await pile.pile();
      const circBefore = await pile.circulatingSupply();
      const expected = (pileBefore * amount) / circBefore;
      expect(await pile.quoteRedeem(amount)).to.equal(expected);
      const founderBefore = await token.feeFounder();
      const q0 = await quote.balanceOf(alice.address);
      const d0 = await token.balanceOf(DEAD);
      const rec = await sent(pile.connect(alice).redeem(amount, expected, G)); // no settle step first
      expect((await token.balanceOf(DEAD)) - d0, "the dead address gains exactly the tokens handed in").to.equal(amount);
      const paid = (await quote.balanceOf(alice.address)) - q0;
      const dispatched = (await token.feeFounder()) - founderBefore;
      const pileAfter = await pile.pile();
      console.log(`      one tx ${rec.hash}: alice hands in ${amount} of ${circBefore}, paid ${paid} (pile before ${pileBefore}); the hand-in dispatched ${dispatched} into the pile; pile after ${pileAfter}`);
      expect(paid, "paid exactly pile-before x amount / circulating-before").to.equal(expected);
      expect(await token.tokenAccumulated(), "the hand-in did the pending tax work").to.equal(0n);
      expect(dispatched).to.be.greaterThan(0n);
      expect(pileAfter, "the dispatched tax is in the pile").to.equal(pileBefore - expected + dispatched);
      expect(await pile.totalReceived()).to.equal(await token.feeFounder());

      // The next redeemer's payout counts that tax.
      const amount2 = (await token.balanceOf(bob.address)) / 2n;
      await sent(token.connect(bob).approve(await pile.getAddress(), amount2));
      const circ2 = await pile.circulatingSupply();
      const expected2 = (pileAfter * amount2) / circ2;
      expect(await pile.quoteRedeem(amount2)).to.equal(expected2);
      const b0 = await quote.balanceOf(bob.address);
      await sent(pile.connect(bob).redeem(amount2, expected2, G));
      const paid2 = (await quote.balanceOf(bob.address)) - b0;
      console.log(`      bob hands in ${amount2} of ${circ2}, paid ${paid2} on the pile ${pileAfter} that includes the dispatched tax`);
      expect(paid2).to.equal(expected2);
      expect(paid2).to.be.greaterThan(((pileBefore - expected) * amount2) / circ2);
    });

    it("after graduation every holder still redeems to the last unit", async function () {
      for (const holder of [alice, bob]) {
        const bal = await token.balanceOf(holder.address);
        const circ = await pile.circulatingSupply();
        const p = await pile.pile();
        const expected = bal === circ ? p : (p * bal) / circ;
        await sent(token.connect(holder).approve(await pile.getAddress(), bal));
        const q0 = await quote.balanceOf(holder.address);
        const d0 = await token.balanceOf(DEAD);
        await sent(pile.connect(holder).redeem(bal, expected, G));
        expect((await quote.balanceOf(holder.address)) - q0).to.equal(expected);
        expect((await token.balanceOf(DEAD)) - d0).to.equal(bal);
        console.log(`      ${holder.address.slice(0, 8)} hands in ${bal} of ${circ}, receives ${expected}`);
      }
    });

    it("the template clone has no owner and no way to move the pile", async function () {
      const writes = at("PileTaxVault", ethers.ZeroAddress, null).interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f) => f.name).sort();
      // initialize (once, by ForwardVault), the two tax hooks, flush (into the pile only), and BaseTaxVault's
      // inherited Ownable functions, which nobody can use after the renounce in initialize.
      expect(writes).to.deep.equal(["createPile", "flush", "initialize", "onERC20TaxReceived", "renounceOwnership", "transferOwnership", "updateShares"]);
      const why = async (p) => {
        try {
          await p;
        } catch (e) {
          return String(e.reason || e.shortMessage);
        }
        return "(no revert)";
      };
      expect(await why(clone.connect(owner).initialize.staticCall(launch.token, await quote.getAddress(), owner.address, [], "0x")))
        .to.equal("Initializable: contract is already initialized");
      expect(await why(clone.connect(owner).transferOwnership.staticCall(owner.address))).to.equal("Ownable: caller is not the owner");
    });
  });
}
