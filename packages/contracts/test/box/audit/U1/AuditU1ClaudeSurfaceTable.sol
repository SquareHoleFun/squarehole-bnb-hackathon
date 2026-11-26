// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AuditU1ClaudeSurfaceTable
/// @notice TEST ONLY (SH-AUDIT-B0 U1, P1.4 and P1.6; BC-010). The documented caller table of every box 0 contract,
/// implementation, extension, the factory, planner and registry, and both randomness sources: every external function
/// of each compiled ABI (`out/<Name>.sol/<Name>.json` `methodIdentifiers` at the start commit), with the caller class
/// its interface NatSpec gives it:
/// - VIEW: view or pure (never writes);
/// - ANYONE: permissionless, or gated only by the caller's own tokens, items, credit or approvals (ERC-20/721 rules,
///   the reward's credited holder), never by a fixed address;
/// - CREATOR: `IBoxFactoryV1.createBox` "the only address that may call createBox" (`box0Creator`);
/// - FACTORY: `IBoxRegistry.record` "the factory only"; `BoxCoordinator.deploy`/`launch` "the factory, once";
/// - COORDINATOR: every `initialize` ("the box's coordinator only"), the hook's `launch`/`migrate`, the router's
///   `bootstrap`/`creatorBuy`, the vault's `openGate`/`waiveHandBackFee`;
/// - RECEIVER: the hook's `harvest`, the stream's `onStreamFunds`; COLLECTION: the stream's `onItemTransfer`; VAULT:
///   the stream's `onVaultAction`; TICKETS: the vault's `openTickets`, `releaseTickets`, `deliverTicket`;
/// - EXECUTOR_OR_HOOK: the receiver's `noteModuleFees` for box 0 ("FIT's executor ... or the box's hook");
/// - POOL_MANAGER: every `unlockCallback` (inside the contract's own unlock), the hook's `afterSwap`, the receiver's
///   `receive`;
/// - NOBODY: a role box 0 does not have (the swap module, the creator payee, the reveal unlocker; `fundCreator` with a
///   FeeHandling destination) and every entry point of the two extensions called directly (`NotDelegated`).
/// The table is checked against the ABIs by `testProperty_AUDIT_U1_selectorsAreTheDocumentedTable`.
library AuditU1ClaudeSurfaceTable {
    uint8 internal constant VIEW = 0;
    uint8 internal constant ANYONE = 1;
    uint8 internal constant CREATOR = 2;
    uint8 internal constant FACTORY = 3;
    uint8 internal constant COORDINATOR = 4;
    uint8 internal constant HOOK = 5;
    uint8 internal constant RECEIVER = 6;
    uint8 internal constant POOL_MANAGER = 7;
    uint8 internal constant EXECUTOR_OR_HOOK = 8;
    uint8 internal constant TICKETS = 9;
    uint8 internal constant COLLECTION = 10;
    uint8 internal constant VAULT = 11;
    uint8 internal constant NOBODY = 12;

    /// @notice The contract kinds (one artifact each), in this order.
    function names() internal pure returns (string[18] memory n) {
        n = [
            "BoxFactoryV1",
            "BoxFactoryV1Planner",
            "BoxRegistry",
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxItemStream",
            "BoxRoyaltyRouter",
            "BoxToken",
            "FitBuybackExecutor",
            "DrandSource",
            "BoxBackedSource"
        ];
    }

    uint8 internal constant K_FACTORY = 0;
    uint8 internal constant K_PLANNER = 1;
    uint8 internal constant K_REGISTRY = 2;
    uint8 internal constant K_COORDINATOR = 3;
    uint8 internal constant K_HOOK = 4;
    uint8 internal constant K_HOOK_EXT = 5;
    uint8 internal constant K_ROUTER = 6;
    uint8 internal constant K_RECEIVER = 7;
    uint8 internal constant K_RECEIVER_EXT = 8;
    uint8 internal constant K_COLLECTION = 9;
    uint8 internal constant K_VAULT = 10;
    uint8 internal constant K_TICKETS = 11;
    uint8 internal constant K_STREAM = 12;
    uint8 internal constant K_ROYALTY = 13;
    uint8 internal constant K_TOKEN = 14;
    uint8 internal constant K_EXECUTOR = 15;
    uint8 internal constant K_DRAND = 16;
    uint8 internal constant K_BACKED = 17;
    /// @notice The metadata table's data contract (0x00 ++ table): no ABI, every call stops at once.
    uint8 internal constant K_TABLE = 18;

    /// @notice The class of a call with empty calldata (`receive`), per kind.
    function receiveClass(uint8 kind) internal pure returns (uint8) {
        if (kind == K_RECEIVER) return POOL_MANAGER;
        if (kind == K_ROYALTY || kind == K_EXECUTOR) return ANYONE;
        return NOBODY;
    }

    function table(uint8 kind) internal pure returns (string[] memory s, uint8[] memory c) {
        if (kind == K_FACTORY) return _tableBoxFactoryV1();
        if (kind == K_PLANNER) return _tableBoxFactoryV1Planner();
        if (kind == K_REGISTRY) return _tableBoxRegistry();
        if (kind == K_COORDINATOR) return _tableBoxCoordinator();
        if (kind == K_HOOK) return _tableBoxHook();
        if (kind == K_HOOK_EXT) return _tableBoxHookExtension();
        if (kind == K_ROUTER) return _tableBoxLaunchRouter();
        if (kind == K_RECEIVER) return _tableBoxReceiver();
        if (kind == K_RECEIVER_EXT) return _tableBoxReceiverExtension();
        if (kind == K_COLLECTION) return _tableBoxCollection();
        if (kind == K_VAULT) return _tableBoxVault();
        if (kind == K_TICKETS) return _tableBoxTickets();
        if (kind == K_STREAM) return _tableBoxItemStream();
        if (kind == K_ROYALTY) return _tableBoxRoyaltyRouter();
        if (kind == K_TOKEN) return _tableBoxToken();
        if (kind == K_EXECUTOR) return _tableFitBuybackExecutor();
        if (kind == K_DRAND) return _tableDrandSource();
        if (kind == K_BACKED) return _tableBoxBackedSource();
    }

    // Generated from the compiled ABIs at the start commit and classified by hand from the interface NatSpec.
    /// @dev BoxFactoryV1: 43 functions
    function _tableBoxFactoryV1() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](43);
        c = new uint8[](43);
        (s[0], c[0]) = ("FACTORY_NONCE_BOX0()", VIEW);
        (s[1], c[1]) = ("FACTORY_NONCE_REGISTRY()", VIEW);
        (s[2], c[2]) = ("IMPL_COLLECTION()", VIEW);
        (s[3], c[3]) = ("IMPL_COORDINATOR()", VIEW);
        (s[4], c[4]) = ("IMPL_HOOK()", VIEW);
        (s[5], c[5]) = ("IMPL_ITEM_STREAM()", VIEW);
        (s[6], c[6]) = ("IMPL_LAUNCH_ROUTER()", VIEW);
        (s[7], c[7]) = ("IMPL_RECEIVER()", VIEW);
        (s[8], c[8]) = ("IMPL_TICKETS()", VIEW);
        (s[9], c[9]) = ("IMPL_VAULT()", VIEW);
        (s[10], c[10]) = ("MW_COLLECTION()", VIEW);
        (s[11], c[11]) = ("MW_COORDINATOR()", VIEW);
        (s[12], c[12]) = ("MW_ETH()", VIEW);
        (s[13], c[13]) = ("MW_EXECUTOR()", VIEW);
        (s[14], c[14]) = ("MW_HOOK()", VIEW);
        (s[15], c[15]) = ("MW_POOL()", VIEW);
        (s[16], c[16]) = ("MW_RECEIVER()", VIEW);
        (s[17], c[17]) = ("MW_ROUTER()", VIEW);
        (s[18], c[18]) = ("MW_ROYALTY()", VIEW);
        (s[19], c[19]) = ("MW_STREAM()", VIEW);
        (s[20], c[20]) = ("MW_SUPPLY()", VIEW);
        (s[21], c[21]) = ("MW_TICKETS()", VIEW);
        (s[22], c[22]) = ("MW_VAULT()", VIEW);
        (s[23], c[23]) = ("VERSION()", VIEW);
        (s[24], c[24]) = ("box0Addresses()", VIEW);
        (s[25], c[25]) = ("box0Creator()", VIEW);
        (s[26], c[26]) =
        (
            "createBox((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),bytes32,bytes)",
            CREATOR
        );
        (s[27], c[27]) = ("executorInitCodeHash()", VIEW);
        (s[28], c[28]) = ("hookExtension()", VIEW);
        (s[29], c[29]) = ("hookInitCodeHash(uint32)", VIEW);
        (s[30], c[30]) = ("implementations()", VIEW);
        (s[31], c[31]) = ("planner()", VIEW);
        (s[32], c[32]) = ("platformSafe()", VIEW);
        (s[33], c[33]) = ("poolManager()", VIEW);
        (s[34], c[34]) = ("predictHook(uint32,bytes32)", VIEW);
        (s[35], c[35]) = ("randomness()", VIEW);
        (s[36], c[36]) = ("receiverExtension()", VIEW);
        (s[37], c[37]) =
        (
            "refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),address)",
            VIEW
        );
        (s[38], c[38]) = ("registry()", VIEW);
        (s[39], c[39]) =
        (
            "templateIdOf((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]))",
            VIEW
        );
        (s[40], c[40]) = ("version()", VIEW);
        (s[41], c[41]) = ("versionCodeHash()", VIEW);
        (s[42], c[42]) = ("weth()", VIEW);
    }

    /// @dev BoxFactoryV1Planner: 17 functions
    function _tableBoxFactoryV1Planner() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](17);
        c = new uint8[](17);
        (s[0], c[0]) = ("NONCE_COLLECTION()", VIEW);
        (s[1], c[1]) = ("NONCE_EXECUTOR()", VIEW);
        (s[2], c[2]) = ("NONCE_RECEIVER()", VIEW);
        (s[3], c[3]) = ("NONCE_ROUTER()", VIEW);
        (s[4], c[4]) = ("NONCE_ROYALTY()", VIEW);
        (s[5], c[5]) = ("NONCE_STREAM()", VIEW);
        (s[6], c[6]) = ("NONCE_TABLE()", VIEW);
        (s[7], c[7]) = ("NONCE_TICKETS()", VIEW);
        (s[8], c[8]) = ("NONCE_TOKEN()", VIEW);
        (s[9], c[9]) = ("NONCE_VAULT()", VIEW);
        (s[10], c[10]) = ("REVEAL_ON_EXIT()", VIEW);
        (s[11], c[11]) = ("TEMPLATE_ID_TAG()", VIEW);
        (s[12], c[12]) = ("addresses(address,bool)", VIEW);
        (s[13], c[13]) =
        (
            "hookInitCode((address,address,address,address,address,address,address,address,address,address,address,address,address,bytes32,bytes32,address,int24,int24,uint160,uint160,uint128,uint256),(address,address,address,address,address,address,address,address,address,address,address),uint32)",
            VIEW
        );
        (s[14], c[14]) =
        (
            "plan((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),(address,address,address,address,address,address,address,address,address,address,address,address,address,bytes32,bytes32,address,int24,int24,uint160,uint160,uint128,uint256),address,bytes32,bytes32)",
            VIEW
        );
        (s[15], c[15]) =
        (
            "refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),address)",
            VIEW
        );
        (s[16], c[16]) =
        (
            "templateIdOf((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),bytes32,bytes32)",
            VIEW
        );
    }

    /// @dev BoxRegistry: 21 functions
    function _tableBoxRegistry() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](21);
        c = new uint8[](21);
        (s[0], c[0]) = ("ROLE_COLLECTION()", VIEW);
        (s[1], c[1]) = ("ROLE_COORDINATOR()", VIEW);
        (s[2], c[2]) = ("ROLE_COUNT()", VIEW);
        (s[3], c[3]) = ("ROLE_EXECUTOR()", VIEW);
        (s[4], c[4]) = ("ROLE_HOOK()", VIEW);
        (s[5], c[5]) = ("ROLE_ITEM_STREAM()", VIEW);
        (s[6], c[6]) = ("ROLE_LAUNCH_ROUTER()", VIEW);
        (s[7], c[7]) = ("ROLE_METADATA_TABLE()", VIEW);
        (s[8], c[8]) = ("ROLE_RECEIVER()", VIEW);
        (s[9], c[9]) = ("ROLE_ROYALTY_ROUTER()", VIEW);
        (s[10], c[10]) = ("ROLE_SWAP_MODULE()", VIEW);
        (s[11], c[11]) = ("ROLE_TICKETS()", VIEW);
        (s[12], c[12]) = ("ROLE_TOKEN()", VIEW);
        (s[13], c[13]) = ("ROLE_VAULT()", VIEW);
        (s[14], c[14]) = ("boxCount()", VIEW);
        (s[15], c[15]) = ("boxIdOf(address)", VIEW);
        (s[16], c[16]) = ("coordinatorOf(uint256)", VIEW);
        (s[17], c[17]) = ("entry(uint256)", VIEW);
        (s[18], c[18]) = ("factory()", VIEW);
        (s[19], c[19]) = ("record(address,bytes32,bytes)", FACTORY);
        (s[20], c[20]) = ("recordOf(uint256)", VIEW);
    }

    /// @dev BoxCoordinator: 47 functions
    function _tableBoxCoordinator() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](47);
        c = new uint8[](47);
        (s[0], c[0]) = ("ARGS_LENGTH()", VIEW);
        (s[1], c[1]) = ("POKE_GAS()", VIEW);
        (s[2], c[2]) = ("ROLE_COLLECTION()", VIEW);
        (s[3], c[3]) = ("ROLE_EXECUTOR()", VIEW);
        (s[4], c[4]) = ("ROLE_ITEM_STREAM()", VIEW);
        (s[5], c[5]) = ("ROLE_LAUNCH_ROUTER()", VIEW);
        (s[6], c[6]) = ("ROLE_RECEIVER()", VIEW);
        (s[7], c[7]) = ("ROLE_ROYALTY_ROUTER()", VIEW);
        (s[8], c[8]) = ("ROLE_TICKETS()", VIEW);
        (s[9], c[9]) = ("ROLE_TOKEN()", VIEW);
        (s[10], c[10]) = ("ROLE_VAULT()", VIEW);
        (s[11], c[11]) = ("boxId()", VIEW);
        (s[12], c[12]) = ("claimReward(address)", ANYONE);
        (s[13], c[13]) = ("collection()", VIEW);
        (s[14], c[14]) = ("creator()", VIEW);
        (s[15], c[15]) = ("creatorBuyAmount()", VIEW);
        (s[16], c[16]) = ("deploy(bytes[],bytes,bytes32,uint256)", FACTORY);
        (s[17], c[17]) = ("executor()", VIEW);
        (s[18], c[18]) = ("factory()", VIEW);
        (s[19], c[19]) = ("graduate()", ANYONE);
        (s[20], c[20]) = ("graduated()", VIEW);
        (s[21], c[21]) = ("graduatedAt()", VIEW);
        (s[22], c[22]) = ("graduatedAtBlock()", VIEW);
        (s[23], c[23]) = ("hook()", VIEW);
        (s[24], c[24]) = ("itemStream()", VIEW);
        (s[25], c[25]) = ("kind()", VIEW);
        (s[26], c[26]) = ("launch()", FACTORY);
        (s[27], c[27]) = ("launchRouter()", VIEW);
        (s[28], c[28]) = ("nonceOf(uint8)", VIEW);
        (s[29], c[29]) = ("phase()", VIEW);
        (s[30], c[30]) = ("poolManager()", VIEW);
        (s[31], c[31]) = ("poolShare()", VIEW);
        (s[32], c[32]) = ("q()", VIEW);
        (s[33], c[33]) = ("raise()", VIEW);
        (s[34], c[34]) = ("randomness()", VIEW);
        (s[35], c[35]) = ("receiver()", VIEW);
        (s[36], c[36]) = ("reserve()", VIEW);
        (s[37], c[37]) = ("rewardCap()", VIEW);
        (s[38], c[38]) = ("rewardOf(address)", VIEW);
        (s[39], c[39]) = ("royaltyRouter()", VIEW);
        (s[40], c[40]) = ("specHash()", VIEW);
        (s[41], c[41]) = ("streamStartBalance()", VIEW);
        (s[42], c[42]) = ("streamStartClaims()", VIEW);
        (s[43], c[43]) = ("tickets()", VIEW);
        (s[44], c[44]) = ("token()", VIEW);
        (s[45], c[45]) = ("unlockCallback(bytes)", POOL_MANAGER);
        (s[46], c[46]) = ("vault()", VIEW);
    }

    /// @dev BoxHook: 55 functions
    function _tableBoxHook() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](55);
        c = new uint8[](55);
        (s[0], c[0]) = ("ADD_CAP_PERCENT()", VIEW);
        (s[1], c[1]) = ("ARGS_LENGTH()", VIEW);
        (s[2], c[2]) = ("DEEPEN_COOLDOWN_BLOCKS()", VIEW);
        (s[3], c[3]) = ("DEEPEN_TIP_BPS()", VIEW);
        (s[4], c[4]) = ("LP_FEE()", VIEW);
        (s[5], c[5]) = ("MAX_DEVIATION_TICKS()", VIEW);
        (s[6], c[6]) = ("REQUIRED_FLAGS()", VIEW);
        (s[7], c[7]) = ("TICK_SPACING()", VIEW);
        (s[8], c[8]) = ("WINDOW_SECONDS()", VIEW);
        (s[9], c[9]) =
        (
            "afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
            VIEW
        );
        (s[10], c[10]) = ("afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)", VIEW);
        (s[11], c[11]) = ("afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)", VIEW);
        (s[12], c[12]) =
        (
            "afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
            VIEW
        );
        (s[13], c[13]) =
        ("afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)", POOL_MANAGER);
        (s[14], c[14]) =
        ("beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)", VIEW);
        (s[15], c[15]) = ("beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)", VIEW);
        (s[16], c[16]) = ("beforeInitialize(address,(address,address,uint24,int24,address),uint160)", VIEW);
        (s[17], c[17]) =
        (
            "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
            VIEW
        );
        (s[18], c[18]) =
        ("beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)", VIEW);
        (s[19], c[19]) = ("closed()", VIEW);
        (s[20], c[20]) = ("closedAtBlock()", VIEW);
        (s[21], c[21]) = ("coordinator()", VIEW);
        (s[22], c[22]) = ("coordinatorImplementation()", VIEW);
        (s[23], c[23]) = ("curve()", VIEW);
        (s[24], c[24]) = ("deepen(address)", ANYONE);
        (s[25], c[25]) = ("deepenTipCap()", VIEW);
        (s[26], c[26]) = ("deployBlock()", VIEW);
        (s[27], c[27]) = ("depthBudget()", VIEW);
        (s[28], c[28]) = ("extension()", VIEW);
        (s[29], c[29]) = ("getHookPermissions()", VIEW);
        (s[30], c[30]) = ("graduatedLayout()", VIEW);
        (s[31], c[31]) = ("harvest()", RECEIVER);
        (s[32], c[32]) = ("initialize()", COORDINATOR);
        (s[33], c[33]) = ("kind()", VIEW);
        (s[34], c[34]) = ("lastDeepenBlock()", VIEW);
        (s[35], c[35]) = ("launch()", COORDINATOR);
        (s[36], c[36]) = ("launchRouter()", VIEW);
        (s[37], c[37]) = ("migrate(uint256)", COORDINATOR);
        (s[38], c[38]) = ("migratedAtBlock()", VIEW);
        (s[39], c[39]) = ("minAdd()", VIEW);
        (s[40], c[40]) = ("openAt()", VIEW);
        (s[41], c[41]) = ("pairedLiquidity()", VIEW);
        (s[42], c[42]) = ("phase()", VIEW);
        (s[43], c[43]) = ("poolId()", VIEW);
        (s[44], c[44]) = ("poolKey()", VIEW);
        (s[45], c[45]) = ("poolManager()", VIEW);
        (s[46], c[46]) = ("priceAverage()", VIEW);
        (s[47], c[47]) = ("q()", VIEW);
        (s[48], c[48]) = ("raise()", VIEW);
        (s[49], c[49]) = ("receiver()", VIEW);
        (s[50], c[50]) = ("reserveCap()", VIEW);
        (s[51], c[51]) = ("reserveMinted()", VIEW);
        (s[52], c[52]) = ("token()", VIEW);
        (s[53], c[53]) = ("unlockCallback(bytes)", POOL_MANAGER);
        (s[54], c[54]) = ("windowEndsAt()", VIEW);
    }

    /// @dev BoxHookExtension: 4 functions
    function _tableBoxHookExtension() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](4);
        c = new uint8[](4);
        (s[0], c[0]) = ("deepen(address)", NOBODY);
        (s[1], c[1]) = ("launch()", NOBODY);
        (s[2], c[2]) = ("migrate(uint256)", NOBODY);
        (s[3], c[3]) = ("unlockCallback(bytes)", NOBODY);
    }

    /// @dev BoxLaunchRouter: 27 functions
    function _tableBoxLaunchRouter() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](27);
        c = new uint8[](27);
        (s[0], c[0]) = ("ARGS_LENGTH()", VIEW);
        (s[1], c[1]) = ("PIPS()", VIEW);
        (s[2], c[2]) = ("TAX_STEP_SECONDS()", VIEW);
        (s[3], c[3]) = ("WINDOW_SECONDS()", VIEW);
        (s[4], c[4]) = ("WINDOW_STEPS()", VIEW);
        (s[5], c[5]) = ("bootstrap()", COORDINATOR);
        (s[6], c[6]) = ("bootstrapped()", VIEW);
        (s[7], c[7]) = ("buy(uint256,uint256,address,uint256)", ANYONE);
        (s[8], c[8]) = ("coordinator()", VIEW);
        (s[9], c[9]) = ("coordinatorImplementation()", VIEW);
        (s[10], c[10]) = ("creatorBought()", VIEW);
        (s[11], c[11]) = ("creatorBuy(address,uint256)", COORDINATOR);
        (s[12], c[12]) = ("hook()", VIEW);
        (s[13], c[13]) = ("initialize()", COORDINATOR);
        (s[14], c[14]) = ("kind()", VIEW);
        (s[15], c[15]) = ("openAt()", VIEW);
        (s[16], c[16]) = ("poolManager()", VIEW);
        (s[17], c[17]) = ("q()", VIEW);
        (s[18], c[18]) = ("quote(uint256)", VIEW);
        (s[19], c[19]) = ("sweep()", ANYONE);
        (s[20], c[20]) = ("taxFor(uint256,uint256)", VIEW);
        (s[21], c[21]) = ("taxPips(uint256)", VIEW);
        (s[22], c[22]) = ("taxTable()", VIEW);
        (s[23], c[23]) = ("token()", VIEW);
        (s[24], c[24]) = ("totalSwept()", VIEW);
        (s[25], c[25]) = ("totalTaxCollected()", VIEW);
        (s[26], c[26]) = ("unlockCallback(bytes)", POOL_MANAGER);
    }

    /// @dev BoxReceiver: 59 functions, receive (POOL_MANAGER)
    function _tableBoxReceiver() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](59);
        c = new uint8[](59);
        (s[0], c[0]) = ("ARGS_LENGTH()", VIEW);
        (s[1], c[1]) = ("FEE_SHARE_DENOMINATOR()", VIEW);
        (s[2], c[2]) = ("PLATFORM_CAP_WEI()", VIEW);
        (s[3], c[3]) = ("PLATFORM_EPOCH_SECONDS()", VIEW);
        (s[4], c[4]) = ("STREAM_NOTIFY_GAS()", VIEW);
        (s[5], c[5]) = ("TIP_BPS()", VIEW);
        (s[6], c[6]) = ("acceptCreatorPayee()", NOBODY);
        (s[7], c[7]) = ("batchMin()", VIEW);
        (s[8], c[8]) = ("booked()", VIEW);
        (s[9], c[9]) = ("carried()", VIEW);
        (s[10], c[10]) = ("claimCreator(address)", NOBODY);
        (s[11], c[11]) = ("collect(address)", ANYONE);
        (s[12], c[12]) = ("coordinator()", VIEW);
        (s[13], c[13]) = ("coordinatorImplementation()", VIEW);
        (s[14], c[14]) = ("creatorCap()", VIEW);
        (s[15], c[15]) = ("creatorHeld()", VIEW);
        (s[16], c[16]) = ("creatorOwed()", VIEW);
        (s[17], c[17]) = ("creatorPayee()", VIEW);
        (s[18], c[18]) = ("depthHeld()", VIEW);
        (s[19], c[19]) = ("executor()", VIEW);
        (s[20], c[20]) = ("extension()", VIEW);
        (s[21], c[21]) = ("fitOwed()", VIEW);
        (s[22], c[22]) = ("fitWaitingT()", VIEW);
        (s[23], c[23]) = ("fundCreator()", NOBODY);
        (s[24], c[24]) = ("fundDepth()", ANYONE);
        (s[25], c[25]) = ("fundFees()", ANYONE);
        (s[26], c[26]) = ("graduationSettled()", VIEW);
        (s[27], c[27]) = ("hook()", VIEW);
        (s[28], c[28]) = ("hookFeesPending()", VIEW);
        (s[29], c[29]) = ("initialize()", COORDINATOR);
        (s[30], c[30]) = ("itemStream()", VIEW);
        (s[31], c[31]) = ("kind()", VIEW);
        (s[32], c[32]) = ("moduleFeeAllowance()", VIEW);
        (s[33], c[33]) = ("moduleFeesPending()", VIEW);
        (s[34], c[34]) = ("moduleOwed()", VIEW);
        (s[35], c[35]) = ("moduleProceeds(uint8,uint256)", NOBODY);
        (s[36], c[36]) = ("noteModuleFees(uint256,uint256)", EXECUTOR_OR_HOOK);
        (s[37], c[37]) = ("onGraduation()", ANYONE);
        (s[38], c[38]) = ("payFit()", ANYONE);
        (s[39], c[39]) = ("payPlatform()", ANYONE);
        (s[40], c[40]) = ("pendingCreatorPayee()", VIEW);
        (s[41], c[41]) = ("platformEpoch()", VIEW);
        (s[42], c[42]) = ("platformHeld()", VIEW);
        (s[43], c[43]) = ("platformOwed()", VIEW);
        (s[44], c[44]) = ("platformSafe()", VIEW);
        (s[45], c[45]) = ("poolManager()", VIEW);
        (s[46], c[46]) = ("proposeCreatorPayee(address)", NOBODY);
        (s[47], c[47]) = ("pullForModule()", NOBODY);
        (s[48], c[48]) = ("q()", VIEW);
        (s[49], c[49]) = ("qStream()", VIEW);
        (s[50], c[50]) = ("royaltyDestination()", VIEW);
        (s[51], c[51]) = ("streamCurveDepthT()", VIEW);
        (s[52], c[52]) = ("swapModule()", VIEW);
        (s[53], c[53]) = ("tBurnPending()", VIEW);
        (s[54], c[54]) = ("tStream()", VIEW);
        (s[55], c[55]) = ("tipMax()", VIEW);
        (s[56], c[56]) = ("token()", VIEW);
        (s[57], c[57]) = ("totals()", VIEW);
        (s[58], c[58]) = ("unlockCallback(bytes)", POOL_MANAGER);
    }

    /// @dev BoxReceiverExtension: 5 functions
    function _tableBoxReceiverExtension() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](5);
        c = new uint8[](5);
        (s[0], c[0]) = ("acceptCreatorPayee()", NOBODY);
        (s[1], c[1]) = ("coordinatorImplementation()", VIEW);
        (s[2], c[2]) = ("initialize()", NOBODY);
        (s[3], c[3]) = ("noteModuleFees(uint256,uint256)", NOBODY);
        (s[4], c[4]) = ("proposeCreatorPayee(address)", NOBODY);
    }

    /// @dev BoxCollection: 59 functions
    function _tableBoxCollection() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](59);
        c = new uint8[](59);
        (s[0], c[0]) = ("OBSERVER_GAS()", VIEW);
        (s[1], c[1]) = ("REVEAL_ALWAYS()", VIEW);
        (s[2], c[2]) = ("REVEAL_ON_EXIT()", VIEW);
        (s[3], c[3]) = ("REVEAL_ON_UNLOCK()", VIEW);
        (s[4], c[4]) = ("approve(address,uint256)", ANYONE);
        (s[5], c[5]) = ("balanceOf(address)", VIEW);
        (s[6], c[6]) = ("bannerSha256()", VIEW);
        (s[7], c[7]) = ("collectionCoverSha256()", VIEW);
        (s[8], c[8]) = ("collectionSize()", VIEW);
        (s[9], c[9]) = ("contractURI()", VIEW);
        (s[10], c[10]) = ("coordinator()", VIEW);
        (s[11], c[11]) = ("coordinatorImplementation()", VIEW);
        (s[12], c[12]) = ("description()", VIEW);
        (s[13], c[13]) = ("externalLink()", VIEW);
        (s[14], c[14]) = ("firstId()", VIEW);
        (s[15], c[15]) = ("generatorHash()", VIEW);
        (s[16], c[16]) = ("getApproved(uint256)", VIEW);
        (s[17], c[17]) = ("hiddenDescription()", VIEW);
        (s[18], c[18]) = ("hiddenSvg()", VIEW);
        (s[19], c[19]) = ("imageCid(uint256)", VIEW);
        (s[20], c[20]) = ("initialize()", COORDINATOR);
        (s[21], c[21]) = ("isApprovedForAll(address,address)", VIEW);
        (s[22], c[22]) = ("isRevealable(uint256)", VIEW);
        (s[23], c[23]) = ("isRevealed(uint256)", VIEW);
        (s[24], c[24]) = ("leafOf(uint256,uint128,bytes32,bytes32,bytes32,bytes32)", VIEW);
        (s[25], c[25]) = ("metadataTable()", VIEW);
        (s[26], c[26]) = ("metadataTableBytes()", VIEW);
        (s[27], c[27]) = ("metadataTableHash()", VIEW);
        (s[28], c[28]) = ("modelCid(uint256)", VIEW);
        (s[29], c[29]) = ("name()", VIEW);
        (s[30], c[30]) = ("observerGas()", VIEW);
        (s[31], c[31]) = ("owner()", VIEW);
        (s[32], c[32]) = ("ownerOf(uint256)", VIEW);
        (s[33], c[33]) = ("receiver()", VIEW);
        (s[34], c[34]) = ("reveal(uint256,uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])", ANYONE);
        (s[35], c[35]) = ("revealRoot()", VIEW);
        (s[36], c[36]) = ("revealState(uint256)", VIEW);
        (s[37], c[37]) = ("revealTriggers()", VIEW);
        (s[38], c[38]) = ("revealUnlocker()", VIEW);
        (s[39], c[39]) = ("revealedCount()", VIEW);
        (s[40], c[40]) = ("royaltyBps()", VIEW);
        (s[41], c[41]) = ("royaltyDestination()", VIEW);
        (s[42], c[42]) = ("royaltyInfo(uint256,uint256)", VIEW);
        (s[43], c[43]) = ("royaltyRouter()", VIEW);
        (s[44], c[44]) = ("safeTransferFrom(address,address,uint256)", ANYONE);
        (s[45], c[45]) = ("safeTransferFrom(address,address,uint256,bytes)", ANYONE);
        (s[46], c[46]) = ("setApprovalForAll(address,bool)", ANYONE);
        (s[47], c[47]) = ("supportsInterface(bytes4)", VIEW);
        (s[48], c[48]) = ("symbol()", VIEW);
        (s[49], c[49]) = ("token()", VIEW);
        (s[50], c[50]) = ("tokenJSON(uint256)", VIEW);
        (s[51], c[51]) = ("tokenURI(uint256)", VIEW);
        (s[52], c[52]) = ("totalSupply()", VIEW);
        (s[53], c[53]) = ("traitsOf(uint256)", VIEW);
        (s[54], c[54]) = ("transferFrom(address,address,uint256)", ANYONE);
        (s[55], c[55]) = ("transferObserver()", VIEW);
        (s[56], c[56]) = ("treeDepth()", VIEW);
        (s[57], c[57]) = ("unlockReveal(uint256)", NOBODY);
        (s[58], c[58]) = ("vault()", VIEW);
    }

    /// @dev BoxVault: 47 functions
    function _tableBoxVault() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](47);
        c = new uint8[](47);
        (s[0], c[0]) = ("FEE_DENOMINATOR()", VIEW);
        (s[1], c[1]) = ("OBSERVER_GAS()", VIEW);
        (s[2], c[2]) = ("activeSupply()", VIEW);
        (s[3], c[3]) = ("collection()", VIEW);
        (s[4], c[4]) = ("collectionSize()", VIEW);
        (s[5], c[5]) = ("coordinator()", VIEW);
        (s[6], c[6]) = ("coordinatorImplementation()", VIEW);
        (s[7], c[7]) = ("deliverTicket(uint256,address)", TICKETS);
        (s[8], c[8]) = ("drawFeeBps()", VIEW);
        (s[9], c[9]) = ("escrowPrincipal()", VIEW);
        (s[10], c[10]) = ("escrowSurplus()", VIEW);
        (s[11], c[11]) = ("firstId()", VIEW);
        (s[12], c[12]) = ("gateOpen()", VIEW);
        (s[13], c[13]) = ("gateOpenedAt()", VIEW);
        (s[14], c[14]) = ("handBackFeeWaived()", VIEW);
        (s[15], c[15]) = ("hasLeftVault(uint256)", VIEW);
        (s[16], c[16]) = ("hiddenCount()", VIEW);
        (s[17], c[17]) = ("initialize()", COORDINATOR);
        (s[18], c[18]) = ("inside()", VIEW);
        (s[19], c[19]) = ("isHidden(uint256)", VIEW);
        (s[20], c[20]) = ("isInside(uint256)", VIEW);
        (s[21], c[21]) = ("isOnShelf(uint256)", VIEW);
        (s[22], c[22]) = ("isOutside(uint256)", VIEW);
        (s[23], c[23]) = ("observer()", VIEW);
        (s[24], c[24]) = ("observerGas()", VIEW);
        (s[25], c[25]) = ("onERC721Received(address,address,uint256,bytes)", VIEW);
        (s[26], c[26]) = ("openGate()", COORDINATOR);
        (s[27], c[27]) = ("openTickets(uint256,uint256)", TICKETS);
        (s[28], c[28]) = ("outside()", VIEW);
        (s[29], c[29]) = ("pendingTickets()", VIEW);
        (s[30], c[30]) = ("pickFeeBps()", VIEW);
        (s[31], c[31]) = ("quoteHandBack(uint256)", VIEW);
        (s[32], c[32]) = ("quoteReturn(uint256)", VIEW);
        (s[33], c[33]) = ("quoteTake(uint256)", VIEW);
        (s[34], c[34]) = ("quoteWithdraw(uint256)", VIEW);
        (s[35], c[35]) = ("releaseTickets(uint256,address,uint256)", TICKETS);
        (s[36], c[36]) = ("returnFeeBps()", VIEW);
        (s[37], c[37]) = ("returnItem(uint256,uint256,uint256)", ANYONE);
        (s[38], c[38]) = ("returnItems(uint256[],uint256,uint256)", ANYONE);
        (s[39], c[39]) = ("shelfCount()", VIEW);
        (s[40], c[40]) = ("supplyFloor()", VIEW);
        (s[41], c[41]) = ("ticketAdapter()", VIEW);
        (s[42], c[42]) = ("token()", VIEW);
        (s[43], c[43]) = ("unsolicitedToken()", VIEW);
        (s[44], c[44]) = ("waiveHandBackFee()", COORDINATOR);
        (s[45], c[45]) = ("withdraw(uint256,uint256,uint256)", ANYONE);
        (s[46], c[46]) = ("withdrawBatch(uint256[],uint256,uint256)", ANYONE);
    }

    /// @dev BoxTickets: 48 functions
    function _tableBoxTickets() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](48);
        c = new uint8[](48);
        (s[0], c[0]) = ("RETURN_GRACE()", VIEW);
        (s[1], c[1]) = ("REVEAL_GRACE()", VIEW);
        (s[2], c[2]) = ("SILENCE()", VIEW);
        (s[3], c[3]) = ("SILENCE_UNREQUESTED()", VIEW);
        (s[4], c[4]) = ("TAKE_DELAY()", VIEW);
        (s[5], c[5]) = ("acceptGraduationWord()", ANYONE);
        (s[6], c[6]) = ("approve(address,uint256)", ANYONE);
        (s[7], c[7]) = ("balanceOf(address)", VIEW);
        (s[8], c[8]) = ("cancelDraw(uint256)", ANYONE);
        (s[9], c[9]) = ("collection()", VIEW);
        (s[10], c[10]) = ("collectionSize()", VIEW);
        (s[11], c[11]) = ("coordinator()", VIEW);
        (s[12], c[12]) = ("coordinatorImplementation()", VIEW);
        (s[13], c[13]) = ("draw(uint256,uint256)", ANYONE);
        (s[14], c[14]) = ("drawTicket(uint256)", VIEW);
        (s[15], c[15]) = ("enterTerminal()", ANYONE);
        (s[16], c[16]) = ("firstId()", VIEW);
        (s[17], c[17]) = ("getApproved(uint256)", VIEW);
        (s[18], c[18]) = ("graduationWord()", VIEW);
        (s[19], c[19]) = ("handBack(uint256[],uint256,uint256)", ANYONE);
        (s[20], c[20]) = ("initialize()", COORDINATOR);
        (s[21], c[21]) = ("isApprovedForAll(address,address)", VIEW);
        (s[22], c[22]) = ("name()", VIEW);
        (s[23], c[23]) = ("numberOf(uint256)", VIEW);
        (s[24], c[24]) = ("open(uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))", ANYONE);
        (s[25], c[25]) = ("openAt()", VIEW);
        (s[26], c[26]) = ("openDraw(uint256,address,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))", ANYONE);
        (s[27], c[27]) = ("ownerOf(uint256)", VIEW);
        (s[28], c[28]) = ("phase()", VIEW);
        (s[29], c[29]) = ("poolPositionAt(uint256)", VIEW);
        (s[30], c[30]) = ("requestGraduationWord()", ANYONE);
        (s[31], c[31]) = ("returnableFrom(uint256)", VIEW);
        (s[32], c[32]) = ("safeTransferFrom(address,address,uint256)", ANYONE);
        (s[33], c[33]) = ("safeTransferFrom(address,address,uint256,bytes)", ANYONE);
        (s[34], c[34]) = ("setApprovalForAll(address,bool)", ANYONE);
        (s[35], c[35]) = ("settle(uint256)", ANYONE);
        (s[36], c[36]) = ("slotOf(uint256)", VIEW);
        (s[37], c[37]) = ("source()", VIEW);
        (s[38], c[38]) = ("status()", VIEW);
        (s[39], c[39]) = ("supportsInterface(bytes4)", VIEW);
        (s[40], c[40]) = ("symbol()", VIEW);
        (s[41], c[41]) = ("take(uint256,uint256,uint256)", ANYONE);
        (s[42], c[42]) =
        ("takeByNumber(uint256,uint256,uint256,uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))", ANYONE);
        (s[43], c[43]) = ("ticketInFlight()", VIEW);
        (s[44], c[44]) = ("token()", VIEW);
        (s[45], c[45]) = ("tokenURI(uint256)", VIEW);
        (s[46], c[46]) = ("transferFrom(address,address,uint256)", ANYONE);
        (s[47], c[47]) = ("vault()", VIEW);
    }

    /// @dev BoxItemStream: 29 functions
    function _tableBoxItemStream() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](29);
        c = new uint8[](29);
        (s[0], c[0]) = ("burn()", ANYONE);
        (s[1], c[1]) = ("claim(uint256[],address)", ANYONE);
        (s[2], c[2]) = ("claimFor(address,uint256[])", ANYONE);
        (s[3], c[3]) = ("collection()", VIEW);
        (s[4], c[4]) = ("collectionSize()", VIEW);
        (s[5], c[5]) = ("coordinator()", VIEW);
        (s[6], c[6]) = ("coordinatorImplementation()", VIEW);
        (s[7], c[7]) = ("firstId()", VIEW);
        (s[8], c[8]) = ("hook()", VIEW);
        (s[9], c[9]) = ("index()", VIEW);
        (s[10], c[10]) = ("initialize()", COORDINATOR);
        (s[11], c[11]) = ("liabilities()", VIEW);
        (s[12], c[12]) = ("onGraduation()", ANYONE);
        (s[13], c[13]) = ("onItemTransfer(address,address,uint256)", COLLECTION);
        (s[14], c[14]) = ("onStreamFunds(uint256)", RECEIVER);
        (s[15], c[15]) = ("onVaultAction(uint8,address,uint256,uint256)", VAULT);
        (s[16], c[16]) = ("openTickets()", VIEW);
        (s[17], c[17]) = ("outsideCount()", VIEW);
        (s[18], c[18]) = ("owedOf(address)", VIEW);
        (s[19], c[19]) = ("pendingOf(uint256)", VIEW);
        (s[20], c[20]) = ("poolManager()", VIEW);
        (s[21], c[21]) = ("receiver()", VIEW);
        (s[22], c[22]) = ("startValue()", VIEW);
        (s[23], c[23]) = ("started()", VIEW);
        (s[24], c[24]) = ("streamValue()", VIEW);
        (s[25], c[25]) = ("tickets()", VIEW);
        (s[26], c[26]) = ("token()", VIEW);
        (s[27], c[27]) = ("totals()", VIEW);
        (s[28], c[28]) = ("vault()", VIEW);
    }

    /// @dev BoxRoyaltyRouter: 6 functions, receive (ANYONE)
    function _tableBoxRoyaltyRouter() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](6);
        c = new uint8[](6);
        (s[0], c[0]) = ("coordinator()", VIEW);
        (s[1], c[1]) = ("destination()", VIEW);
        (s[2], c[2]) = ("flush()", ANYONE);
        (s[3], c[3]) = ("receiver()", VIEW);
        (s[4], c[4]) = ("sweep(address)", ANYONE);
        (s[5], c[5]) = ("weth()", VIEW);
    }

    /// @dev BoxToken: 15 functions
    function _tableBoxToken() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](15);
        c = new uint8[](15);
        (s[0], c[0]) = ("ISSUANCE()", VIEW);
        (s[1], c[1]) = ("allowance(address,address)", VIEW);
        (s[2], c[2]) = ("approve(address,uint256)", ANYONE);
        (s[3], c[3]) = ("balanceOf(address)", VIEW);
        (s[4], c[4]) = ("burn(uint256)", ANYONE);
        (s[5], c[5]) = ("decimals()", VIEW);
        (s[6], c[6]) = ("initialHolder()", VIEW);
        (s[7], c[7]) = ("initialSupply()", VIEW);
        (s[8], c[8]) = ("name()", VIEW);
        (s[9], c[9]) = ("symbol()", VIEW);
        (s[10], c[10]) = ("totalBurned()", VIEW);
        (s[11], c[11]) = ("totalSupply()", VIEW);
        (s[12], c[12]) = ("transfer(address,uint256)", ANYONE);
        (s[13], c[13]) = ("transferFrom(address,address,uint256)", ANYONE);
        (s[14], c[14]) = ("vault()", VIEW);
    }

    /// @dev FitBuybackExecutor: 32 functions, receive (ANYONE)
    function _tableFitBuybackExecutor() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](32);
        c = new uint8[](32);
        (s[0], c[0]) = ("CHECKPOINTS()", VIEW);
        (s[1], c[1]) = ("CHECKPOINT_SPACING()", VIEW);
        (s[2], c[2]) = ("MAX_CHUNKS_PER_BLOCK()", VIEW);
        (s[3], c[3]) = ("MAX_IMPACT_TICKS()", VIEW);
        (s[4], c[4]) = ("MAX_OBSERVATION_STEP()", VIEW);
        (s[5], c[5]) = ("MIN_SQRT_PRICE_X96()", VIEW);
        (s[6], c[6]) = ("POOL_FEE()", VIEW);
        (s[7], c[7]) = ("TICK_SPACING()", VIEW);
        (s[8], c[8]) = ("TWAP_BAND_TICKS()", VIEW);
        (s[9], c[9]) = ("TWAP_WINDOW()", VIEW);
        (s[10], c[10]) = ("batchThreshold()", VIEW);
        (s[11], c[11]) = ("budget()", VIEW);
        (s[12], c[12]) = ("checkpointAt(uint256)", VIEW);
        (s[13], c[13]) = ("execute(uint256)", ANYONE);
        (s[14], c[14]) = ("fitGraduated()", VIEW);
        (s[15], c[15]) = ("fundBudget()", ANYONE);
        (s[16], c[16]) = ("graduationSeen()", VIEW);
        (s[17], c[17]) = ("hooks()", VIEW);
        (s[18], c[18]) = ("latestSampleTick()", VIEW);
        (s[19], c[19]) = ("launchPhase()", VIEW);
        (s[20], c[20]) = ("oracle()", VIEW);
        (s[21], c[21]) = ("poke()", ANYONE);
        (s[22], c[22]) = ("poolId()", VIEW);
        (s[23], c[23]) = ("poolKey()", VIEW);
        (s[24], c[24]) = ("poolManager()", VIEW);
        (s[25], c[25]) = ("receiver()", VIEW);
        (s[26], c[26]) = ("token()", VIEW);
        (s[27], c[27]) = ("totalBurned()", VIEW);
        (s[28], c[28]) = ("totalEthSpent()", VIEW);
        (s[29], c[29]) = ("totalToBudget()", VIEW);
        (s[30], c[30]) = ("twap()", VIEW);
        (s[31], c[31]) = ("unlockCallback(bytes)", POOL_MANAGER);
    }

    /// @dev DrandSource: 17 functions
    function _tableDrandSource() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](17);
        c = new uint8[](17);
        (s[0], c[0]) = ("GENESIS_TIME()", VIEW);
        (s[1], c[1]) = ("MARGIN()", VIEW);
        (s[2], c[2]) = ("PERIOD()", VIEW);
        (s[3], c[3]) = ("SILENCE()", VIEW);
        (s[4], c[4]) = ("WORD_TAG()", VIEW);
        (s[5], c[5]) = ("addBounty(uint256)", ANYONE);
        (s[6], c[6]) = ("beaconOf(uint256)", VIEW);
        (s[7], c[7]) = ("bountyOf(uint256)", VIEW);
        (s[8], c[8]) = ("isSilent(address,uint256)", VIEW);
        (s[9], c[9]) = ("owedTo(address)", VIEW);
        (s[10], c[10]) = ("postRound(uint256,bytes)", ANYONE);
        (s[11], c[11]) = ("request(uint256)", ANYONE);
        (s[12], c[12]) = ("requestOf(address,uint256)", VIEW);
        (s[13], c[13]) = ("roundAt(uint256)", VIEW);
        (s[14], c[14]) = ("roundTime(uint256)", VIEW);
        (s[15], c[15]) = ("withdrawBounty(address)", ANYONE);
        (s[16], c[16]) = ("wordOf(address,uint256)", VIEW);
    }

    /// @dev BoxBackedSource: 22 functions
    function _tableBoxBackedSource() internal pure returns (string[] memory s, uint8[] memory c) {
        s = new string[](22);
        c = new uint8[](22);
        (s[0], c[0]) = ("BACKUP_AFTER()", VIEW);
        (s[1], c[1]) = ("BACKUP_TAG()", VIEW);
        (s[2], c[2]) = ("DRAND()", VIEW);
        (s[3], c[3]) = ("DRAND_TAG()", VIEW);
        (s[4], c[4]) = ("HISTORY()", VIEW);
        (s[5], c[5]) = ("HISTORY_WINDOW()", VIEW);
        (s[6], c[6]) = ("LATEST_START()", VIEW);
        (s[7], c[7]) = ("MARGIN()", VIEW);
        (s[8], c[8]) = ("RECENT_BLOCKS()", VIEW);
        (s[9], c[9]) = ("SILENCE()", VIEW);
        (s[10], c[10]) = ("TARGET_BLOCKS()", VIEW);
        (s[11], c[11]) = ("addBounty(uint256)", ANYONE);
        (s[12], c[12]) = ("backupOf(uint256)", VIEW);
        (s[13], c[13]) = ("bountyOf(uint256)", VIEW);
        (s[14], c[14]) = ("fixBackup(uint256,bytes)", ANYONE);
        (s[15], c[15]) = ("isSilent(address,uint256)", VIEW);
        (s[16], c[16]) = ("request(uint256)", ANYONE);
        (s[17], c[17]) = ("requestOf(address,uint256)", VIEW);
        (s[18], c[18]) = ("roundAt(uint256)", VIEW);
        (s[19], c[19]) = ("roundTime(uint256)", VIEW);
        (s[20], c[20]) = ("startBackup(uint256,uint256,bytes)", ANYONE);
        (s[21], c[21]) = ("wordOf(address,uint256)", VIEW);
    }
}
