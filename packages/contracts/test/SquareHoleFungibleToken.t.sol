// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RewardLedger} from "../src/RewardLedger.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {SquareHoleFungibleToken} from "../src/SquareHoleFungibleToken.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {LaunchTokenCore} from "../src/base/LaunchTokenCore.sol";
import {Fixture} from "./utils/Fixture.sol";
import {RecordingLedger, StubCollector} from "./utils/Harness.sol";

/// @notice A recording ledger for the fungible template (no mirror role).
contract RecordingLedgerNoMirror is RecordingLedger {
    constructor(address token_, address feeCollector_) RecordingLedger(token_, feeCollector_) {}

    function mirror() external pure override returns (address) {
        return address(0);
    }
}

/// @notice Test-only subclass exposing the internal mint (the constructor is the only production mint).
contract FungibleHarness is SquareHoleFungibleToken {
    constructor(LaunchTerms memory terms) SquareHoleFungibleToken(terms) {}

    function exposedMint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice The plain ERC-20 template ("token" launches): same ledger semantics as the DN404 template (the shared
/// suites in Differential.t.sol and the invariant campaigns run against both), plus ERC-20 specifics here.
contract SquareHoleFungibleTokenTest is Fixture {
    uint256 internal constant Q = 1e18;

    function setUp() public {
        _deployFungible(IRewardLedger.PayoutAsset.Q, 1e9);
    }

    function test_constructor_fixesTerms() public view {
        assertEq(fungible.name(), "Square Hole Fit (test)");
        assertEq(fungible.symbol(), "FIT");
        assertEq(fungible.decimals(), 18);
        assertEq(fungible.wholeSupply(), 1e9, "F10: the fixed supply");
        assertEq(fungible.initialSupply(), 1e27);
        assertEq(fungible.totalSupply(), 1e27);
        assertEq(fungible.balanceOf(launcher), 1e27);
        assertEq(fungible.initialHolder(), launcher);
        assertEq(fungible.feeCollector(), address(collector));
        assertEq(fungible.rewardLedger(), address(ledger));
        assertEq(fungible.metadataManifestHash(), MANIFEST);
        assertEq(ledger.mirror(), address(0), "no mirror role");
    }

    /// F10: plain token launches have the same fixed supply as collections, exactly 1e9 whole tokens.
    function test_constructor_supplyIsFixed() public {
        _deployFungible(IRewardLedger.PayoutAsset.Q, 1e9);
        assertEq(fungible.totalSupply(), 1e27);
        uint256[5] memory bad = [uint256(0), 1, 21_000_000, 1e9 - 1, 1e9 + 1];
        for (uint256 i; i < bad.length; ++i) {
            _expectFungibleRevert(bad[i], abi.encodeWithSelector(LaunchTokenCore.InvalidSupply.selector, bad[i]));
        }
    }

    function testFuzz_constructor_supplyOtherThan1e9Reverts(uint256 wholeSupply) public {
        vm.assume(wholeSupply != 1e9);
        _expectFungibleRevert(wholeSupply, abi.encodeWithSelector(LaunchTokenCore.InvalidSupply.selector, wholeSupply));
    }

    function _expectFungibleRevert(uint256 wholeSupply, bytes memory err) internal {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, false)
        );
        new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        vm.expectRevert(err);
        new SquareHoleFungibleToken(_fungibleTerms(wholeSupply, predictedCollector, address(l)));
    }

    /// A ledger that predicts a mirror (the collection wiring) cannot be used with the fungible template.
    function test_constructor_rejectsLedgerWithMirrorRole() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        vm.expectRevert(LaunchTokenCore.WiringMismatch.selector);
        new SquareHoleFungibleToken(_fungibleTerms(1e9, predictedCollector, address(l)));
    }

    function test_constructor_initialHolderMustBeExcluded() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, false)
        );
        new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        SquareHoleFungibleToken.LaunchTerms memory t = _fungibleTerms(1e9, predictedCollector, address(l));
        t.initialHolder = makeAddr("creator");
        vm.expectRevert(LaunchTokenCore.InvalidInitialHolder.selector);
        new SquareHoleFungibleToken(t);
    }

    /*//////////////////////////////////////////////////////////////
                                 ERC-20
    //////////////////////////////////////////////////////////////*/

    function testFuzz_transfer_hasNoFee(uint256 amount) public {
        amount = bound(amount, 0, fungible.balanceOf(launcher));
        uint256 supply = fungible.totalSupply();
        _buy(alice, amount);
        assertEq(fungible.balanceOf(alice), amount, "recipient gets exactly amount");
        assertEq(fungible.totalSupply(), supply, "no burn on transfer");
    }

    function test_transferFrom_allowanceRules() public {
        _buy(alice, 10e18);
        vm.prank(alice);
        fungible.approve(bob, 4e18);
        vm.prank(bob);
        fungible.transferFrom(alice, carol, 3e18);
        assertEq(fungible.allowance(alice, bob), 1e18);
        vm.prank(bob);
        vm.expectRevert(SquareHoleFungibleToken.InsufficientAllowance.selector);
        fungible.transferFrom(alice, carol, 2e18);
        vm.prank(alice);
        fungible.approve(bob, type(uint256).max); // an explicit choice by the owner; never a default
        vm.prank(bob);
        fungible.transferFrom(alice, carol, 5e18);
        assertEq(fungible.allowance(alice, bob), type(uint256).max, "max allowance is not decremented");
        assertEq(fungible.allowance(alice, PERMIT2), 0, "no Permit2 default allowance");
    }

    function test_errors() public {
        _buy(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(SquareHoleFungibleToken.InsufficientBalance.selector);
        fungible.transfer(bob, 1e18 + 1);
        vm.prank(alice);
        vm.expectRevert(SquareHoleFungibleToken.TransferToZeroAddress.selector);
        fungible.transfer(address(0), 1);
        vm.prank(alice);
        vm.expectRevert(SquareHoleFungibleToken.ApproveToZeroAddress.selector);
        fungible.approve(address(0), 1);
        vm.prank(bob);
        vm.expectRevert(SquareHoleFungibleToken.TransferFromZeroAddress.selector);
        fungible.transferFrom(address(0), bob, 0);
    }

    function test_events() public {
        vm.expectEmit(address(fungible));
        emit SquareHoleFungibleToken.Transfer(launcher, alice, 5);
        _buy(alice, 5);
        vm.expectEmit(address(fungible));
        emit SquareHoleFungibleToken.Approval(alice, bob, 7);
        vm.prank(alice);
        fungible.approve(bob, 7);
    }

    function test_rejectsEthAndHasNoMint() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(fungible).call{value: 1}("");
        assertFalse(ok, "no receive");
        (ok,) = address(fungible).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1e18));
        assertFalse(ok, "no mint");
        (ok,) = address(fungible)
            .call(
                abi.encodeWithSignature(
                    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                    alice,
                    bob,
                    1,
                    1,
                    uint8(27),
                    bytes32(0),
                    bytes32(0)
                )
            );
        assertFalse(ok, "no permit");
        assertEq(address(fungible).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                   CHECKPOINTS AND THE FEE-INVENTORY BURN
    //////////////////////////////////////////////////////////////*/

    /// All three balance-write paths (initial mint, transfer/transferFrom, fee burn) call the ledger first with the
    /// pre-change balances.
    function test_checkpoints_allWritePathsWithPreChangeBalances() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RecordingLedgerNoMirror rec = new RecordingLedgerNoMirror(predictedToken, predictedCollector);
        StubCollector stub = new StubCollector(predictedToken, address(rec));
        FungibleHarness h = new FungibleHarness(_fungibleTerms(1e9, address(stub), address(rec)));
        _assertCall(rec, 0, address(0), 0, launcher, 0, 1e27, 0); // initial supply
        vm.prank(launcher);
        h.transfer(alice, 3e18);
        _assertCall(rec, 1, launcher, 1e27, alice, 0, 3e18, 1e27);
        vm.prank(alice);
        h.approve(bob, 1e18);
        vm.prank(bob);
        h.transferFrom(alice, carol, 1e18);
        _assertCall(rec, 2, alice, 3e18, carol, 0, 1e18, 1e27);
        vm.prank(launcher);
        h.transfer(address(stub), 4e18);
        stub.burn(4e18);
        _assertCall(rec, 4, address(stub), 4e18, address(0), 0, 4e18, 1e27);
        h.exposedMint(bob, 2e18);
        _assertCall(rec, 5, address(0), 0, bob, 0, 2e18, 1e27 - 4e18);
        assertEq(rec.callCount(), 6);
        assertEq(h.totalSupply(), 1e27 - 2e18);
    }

    function _assertCall(
        RecordingLedger rec,
        uint256 i,
        address from,
        uint256 fromBalance,
        address to,
        uint256 toBalance,
        uint256 amount,
        uint256 supplyAtCall
    ) internal view {
        RecordingLedger.Call memory c = rec.callAt(i);
        assertEq(c.from, from, "from");
        assertEq(c.fromBalance, fromBalance, "from balance is pre-change");
        assertEq(c.to, to, "to");
        assertEq(c.toBalance, toBalance, "to balance is pre-change");
        assertEq(c.amount, amount, "amount");
        assertEq(c.tokenTotalSupplyAtCall, supplyAtCall, "supply is pre-change");
    }

    function test_burnFeeInventory_onlyCollector_onlyItsOwnBalance() public {
        _buy(alice, 5e18);
        address[5] memory callers = [alice, launcher, treasury, hook, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(LaunchTokenCore.NotFeeCollector.selector);
            fungible.burnFeeInventory(1);
        }
        _feeEvent(30e18, 0);
        uint256 supply = fungible.totalSupply();
        collector.processFees();
        assertEq(fungible.totalSupply(), supply - 30e18, "real supply reduction");
        assertEq(fungible.balanceOf(alice), 5e18, "nobody else is burned");
        vm.prank(address(collector));
        vm.expectRevert(SquareHoleFungibleToken.InsufficientBalance.selector);
        fungible.burnFeeInventory(1);
    }

    /// Spec 05 worked example on the fungible template.
    function test_workedExample_spec05() public {
        _buy(alice, 25e18);
        _buy(bob, 75e18);
        _feeEvent(30e18, 3 * Q);
        collector.processFees();
        assertEq(fungible.totalSupply(), 1e27 - 30e18);
        assertEq(quote.balanceOf(treasury), Q);
        assertEq(ledger.claimable(alice), Q / 2);
        assertEq(ledger.claimable(bob), 3 * Q / 2);
        vm.prank(alice);
        fungible.transfer(carol, 25e18); // alice sells; keeps her 0.5 Q, carol inherits nothing
        assertEq(ledger.claimable(alice), Q / 2);
        assertEq(ledger.claimable(carol), 0);
        assertEq(_claim(alice), Q / 2);
    }
}
