// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, FeeBatchV2, Currency} from "../cq11-b/ReceiverFixture.sol";
import {ReferenceModel} from "./ReferenceModel.sol";

contract SplitReferenceTest is ReceiverFixture, ReferenceModel {
    function testFuzz_twoSidesTwoBatches(uint96 b0, uint96 s0, uint96 b1, uint96 s1, uint8 bc, uint8 sc)
        public
        checkedModel
    {
        (b0, s0, b1, s1, bc, sc) = abi.decode(
            modelCase("split", abi.encode(b0, s0, b1, s1, bc, sc)), (uint96, uint96, uint96, uint96, uint8, uint8)
        );
        bc = uint8(bound(bc, 1, 3));
        sc = uint8(bound(sc, 1, 3));
        r = _receiver(bc, sc, 1, address(p), true);
        _fees(b0, s0);
        r.collect(address(0));
        _assertSplit(b0, s0, bc, sc);
        _fees(b1, s1);
        r.collect(address(0));
        _assertSplit(uint256(b0) + b1, uint256(s0) + s1, bc, sc);
        uint256 fit = r.fitOwed();
        uint256 platform = r.platformOwed();
        assertEq(r.payFit(), fit);
        assertEq(r.payPlatform(), platform);
        assertEq(p.balanceOf(FIT), fit);
        assertEq(p.balanceOf(PLATFORM), platform);
        _booked();
    }

    function testFuzz_sellerCounterClippedToActualClaims(uint96 balance, uint96 counter) public checkedModel {
        (balance, counter) = abi.decode(modelCase("clipped", abi.encode(balance, counter)), (uint96, uint96));
        driver.mintClaims(Currency.wrap(address(p)), address(r), balance);
        hook.script(0, counter, 0);
        FeeBatchV2 memory batch = r.collect(address(0));
        uint256 sellers = counter > balance ? balance : counter;
        assertEq(batch.sellersP, sellers);
        assertEq(batch.buyersP, balance - sellers);
        _assertSplit(balance - sellers, sellers, 1, 1);
    }

    function test_separateDustAndCarryCrossing() public checkedModel {
        modelCase("dust", abi.encode());
        _fees(14, 1);
        r.collect(address(0));
        _assertSplit(14, 1, 1, 1);
        _fees(1, 14);
        r.collect(address(0));
        _assertSplit(15, 15, 1, 1);
    }

    function _assertSplit(uint256 buyers, uint256 sellers, uint8 bc, uint8 sc) internal {
        uint256[] memory input = new uint256[](4);
        input[0] = buyers;
        input[1] = sellers;
        input[2] = bc;
        input[3] = sc;
        uint256[] memory e = model("split", input);
        assertEq(r.fitOwed(), e[0], "FIT");
        assertEq(r.platformOwed(), e[1], "platform");
        assertEq(r.poolHeldP(), e[2], "pool");
        assertEq(r.creatorP(), e[3], "keep");
        assertEq(r.buyBackP(), e[4], "burn");
        assertEq(r.growHeldP(), e[5], "grow");
        assertEq(r.booked(address(p)) - _sum(), e[6] + e[7], "carries");
        assertEq(r.booked(address(p)), buyers + sellers, "conservation");
        _booked();
    }
}
