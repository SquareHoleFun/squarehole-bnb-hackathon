// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AuditU1FableTables
/// @notice TEST ONLY (SH-AUDIT-B0 U1, Fable). The selector table of every box 0 contract at core-v21-rc8.1, GENERATED
/// from the build artifacts (`out/<name>.sol/<name>.json`, `abi` and `methodIdentifiers`) by the scratch script
/// gen-tables.py of SH-AUDIT-B0-U1-F: one 5-byte entry per function, selector (4) then its documented caller class
/// (1), sorted by selector; beside it the canonical signatures in the same order. `AuditU1FableSurface` checks at run
/// time that each artifact still dispatches exactly these selectors (so an ABI change fails here until the table is
/// regenerated and the new entry classified), then drives every entry from every caller class (BC-010; ADR-0016 § 5;
/// F23 C2). Classes: 0 view/pure (no write possible) · 1 anyone (a permissionless entry, gated by state, balances or
/// ownership) · 2 the factory · 3 the box's coordinator · 4 the PoolManager · 5 the receiver · 6 the collection · 7 the
/// vault · 8 the tickets · 9 FIT's executor or the hook (the receiver's fee notes) · 10 the box-0 creator · 11 nobody
/// (an entry no caller can take on box 0: a creator payee, a swap module, a reveal unlocker, an extension called
/// directly). On an implementation every entry but the PoolManager's callbacks is class 11: implementations are inert.
library AuditU1FableTables {
    uint8 internal constant VIEW = 0;
    uint8 internal constant ANYONE = 1;
    uint8 internal constant FACTORY = 2;
    uint8 internal constant COORDINATOR = 3;
    uint8 internal constant POOL_MANAGER = 4;
    uint8 internal constant RECEIVER = 5;
    uint8 internal constant COLLECTION = 6;
    uint8 internal constant VAULT = 7;
    uint8 internal constant TICKETS = 8;
    uint8 internal constant EXECUTOR_OR_HOOK = 9;
    uint8 internal constant CREATOR = 10;
    uint8 internal constant NOBODY = 11;

    uint256 internal constant ENTRY = 5;

    /// BoxCoordinator: 47 functions, 5 state-changing.
    bytes internal constant BOX_COORDINATOR =
        hex"01339c210202d05d3f0004baa00b00081ab60200111f6b9a001a809039001c33e007001d62ebd90020c800810021858521003601318900386834a300459bc13200523925bf00692a5351007c9b032a007de1e536007f544e49007f5a7c7b00839ea776008778df72028aff4f2a008d3931260091dd7346049532e28700987d4e34009e801ab800a13b1ba300b1c9fe6e00b1da0d1700b361e19800b4deda3300c34c08e500c45a015500cbe39c2000cd3293de00d279c19101d3618cca01d958ddf600dc4c90d300e7a3808f00e7c2b77200f7260d3e00fbfa77cf00fc0c546a00fd3ab28200febe5cfc00";
    string internal constant BOX_COORDINATOR_SIGS = "launch()|creator()|kind()|ROLE_ITEM_STREAM()|ROLE_LAUNCH_ROUTER()|ARGS_LENGTH()|ROLE_VAULT()|rewardO"
        "f(address)|creatorBuyAmount()|tickets()|randomness()|nonceOf(uint8)|poolShare()|launchRouter()|ROLE_"
        "ROYALTY_ROUTER()|ROLE_TOKEN()|collection()|graduatedAt()|hook()|specHash()|deploy(bytes[],bytes,byte"
        "s32,uint256)|ROLE_COLLECTION()|graduatedAtBlock()|unlockCallback(bytes)|rewardCap()|boxId()|ROLE_TIC"
        "KETS()|ROLE_RECEIVER()|phase()|streamStartClaims()|raise()|streamStartBalance()|executor()|factory()"
        "|royaltyRouter()|reserve()|claimReward(address)|graduate()|ROLE_EXECUTOR()|poolManager()|itemStream("
        ")|graduated()|receiver()|vault()|token()|q()|POKE_GAS()";

    /// BoxHook: 55 functions, 7 state-changing.
    bytes internal constant BOX_HOOK =
        hex"01339c210304baa00b000a009097000ba2622d00182148ef001a8090390021d0ee70002223a5da00259982e50028d53bc4002d5537b0002f5162d1003e0dc34e00454b0608034641257d054646947d0046ca626b004c81433f00523925bf00575e24b400597e1fb50059c63999005e3f272700602ed6c5006353052e006c2bbe7e006fe7e6eb007165485d00727f7f4700769da421008129fc1c038549d9be00909959290091dd7346049f063efc00a0e23ebd00a2fbdad601a3ec191a00b1c9fe6e00b361e19800b47b2fb104b6a8b0fa00bbbf12be00c1f38a2a00c4e833ce00dc4c90d300dc98354e00e1b4af6900e1f9f33700eb3091b100f5bec8a600f7260d3e00f77d46e000fc0c546a00fd3ab28200";
    string internal constant BOX_HOOK_SIGS = "launch()|kind()|coordinator()|DEEPEN_COOLDOWN_BLOCKS()|poolKey()|ARGS_LENGTH()|beforeRemoveLiquidity"
        "(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)|reserveCap()|bef"
        "oreAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)|c"
        "losedAtBlock()|extension()|pairedLiquidity()|poolId()|migrate(uint256)|harvest()|WINDOW_SECONDS()|TI"
        "CK_SPACING()|reserveMinted()|launchRouter()|beforeSwap(address,(address,address,uint24,int24,address"
        "),(bool,int256,uint160),bytes)|closed()|depthBudget()|LP_FEE()|DEEPEN_TIP_BPS()|windowEndsAt()|after"
        "RemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,i"
        "nt256,bytes)|afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)|curve()|m"
        "igratedAtBlock()|coordinatorImplementation()|initialize()|REQUIRED_FLAGS()|lastDeepenBlock()|unlockC"
        "allback(bytes)|afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,"
        "bytes32),int256,int256,bytes)|openAt()|deepen(address)|deployBlock()|phase()|raise()|afterSwap(addre"
        "ss,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)|beforeDonate(address,("
        "address,address,uint24,int24,address),uint256,uint256,bytes)|ADD_CAP_PERCENT()|minAdd()|getHookPermi"
        "ssions()|poolManager()|beforeInitialize(address,(address,address,uint24,int24,address),uint160)|afte"
        "rDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)|MAX_DEVIATION_TICKS()|"
        "priceAverage()|deepenTipCap()|receiver()|graduatedLayout()|token()|q()";

    /// BoxHookExtension: 4 functions, 4 state-changing.
    bytes internal constant BOX_HOOK_EXTENSION = hex"01339c210b454b06080b91dd73460ba2fbdad60b";
    string internal constant BOX_HOOK_EXTENSION_SIGS =
        "launch()|migrate(uint256)|unlockCallback(bytes)|deepen(address)";

    /// BoxLaunchRouter: 27 functions, 6 state-changing.
    bytes internal constant BOX_LAUNCH_ROUTER =
        hex"04baa00b000a0090970016a43460001a809039001dcc904e001fb9984700243389bc0035142c8c0035faa416014646947d00521164790061916b96036672badb00769da421007f5a7c7b008129fc1c038945257c0191dd734604a0e23ebd00c8ced51f00ce858b9e00d8454a8200dc4c90d300ed1bd76c00fb969b0a03fc0c546a00fd3ab28200";
    string internal constant BOX_LAUNCH_ROUTER_SIGS = "kind()|coordinator()|taxFor(uint256,uint256)|ARGS_LENGTH()|taxTable()|WINDOW_STEPS()|totalSwept()|bo"
        "otstrapped()|sweep()|WINDOW_SECONDS()|TAX_STEP_SECONDS()|creatorBuy(address,uint256)|PIPS()|coordina"
        "torImplementation()|hook()|initialize()|buy(uint256,uint256,address,uint256)|unlockCallback(bytes)|o"
        "penAt()|taxPips(uint256)|creatorBought()|totalTaxCollected()|poolManager()|quote(uint256)|bootstrap("
        ")|token()|q()";

    /// BoxReceiver: 59 functions, 15 state-changing.
    bytes internal constant BOX_RECEIVER =
        hex"0372bf250004baa00b0006ec16f8010a009097000d44eb6b00185cdcbc001a809039001b8f4aa50024247257002553b369002582c401002d5537b00037712a4000379a3d81013c1887af0040e7120b0041136c5d0043efdbf9005230b87800539c8094015518e7f8006a9d1766006ad556600074edc09000769da4210076f0b2370b789775c0007f5a7c7b008129fc1c038669ae4a0191dd7346049e1f3cea0b9e41bad300a15fd0cd00a29a055200acc0dcca00af7b75d000af9b9da30bb1ef04e10bb73d845200b8b78a3c00b92fee1b00c038a38e00c324d26200c34c08e500c4026c5800cfc8c96301d65c7f300bd6b03efc00dc4c90d300df62cedc00e29bfaa400e2c4928009e7a3808f00ee4fb37301fa716b3f00fc0c546a00fd3ab28200ff73c9c50b";
    string internal constant BOX_RECEIVER_SIGS = "platformSafe()|kind()|collect(address)|coordinator()|hookFeesPending()|platformOwed()|ARGS_LENGTH()|"
        "platformEpoch()|pendingCreatorPayee()|creatorCap()|fitWaitingT()|extension()|platformHeld()|fundDept"
        "h()|TIP_BPS()|creatorHeld()|tipMax()|FEE_SHARE_DENOMINATOR()|fitOwed()|fundFees()|carried()|streamCu"
        "rveDepthT()|creatorOwed()|PLATFORM_EPOCH_SECONDS()|coordinatorImplementation()|pullForModule()|tBurn"
        "Pending()|hook()|initialize()|payFit()|unlockCallback(bytes)|moduleProceeds(uint8,uint256)|PLATFORM_"
        "CAP_WEI()|depthHeld()|booked()|moduleFeesPending()|batchMin()|acceptCreatorPayee()|fundCreator()|gra"
        "duationSettled()|moduleOwed()|creatorPayee()|totals()|tStream()|executor()|moduleFeeAllowance()|onGr"
        "aduation()|claimCreator(address)|STREAM_NOTIFY_GAS()|poolManager()|qStream()|royaltyDestination()|no"
        "teModuleFees(uint256,uint256)|itemStream()|payPlatform()|swapModule()|token()|q()|proposeCreatorPaye"
        "e(address)";

    /// BoxReceiverExtension: 5 functions, 4 state-changing.
    bytes internal constant BOX_RECEIVER_EXTENSION = hex"769da421008129fc1c0baf9b9da30be2c492800bff73c9c50b";
    string internal constant BOX_RECEIVER_EXTENSION_SIGS = "coordinatorImplementation()|initialize()|acceptCreatorPayee()|noteModuleFees(uint256,uint256)|propos"
        "eCreatorPayee(address)";

    /// BoxCollection: 59 functions, 8 state-changing.
    bytes internal constant BOX_COLLECTION =
        hex"003cca590001ffc9a70006fdde0300081812fc00095ea7b3010a0090970016a56c410018160ddd00183698cb002262eb740023b872dd01242213620024ea3023002a55205a002b96bf3400401576a20042842e0e0145798f650145c0f533004c185cbd004cb82968004f6391ae0b5055fbc3005b9db898005efab6e4006352211e00701454540070a08231007284e4160074c3519a00769da421008008e8bc008129fc1c038da5cb5b008f7bb1790095d89b4100a1a0d07800a227d60f00a22cb46501b341980700b88d4fde01bbd78e9300c1b7775a00c22c709900c63adb2b00c87b56dd00ca6a150600cbe39c2000ce178a0400d7268a2e00e29bfaa400e4f0335600e8a3d48500e985e9c500eb6e061400f66bb36e00f7260d3e00fbfa77cf00fc0c546a00";
    string internal constant BOX_COLLECTION_SIGS = "leafOf(uint256,uint128,bytes32,bytes32,bytes32,bytes32)|supportsInterface(bytes4)|name()|getApproved"
        "(uint256)|approve(address,uint256)|coordinator()|treeDepth()|totalSupply()|metadataTableHash()|OBSER"
        "VER_GAS()|transferFrom(address,address,uint256)|isRevealable(uint256)|hiddenDescription()|royaltyInf"
        "o(uint256,uint256)|observerGas()|firstId()|safeTransferFrom(address,address,uint256)|reveal(uint256,"
        "uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])|collectionSize()|hiddenSvg()|REVEAL_ALWAYS()|unlo"
        "ckReveal(uint256)|isRevealed(uint256)|externalLink()|traitsOf(uint256)|ownerOf(uint256)|revealUnlock"
        "er()|balanceOf(address)|description()|modelCid(uint256)|coordinatorImplementation()|revealState(uint"
        "256)|initialize()|owner()|tokenJSON(uint256)|symbol()|bannerSha256()|metadataTableBytes()|setApprova"
        "lForAll(address,bool)|revealRoot()|safeTransferFrom(address,address,uint256,bytes)|revealedCount()|r"
        "evealTriggers()|REVEAL_ON_EXIT()|royaltyBps()|tokenURI(uint256)|collectionCoverSha256()|royaltyRoute"
        "r()|imageCid(uint256)|metadataTable()|royaltyDestination()|transferObserver()|contractURI()|isApprov"
        "edForAll(address,address)|generatorHash()|REVEAL_ON_UNLOCK()|receiver()|vault()|token()";

    /// BoxVault: 47 functions, 10 state-changing.
    bytes internal constant BOX_VAULT =
        hex"07d4d015000a00909700108e9f6b0113d9df4000150b7a02001771f9ce001913064d082262eb74002b96bf34003a775fe700401576a20043c9f97a0045c0f533004bea9cab0155d9deba00657be509036d1127d400769da4210078e81ebe00793fd246007ccbf0e1007de1e536008129fc1c0382dc78360392849421009929716f089bcada0700a41fe49f01a924710200b35a720000b4057bbd00babd701200c18fe69d00c256b1bd00c89b6d2000d73792a900db797ea900db851dd700dd058abe01e0c4b94608e576cfd900eb70e49800ec21184000ee9d4a2000f225c5ea00f6a217f100fc0c546a00";
    string internal constant BOX_VAULT_SIGS = "inside()|coordinator()|withdrawBatch(uint256[],uint256,uint256)|quoteTake(uint256)|onERC721Received("
        "address,address,uint256,bytes)|ticketAdapter()|openTickets(uint256,uint256)|OBSERVER_GAS()|observerG"
        "as()|pendingTickets()|firstId()|isHidden(uint256)|collectionSize()|returnItem(uint256,uint256,uint25"
        "6)|quoteHandBack(uint256)|waiveHandBackFee()|unsolicitedToken()|coordinatorImplementation()|hasLeftV"
        "ault(uint256)|quoteReturn(uint256)|handBackFeeWaived()|collection()|initialize()|openGate()|escrowPr"
        "incipal()|releaseTickets(uint256,address,uint256)|outside()|withdraw(uint256,uint256,uint256)|gateOp"
        "enedAt()|gateOpen()|escrowSurplus()|activeSupply()|shelfCount()|isOutside(uint256)|isOnShelf(uint256"
        ")|FEE_DENOMINATOR()|supplyFloor()|hiddenCount()|returnItems(uint256[],uint256,uint256)|deliverTicket"
        "(uint256,address)|returnFeeBps()|observer()|quoteWithdraw(uint256)|pickFeeBps()|drawFeeBps()|isInsid"
        "e(uint256)|token()";

    /// BoxTickets: 48 functions, 17 state-changing.
    bytes internal constant BOX_TICKETS =
        hex"01ffc9a70006fdde0300081812fc00095ea7b3010a009097001991ba6b00200d2ed200231c4d3f0023b872dd01263f3e7e003309d485003738f1a501401576a200405341a30142842e0e0145c0f533005888f5a0006352211e0064dd1d290067e828bf006ddc6dbd0070a082310073b0cee101769da421007de1e536008129fc1c0382bf3bc30084b850540187c8cca6008df828000192612c4c0195d89b4100a0e23ebd00a1f5504500a22cb46501b1c9fe6e00b88d4fde01c87b56dd00d2b8035a01d51c46c401e985e9c500ef973b5c00f6d7e54701f827d29401fbfa77cf00fc0c546a00fd561c7f00fe5ae01b01";
    string internal constant BOX_TICKETS_SIGS = "supportsInterface(bytes4)|name()|getApproved(uint256)|approve(address,uint256)|coordinator()|TAKE_DE"
        "LAY()|status()|drawTicket(uint256)|transferFrom(address,address,uint256)|slotOf(uint256)|RETURN_GRAC"
        "E()|take(uint256,uint256,uint256)|firstId()|takeByNumber(uint256,uint256,uint256,uint256,(uint128,by"
        "tes32,bytes32,bytes32,bytes32,bytes32[]))|safeTransferFrom(address,address,uint256)|collectionSize()"
        "|REVEAL_GRACE()|ownerOf(uint256)|poolPositionAt(uint256)|source()|graduationWord()|balanceOf(address"
        ")|requestGraduationWord()|coordinatorImplementation()|collection()|initialize()|numberOf(uint256)|ac"
        "ceptGraduationWord()|SILENCE()|settle(uint256)|cancelDraw(uint256)|symbol()|openAt()|ticketInFlight("
        ")|setApprovalForAll(address,bool)|phase()|safeTransferFrom(address,address,uint256,bytes)|tokenURI(u"
        "int256)|draw(uint256,uint256)|open(uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))|isAp"
        "provedForAll(address,address)|SILENCE_UNREQUESTED()|enterTerminal()|openDraw(uint256,address,(uint12"
        "8,bytes32,bytes32,bytes32,bytes32,bytes32[]))|vault()|token()|returnableFrom(uint256)|handBack(uint2"
        "56[],uint256,uint256)";

    /// BoxRoyaltyRouter: 6 functions, 2 state-changing.
    bytes internal constant BOX_ROYALTY_ROUTER = hex"01681a62010a009097003fc8cef3006b9f96ea01b269681d00f7260d3e00";
    string internal constant BOX_ROYALTY_ROUTER_SIGS =
        "sweep(address)|coordinator()|weth()|flush()|destination()|receiver()";

    /// BoxItemStream: 29 functions, 8 state-changing.
    bytes internal constant BOX_ITEM_STREAM =
        hex"0a009097001f2698ab002185852100228db984002986c0e5003f35ff3200401576a20044df8e700145c0f53300769da421007de1e536007e7feaa7007f5a7c7b008129fc1c0382b250110187c9505f008c574b4801b4add30700b97c98e700bf98a4a407c038a38e00cfc8c96301dc1ab9af05dc4c90d300f07e19e400f352bac506f7260d3e00fbfa77cf00fc0c546a00";
    string internal constant BOX_ITEM_STREAM_SIGS = "coordinator()|started()|tickets()|owedOf(address)|index()|startValue()|firstId()|burn()|collectionSi"
        "ze()|coordinatorImplementation()|collection()|pendingOf(uint256)|hook()|initialize()|claimFor(addres"
        "s,uint256[])|openTickets()|claim(uint256[],address)|liabilities()|streamValue()|onVaultAction(uint8,"
        "address,uint256,uint256)|totals()|onGraduation()|onStreamFunds(uint256)|poolManager()|outsideCount()"
        "|onItemTransfer(address,address,uint256)|receiver()|vault()|token()";

    /// BoxToken: 15 functions, 4 state-changing.
    bytes internal constant BOX_TOKEN =
        hex"06fdde0300095ea7b30118160ddd0023b872dd01313ce56700378dc3dc0042966c680170a082310095d89b4100a9059cbb01b026737900b72218e300d89135cd00dd62ed3e00fbfa77cf00";
    string internal constant BOX_TOKEN_SIGS = "name()|approve(address,uint256)|totalSupply()|transferFrom(address,address,uint256)|decimals()|initi"
        "alSupply()|burn(uint256)|balanceOf(address)|symbol()|transfer(address,uint256)|ISSUANCE()|initialHol"
        "der()|totalBurned()|allowance(address,address)|vault()";

    /// FitBuybackExecutor: 32 functions, 4 state-changing.
    bytes internal constant FIT_BUYBACK_EXECUTOR =
        hex"1208aa1800121cb671001254b9af001817835801182148ef0019bb9d460037bb2161003e0dc34e00412c79cc0143413d730046ca626b00473d2632007dc0d1d00088a640ea0091dd73460492d3b88600a1cc065600a84fe7c000c606e72000c8c25dfe00cbc8307f00cd7033c400d89135cd00dc4c90d300dd1b9c4a00e2c1d1d100e53bd8a100ed01bf2900f7260d3e00fc0c546a00fe0d94c101ff9536db00";
    string internal constant FIT_BUYBACK_EXECUTOR_SIGS = "twap()|MIN_SQRT_PRICE_X96()|MAX_CHUNKS_PER_BLOCK()|poke()|poolKey()|TWAP_BAND_TICKS()|MAX_OBSERVATIO"
        "N_STEP()|poolId()|fundBudget()|latestSampleTick()|TICK_SPACING()|graduationSeen()|oracle()|CHECKPOIN"
        "T_SPACING()|unlockCallback(bytes)|totalEthSpent()|batchThreshold()|totalToBudget()|CHECKPOINTS()|lau"
        "nchPhase()|MAX_IMPACT_TICKS()|hooks()|totalBurned()|poolManager()|POOL_FEE()|TWAP_WINDOW()|fitGradua"
        "ted()|budget()|receiver()|token()|execute(uint256)|checkpointAt(uint256)";

    /// BoxFactoryV1: 43 functions, 1 state-changing.
    bytes internal constant BOX_FACTORY_V1 =
        hex"0372bf25000c2a0adb00134b85df0013524f3b001466c81c001639f2c7002518a352002689374d002e4995ed0030e9012c0032e4e363003601318900398aad76003fc8cef3004272eb04004418a904004bb4a695004d35d32800521ddcf50054fd4d500056a527b40058e9c67d005a548be9005dfffe9600609b368e006454a31d006b9947b4006eb33577007879dd2f007b103999007c609cd000a08d119d00ad29ef7a00ad84f1b300b4a06cad00c291fac800ccf5202c00dc4c90d300e4435bac00eda9ad0100efafe8c80af2a84bba00ffa1ad7400";
    string internal constant BOX_FACTORY_V1_SIGS = "platformSafe()|FACTORY_NONCE_BOX0()|IMPL_VAULT()|MW_COLLECTION()|MW_POOL()|MW_TICKETS()|MW_EXECUTOR("
        ")|MW_VAULT()|hookExtension()|implementations()|planner()|randomness()|receiverExtension()|weth()|IMP"
        "L_HOOK()|MW_ROYALTY()|IMPL_COORDINATOR()|hookInitCodeHash(uint32)|predictHook(uint32,bytes32)|versio"
        "n()|IMPL_ITEM_STREAM()|box0Creator()|IMPL_RECEIVER()|MW_RECEIVER()|MW_ROUTER()|MW_HOOK()|executorIni"
        "tCodeHash()|refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,"
        "uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,addr"
        "ess,uint256,bytes32,(uint16,bytes)[]),address)|MW_SUPPLY()|registry()|templateIdOf((uint16,uint8,str"
        "ing,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8"
        ",uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[])"
        ")|versionCodeHash()|IMPL_COLLECTION()|MW_ETH()|box0Addresses()|IMPL_LAUNCH_ROUTER()|MW_COORDINATOR()"
        "|poolManager()|FACTORY_NONCE_REGISTRY()|IMPL_TICKETS()|createBox((uint16,uint8,string,string,string,"
        "string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes"
        "32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),bytes32,bytes)|MW"
        "_STREAM()|VERSION()";

    /// BoxFactoryV1Planner: 17 functions, 0 state-changing.
    bytes internal constant BOX_FACTORY_V1_PLANNER =
        hex"1211ada10013d282c200312a5257003845cb090040917e67005f900316006eb335770078b51ad3008a537c47009ed9f82000a02b3ca000bbde0b2000c22c709900c6a5ed7200e5496f6800e88e10fa00faa597c900";
    string internal constant BOX_FACTORY_V1_PLANNER_SIGS = "addresses(address,bool)|NONCE_ROUTER()|TEMPLATE_ID_TAG()|NONCE_EXECUTOR()|NONCE_ROYALTY()|NONCE_TABL"
        "E()|refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,ui"
        "nt8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint"
        "256,bytes32,(uint16,bytes)[]),address)|plan((uint16,uint8,string,string,string,string,string,uint32,"
        "uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,byte"
        "s32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),(address,address,address,address,addre"
        "ss,address,address,address,address,address,address,address,address,bytes32,bytes32,address,int24,int"
        "24,uint160,uint160,uint128,uint256),address,bytes32,bytes32)|NONCE_VAULT()|NONCE_STREAM()|templateId"
        "Of((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8"
        ",uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes"
        "32,(uint16,bytes)[]),bytes32,bytes32)|NONCE_RECEIVER()|REVEAL_ON_EXIT()|NONCE_COLLECTION()|NONCE_TOK"
        "EN()|hookInitCode((address,address,address,address,address,address,address,address,address,address,a"
        "ddress,address,address,bytes32,bytes32,address,int24,int24,uint160,uint160,uint128,uint256),(address"
        ",address,address,address,address,address,address,address,address,address,address),uint32)|NONCE_TICK" "ETS()";

    /// BoxRegistry: 21 functions, 1 state-changing.
    bytes internal constant BOX_REGISTRY =
        hex"081ab60200111f6b9a0016c0e2fc001c33e0070044ff038f00505a90870055d742e400572be4b3006523fc2d00692a5351007c9b032a0081def29b028aff4f2a009e801ab800a13b1ba300a75178cb00c45a015500d958ddf600de261db000e2095c0700e36bbed200";
    string internal constant BOX_REGISTRY_SIGS = "ROLE_ITEM_STREAM()|ROLE_LAUNCH_ROUTER()|ROLE_HOOK()|ROLE_VAULT()|boxCount()|ROLE_METADATA_TABLE()|re"
        "cordOf(uint256)|ROLE_COORDINATOR()|boxIdOf(address)|ROLE_ROYALTY_ROUTER()|ROLE_TOKEN()|record(addres"
        "s,bytes32,bytes)|ROLE_COLLECTION()|ROLE_TICKETS()|ROLE_RECEIVER()|coordinatorOf(uint256)|factory()|R"
        "OLE_EXECUTOR()|ROLE_SWAP_MODULE()|entry(uint256)|ROLE_COUNT()";

    /// @notice Entry `i` of a table: its selector and class.
    function entry(bytes memory table, uint256 i) internal pure returns (bytes4 selector, uint8 class) {
        uint256 at = i * ENTRY;
        selector = bytes4(bytes.concat(table[at], table[at + 1], table[at + 2], table[at + 3]));
        class = uint8(table[at + 4]);
    }

    function count(bytes memory table) internal pure returns (uint256) {
        return table.length / ENTRY;
    }

    /// @notice Signature `i` of a `|`-joined list (the order of its table).
    function signature(string memory sigs, uint256 i) internal pure returns (string memory) {
        bytes memory b = bytes(sigs);
        uint256 start;
        uint256 seen;
        for (uint256 j; j <= b.length; ++j) {
            if (j == b.length || b[j] == "|") {
                if (seen == i) {
                    bytes memory out = new bytes(j - start);
                    for (uint256 k; k < out.length; ++k) {
                        out[k] = b[start + k];
                    }
                    return string(out);
                }
                ++seen;
                start = j + 1;
            }
        }
        return "";
    }
}
