// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DN404} from "dn404/DN404.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {SquareHoleToken} from "../src/SquareHoleToken.sol";
import {RewardLedger} from "../src/RewardLedger.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {LaunchTokenCore} from "../src/base/LaunchTokenCore.sol";
import {Fixture} from "./utils/Fixture.sol";
import {SquareHoleTokenHarness, RecordingLedger, StubCollector, WrongMirrorLedger} from "./utils/Harness.sol";

contract SquareHoleTokenTest is Fixture {
    function setUp() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1e6, 1_000);
    }

    /*//////////////////////////////////////////////////////////////
                              LAUNCH TERMS
    //////////////////////////////////////////////////////////////*/

    function test_constructor_fixesLaunchTerms() public view {
        assertEq(token.name(), "Orchard Misfits (test)");
        assertEq(token.symbol(), "MISFIT");
        assertEq(token.decimals(), 18, "F08: standard 18 decimals");
        assertEq(token.fractionsPerNft(), 1e6);
        assertEq(token.unit(), 1e27 / 1_000, "F10: one NFT = 1e27 / N raw = 1,000,000 tokens");
        assertEq(UNIT, token.unit());
        assertEq(token.collectionSize(), 1_000);
        assertEq(token.wholeSupply(), 1e9, "F10: always 1e9 whole tokens");
        assertEq(token.FIXED_WHOLE_SUPPLY(), 1e9);
        assertEq(token.FIXED_SUPPLY(), 1e27);
        assertEq(token.MAX_COLLECTION_SIZE(), 1e9);
        assertEq(token.initialSupply(), 1_000 * UNIT);
        assertEq(token.totalSupply(), 1_000 * UNIT);
        assertEq(token.balanceOf(launcher), 1_000 * UNIT);
        assertEq(token.initialHolder(), launcher);
        assertEq(token.feeCollector(), address(collector));
        assertEq(token.rewardLedger(), address(ledger));
        assertEq(token.baseURI(), BASE_URI);
        assertEq(token.metadataManifestHash(), MANIFEST);
        assertEq(mirror.baseERC20(), address(token));
        assertEq(ledger.mirror(), address(mirror));
        assertTrue(token.getSkipNFT(launcher), "initial holder skips NFTs");
        assertEq(mirror.totalSupply(), 0);
        assertEq(mirror.owner(), address(0), "no owner anywhere");
    }

    function test_constructor_emitsLaunched() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        address predictedMirror = vm.computeCreateAddress(predictedToken, 1);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        vm.expectEmit(true, true, false, true, predictedToken);
        // r = 0 derives the recorded value: N = 1 → one NFT of 1e9 tokens.
        emit SquareHoleToken.Launched(
            predictedMirror, launcher, 1e9, 1, predictedCollector, address(l), BASE_URI, MANIFEST
        );
        new SquareHoleToken(_terms(0, 1, predictedCollector, address(l)));
    }

    /// F10: every collection has exactly 1e9 tokens; the creator picks N (a divisor of 1e27 raw), one NFT is 1e27 / N
    /// raw. Presets, both extremes and the non-1e9 divisors (N = 1,024 / 8,192: 976,562.5 / 122,070.3125 tokens).
    function test_collectionSizes_fixedSupplyExactUnit() public {
        uint256[12] memory sizes = [uint256(1), 2, 100, 500, 1_000, 1_024, 2_500, 5_000, 8_192, 10_000, 1_000_000, 1e9];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 n = sizes[i];
            _deploy(IRewardLedger.PayoutAsset.Q, 0, n);
            assertEq(token.decimals(), 18);
            assertEq(token.initialSupply(), 1e27, "always 1e9 tokens");
            assertEq(token.totalSupply(), 1e27);
            assertEq(token.wholeSupply(), 1e9);
            assertEq(token.collectionSize(), n);
            assertEq(token.unit(), 1e27 / n);
            assertEq(token.unit() * n, 1e27, "every NFT is an exact unit");
            assertEq(token.fractionsPerNft(), 1e9 % n == 0 ? 1e9 / n : 0);
            if (n == 1) continue; // one NFT is the whole supply
            // A whole-unit buy materializes exactly one NFT, whatever the unit.
            _buy(alice, token.unit());
            assertEq(mirror.balanceOf(alice), 1);
            _buy(alice, token.unit() - 1);
            assertEq(mirror.balanceOf(alice), 1, "a fraction short of the second unit");
        }
    }

    /// The optional r cross-check accepts exactly 1e9 / N (and 0), nothing else.
    function test_constructor_fractionsPerNftCrossCheck() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 100_000, 10_000);
        assertEq(token.fractionsPerNft(), 100_000);
        assertEq(token.unit(), 1e23);
        _expectConstructorRevert(
            _terms(1, 10_000, address(0xC0), address(0xC1)),
            abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(1))
        );
        _expectConstructorRevert(
            _terms(1e6, 10_000, address(0xC0), address(0xC1)),
            abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(1e6))
        );
        // N = 1,024 does not divide 1e9: only r = 0 is accepted (976,562.5 tokens per NFT).
        _expectConstructorRevert(
            _terms(976_562, 1_024, address(0xC0), address(0xC1)),
            abi.encodeWithSelector(SquareHoleToken.InvalidFractionsPerNft.selector, uint256(976_562))
        );
    }

    /// Fuzz over N (valid and invalid): the constructor accepts N iff 1 ≤ N ≤ 1e9 and 1e27 % N == 0, and then always
    /// mints exactly 1e27 with an exact unit.
    function testFuzz_constructor_collectionSizeRule(uint256 n) public {
        n = n % 4 == 0 ? bound(n, 0, 20_000) : (n % 4 == 1 ? bound(n, 0, 2e9) : n);
        bool valid = n != 0 && n <= 1e9 && 1e27 % n == 0;
        if (!valid) {
            _expectConstructorRevert(
                _terms(0, n, address(0xC0), address(0xC1)),
                abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, n)
            );
            return;
        }
        _deploy(IRewardLedger.PayoutAsset.Q, 0, n);
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.unit() * n, 1e27);
    }

    /// Fuzz over valid N (every 2^a × 5^b ≤ 1e9, a, b ≤ 27): supply, unit and the recorded r.
    function testFuzz_constructor_everyDivisorOf1e27(uint8 a, uint8 b) public {
        a = uint8(bound(a, 0, 27));
        b = uint8(bound(b, 0, 27));
        uint256 n = 2 ** uint256(a) * 5 ** uint256(b);
        vm.assume(n <= 1e9);
        _deploy(IRewardLedger.PayoutAsset.Q, 0, n);
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.unit() * n, 1e27);
        assertEq(token.fractionsPerNft(), 1e9 % n == 0 ? 1e9 / n : 0);
        assertLe(n, 0xfffffffe, "inside DN404's NFT-id cap");
    }

    /// Non-divisors of 1e27 (any prime factor other than 2 and 5, e.g. 3, 7, 3,333, 9,999) never launch.
    function test_constructor_rejectsNonDivisorsOutOfRangeAndZero() public {
        uint256[9] memory bad = [uint256(0), 3, 7, 3_333, 6_000, 9_999, 1e9 + 1, 2 ** 28, 1e10];
        for (uint256 i; i < bad.length; ++i) {
            _expectConstructorRevert(
                _terms(0, bad[i], address(0xC0), address(0xC1)),
                abi.encodeWithSelector(SquareHoleToken.InvalidCollectionSize.selector, bad[i])
            );
        }
    }

    function test_constructor_acceptsBothEnds() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1, 1e9); // 1e9 NFTs of one token each
        assertEq(token.totalSupply(), 1e27);
        assertLt(token.totalSupply(), 2 ** 96);
        assertLe(token.collectionSize(), 0xfffffffe, "inside DN404's NFT-id cap");
        _deploy(IRewardLedger.PayoutAsset.Q, 1e9, 1); // one NFT of 1e9 tokens
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.unit(), 1e27);
    }

    function test_constructor_rejectsZeroAddresses() public {
        SquareHoleToken.LaunchTerms memory t = _terms(1e8, 10, address(0xC0), address(0xC1));
        t.initialHolder = address(0);
        _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.ZeroAddress.selector));
        t = _terms(1e8, 10, address(0), address(0xC1));
        _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.ZeroAddress.selector));
        t = _terms(1e8, 10, address(0xC0), address(0));
        _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.ZeroAddress.selector));
    }

    function test_constructor_rejectsInitialHolderAsCollectorOrLedger() public {
        SquareHoleToken.LaunchTerms memory t = _terms(1e8, 10, address(0xC0), address(0xC1));
        t.initialHolder = address(0xC0);
        _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.InvalidInitialHolder.selector));
        t.initialHolder = address(0xC1);
        _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.InvalidInitialHolder.selector));
    }

    /// Spec 05: unsold launch inventory is not an ordinary reward owner. Review PoC: a ledger without a launcher role
    /// and an EOA initial holder made the whole supply eligible from block 0.
    function test_constructor_rejectsInitialHolderThatIsNotExcluded() public {
        address creator = makeAddr("creator");
        address[2] memory launcherRoles = [address(0), launcher];
        for (uint256 i; i < launcherRoles.length; ++i) {
            uint256 nonce = vm.getNonce(address(this));
            address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
            address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
            RewardLedger l = new RewardLedger(
                _config(
                    predictedToken,
                    address(quote),
                    predictedCollector,
                    IRewardLedger.PayoutAsset.Q,
                    launcherRoles[i],
                    true
                )
            );
            new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
            SquareHoleToken.LaunchTerms memory t = _terms(1e8, 10, predictedCollector, address(l));
            t.initialHolder = creator;
            _expectConstructorRevert(t, abi.encodeWithSelector(LaunchTokenCore.InvalidInitialHolder.selector));
        }
    }

    function test_constructor_rejectsWiringMismatch() public {
        // The existing ledger/collector are bound to the already-deployed token, not to a new one.
        _expectConstructorRevert(
            _terms(1e8, 10, address(collector), address(ledger)),
            abi.encodeWithSelector(LaunchTokenCore.WiringMismatch.selector)
        );
    }

    function test_constructor_rejectsWrongMirrorPrediction() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        WrongMirrorLedger l = new WrongMirrorLedger(predictedToken, predictedCollector);
        StubCollector c = new StubCollector(predictedToken, address(l));
        vm.expectRevert(LaunchTokenCore.WiringMismatch.selector);
        new SquareHoleToken(_terms(1e8, 10, address(c), address(l)));
    }

    function test_tokenUriNft_directCallForIdZero() public view {
        // DN404's fallback serves `tokenURINFT(uint256)` without an existence check (the mirror checks first).
        (bool ok, bytes memory ret) = address(token).staticcall(abi.encodeWithSelector(0xcb30b460, uint256(0)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (string)), string.concat(BASE_URI, "0.json"));
    }

    function _expectConstructorRevert(SquareHoleToken.LaunchTerms memory t, bytes memory err) internal {
        vm.expectRevert(err);
        new SquareHoleToken(t);
    }

    /*//////////////////////////////////////////////////////////////
                       TRANSFERS: NO FEE, NFT SYNC
    //////////////////////////////////////////////////////////////*/

    function testFuzz_transfer_hasNoFee(uint256 amount) public {
        amount = bound(amount, 0, token.balanceOf(launcher));
        uint256 supply = token.totalSupply();
        _buy(alice, amount);
        assertEq(token.balanceOf(alice), amount, "recipient gets exactly amount");
        assertEq(token.balanceOf(launcher), supply - amount);
        assertEq(token.totalSupply(), supply, "no burn on transfer");
        assertEq(mirror.balanceOf(alice), amount / UNIT, "EOA materializes whole units");
    }

    function test_fractionalTransfer_crossesThresholds() public {
        _buy(alice, UNIT - 1);
        assertEq(mirror.balanceOf(alice), 0);
        _buy(alice, 1);
        assertEq(mirror.balanceOf(alice), 1, "crossing 1.0 mints one NFT");
        vm.prank(alice);
        token.transfer(bob, 1);
        assertEq(mirror.balanceOf(alice), 0, "dropping below 1.0 burns it");
        assertEq(mirror.balanceOf(bob), 0);
        assertEq(token.totalSupply(), 1_000 * UNIT, "NFT burns are not T burns (ECO-11)");
        assertEq(token.balanceOf(alice), UNIT - 1, "partial fractions down to 1e-18 of a token");
    }

    function test_wholeNftTransfer_movesExactlyOneUnit() public {
        _buy(alice, 3 * UNIT + 5);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        mirror.transferFrom(alice, bob, id);
        assertEq(mirror.ownerOf(id), bob);
        assertEq(token.balanceOf(alice), 2 * UNIT + 5);
        assertEq(token.balanceOf(bob), UNIT);
        assertEq(mirror.balanceOf(alice), 2);
        assertEq(mirror.balanceOf(bob), 1);
    }

    function test_senderWithExactlyOneUnit_canMoveItsNft() public {
        _buy(alice, UNIT);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        mirror.transferFrom(alice, bob, id);
        assertEq(token.balanceOf(alice), 0);
        assertEq(mirror.ownerOf(id), bob);
    }

    function test_insufficientBalance_keepsDn404Error() public {
        _buy(alice, UNIT);
        uint256 eligibleBefore = ledger.eligibleSupply();
        vm.prank(alice);
        vm.expectRevert(DN404.InsufficientBalance.selector);
        token.transfer(bob, UNIT + 1);
        assertEq(ledger.eligibleSupply(), eligibleBefore);
    }

    function test_mirrorTransfer_byNonOwnerKeepsDn404Error() public {
        _buy(alice, UNIT);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.prank(bob);
        vm.expectRevert(DN404.TransferCallerNotOwnerNorApproved.selector);
        mirror.transferFrom(alice, bob, id);
        vm.prank(bob);
        vm.expectRevert(DN404.TransferFromIncorrectOwner.selector);
        mirror.transferFrom(bob, carol, id);
    }

    function test_approvals_bothRepresentations() public {
        _buy(alice, 2 * UNIT);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        // ERC-20 allowance does not grant NFT rights and vice versa (Guardian L-10: they are separate).
        vm.prank(alice);
        token.approve(bob, UNIT);
        vm.prank(bob);
        vm.expectRevert(DN404.TransferCallerNotOwnerNorApproved.selector);
        mirror.transferFrom(alice, bob, id);
        vm.prank(bob);
        token.transferFrom(alice, bob, UNIT);
        assertEq(token.allowance(alice, bob), 0);
        uint256 id2 = token.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        mirror.approve(carol, id2);
        vm.prank(carol);
        mirror.transferFrom(alice, carol, id2);
        assertEq(mirror.ownerOf(id2), carol);
        vm.prank(carol);
        vm.expectRevert(DN404.InsufficientAllowance.selector);
        token.transferFrom(bob, carol, 1);
    }

    /*//////////////////////////////////////////////////////////////
                    PERMIT2 / SKIP-NFT / 7702 POLICY
    //////////////////////////////////////////////////////////////*/

    function test_permit2_hasNoDefaultAllowance() public {
        _buy(alice, UNIT);
        assertEq(token.allowance(alice, PERMIT2), 0);
        vm.prank(PERMIT2);
        vm.expectRevert(DN404.InsufficientAllowance.selector);
        token.transferFrom(alice, PERMIT2, 1);
        vm.prank(alice);
        token.approve(PERMIT2, 5);
        assertEq(token.allowance(alice, PERMIT2), 5, "an explicit approval still works");
    }

    function test_skipNftDefaults() public {
        address plainEoa = makeAddr("plainEoa");
        address contractAccount = makeAddr("contractAccount");
        address delegated = makeAddr("delegated7702");
        address sameLength = makeAddr("sameLength");
        address shorter = makeAddr("shorter");
        _etchContract(contractAccount);
        _etch7702(delegated, address(0xBEEF));
        // (revm refuses to etch other 0xef01-prefixed code; since EIP-3541 no contract can start with 0xef.)
        vm.etch(sameLength, abi.encodePacked(hex"fe0100", address(0xBEEF))); // 23 bytes, not a designator
        vm.etch(shorter, abi.encodePacked(hex"fe0100", bytes19(0))); // 22 bytes
        assertFalse(token.getSkipNFT(plainEoa));
        assertTrue(token.getSkipNFT(contractAccount));
        assertFalse(token.getSkipNFT(delegated), "7702 EOAs receive NFTs");
        assertTrue(token.getSkipNFT(sameLength));
        assertTrue(token.getSkipNFT(shorter));
        assertTrue(token.getSkipNFT(address(collector)));
        assertTrue(token.getSkipNFT(address(ledger)));
    }

    function testFuzz_7702DesignatorReceivesNfts(address delegate, uint8 units) public {
        units = uint8(bound(units, 1, 20));
        address wallet = makeAddr("wallet7702");
        _etch7702(wallet, delegate);
        _buy(wallet, uint256(units) * UNIT);
        assertEq(mirror.balanceOf(wallet), units);
    }

    function test_7702Wallet_canOptOut() public {
        address wallet = makeAddr("wallet7702");
        _etch7702(wallet, address(0xBEEF));
        vm.prank(wallet);
        token.setSkipNFT(true);
        _buy(wallet, 3 * UNIT);
        assertEq(mirror.balanceOf(wallet), 0);
        assertEq(token.balanceOf(wallet), 3 * UNIT);
    }

    /// @dev Real EIP-7702 delegation under Prague rules (forge cheatcodes), not only an etched designator.
    function test_7702_realDelegationUnderPrague() public {
        vm.setEvmVersion("prague");
        (address wallet, uint256 key) = makeAddrAndKey("real7702");
        vm.signAndAttachDelegation(address(ledger), key);
        _buy(wallet, 2 * UNIT);
        assertEq(wallet.code.length, 23, "delegation designator installed");
        assertEq(bytes3(wallet.code), bytes3(hex"ef0100"));
        assertFalse(token.getSkipNFT(wallet));
        assertEq(mirror.balanceOf(wallet), 2);
    }

    function test_contractRecipient_skipsNftsUntilOptIn() public {
        address vault = makeAddr("vault");
        _etchContract(vault);
        _buy(vault, 5 * UNIT);
        assertEq(mirror.balanceOf(vault), 0);
        vm.prank(vault);
        token.setSkipNFT(false);
        _buy(vault, 1);
        assertEq(mirror.balanceOf(vault), 5);
    }

    /*//////////////////////////////////////////////////////////////
                         FEE INVENTORY BURN
    //////////////////////////////////////////////////////////////*/

    function test_burnFeeInventory_onlyCollector() public {
        address[6] memory callers = [alice, launcher, treasury, address(ledger), hook, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(LaunchTokenCore.NotFeeCollector.selector);
            token.burnFeeInventory(1);
        }
    }

    function test_burnFeeInventory_burnsOnlyCollectorBalance() public {
        _buy(alice, 5 * UNIT);
        _feeEvent(30 * UNIT, 0);
        uint256 supply = token.totalSupply();
        uint256 nfts = mirror.totalSupply();
        uint256 aliceBefore = token.balanceOf(alice);
        collector.processFees();
        assertEq(token.totalSupply(), supply - 30 * UNIT, "real supply reduction");
        assertEq(token.balanceOf(address(collector)), 0);
        assertEq(token.balanceOf(alice), aliceBefore, "nobody else is burned");
        assertEq(mirror.totalSupply(), nfts, "the collector never held NFTs");
        assertEq(mirror.balanceOf(address(collector)), 0);
    }

    function test_burnFeeInventory_cannotExceedOwnBalance() public {
        _buy(alice, 5 * UNIT);
        vm.prank(address(collector));
        vm.expectRevert(DN404.InsufficientBalance.selector);
        token.burnFeeInventory(1);
    }

    function test_noExternalMint() public {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, UNIT));
        assertFalse(ok);
        assertEq(bytes4(ret), DN404.FnSelectorNotRecognized.selector);
        assertEq(token.totalSupply(), 1_000 * UNIT);
    }

    function test_shrinkingIdSpace_keepsMintingDistinctIds() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1e8, 10);
        _buy(alice, UNIT);
        _feeEvent(3 * UNIT, 0);
        collector.processFees();
        assertEq(token.totalSupply(), 7 * UNIT);
        address[6] memory holders = [bob, carol, dave, makeAddr("h4"), makeAddr("h5"), makeAddr("h6")];
        for (uint256 i; i < holders.length; ++i) {
            _buy(holders[i], UNIT);
        }
        assertEq(mirror.totalSupply(), 7);
        uint256 seen;
        for (uint256 i; i < holders.length; ++i) {
            uint256 id = token.ownedIds(holders[i], 0, 1)[0];
            assertGe(id, 1);
            assertLe(id, 10);
            assertEq(seen & (1 << id), 0, "ids are distinct");
            seen |= 1 << id;
        }
    }

    /*//////////////////////////////////////////////////////////////
                     ETH, METADATA, VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_rejectsEth() public {
        _buy(alice, UNIT);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(SquareHoleToken.ValueNotAccepted.selector);
        mirror.transferFrom{value: 1}(alice, bob, id);
        vm.prank(alice);
        (bool ok,) = address(token).call{value: 1}("");
        assertFalse(ok, "receive rejects ETH");
        vm.prank(alice);
        (ok,) = address(token).call{value: 1}(abi.encodeWithSignature("unknown()"));
        assertFalse(ok);
        assertEq(address(token).balance, 0);
    }

    /// ADR-0011 F10 addendum: tokenURI(id) = baseURI + decimal(id) + ".json" (static hosting of <id>.json files).
    function test_tokenUri() public {
        _buy(alice, 2 * UNIT);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        assertEq(mirror.tokenURI(id), string.concat(BASE_URI, vm.toString(id), ".json"));
        uint256 id2 = token.ownedIds(alice, 1, 2)[0];
        assertEq(mirror.tokenURI(id2), string.concat(BASE_URI, vm.toString(id2), ".json"));
        vm.expectRevert(DN404.TokenDoesNotExist.selector);
        mirror.tokenURI(999);
        assertEq(token.ownedIds(alice, 0, 10).length, 2);
        assertEq(token.totalNFTSupply(), 2);
    }

    function test_tokenUri_emptyBase() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        SquareHoleToken.LaunchTerms memory t = _terms(1e8, 10, predictedCollector, address(l));
        t.baseURI = "";
        SquareHoleToken tok = new SquareHoleToken(t);
        uint256 oneNft = tok.unit();
        vm.prank(launcher);
        tok.transfer(alice, oneNft);
        DN404Mirror m = DN404Mirror(payable(tok.mirrorERC721()));
        assertEq(m.tokenURI(1), "");
    }

    /*//////////////////////////////////////////////////////////////
               CHECKPOINTS ON ALL SIX BALANCE-WRITE PATHS
    //////////////////////////////////////////////////////////////*/

    function test_checkpoints_allSixPathsWithPreChangeBalances() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedLedger = vm.computeCreateAddress(address(this), nonce);
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RecordingLedger rec = new RecordingLedger(predictedToken, predictedCollector);
        assertEq(address(rec), predictedLedger);
        StubCollector stub = new StubCollector(predictedToken, address(rec));
        SquareHoleTokenHarness h = new SquareHoleTokenHarness(_terms(1e6, 1_000, address(stub), address(rec)));
        DN404Mirror m = DN404Mirror(payable(h.mirrorERC721()));

        // 1. initial supply in _initializeDN404
        _assertCall(rec, 0, address(0), 0, launcher, 0, 1_000 * UNIT, 0);
        // 2. _transfer (ERC-20 transfer)
        vm.prank(launcher);
        h.transfer(alice, 3 * UNIT);
        _assertCall(rec, 1, launcher, 1_000 * UNIT, alice, 0, 3 * UNIT, 1_000 * UNIT);
        // 2b. _transfer via transferFrom
        vm.prank(alice);
        h.approve(bob, UNIT / 2);
        vm.prank(bob);
        h.transferFrom(alice, carol, UNIT / 2);
        _assertCall(rec, 2, alice, 3 * UNIT, carol, 0, UNIT / 2, 1_000 * UNIT);
        // 3. _transferFromNFT (mirror transferFrom)
        uint256 id = h.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        m.transferFrom(alice, bob, id);
        _assertCall(rec, 3, alice, 5 * UNIT / 2, bob, 0, UNIT, 1_000 * UNIT);
        // 4. _mint
        h.exposedMint(dave, 2 * UNIT);
        _assertCall(rec, 4, address(0), 0, dave, 0, 2 * UNIT, 1_000 * UNIT);
        // 5. _mintNext
        h.exposedMintNext(dave, UNIT);
        _assertCall(rec, 5, address(0), 0, dave, 2 * UNIT, UNIT, 1_002 * UNIT);
        // 6. _burn (collector fee inventory burn and the raw internal path)
        vm.prank(launcher);
        h.transfer(address(stub), 4 * UNIT);
        stub.burn(4 * UNIT);
        _assertCall(rec, 7, address(stub), 4 * UNIT, address(0), 0, 4 * UNIT, 1_003 * UNIT);
        h.exposedBurn(dave, UNIT);
        _assertCall(rec, 8, dave, 3 * UNIT, address(0), 0, UNIT, 999 * UNIT);
        assertEq(rec.callCount(), 9);
        assertEq(h.totalSupply(), 998 * UNIT);
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
}
