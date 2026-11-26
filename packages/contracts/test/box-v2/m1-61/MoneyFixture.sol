// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {
    FailureTestBase,
    IPoolManager,
    BoxClones,
    BoxTokenV2,
    BoxTokenV2Args,
    CoordinatorV2Config,
    BoxCoordinatorV2Args,
    BoxRolesV2,
    HostileToken
} from "../m1-31/FailureTestBase.sol";
import {CoordinatorHarness, FailureHook, FailureRouter, FailureVault} from "../m1-31/FailureShells.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract MoneySafe {
    receive() external payable {}
}

/// @dev CQ11-A boundary only. Real backed claims are supplied by the fixture, not minted by this counter.
contract MoneyHook is FailureHook {
    uint256 public sellersPending;

    constructor(IPoolManager pm_, address c, address r, address t, address p_) FailureHook(pm_, c, r, t, p_) {}

    function sales(uint256 amount) external {
        sellersPending += amount;
    }

    function harvest() external returns (uint256, uint256 sellers, uint256) {
        require(msg.sender == receiver, "receiver only");
        sellers = sellersPending;
        sellersPending = 0;
        return (0, sellers, 0);
    }
}

/// @notice Real default-profile receiver, coordinator and T with a real PoolManager. Creation alone is seeded;
/// the hook, router and vault boundaries are scripted. No production accounting storage is patched.
abstract contract MoneyFixture is FailureTestBase {
    BoxReceiverV2 internal fees;
    MoneyHook internal moneyHook;
    HostileToken internal foreignCoin;
    address internal constant CAROL = address(0xCA201);
    address internal constant FIT = address(0xF17);
    address internal constant PLATFORM = address(0xF18);
    address internal constant CONVERSION = address(0xF19);
    /// @dev One release per fixture, as in production: the first `_realBox` deploys the coordinator, T and receiver
    /// code (with the receiver's shared parts) and every box is new clones of them. Deploying them again for each box
    /// cost about 114M gas per box under Amsterdam's state-creation prices, so nine boxes ran out of the default 2^30
    /// test gas (docs/evidence/SH-V21-FUZZ-AMS.md).
    CoordinatorHarness private releaseCoordinator;
    address private releaseToken;
    address private releaseReceiver;

    function setUp() public virtual override {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        // A low P address preserves the frozen P < T rule for every deterministic coordinator clone.
        HostileToken code = new HostileToken("Price", "P", 6);
        vm.etch(address(0x1000), address(code).code);
        priceToken = HostileToken(address(0x1000));
        priceToken.setDecimals(6);
        // The release requires existing contracts at all three immutable Safe addresses. In Amsterdam a
        // fresh EOA has an account-creation charge that a deployed Safe does not have.
        bytes memory safeCode = address(new MoneySafe()).code;
        vm.etch(FIT, safeCode);
        vm.etch(PLATFORM, safeCode);
        vm.etch(CONVERSION, safeCode);
        foreignCoin = new HostileToken("Royalty", "R", 18);
        _realBox(1, 2, 1, true, address(priceToken));
    }

    function _release() private {
        if (address(releaseCoordinator) != address(0)) return;
        releaseCoordinator =
            CoordinatorHarness(deployCode("out/FailureShells.sol/CoordinatorHarness.json", abi.encode(pm)));
        releaseToken = deployCode("out/BoxTokenV2.sol/BoxTokenV2.json", abi.encode(address(releaseCoordinator)));
        releaseReceiver = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2",
            ReceiverDeploy.args(pm, address(releaseCoordinator), FIT, PLATFORM)
        );
    }

    function _realBox(uint8 buyers, uint8 sellers, uint8 royalty, bool withVault, address price) internal {
        p = price;
        _release();
        implementation = releaseCoordinator;
        bytes memory nonces = new bytes(24);
        nonces[BoxRolesV2.ROLE_TOKEN] = bytes1(uint8(1));
        nonces[BoxRolesV2.ROLE_RECEIVER] = bytes1(uint8(2));
        nonces[BoxRolesV2.ROLE_LAUNCH_ROUTER] = bytes1(uint8(3));
        if (withVault) nonces[BoxRolesV2.ROLE_VAULT] = bytes1(uint8(4));
        CoordinatorV2Config memory c;
        c.p = p;
        c.creator = CREATOR;
        c.raise = 1e18;
        c.deadlineDays = 30;
        c.nonces = bytes24(nonces);
        box = CoordinatorHarness(
            BoxClones.create(BoxClones.initCode(address(implementation), BoxCoordinatorV2Args.encode(c)))
        );
        address ta = box.token();
        address ra = box.receiver();
        address la = box.launchRouter();
        address va = box.vault();
        t = BoxTokenV2(ta);
        vm.etch(
            ta, BoxClones.runtime(releaseToken, BoxTokenV2Args.encode(address(box), va, address(0), SUPPLY, "T", "T"))
        );
        moneyHook = new MoneyHook(pm, address(box), ra, ta, p);
        hook = moneyHook;
        router = FailureRouter(payable(la));
        vm.etch(la, address(new FailureRouter(pm, address(box), p)).code);
        vault = FailureVault(va);
        if (withVault) vm.etch(va, address(new FailureVault()).code);
        ReceiverArgs memory a = ReceiverArgs(
            address(box),
            address(hook),
            p,
            ta,
            la,
            address(0xA2),
            CREATOR,
            61,
            1000,
            100,
            100,
            buyers,
            sellers,
            royalty,
            address(0),
            address(0)
        );
        vm.etch(ra, BoxClones.runtime(releaseReceiver, BoxReceiverV2Args.encode(a)));
        fees = BoxReceiverV2(ra);
        box.seed(address(hook), block.timestamp, true);
        vm.startPrank(address(box));
        t.initialize();
        t.approve(address(hook), type(uint256).max);
        fees.initialize();
        vm.stopPrank();
    }

    function _feed(uint256 buyers, uint256 sellers) internal {
        _fund(p, address(fees), buyers + sellers);
        moneyHook.sales(sellers);
        fees.collect(address(0));
    }

    function _royaltyP(uint256 amount) internal {
        if (p == address(0)) {
            vm.deal(address(this), address(this).balance + amount);
            fees.fundRoyalty{value: amount}(p, amount);
        } else {
            priceToken.mint(address(this), amount);
            priceToken.approve(address(fees), amount);
            fees.fundRoyalty(p, amount);
        }
    }

    function _royaltyForeign(uint256 amount) internal {
        foreignCoin.mint(address(this), amount);
        foreignCoin.approve(address(fees), amount);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        fees.fundRoyalty(address(foreignCoin), amount);
    }

    function _vaultTokens(uint256 amount) internal {
        vm.prank(address(box));
        t.approve(address(vault), amount);
        vm.prank(address(vault));
        t.transferFrom(address(box), address(vault), amount);
    }

    function _claimsP(address who) internal view returns (uint256) {
        return pm.balanceOf(who, uint160(p));
    }

    function _ledgerSum() internal view returns (uint256) {
        return fees.fitOwed() + fees.platformOwed() + fees.poolHeldP() + fees.growHeldP() + fees.creatorP()
            + fees.buyBackP() + fees.royaltyHeldP() + fees.itemsHeldP();
    }

    function _assertBooked() internal view {
        assertLe(fees.booked(p), _claimsP(address(fees)), "booked exceeds backed claims");
        assertLe(_ledgerSum(), fees.booked(p), "ledgers omitted from booked");
        assertLt(fees.booked(p) - _ledgerSum(), 30, "side carries exceed 14 each");
    }
}
