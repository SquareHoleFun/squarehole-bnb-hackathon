// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HostileToken} from "./HostileToken.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {PoolDriver} from "./BoxV2TestBase.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {Side} from "../../../src/box-v2/interfaces/RecipeTypes.sol";

/// Local custody endpoint only; Safe threshold/signature proofs belong to the bot fork suite.
contract LifeCustody {
    bool public refusing;

    function setRefusing(bool value) external {
        refusing = value;
    }

    receive() external payable {
        require(!refusing, "receipt refused");
    }
}

/// Factory-created production parts and the pinned real PoolManager; only settlement actors are test code.
abstract contract FactoryLife is M132aBase {
    BoxCoordinatorV2 internal box;
    BoxTokenV2 internal token;
    IBoxHookV2 internal hook;
    IBoxReceiverV2 internal receiver;
    PoolDriver internal buyer;
    BoxLayoutV2.Curve internal layout;

    receive() external payable {}

    function setUp() public virtual override {
        super.setUp();
        // The creation fixture only needs code at its Safe addresses; life tests need receiving endpoints.
        bytes memory custody = address(new LifeCustody()).code;
        vm.etch(fitSafe, custody);
        vm.etch(conversionSafe, custody);
    }

    function _side(uint8 choice) internal pure returns (Side memory s) {
        s.split = 1;
        s.a.leg = choice == 2 ? 2 : 1;
        s.a.dest = choice == 1 ? 2 : choice == 2 ? 1 : 4;
    }

    function _menu(uint8 buys, uint8 sells) internal view returns (BoxSpec memory s) {
        s = _spec();
        s.tokenName = "Sample coin";
        s.tokenSymbol = "SAMPLE";
        s.buyers = _side(buys);
        s.sellers = _side(sells);
        if (buys == 1 || sells == 1) s.creatorFeeRecipient = CREATOR;
    }

    function _start(BoxSpec memory s) internal {
        _startAt(s, 384);
    }

    function _startAt(BoxSpec memory s, uint256 elapsed) internal {
        box = _create(s);
        if (!box.gateOpen() && s.metadataTable.length != 0) box.loadChunk(ChunkPart.Table, s.metadataTable, 0);
        if (!box.gateOpen()) {
            BoxFactoryV2Parts.Box memory encoding;
            (, bytes memory texts) = planner.parts().partArgs(encoding, s);
            if (texts.length != 0) box.loadChunk(ChunkPart.Texts, texts, 0);
        }
        assertTrue(box.gateOpen(), "life fixture loaded every required chunk");
        layout = BoxLayoutV2.curve(s.raise, s.layout == 2);
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        buyer = new PoolDriver(pm);
        if (s.pricing.token == address(0)) vm.deal(address(buyer), s.raise * 10);
        else HostileToken(s.pricing.token).mint(address(buyer), s.raise * 10);
        vm.warp(box.effectiveOpenAt() + elapsed);
        vm.roll(block.number + 1);
    }

    function _buy(uint256 amount) internal returns (uint256 paid, uint256 received) {
        return buyer.swap(hook.poolKey(), true, amount, layout.sqrtPriceEndX96);
    }

    function _fill() internal {
        for (uint256 i; i < 5 && !hook.closed(); ++i) {
            _buy(box.raise() / 4);
        }
        assertTrue(hook.closed(), "curve filled by actual buys");
    }

    function _priceSpec(uint8 buys, uint8 sells, uint8 decimals) internal returns (BoxSpec memory s, HostileToken p) {
        s = _menu(buys, sells);
        p = new HostileToken("Price coin", "PRICE", decimals);
        p.mint(address(this), 10_000);
        p.approve(address(listings), 10_000);
        s.pricing.token = address(p);
        s.raise = 10 ** uint256(decimals);
        s.pricing.listingId = listings.add(address(p), ListingClass.OTHER, s.raise);
        p.mint(CREATOR, s.raise);
        vm.prank(CREATOR);
        p.approve(address(factory), s.raise);
    }

    function _balance(address who) internal view returns (uint256) {
        return box.q() == address(0) ? who.balance : HostileToken(box.q()).balanceOf(who);
    }

    function _money() internal view returns (uint256) {
        return _balance(address(pm)) + _balance(address(buyer)) + _balance(CREATOR) + _balance(address(this))
            + _balance(fitSafe) + _balance(conversionSafe) + _balance(box.launchRouter()) + _balance(address(box))
            + _balance(address(receiver));
    }

    function _gift(address to, uint256 amount) internal {
        buyer.mintClaims(Currency.wrap(box.q()), to, amount);
    }

    /// F137 test settlement: convert graduated T fees before asserting seller P receipts.
    /// Use the hook as caller so the refused self-tip stays in the fee proceeds, preserving conservation totals.
    function _sellFeeP() internal {
        for (uint256 i; i < 256; ++i) {
            vm.roll(block.number + 1);
            vm.prank(address(hook)); (ProtocolSkip skip,,,) = hook.sellFees();
            if (skip == ProtocolSkip.BelowMinimum) return;
            assertEq(uint8(skip), uint8(ProtocolSkip.None));
        }
        revert("fee conversion did not reach step minimum");
    }

    function _claimBuyer() internal returns (uint256 paid) {
        uint256 held = token.balanceOf(address(buyer));
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, held, "all outstanding T belongs to buyer");
        assertGt(left, 0);
        vm.startPrank(address(buyer));
        token.approve(address(box), held);
        paid = box.claim(held, address(buyer));
        vm.stopPrank();
        assertEq(paid, pot);
        (pot, left) = box.claimState();
        assertEq(pot, 0);
        assertEq(left, 0);
    }

    function _booked() internal view {
        assertLe(receiver.booked(box.q()), pm.balanceOf(address(receiver), uint160(box.q())));
    }
}

/// Exercises coordinator entry from an unrelated real PoolManager unlock.
contract LifeForeignUnlock {
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function attempt(address target, bytes memory data) external returns (bool ok, bytes memory result) {
        return abi.decode(manager.unlock(abi.encode(target, data)), (bool, bytes));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (address target, bytes memory callData) = abi.decode(data, (address, bytes));
        (bool ok, bytes memory result) = target.call(callData);
        return abi.encode(ok, result);
    }
}

/// A forced native gift models money arriving outside the router's payable entry points.
contract LifeGift {
    constructor(address to) payable {
        selfdestruct(payable(to));
    }
}
