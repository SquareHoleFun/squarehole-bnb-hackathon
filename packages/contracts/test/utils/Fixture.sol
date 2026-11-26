// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SquareHoleToken} from "../../src/SquareHoleToken.sol";
import {SquareHoleFungibleToken} from "../../src/SquareHoleFungibleToken.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {ClaimsFunder} from "./ClaimsFunder.sol";
import {MockERC20} from "./MockTokens.sol";

/// @notice Template-agnostic view of T (both SquareHoleToken and SquareHoleFungibleToken implement it).
interface ITestT {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function initialSupply() external view returns (uint256);
    function burnFeeInventory(uint256 amount) external;
}

/// @notice Deploys one launch (ledger → collector → token at predicted CREATE addresses) the way the launcher does,
/// against a real Uniswap v4 PoolManager (compiled from the pinned source; local tests only), plus helpers for fee
/// events, buys and 7702-style accounts. The fee source is a stand-in address (`hook`) that receives ERC-6909
/// claims from `ClaimsFunder`, exactly as the real hook holds them for a moment inside `afterSwap`; the v4
/// integration suites (test/integration) use the real hook, launcher and pools.
abstract contract Fixture is Test {
    uint256 internal constant WHOLE = 1e18;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Raw units per whole NFT of the deployed collection (fractionsPerNft × 1e18); for the fungible template,
    /// one whole token (1e18). Set by `_deploy*`.
    uint256 internal UNIT = 1e18;

    IPoolManager internal pm;
    ClaimsFunder internal funder;

    SquareHoleToken internal token; // the collection template (when deployed)
    SquareHoleFungibleToken internal fungible; // the fungible template (when deployed)
    ITestT internal tt; // T, whichever template
    bool internal isCollection;
    DN404Mirror internal mirror;
    RewardLedger internal ledger;
    FeeCollector internal collector;
    MockERC20 internal quote;

    address internal treasury = makeAddr("treasury");
    address internal launcher = makeAddr("launcher");
    address internal hook = makeAddr("hook"); // stand-in fee source (the real hook in test/integration)
    address internal poolManager; // = address(pm)
    address internal converter = makeAddr("converter");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    string internal constant BASE_URI = "ipfs://bafy-square-hole-demo/";
    bytes32 internal constant MANIFEST = keccak256("square-hole demo manifest v1");

    function _ensurePoolManager() internal {
        if (address(pm) != address(0)) return;
        // Artifact deploy: test files never import PoolManager.sol (see test/utils/v4/PoolManagerBuild.sol).
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("pmOwner"))));
        poolManager = address(pm);
        funder = new ClaimsFunder(pm);
    }

    function _deploy(IRewardLedger.PayoutAsset payout, uint256 fractionsPerNft, uint256 collectionSize) internal {
        if (address(quote) == address(0)) quote = new MockERC20("Wrapped Ether (test)", "WETH");
        _deployWith(payout, fractionsPerNft, collectionSize, address(quote));
    }

    function _deployWith(IRewardLedger.PayoutAsset payout, uint256 fractionsPerNft, uint256 collectionSize, address q)
        internal
    {
        (address predictedCollector, address predictedToken) = _deployCore(payout, q, true);
        token = new SquareHoleToken(_terms(fractionsPerNft, collectionSize, predictedCollector, address(ledger)));
        assertEq(address(token), predictedToken, "token address");
        tt = ITestT(address(token));
        fungible = SquareHoleFungibleToken(address(0));
        isCollection = true;
        mirror = DN404Mirror(payable(token.mirrorERC721()));
        UNIT = token.unit();
    }

    function _deployFungible(IRewardLedger.PayoutAsset payout, uint256 wholeSupply) internal {
        if (address(quote) == address(0)) quote = new MockERC20("Wrapped Ether (test)", "WETH");
        _deployFungibleWith(payout, wholeSupply, address(quote));
    }

    function _deployFungibleWith(IRewardLedger.PayoutAsset payout, uint256 wholeSupply, address q) internal {
        (address predictedCollector, address predictedToken) = _deployCore(payout, q, false);
        fungible = new SquareHoleFungibleToken(_fungibleTerms(wholeSupply, predictedCollector, address(ledger)));
        assertEq(address(fungible), predictedToken, "token address");
        tt = ITestT(address(fungible));
        token = SquareHoleToken(payable(address(0)));
        isCollection = false;
        mirror = DN404Mirror(payable(address(0)));
        UNIT = WHOLE;
    }

    /// @dev Ledger then collector at predicted addresses; the caller deploys T next (nonce + 2).
    function _deployCore(IRewardLedger.PayoutAsset payout, address q, bool nftMirror)
        internal
        returns (address predictedCollector, address predictedToken)
    {
        _ensurePoolManager();
        // In production these roles are contracts (hook, converter), so they skip NFTs by default.
        _etchContract(hook);
        _etchContract(converter);
        uint256 nonce = vm.getNonce(address(this));
        predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        ledger = new RewardLedger(
            RewardLedger.Config({
                token: predictedToken,
                quote: q,
                feeCollector: predictedCollector,
                treasury: treasury,
                payoutAsset: payout,
                converter: payout == IRewardLedger.PayoutAsset.T ? converter : address(0),
                launcher: launcher,
                poolManager: poolManager,
                hook: hook,
                nftMirror: nftMirror
            })
        );
        collector = new FeeCollector(predictedToken, q, address(ledger), treasury, hook, poolManager);
        assertEq(address(collector), predictedCollector, "collector address");
    }

    /// @dev A ledger config with the fixture's roles (for tests that deploy extra launches by hand).
    function _config(
        address token_,
        address q,
        address feeCollector_,
        IRewardLedger.PayoutAsset payout,
        address launcherRole,
        bool nftMirror
    ) internal view returns (RewardLedger.Config memory) {
        return RewardLedger.Config({
            token: token_,
            quote: q,
            feeCollector: feeCollector_,
            treasury: treasury,
            payoutAsset: payout,
            converter: payout == IRewardLedger.PayoutAsset.T ? converter : address(0),
            launcher: launcherRole,
            poolManager: poolManager,
            hook: hook,
            nftMirror: nftMirror
        });
    }

    function _terms(uint256 fractionsPerNft, uint256 collectionSize, address feeCollector_, address ledger_)
        internal
        view
        returns (SquareHoleToken.LaunchTerms memory)
    {
        return SquareHoleToken.LaunchTerms({
            name: "Orchard Misfits (test)",
            symbol: "MISFIT",
            fractionsPerNft: fractionsPerNft,
            collectionSize: collectionSize,
            initialHolder: launcher,
            feeCollector: feeCollector_,
            rewardLedger: ledger_,
            baseURI: BASE_URI,
            metadataManifestHash: MANIFEST
        });
    }

    function _fungibleTerms(uint256 wholeSupply, address feeCollector_, address ledger_)
        internal
        view
        returns (SquareHoleFungibleToken.LaunchTerms memory)
    {
        return SquareHoleFungibleToken.LaunchTerms({
            name: "Square Hole Fit (test)",
            symbol: "FIT",
            wholeSupply: wholeSupply,
            initialHolder: launcher,
            feeCollector: feeCollector_,
            rewardLedger: ledger_,
            metadataManifestHash: MANIFEST
        });
    }

    /// @dev The launcher plays the market: "buys" and payout purchases come from its inventory.
    function _buy(address to, uint256 amount) internal {
        vm.prank(launcher);
        tt.transfer(to, amount);
    }

    /// @dev An authenticated fee event: `t` native fee T (from launch inventory) and `q` realized Q, delivered as
    /// PoolManager claims by the fee source.
    function _feeEvent(uint256 t, uint256 q) internal returns (uint256 receiptId) {
        _prepareFee(t, q);
        vm.prank(hook);
        receiptId = collector.receiveFees(t, q);
    }

    /// @dev Gives the fee source `t` T claims and `q` Q claims and grants the collector exact ERC-6909 allowances
    /// (no infinite approvals). The T comes out of launch inventory into the PoolManager (both excluded).
    function _prepareFee(uint256 t, uint256 q) internal {
        if (t != 0) funder.deposit(address(tt), launcher, t, hook);
        if (q != 0) funder.deposit(address(quote), address(0), q, hook);
        vm.startPrank(hook);
        if (t != 0) pm.approve(address(collector), _id(address(tt)), t);
        if (q != 0) pm.approve(address(collector), _id(address(quote)), q);
        vm.stopPrank();
    }

    function _claim(address account) internal returns (uint256) {
        vm.prank(account);
        return ledger.claim(account);
    }

    /// @dev ERC-6909 claim id of `asset` on the PoolManager.
    function _id(address asset) internal pure returns (uint256) {
        return uint256(uint160(asset));
    }

    /// @dev `owner`'s PoolManager claims of `asset`.
    function _claims(address owner, address asset) internal view returns (uint256) {
        return pm.balanceOf(owner, _id(asset));
    }

    /// @dev EIP-7702 delegation designator: 0xef0100 ‖ delegate (23 bytes).
    function _etch7702(address account, address delegate) internal {
        vm.etch(account, abi.encodePacked(hex"ef0100", delegate));
    }

    function _etchContract(address account) internal {
        vm.etch(account, hex"00");
    }

    function _excluded() internal view returns (address[9] memory) {
        return [
            address(ledger),
            address(tt),
            address(mirror),
            address(collector),
            treasury,
            converter,
            launcher,
            poolManager,
            hook
        ];
    }

    /// @dev Σ excluded balances, computed independently of the ledger's tracked eligibleSupply.
    function _excludedBalance() internal view returns (uint256 sum) {
        address[9] memory ex = _excluded();
        for (uint256 i; i < ex.length; ++i) {
            if (ex[i] == address(0)) continue;
            if (ex[i] == converter && ledger.converter() == address(0)) continue;
            sum += tt.balanceOf(ex[i]);
        }
    }
}
