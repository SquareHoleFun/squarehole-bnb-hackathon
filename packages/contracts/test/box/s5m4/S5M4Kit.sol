// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxData} from "../../../src/box/libraries/BoxData.sol";
import {CoreBox0Kit} from "../conformance/core/CoreBox0Kit.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @title S5M4Kit
/// @notice TEST ONLY (slice S5.M4). Box 0 created by factory v1 (`CoreBox0Kit`), and beside it on the **same version**
/// (the implementations `CoreV1Deployment` deployed for the factory: coordinator, hook and its extension, launch router,
/// receiver and its extension, collection, vault, tickets, royalty router) a **Standard box** built the way a later
/// factory will, because factory v1 creates box 0 only: this kit plays the factory (the coordinator implementation names
/// the factory, so `deploy` and `launch` are sent as the factory's address), CREATE2s the coordinator clone, mines the
/// hook salt over the hook's final init code and lets the coordinator CREATE every other contract at its nonce, the
/// box's price sampler and its `BoxSwapModule` clone included (two implementations version 1 does not deploy). Every
/// Standard-box contract is the real code: BoxToken, BoxVault, BoxCollection and BoxTickets (S3), the sampler (S4), the
/// receiver halves (S5.M1, M3), the module (S5.M2, M3), the hook and its extension (S4, S5.M5), the coordinator (S6).
/// Its FIT share pays box 0's FIT executor, as every box's will.
///
/// **Nonce plan of the Standard box** (P, the planner's with the sampler and the module): table 1, T 2, vault 3,
/// collection 4, receiver 5, launch router 6, sampler 7, tickets 8, module 9, royalty router 10 (with royalties).
/// Texts, the metadata table, the reveal root and the placeholders' texts are box 0's fixture's (`prepare` first).
contract S5M4Kit is CoreBox0Kit {
    uint8 internal constant S_TABLE = 1;
    uint8 internal constant S_TOKEN = 2;
    uint8 internal constant S_VAULT = 3;
    uint8 internal constant S_COLLECTION = 4;
    uint8 internal constant S_RECEIVER = 5;
    uint8 internal constant S_ROUTER = 6;
    uint8 internal constant S_SAMPLER = 7;
    uint8 internal constant S_TICKETS = 8;
    uint8 internal constant S_MODULE = 9;
    uint8 internal constant S_ROYALTY = 10;
    uint8 internal constant REVEAL_ON_EXIT = 1;

    /// @notice How to build one Standard box.
    struct StdParams {
        uint8 qStream;
        uint8 tStream;
        /// The creator payee (the spec's creatorFeeRecipient); zero for a box without creator payouts.
        address payee;
        /// Add-on 5: Q raw units per 30-day epoch (0: none) and the excess destination.
        uint128 creatorCap;
        uint8 capExcess;
        uint32 n;
        bool royalties;
    }

    /// @notice What one Standard box is made of.
    struct StdBox {
        address coordinator;
        address table;
        address token;
        address vault;
        address collection;
        address receiver;
        address launchRouter;
        address sampler;
        address tickets;
        address module;
        address royaltyRouter;
        address hook;
        bytes32 hookSalt;
        uint256 raise;
        PoolKey key;
    }

    BoxPriceSampler public samplerImpl;
    BoxSwapModule public moduleImpl;
    StdBox[] internal _std;
    /// @notice The last Standard box's creation (coordinator CREATE2, `deploy`, `launch`) in this kit's frame.
    uint256 public stdCreationGas;

    // ------------------------------------------------------------------------------------------------ building

    /// @notice The two implementations a Standard box needs beyond version 1's (sampler, module).
    function deployStandardImpls() public {
        if (address(samplerImpl) != address(0)) return;
        samplerImpl = new BoxPriceSampler(pm);
        moduleImpl = new BoxSwapModule(pm);
    }

    /// @notice One Standard box, created and launched (the bootstrap buy run and burned); returns its index.
    function buildStandard(StdParams memory p) external returns (uint256 index) {
        deployStandardImpls();
        index = _std.length;
        StdBox memory x = _plan(p, index);
        bytes[] memory codes = _codes(p, x);
        bytes memory hookInit = _hookInit(x);
        bytes memory coordInit = BoxClones.initCode(_impls.coordinator, _coordArgs(p, x, index));
        bytes32 salt = keccak256(abi.encode("s5m4.standard", index));
        require(vm.computeCreate2Address(salt, keccak256(coordInit), address(this)) == x.coordinator, "kit: coord");
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        vm.deal(address(factory), address(factory).balance + BoxSpecV1.BOOTSTRAP_ETH);
        uint256 g0 = gasleft();
        address c;
        assembly ("memory-safe") {
            c := create2(0, add(coordInit, 0x20), mload(coordInit), salt)
        }
        require(c == x.coordinator, "kit: the coordinator's CREATE2");
        vm.prank(address(factory));
        address h = BoxCoordinator(c).deploy(codes, hookInit, x.hookSalt, index + 1);
        vm.prank(address(factory));
        BoxCoordinator(c).launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        stdCreationGas = g0 - gasleft();
        require(h == x.hook, "kit: the hook's address");
        _std.push(x);
    }

    /// @notice What `buildStandard` would create, before it does: the addresses, the codes and the hook salt (for the
    /// creation-cost tests, which send the steps themselves).
    function planStandard(StdParams memory p)
        external
        returns (StdBox memory x, bytes memory coordInit, bytes32 salt, bytes[] memory codes, bytes memory hookInit)
    {
        deployStandardImpls();
        uint256 index = _std.length;
        x = _plan(p, index);
        codes = _codes(p, x);
        hookInit = _hookInit(x);
        coordInit = BoxClones.initCode(_impls.coordinator, _coordArgs(p, x, index));
        salt = keccak256(abi.encode("s5m4.standard", index));
    }

    /// @notice Records a Standard box a test created itself from `planStandard`'s output.
    function adopt(StdBox memory x) external {
        _std.push(x);
    }

    function _plan(StdParams memory p, uint256 index) internal view returns (StdBox memory x) {
        BoxSpecV1.BoxSpec memory s = spec();
        x.raise = s.raise;
        bytes32 salt = keccak256(abi.encode("s5m4.standard", index));
        x.coordinator = vm.computeCreate2Address(
            salt, keccak256(BoxClones.initCode(_impls.coordinator, _coordArgs(p, x, index))), address(this)
        );
        address c = x.coordinator;
        x.table = vm.computeCreateAddress(c, S_TABLE);
        x.token = vm.computeCreateAddress(c, S_TOKEN);
        x.vault = vm.computeCreateAddress(c, S_VAULT);
        x.collection = vm.computeCreateAddress(c, S_COLLECTION);
        x.receiver = vm.computeCreateAddress(c, S_RECEIVER);
        x.launchRouter = vm.computeCreateAddress(c, S_ROUTER);
        x.sampler = vm.computeCreateAddress(c, S_SAMPLER);
        x.tickets = vm.computeCreateAddress(c, S_TICKETS);
        x.module = vm.computeCreateAddress(c, S_MODULE);
        if (p.royalties) x.royaltyRouter = vm.computeCreateAddress(c, S_ROYALTY);
        bytes memory hookInit = _hookInit(x);
        x.hookSalt = _mineHookSalt(c, keccak256(hookInit));
        x.hook = BoxClones.predict(c, x.hookSalt, keccak256(hookInit));
        x.key = PoolKey(Currency.wrap(address(0)), Currency.wrap(x.token), BoxSpecV1.LP_FEE, 60, IHooks(x.hook));
    }

    /// @dev BoxCoordinator's 154 argument bytes for a Standard box: native ETH, the raise, no creator buy, this kit as
    /// the creator, a spec hash per index (no registry record in version 1), FIT's executor (box 0's, an outside
    /// address), the pinned source, the nonce plan (no per-item stream, the executor not created here).
    function _coordArgs(StdParams memory p, StdBox memory x, uint256 index) internal view returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            uint8(BoxKind.Standard),
            address(0),
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128(x.raise),
            uint128(0),
            address(this),
            keccak256(abi.encode("s5m4.standard.spec", index)),
            _a.executor,
            address(source)
        );
        return abi.encodePacked(
            head,
            S_TOKEN,
            S_VAULT,
            S_COLLECTION,
            S_RECEIVER,
            S_ROUTER,
            S_TICKETS,
            p.royalties ? S_ROYALTY : uint8(0),
            uint8(0),
            uint8(0)
        );
    }

    function _hookInit(StdBox memory x) internal view returns (bytes memory) {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(x.raise, false);
        bytes memory head = abi.encodePacked(
            address(0), x.token, c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, x.launchRouter, uint8(BoxKind.Standard)
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory mid = abi.encodePacked(c.tickLower, c.tickUpper, spec().openAt, c.liquidity, uint128(x.raise));
        return BoxClones.initCode(
            _impls.hook, bytes.concat(head, mid, abi.encodePacked(x.coordinator, x.receiver, x.sampler))
        );
    }

    function _codes(StdParams memory p, StdBox memory x) internal view returns (bytes[] memory codes) {
        BoxSpecV1.BoxSpec memory s = spec();
        codes = new bytes[](p.royalties ? S_ROYALTY : S_MODULE);
        codes[S_TABLE - 1] = BoxData.creationCode(s.metadataTable);
        codes[S_TOKEN - 1] =
            bytes.concat(type(BoxToken).creationCode, abi.encode("Kit Standard", "KSTD", x.coordinator, x.vault));
        codes[S_VAULT - 1] = BoxClones.initCode(
            _impls.vault,
            BoxCloneArgs.vault(
                BoxCloneArgs.VaultArgs({
                    coordinator: x.coordinator,
                    token: x.token,
                    collection: x.collection,
                    ticketAdapter: x.tickets,
                    observer: address(0),
                    collectionSize: p.n,
                    // forge-lint: disable-next-line(unsafe-typecast)
                    drawFeeBps: uint16(BoxSpecV1.DRAW_FEE_BPS),
                    // forge-lint: disable-next-line(unsafe-typecast)
                    pickFeeBps: uint16(BoxSpecV1.PICK_FEE_BPS),
                    // forge-lint: disable-next-line(unsafe-typecast)
                    returnFeeBps: uint16(BoxSpecV1.RETURN_FEE_BPS),
                    firstId: s.firstId
                })
            )
        );
        codes[S_COLLECTION - 1] = BoxClones.initCode(_impls.collection, _collectionArgs(s, p, x));
        codes[S_RECEIVER - 1] = BoxClones.initCode(_impls.receiver, _receiverArgs(p, x));
        // BoxLaunchRouter's 106 argument bytes: a Standard box, native ETH, T, the hook, the coordinator, P1, openAt.
        codes[S_ROUTER - 1] = BoxClones.initCode(
            _impls.launchRouter,
            abi.encodePacked(
                uint8(BoxKind.Standard),
                address(0),
                x.token,
                x.hook,
                x.coordinator,
                BoxLayoutV1.curve(x.raise, false).sqrtPriceLowerX96,
                s.openAt
            )
        );
        // BoxPriceSampler's 60 argument bytes: the hook, Q, T.
        codes[S_SAMPLER - 1] = BoxClones.initCode(address(samplerImpl), abi.encodePacked(x.hook, address(0), x.token));
        codes[S_TICKETS - 1] = BoxClones.initCode(_impls.tickets, _ticketsArgs(s, p, x));
        // BoxSwapModule's 102 argument bytes: receiver · hook · price average · Q · T · Q action · T action.
        codes[S_MODULE - 1] = BoxClones.initCode(
            address(moduleImpl),
            abi.encodePacked(x.receiver, x.hook, x.sampler, address(0), x.token, p.qStream, p.tStream)
        );
        if (p.royalties) {
            codes[S_ROYALTY - 1] = BoxClones.initCodeReceiving(
                _impls.royaltyRouter,
                BoxCloneArgs.router(
                    BoxCloneArgs.RouterArgs({
                        coordinator: x.coordinator,
                        receiver: x.receiver,
                        weth: address(weth),
                        destination: BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING
                    })
                )
            );
        }
    }

    /// @dev BoxReceiver's 201 argument bytes for a Standard box: FIT's executor (box 0's), no Safe, no stream, the
    /// streams, fee handling, the payee, the module, add-on 5's cap and excess.
    function _receiverArgs(StdParams memory p, StdBox memory x) internal view returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            uint8(BoxKind.Standard), address(0), x.token, x.coordinator, x.hook, _a.executor, address(0), address(0)
        );
        return abi.encodePacked(
            head,
            p.qStream,
            p.tStream,
            BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING,
            p.payee,
            x.module,
            p.creatorCap,
            p.capExcess
        );
    }

    function _collectionArgs(BoxSpecV1.BoxSpec memory s, StdParams memory p, StdBox memory x)
        internal
        view
        returns (bytes memory)
    {
        string[5] memory t = _placeholderTexts(s);
        return BoxCloneArgs.collection(
            BoxCloneArgs.CollectionArgs({
                coordinator: x.coordinator,
                vault: x.vault,
                token: x.token,
                receiver: x.receiver,
                revealUnlocker: address(0),
                transferObserver: address(0),
                royaltyRouter: x.royaltyRouter,
                marketplaceOwner: address(this),
                metadataTable: x.table,
                collectionSize: p.n,
                revealTriggers: REVEAL_ON_EXIT,
                royaltyBps: p.royalties ? 500 : 0,
                royaltyDestination: BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING,
                firstId: s.firstId,
                revealRoot: s.revealRoot,
                metadataTableHash: keccak256(s.metadataTable),
                generatorHash: s.generatorHash,
                collectionCoverSha256: s.collectionCoverSha256,
                bannerSha256: bytes32(0),
                name: "Kit Standard",
                symbol: "KSTDC",
                description: s.description,
                hiddenDescription: t[3],
                hiddenSvg: t[4],
                externalLink: ""
            })
        );
    }

    function _ticketsArgs(BoxSpecV1.BoxSpec memory s, StdParams memory p, StdBox memory x)
        internal
        view
        returns (bytes memory)
    {
        string[5] memory t = _placeholderTexts(s);
        return BoxCloneArgs.tickets(
            BoxCloneArgs.TicketsArgs({
                coordinator: x.coordinator,
                vault: x.vault,
                collection: x.collection,
                token: x.token,
                source: address(source),
                openAt: s.openAt,
                collectionSize: p.n,
                firstId: s.firstId,
                name: t[0],
                symbol: t[1],
                description: t[2]
            })
        );
    }

    function _placeholderTexts(BoxSpecV1.BoxSpec memory s) internal pure returns (string[5] memory t) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_PLACEHOLDERS) continue;
            (t[0], t[1], t[2], t[3], t[4]) = abi.decode(s.addOns[i].params, (string, string, string, string, string));
        }
    }

    // ------------------------------------------------------------------------------------------------ reads

    function std(uint256 i) external view returns (StdBox memory) {
        return _std[i];
    }

    function stdCount() external view returns (uint256) {
        return _std.length;
    }

    // ------------------------------------------------------------------------------------------------ life

    /// @notice A Standard box from its launch to graduation: the window skipped, two buys and a sell on the curve, one
    /// batch collected, the curve closed at exactly P1 and `graduate()` by the keeper; then the keeper's first sampler
    /// poke (P1) and an hour of samples, so the price average is ready (swap-module § 4.6).
    function stdToGraduated(uint256 i) external {
        StdBox memory x = _std[i];
        OpenTime.to(BoxHook(x.hook).windowEndsAt());
        uint256 bought = _swapOn(x.key, x.token, alice, true, 0.6 ether, 0);
        _swapOn(x.key, x.token, bob, true, 0.4 ether, 0);
        _swapOn(x.key, x.token, alice, false, bought / 3, 0);
        _roll(12);
        BoxReceiver(payable(x.receiver)).collect(keeper);
        _roll(12);
        _swapOn(x.key, x.token, carol, true, 3 * x.raise, BoxLayoutV1.curve(x.raise, false).sqrtPriceLowerX96);
        require(BoxHook(x.hook).closed(), "kit: std closed");
        vm.prank(keeper);
        BoxCoordinator(x.coordinator).graduate();
        _roll(1);
        IBoxPriceAverage(x.sampler).poke();
        stdHold(i, 301);
    }

    /// @notice The sampler poked every block for `blocks` blocks (12 s each).
    function stdHold(uint256 i, uint256 blocks) public {
        address s = _std[i].sampler;
        for (uint256 k; k < blocks; ++k) {
            _roll(1);
            IBoxPriceAverage(s).poke();
        }
    }

    /// @notice Box 0's FIT executor poked every block for `blocks` blocks (its own average, box 0's price).
    function box0Hold(uint256 blocks) external {
        for (uint256 k; k < blocks; ++k) {
            _roll(1);
            IBoxPriceAverage(_a.executor).poke();
        }
    }

    /// @notice A swap on any pool of this world as `who` (exact input; `limit` 0: the extreme price): buys pay ETH,
    /// sells pay `token`. Returns what `who` received.
    function swapOn(PoolKey memory key, address token, address who, bool buy, uint256 amountIn, uint160 limit)
        external
        returns (uint256 out)
    {
        return _swapOn(key, token, who, buy, amountIn, limit);
    }

    function _swapOn(PoolKey memory key, address token, address who, bool buy, uint256 amountIn, uint160 limit)
        internal
        returns (uint256 out)
    {
        if (buy) {
            vm.deal(who, who.balance + amountIn);
            uint256 t0 = BoxToken(token).balanceOf(who);
            vm.prank(who);
            // forge-lint: disable-next-line(unsafe-typecast)
            swapper.swap{value: amountIn}(key, true, -int256(amountIn), limit);
            return BoxToken(token).balanceOf(who) - t0;
        }
        uint256 e0 = who.balance;
        vm.startPrank(who);
        BoxToken(token).approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(key, false, -int256(amountIn), limit);
        vm.stopPrank();
        return who.balance - e0;
    }

    /// @notice Rolls `blocks` blocks (12 s each).
    function roll(uint256 blocks) external {
        _roll(blocks);
    }
}
