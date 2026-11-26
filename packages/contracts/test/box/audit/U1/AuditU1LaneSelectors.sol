// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Frozen external selector/caller table at the ticket start commit. Interfaces supply callers;
/// constants and extra implementation getters are explicit additions. Role 0: permissionless/view or holder
/// operation; 1: coordinator, 2: factory, 3: PoolManager, 4: receiver, 5: tickets, 6: collection,
/// 7: vault, 8: executor OR hook, 9: box0Creator, 10: no caller in box 0 (absent role/direct extension).
/// Holder operations are permissionless entry points with per-asset checks, not administrative roles.
library AuditU1LaneSelectors {
    // BoxCoordinator
    // 1a809039 | ARGS_LENGTH() | 0
    // febe5cfc | POKE_GAS() | 0
    // 8aff4f2a | ROLE_COLLECTION() | 0
    // d958ddf6 | ROLE_EXECUTOR() | 0
    // 081ab602 | ROLE_ITEM_STREAM() | 0
    // 111f6b9a | ROLE_LAUNCH_ROUTER() | 0
    // a13b1ba3 | ROLE_RECEIVER() | 0
    // 692a5351 | ROLE_ROYALTY_ROUTER() | 0
    // 9e801ab8 | ROLE_TICKETS() | 0
    // 7c9b032a | ROLE_TOKEN() | 0
    // 1c33e007 | ROLE_VAULT() | 0
    // 987d4e34 | boxId() | 0
    // d279c191 | claimReward(address) | 0
    // 7de1e536 | collection() | 0
    // 02d05d3f | creator() | 0
    // 20c80081 | creatorBuyAmount() | 0
    // 8778df72 | deploy(bytes[],bytes,bytes32,uint256) | 2
    // c34c08e5 | executor() | 0
    // c45a0155 | factory() | 0
    // d3618cca | graduate() | 0
    // e7c2b772 | graduated() | 0
    // 7f544e49 | graduatedAt() | 0
    // 8d393126 | graduatedAtBlock() | 0
    // 7f5a7c7b | hook() | 0
    // e7a3808f | itemStream() | 0
    // 04baa00b | kind() | 0
    // 01339c21 | launch() | 2
    // 523925bf | launchRouter() | 0
    // 386834a3 | nonceOf(uint8) | 0
    // b1c9fe6e | phase() | 0
    // dc4c90d3 | poolManager() | 0
    // 459bc132 | poolShare() | 0
    // fd3ab282 | q() | 0
    // b361e198 | raise() | 0
    // 36013189 | randomness() | 0
    // f7260d3e | receiver() | 0
    // cd3293de | reserve() | 0
    // 9532e287 | rewardCap() | 0
    // 1d62ebd9 | rewardOf(address) | 0
    // cbe39c20 | royaltyRouter() | 0
    // 839ea776 | specHash() | 0
    // b4deda33 | streamStartBalance() | 0
    // b1da0d17 | streamStartClaims() | 0
    // 21858521 | tickets() | 0
    // fc0c546a | token() | 0
    // 91dd7346 | unlockCallback(bytes) | 3
    // fbfa77cf | vault() | 0
    // BoxHook
    // bbbf12be | ADD_CAP_PERCENT() | 0
    // 1a809039 | ARGS_LENGTH() | 0
    // 0ba2622d | DEEPEN_COOLDOWN_BLOCKS() | 0
    // 602ed6c5 | DEEPEN_TIP_BPS() | 0
    // 5e3f2727 | LP_FEE() | 0
    // e1f9f337 | MAX_DEVIATION_TICKS() | 0
    // 8549d9be | REQUIRED_FLAGS() | 0
    // 46ca626b | TICK_SPACING() | 0
    // 4646947d | WINDOW_SECONDS() | 0
    // 9f063efc | afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes) | 0
    // e1b4af69 | afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes) | 0
    // 6fe7e6eb | afterInitialize(address,(address,address,uint24,int24,address),uint160,int24) | 0
    // 6c2bbe7e | afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes) | 0
    // b47b2fb1 | afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes) | 3
    // 259982e5 | beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes) | 0
    // b6a8b0fa | beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes) | 0
    // dc98354e | beforeInitialize(address,(address,address,uint24,int24,address),uint160) | 0
    // 21d0ee70 | beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes) | 0
    // 575e24b4 | beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes) | 0
    // 597e1fb5 | closed() | 0
    // 28d53bc4 | closedAtBlock() | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // 7165485d | curve() | 0
    // a2fbdad6 | deepen(address) | 0
    // f5bec8a6 | deepenTipCap() | 0
    // a3ec191a | deployBlock() | 0
    // 59c63999 | depthBudget() | 0
    // 2d5537b0 | extension() | 0
    // c4e833ce | getHookPermissions() | 0
    // f77d46e0 | graduatedLayout() | 0
    // 4641257d | harvest() | 4
    // 8129fc1c | initialize() | 1
    // 04baa00b | kind() | 0
    // 90995929 | lastDeepenBlock() | 0
    // 01339c21 | launch() | 1
    // 523925bf | launchRouter() | 0
    // 454b0608 | migrate(uint256) | 1
    // 727f7f47 | migratedAtBlock() | 0
    // c1f38a2a | minAdd() | 0
    // a0e23ebd | openAt() | 0
    // 2f5162d1 | pairedLiquidity() | 0
    // b1c9fe6e | phase() | 0
    // 3e0dc34e | poolId() | 0
    // 182148ef | poolKey() | 0
    // dc4c90d3 | poolManager() | 0
    // eb3091b1 | priceAverage() | 0
    // fd3ab282 | q() | 0
    // b361e198 | raise() | 0
    // f7260d3e | receiver() | 0
    // 2223a5da | reserveCap() | 0
    // 4c81433f | reserveMinted() | 0
    // fc0c546a | token() | 0
    // 91dd7346 | unlockCallback(bytes) | 3
    // 6353052e | windowEndsAt() | 0
    // BoxLaunchRouter
    // 1a809039 | ARGS_LENGTH() | 0
    // 6672badb | PIPS() | 0
    // 52116479 | TAX_STEP_SECONDS() | 0
    // 4646947d | WINDOW_SECONDS() | 0
    // 1fb99847 | WINDOW_STEPS() | 0
    // fb969b0a | bootstrap() | 1
    // 35142c8c | bootstrapped() | 0
    // 8945257c | buy(uint256,uint256,address,uint256) | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // ce858b9e | creatorBought() | 0
    // 61916b96 | creatorBuy(address,uint256) | 1
    // 7f5a7c7b | hook() | 0
    // 8129fc1c | initialize() | 1
    // 04baa00b | kind() | 0
    // a0e23ebd | openAt() | 0
    // dc4c90d3 | poolManager() | 0
    // fd3ab282 | q() | 0
    // ed1bd76c | quote(uint256) | 0
    // 35faa416 | sweep() | 0
    // 16a43460 | taxFor(uint256,uint256) | 0
    // c8ced51f | taxPips(uint256) | 0
    // 1dcc904e | taxTable() | 0
    // fc0c546a | token() | 0
    // 243389bc | totalSwept() | 0
    // d8454a82 | totalTaxCollected() | 0
    // 91dd7346 | unlockCallback(bytes) | 3
    // BoxReceiver
    // 1a809039 | ARGS_LENGTH() | 0
    // 43efdbf9 | FEE_SHARE_DENOMINATOR() | 0
    // 9e41bad3 | PLATFORM_CAP_WEI() | 0
    // 74edc090 | PLATFORM_EPOCH_SECONDS() | 0
    // d6b03efc | STREAM_NOTIFY_GAS() | 0
    // 3c1887af | TIP_BPS() | 0
    // af9b9da3 | acceptCreatorPayee() | 10
    // af7b75d0 | batchMin() | 0
    // a29a0552 | booked() | 0
    // 5518e7f8 | carried() | 0
    // d65c7f30 | claimCreator(address) | 10
    // 06ec16f8 | collect(address) | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // 2553b369 | creatorCap() | 0
    // 40e7120b | creatorHeld() | 0
    // 6ad55660 | creatorOwed() | 0
    // b92fee1b | creatorPayee() | 0
    // a15fd0cd | depthHeld() | 0
    // c34c08e5 | executor() | 0
    // 2d5537b0 | extension() | 0
    // 5230b878 | fitOwed() | 0
    // 2582c401 | fitWaitingT() | 0
    // b1ef04e1 | fundCreator() | 0
    // 379a3d81 | fundDepth() | 0
    // 539c8094 | fundFees() | 0
    // b73d8452 | graduationSettled() | 0
    // 7f5a7c7b | hook() | 0
    // 0d44eb6b | hookFeesPending() | 0
    // 8129fc1c | initialize() | 1
    // e7a3808f | itemStream() | 0
    // 04baa00b | kind() | 0
    // c4026c58 | moduleFeeAllowance() | 0
    // acc0dcca | moduleFeesPending() | 0
    // b8b78a3c | moduleOwed() | 0
    // 9e1f3cea | moduleProceeds(uint8,uint256) | 10
    // e2c49280 | noteModuleFees(uint256,uint256) | 8
    // cfc8c963 | onGraduation() | 0
    // 8669ae4a | payFit() | 0
    // ee4fb373 | payPlatform() | 0
    // 24247257 | pendingCreatorPayee() | 0
    // 1b8f4aa5 | platformEpoch() | 0
    // 37712a40 | platformHeld() | 0
    // 185cdcbc | platformOwed() | 0
    // 0372bf25 | platformSafe() | 0
    // dc4c90d3 | poolManager() | 0
    // ff73c9c5 | proposeCreatorPayee(address) | 10
    // 76f0b237 | pullForModule() | 10
    // fd3ab282 | q() | 0
    // df62cedc | qStream() | 0
    // e29bfaa4 | royaltyDestination() | 0
    // 6a9d1766 | streamCurveDepthT() | 0
    // fa716b3f | swapModule() | 0
    // 789775c0 | tBurnPending() | 0
    // c324d262 | tStream() | 0
    // 41136c5d | tipMax() | 0
    // fc0c546a | token() | 0
    // c038a38e | totals() | 0
    // 91dd7346 | unlockCallback(bytes) | 3
    // BoxCollection
    // 2262eb74 | OBSERVER_GAS() | 0
    // 4cb82968 | REVEAL_ALWAYS() | 0
    // c22c7099 | REVEAL_ON_EXIT() | 0
    // f66bb36e | REVEAL_ON_UNLOCK() | 0
    // 095ea7b3 | approve(address,uint256) | 0
    // 70a08231 | balanceOf(address) | 0
    // a1a0d078 | bannerSha256() | 0
    // ca6a1506 | collectionCoverSha256() | 0
    // 45c0f533 | collectionSize() | 0
    // e8a3d485 | contractURI() | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // 7284e416 | description() | 0
    // 5b9db898 | externalLink() | 0
    // 401576a2 | firstId() | 0
    // eb6e0614 | generatorHash() | 0
    // 081812fc | getApproved(uint256) | 0
    // 24ea3023 | hiddenDescription() | 0
    // 4c185cbd | hiddenSvg() | 0
    // ce178a04 | imageCid(uint256) | 0
    // 8129fc1c | initialize() | 1
    // e985e9c5 | isApprovedForAll(address,address) | 0
    // 24221362 | isRevealable(uint256) | 0
    // 5055fbc3 | isRevealed(uint256) | 0
    // 003cca59 | leafOf(uint256,uint128,bytes32,bytes32,bytes32,bytes32) | 0
    // d7268a2e | metadataTable() | 0
    // a227d60f | metadataTableBytes() | 0
    // 183698cb | metadataTableHash() | 0
    // 74c3519a | modelCid(uint256) | 0
    // 06fdde03 | name() | 0
    // 2b96bf34 | observerGas() | 0
    // 8da5cb5b | owner() | 0
    // 6352211e | ownerOf(uint256) | 0
    // f7260d3e | receiver() | 0
    // 45798f65 | reveal(uint256,uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]) | 0
    // b3419807 | revealRoot() | 0
    // 8008e8bc | revealState(uint256) | 0
    // c1b7775a | revealTriggers() | 0
    // 70145454 | revealUnlocker() | 0
    // bbd78e93 | revealedCount() | 0
    // c63adb2b | royaltyBps() | 0
    // e29bfaa4 | royaltyDestination() | 0
    // 2a55205a | royaltyInfo(uint256,uint256) | 0
    // cbe39c20 | royaltyRouter() | 0
    // 42842e0e | safeTransferFrom(address,address,uint256) | 0
    // b88d4fde | safeTransferFrom(address,address,uint256,bytes) | 0
    // a22cb465 | setApprovalForAll(address,bool) | 0
    // 01ffc9a7 | supportsInterface(bytes4) | 0
    // 95d89b41 | symbol() | 0
    // fc0c546a | token() | 0
    // 8f7bb179 | tokenJSON(uint256) | 0
    // c87b56dd | tokenURI(uint256) | 0
    // 18160ddd | totalSupply() | 0
    // 5efab6e4 | traitsOf(uint256) | 0
    // 23b872dd | transferFrom(address,address,uint256) | 0
    // e4f03356 | transferObserver() | 0
    // 16a56c41 | treeDepth() | 0
    // 4f6391ae | unlockReveal(uint256) | 10
    // fbfa77cf | vault() | 0
    // BoxVault
    // d73792a9 | FEE_DENOMINATOR() | 0
    // 2262eb74 | OBSERVER_GAS() | 0
    // babd7012 | activeSupply() | 0
    // 7de1e536 | collection() | 0
    // 45c0f533 | collectionSize() | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // e0c4b946 | deliverTicket(uint256,address) | 5
    // f225c5ea | drawFeeBps() | 0
    // 92849421 | escrowPrincipal() | 0
    // b4057bbd | escrowSurplus() | 0
    // 401576a2 | firstId() | 0
    // b35a7200 | gateOpen() | 0
    // a9247102 | gateOpenedAt() | 0
    // 7ccbf0e1 | handBackFeeWaived() | 0
    // 78e81ebe | hasLeftVault(uint256) | 0
    // db851dd7 | hiddenCount() | 0
    // 8129fc1c | initialize() | 1
    // 07d4d015 | inside() | 0
    // 43c9f97a | isHidden(uint256) | 0
    // f6a217f1 | isInside(uint256) | 0
    // c89b6d20 | isOnShelf(uint256) | 0
    // c256b1bd | isOutside(uint256) | 0
    // eb70e498 | observer() | 0
    // 2b96bf34 | observerGas() | 0
    // 150b7a02 | onERC721Received(address,address,uint256,bytes) | 0
    // 82dc7836 | openGate() | 1
    // 1913064d | openTickets(uint256,uint256) | 5
    // 9bcada07 | outside() | 0
    // 3a775fe7 | pendingTickets() | 0
    // ee9d4a20 | pickFeeBps() | 0
    // 55d9deba | quoteHandBack(uint256) | 0
    // 793fd246 | quoteReturn(uint256) | 0
    // 13d9df40 | quoteTake(uint256) | 0
    // ec211840 | quoteWithdraw(uint256) | 0
    // 9929716f | releaseTickets(uint256,address,uint256) | 5
    // e576cfd9 | returnFeeBps() | 0
    // 4bea9cab | returnItem(uint256,uint256,uint256) | 0
    // dd058abe | returnItems(uint256[],uint256,uint256) | 0
    // c18fe69d | shelfCount() | 0
    // db797ea9 | supplyFloor() | 0
    // 1771f9ce | ticketAdapter() | 0
    // fc0c546a | token() | 0
    // 6d1127d4 | unsolicitedToken() | 0
    // 657be509 | waiveHandBackFee() | 1
    // a41fe49f | withdraw(uint256,uint256,uint256) | 0
    // 108e9f6b | withdrawBatch(uint256[],uint256,uint256) | 0
    // BoxTickets
    // 3309d485 | RETURN_GRACE() | 0
    // 5888f5a0 | REVEAL_GRACE() | 0
    // 87c8cca6 | SILENCE() | 0
    // ef973b5c | SILENCE_UNREQUESTED() | 0
    // 1991ba6b | TAKE_DELAY() | 0
    // 84b85054 | acceptGraduationWord() | 0
    // 095ea7b3 | approve(address,uint256) | 0
    // 70a08231 | balanceOf(address) | 0
    // 92612c4c | cancelDraw(uint256) | 0
    // 7de1e536 | collection() | 0
    // 45c0f533 | collectionSize() | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // d2b8035a | draw(uint256,uint256) | 0
    // 231c4d3f | drawTicket(uint256) | 0
    // f6d7e547 | enterTerminal() | 0
    // 401576a2 | firstId() | 0
    // 081812fc | getApproved(uint256) | 0
    // 6ddc6dbd | graduationWord() | 0
    // fe5ae01b | handBack(uint256[],uint256,uint256) | 0
    // 8129fc1c | initialize() | 1
    // e985e9c5 | isApprovedForAll(address,address) | 0
    // 06fdde03 | name() | 0
    // 82bf3bc3 | numberOf(uint256) | 0
    // d51c46c4 | open(uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])) | 0
    // a0e23ebd | openAt() | 0
    // f827d294 | openDraw(uint256,address,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])) | 0
    // 6352211e | ownerOf(uint256) | 0
    // b1c9fe6e | phase() | 0
    // 64dd1d29 | poolPositionAt(uint256) | 0
    // 73b0cee1 | requestGraduationWord() | 0
    // fd561c7f | returnableFrom(uint256) | 0
    // 42842e0e | safeTransferFrom(address,address,uint256) | 0
    // b88d4fde | safeTransferFrom(address,address,uint256,bytes) | 0
    // a22cb465 | setApprovalForAll(address,bool) | 0
    // 8df82800 | settle(uint256) | 0
    // 263f3e7e | slotOf(uint256) | 0
    // 67e828bf | source() | 0
    // 200d2ed2 | status() | 0
    // 01ffc9a7 | supportsInterface(bytes4) | 0
    // 95d89b41 | symbol() | 0
    // 3738f1a5 | take(uint256,uint256,uint256) | 0
    // 405341a3 | takeByNumber(uint256,uint256,uint256,uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])) | 0
    // a1f55045 | ticketInFlight() | 0
    // fc0c546a | token() | 0
    // c87b56dd | tokenURI(uint256) | 0
    // 23b872dd | transferFrom(address,address,uint256) | 0
    // fbfa77cf | vault() | 0
    // BoxRoyaltyRouter
    // 0a009097 | coordinator() | 0
    // b269681d | destination() | 0
    // 6b9f96ea | flush() | 0
    // f7260d3e | receiver() | 0
    // 01681a62 | sweep(address) | 0
    // 3fc8cef3 | weth() | 0
    // BoxItemStream
    // 44df8e70 | burn() | 0
    // 8c574b48 | claim(uint256[],address) | 0
    // 82b25011 | claimFor(address,uint256[]) | 0
    // 7de1e536 | collection() | 0
    // 45c0f533 | collectionSize() | 0
    // 0a009097 | coordinator() | 0
    // 769da421 | coordinatorImplementation() | 0
    // 401576a2 | firstId() | 0
    // 7f5a7c7b | hook() | 0
    // 2986c0e5 | index() | 0
    // 8129fc1c | initialize() | 1
    // b4add307 | liabilities() | 0
    // cfc8c963 | onGraduation() | 0
    // f352bac5 | onItemTransfer(address,address,uint256) | 6
    // dc1ab9af | onStreamFunds(uint256) | 4
    // bf98a4a4 | onVaultAction(uint8,address,uint256,uint256) | 7
    // 87c9505f | openTickets() | 0
    // f07e19e4 | outsideCount() | 0
    // 228db984 | owedOf(address) | 0
    // 7e7feaa7 | pendingOf(uint256) | 0
    // dc4c90d3 | poolManager() | 0
    // f7260d3e | receiver() | 0
    // 3f35ff32 | startValue() | 0
    // 1f2698ab | started() | 0
    // b97c98e7 | streamValue() | 0
    // 21858521 | tickets() | 0
    // fc0c546a | token() | 0
    // c038a38e | totals() | 0
    // fbfa77cf | vault() | 0
    // BoxToken
    // b0267379 | ISSUANCE() | 0
    // dd62ed3e | allowance(address,address) | 0
    // 095ea7b3 | approve(address,uint256) | 0
    // 70a08231 | balanceOf(address) | 0
    // 42966c68 | burn(uint256) | 0
    // 313ce567 | decimals() | 0
    // b72218e3 | initialHolder() | 0
    // 378dc3dc | initialSupply() | 0
    // 06fdde03 | name() | 0
    // 95d89b41 | symbol() | 0
    // d89135cd | totalBurned() | 0
    // 18160ddd | totalSupply() | 0
    // a9059cbb | transfer(address,uint256) | 0
    // 23b872dd | transferFrom(address,address,uint256) | 0
    // fbfa77cf | vault() | 0
    // FitBuybackExecutor
    // c606e720 | CHECKPOINTS() | 0
    // 88a640ea | CHECKPOINT_SPACING() | 0
    // 1254b9af | MAX_CHUNKS_PER_BLOCK() | 0
    // cbc8307f | MAX_IMPACT_TICKS() | 0
    // 37bb2161 | MAX_OBSERVATION_STEP() | 0
    // 121cb671 | MIN_SQRT_PRICE_X96() | 0
    // dd1b9c4a | POOL_FEE() | 0
    // 46ca626b | TICK_SPACING() | 0
    // 19bb9d46 | TWAP_BAND_TICKS() | 0
    // e2c1d1d1 | TWAP_WINDOW() | 0
    // a1cc0656 | batchThreshold() | 0
    // ed01bf29 | budget() | 0
    // ff9536db | checkpointAt(uint256) | 0
    // fe0d94c1 | execute(uint256) | 0
    // e53bd8a1 | fitGraduated() | 0
    // 412c79cc | fundBudget() | 0
    // 473d2632 | graduationSeen() | 0
    // cd7033c4 | hooks() | 0
    // 43413d73 | latestSampleTick() | 0
    // c8c25dfe | launchPhase() | 0
    // 7dc0d1d0 | oracle() | 0
    // 18178358 | poke() | 0
    // 3e0dc34e | poolId() | 0
    // 182148ef | poolKey() | 0
    // dc4c90d3 | poolManager() | 0
    // f7260d3e | receiver() | 0
    // fc0c546a | token() | 0
    // d89135cd | totalBurned() | 0
    // 92d3b886 | totalEthSpent() | 0
    // a84fe7c0 | totalToBudget() | 0
    // 1208aa18 | twap() | 0
    // 91dd7346 | unlockCallback(bytes) | 3
    // BoxFactoryV1
    // 0c2a0adb | FACTORY_NONCE_BOX0() | 0
    // e4435bac | FACTORY_NONCE_REGISTRY() | 0
    // ad29ef7a | IMPL_COLLECTION() | 0
    // 4bb4a695 | IMPL_COORDINATOR() | 0
    // 4272eb04 | IMPL_HOOK() | 0
    // 56a527b4 | IMPL_ITEM_STREAM() | 0
    // c291fac8 | IMPL_LAUNCH_ROUTER() | 0
    // 5a548be9 | IMPL_RECEIVER() | 0
    // eda9ad01 | IMPL_TICKETS() | 0
    // 134b85df | IMPL_VAULT() | 0
    // 13524f3b | MW_COLLECTION() | 0
    // ccf5202c | MW_COORDINATOR() | 0
    // ad84f1b3 | MW_ETH() | 0
    // 2518a352 | MW_EXECUTOR() | 0
    // 6454a31d | MW_HOOK() | 0
    // 1466c81c | MW_POOL() | 0
    // 5dfffe96 | MW_RECEIVER() | 0
    // 609b368e | MW_ROUTER() | 0
    // 4418a904 | MW_ROYALTY() | 0
    // f2a84bba | MW_STREAM() | 0
    // 7879dd2f | MW_SUPPLY() | 0
    // 1639f2c7 | MW_TICKETS() | 0
    // 2689374d | MW_VAULT() | 0
    // ffa1ad74 | VERSION() | 0
    // b4a06cad | box0Addresses() | 0
    // 58e9c67d | box0Creator() | 0
    // efafe8c8 | createBox((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),bytes32,bytes) | 9
    // 6b9947b4 | executorInitCodeHash() | 0
    // 2e4995ed | hookExtension() | 0
    // 4d35d328 | hookInitCodeHash(uint32) | 0
    // 30e9012c | implementations() | 0
    // 32e4e363 | planner() | 0
    // 0372bf25 | platformSafe() | 0
    // dc4c90d3 | poolManager() | 0
    // 521ddcf5 | predictHook(uint32,bytes32) | 0
    // 36013189 | randomness() | 0
    // 398aad76 | receiverExtension() | 0
    // 6eb33577 | refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),address) | 0
    // 7b103999 | registry() | 0
    // 7c609cd0 | templateIdOf((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[])) | 0
    // 54fd4d50 | version() | 0
    // a08d119d | versionCodeHash() | 0
    // 3fc8cef3 | weth() | 0
    // BoxFactoryV1Planner
    // c6a5ed72 | NONCE_COLLECTION() | 0
    // 3845cb09 | NONCE_EXECUTOR() | 0
    // bbde0b20 | NONCE_RECEIVER() | 0
    // 13d282c2 | NONCE_ROUTER() | 0
    // 40917e67 | NONCE_ROYALTY() | 0
    // 9ed9f820 | NONCE_STREAM() | 0
    // 5f900316 | NONCE_TABLE() | 0
    // faa597c9 | NONCE_TICKETS() | 0
    // e5496f68 | NONCE_TOKEN() | 0
    // 8a537c47 | NONCE_VAULT() | 0
    // c22c7099 | REVEAL_ON_EXIT() | 0
    // 312a5257 | TEMPLATE_ID_TAG() | 0
    // 1211ada1 | addresses(address,bool) | 0
    // e88e10fa | hookInitCode((address,address,address,address,address,address,address,address,address,address,address,address,address,bytes32,bytes32,address,int24,int24,uint160,uint160,uint128,uint256),(address,address,address,address,address,address,address,address,address,address,address),uint32) | 0
    // 78b51ad3 | plan((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),(address,address,address,address,address,address,address,address,address,address,address,address,address,bytes32,bytes32,address,int24,int24,uint160,uint160,uint128,uint256),address,bytes32,bytes32) | 0
    // 6eb33577 | refusal((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),address) | 0
    // a02b3ca0 | templateIdOf((uint16,uint8,string,string,string,string,string,uint32,uint256,address,uint256,uint8,uint8,uint8,uint32,uint16,uint8,uint8,uint8,bytes32,bytes,bytes32,bytes32,bytes32,address,address,uint256,bytes32,(uint16,bytes)[]),bytes32,bytes32) | 0
    // BoxRegistry
    // 8aff4f2a | ROLE_COLLECTION() | 0
    // 572be4b3 | ROLE_COORDINATOR() | 0
    // e36bbed2 | ROLE_COUNT() | 0
    // d958ddf6 | ROLE_EXECUTOR() | 0
    // 16c0e2fc | ROLE_HOOK() | 0
    // 081ab602 | ROLE_ITEM_STREAM() | 0
    // 111f6b9a | ROLE_LAUNCH_ROUTER() | 0
    // 505a9087 | ROLE_METADATA_TABLE() | 0
    // a13b1ba3 | ROLE_RECEIVER() | 0
    // 692a5351 | ROLE_ROYALTY_ROUTER() | 0
    // de261db0 | ROLE_SWAP_MODULE() | 0
    // 9e801ab8 | ROLE_TICKETS() | 0
    // 7c9b032a | ROLE_TOKEN() | 0
    // 1c33e007 | ROLE_VAULT() | 0
    // 44ff038f | boxCount() | 0
    // 6523fc2d | boxIdOf(address) | 0
    // a75178cb | coordinatorOf(uint256) | 0
    // e2095c07 | entry(uint256) | 0
    // c45a0155 | factory() | 0
    // 81def29b | record(address,bytes32,bytes) | 2
    // 55d742e4 | recordOf(uint256) | 0
    // BoxHookExtension
    // a2fbdad6 | deepen(address) | 10
    // 01339c21 | launch() | 10
    // 454b0608 | migrate(uint256) | 10
    // 91dd7346 | unlockCallback(bytes) | 10
    // BoxReceiverExtension
    // af9b9da3 | acceptCreatorPayee() | 10
    // 769da421 | coordinatorImplementation() | 0
    // 8129fc1c | initialize() | 10
    // e2c49280 | noteModuleFees(uint256,uint256) | 10
    // ff73c9c5 | proposeCreatorPayee(address) | 10
    // BoxBackedSource
    // 2d3bd87b | BACKUP_AFTER() | 0
    // 6c709fe0 | BACKUP_TAG() | 0
    // e323c2f2 | DRAND() | 0
    // 9a7ca393 | DRAND_TAG() | 0
    // adf54cce | HISTORY() | 0
    // 5892f9be | HISTORY_WINDOW() | 0
    // e1370104 | LATEST_START() | 0
    // 78f94940 | MARGIN() | 0
    // d4a3bde1 | RECENT_BLOCKS() | 0
    // 87c8cca6 | SILENCE() | 0
    // 8e78ee80 | TARGET_BLOCKS() | 0
    // 38e43895 | addBounty(uint256) | 0
    // 80fc249c | backupOf(uint256) | 0
    // 7d21bd56 | bountyOf(uint256) | 0
    // a8a2370c | fixBackup(uint256,bytes) | 0
    // bb9fcf72 | isSilent(address,uint256) | 0
    // d845a4b3 | request(uint256) | 0
    // 5a69c50b | requestOf(address,uint256) | 0
    // 0e5a4ff3 | roundAt(uint256) | 0
    // fd56981a | roundTime(uint256) | 0
    // b4ef5dcb | startBackup(uint256,uint256,bytes) | 0
    // 2b3fb3a9 | wordOf(address,uint256) | 0
    // DrandSource
    // f2882461 | GENESIS_TIME() | 0
    // 78f94940 | MARGIN() | 0
    // b4d1d795 | PERIOD() | 0
    // 87c8cca6 | SILENCE() | 0
    // fe2cf9b2 | WORD_TAG() | 0
    // 38e43895 | addBounty(uint256) | 0
    // a7dfd6c2 | beaconOf(uint256) | 0
    // 7d21bd56 | bountyOf(uint256) | 0
    // bb9fcf72 | isSilent(address,uint256) | 0
    // 8462d661 | owedTo(address) | 0
    // cbb411f8 | postRound(uint256,bytes) | 0
    // d845a4b3 | request(uint256) | 0
    // 5a69c50b | requestOf(address,uint256) | 0
    // 0e5a4ff3 | roundAt(uint256) | 0
    // fd56981a | roundTime(uint256) | 0
    // 6dbf8108 | withdrawBounty(address) | 0
    // 2b3fb3a9 | wordOf(address,uint256) | 0
    function name(uint256 kind) internal pure returns (string memory) {
        if (kind == 0) return "BoxCoordinator";
        if (kind == 1) return "BoxHook";
        if (kind == 2) return "BoxLaunchRouter";
        if (kind == 3) return "BoxReceiver";
        if (kind == 4) return "BoxCollection";
        if (kind == 5) return "BoxVault";
        if (kind == 6) return "BoxTickets";
        if (kind == 7) return "BoxRoyaltyRouter";
        if (kind == 8) return "BoxItemStream";
        if (kind == 9) return "BoxToken";
        if (kind == 10) return "FitBuybackExecutor";
        if (kind == 11) return "BoxFactoryV1";
        if (kind == 12) return "BoxFactoryV1Planner";
        if (kind == 13) return "BoxRegistry";
        if (kind == 14) return "BoxHookExtension";
        if (kind == 15) return "BoxReceiverExtension";
        if (kind == 16) return "BoxBackedSource";
        if (kind == 17) return "DrandSource";
        revert("unknown kind");
    }

    function selectors(uint256 kind) internal pure returns (bytes memory) {
        if (kind == 0) {
            return hex"1a809039febe5cfc8aff4f2ad958ddf6081ab602111f6b9aa13b1ba3692a53519e801ab87c9b032a1c33e007987d4e34d279c1917de1e53602d05d3f20c800818778df72c34c08e5c45a0155d3618ccae7c2b7727f544e498d3931267f5a7c7be7a3808f04baa00b01339c21523925bf386834a3b1c9fe6edc4c90d3459bc132fd3ab282b361e19836013189f7260d3ecd3293de9532e2871d62ebd9cbe39c20839ea776b4deda33b1da0d1721858521fc0c546a91dd7346fbfa77cf";
        }
        if (kind == 1) {
            return hex"bbbf12be1a8090390ba2622d602ed6c55e3f2727e1f9f3378549d9be46ca626b4646947d9f063efce1b4af696fe7e6eb6c2bbe7eb47b2fb1259982e5b6a8b0fadc98354e21d0ee70575e24b4597e1fb528d53bc40a009097769da4217165485da2fbdad6f5bec8a6a3ec191a59c639992d5537b0c4e833cef77d46e04641257d8129fc1c04baa00b9099592901339c21523925bf454b0608727f7f47c1f38a2aa0e23ebd2f5162d1b1c9fe6e3e0dc34e182148efdc4c90d3eb3091b1fd3ab282b361e198f7260d3e2223a5da4c81433ffc0c546a91dd73466353052e";
        }
        if (kind == 2) {
            return hex"1a8090396672badb521164794646947d1fb99847fb969b0a35142c8c8945257c0a009097769da421ce858b9e61916b967f5a7c7b8129fc1c04baa00ba0e23ebddc4c90d3fd3ab282ed1bd76c35faa41616a43460c8ced51f1dcc904efc0c546a243389bcd8454a8291dd7346";
        }
        if (kind == 3) {
            return hex"1a80903943efdbf99e41bad374edc090d6b03efc3c1887afaf9b9da3af7b75d0a29a05525518e7f8d65c7f3006ec16f80a009097769da4212553b36940e7120b6ad55660b92fee1ba15fd0cdc34c08e52d5537b05230b8782582c401b1ef04e1379a3d81539c8094b73d84527f5a7c7b0d44eb6b8129fc1ce7a3808f04baa00bc4026c58acc0dccab8b78a3c9e1f3ceae2c49280cfc8c9638669ae4aee4fb373242472571b8f4aa537712a40185cdcbc0372bf25dc4c90d3ff73c9c576f0b237fd3ab282df62cedce29bfaa46a9d1766fa716b3f789775c0c324d26241136c5dfc0c546ac038a38e91dd7346";
        }
        if (kind == 4) {
            return hex"2262eb744cb82968c22c7099f66bb36e095ea7b370a08231a1a0d078ca6a150645c0f533e8a3d4850a009097769da4217284e4165b9db898401576a2eb6e0614081812fc24ea30234c185cbdce178a048129fc1ce985e9c5242213625055fbc3003cca59d7268a2ea227d60f183698cb74c3519a06fdde032b96bf348da5cb5b6352211ef7260d3e45798f65b34198078008e8bcc1b7775a70145454bbd78e93c63adb2be29bfaa42a55205acbe39c2042842e0eb88d4fdea22cb46501ffc9a795d89b41fc0c546a8f7bb179c87b56dd18160ddd5efab6e423b872dde4f0335616a56c414f6391aefbfa77cf";
        }
        if (kind == 5) {
            return hex"d73792a92262eb74babd70127de1e53645c0f5330a009097769da421e0c4b946f225c5ea92849421b4057bbd401576a2b35a7200a92471027ccbf0e178e81ebedb851dd78129fc1c07d4d01543c9f97af6a217f1c89b6d20c256b1bdeb70e4982b96bf34150b7a0282dc78361913064d9bcada073a775fe7ee9d4a2055d9deba793fd24613d9df40ec2118409929716fe576cfd94bea9cabdd058abec18fe69ddb797ea91771f9cefc0c546a6d1127d4657be509a41fe49f108e9f6b";
        }
        if (kind == 6) {
            return hex"3309d4855888f5a087c8cca6ef973b5c1991ba6b84b85054095ea7b370a0823192612c4c7de1e53645c0f5330a009097769da421d2b8035a231c4d3ff6d7e547401576a2081812fc6ddc6dbdfe5ae01b8129fc1ce985e9c506fdde0382bf3bc3d51c46c4a0e23ebdf827d2946352211eb1c9fe6e64dd1d2973b0cee1fd561c7f42842e0eb88d4fdea22cb4658df82800263f3e7e67e828bf200d2ed201ffc9a795d89b413738f1a5405341a3a1f55045fc0c546ac87b56dd23b872ddfbfa77cf";
        }
        if (kind == 7) return hex"0a009097b269681d6b9f96eaf7260d3e01681a623fc8cef3";
        if (kind == 8) {
            return hex"44df8e708c574b4882b250117de1e53645c0f5330a009097769da421401576a27f5a7c7b2986c0e58129fc1cb4add307cfc8c963f352bac5dc1ab9afbf98a4a487c9505ff07e19e4228db9847e7feaa7dc4c90d3f7260d3e3f35ff321f2698abb97c98e721858521fc0c546ac038a38efbfa77cf";
        }
        if (kind == 9) {
            return hex"b0267379dd62ed3e095ea7b370a0823142966c68313ce567b72218e3378dc3dc06fdde0395d89b41d89135cd18160ddda9059cbb23b872ddfbfa77cf";
        }
        if (kind == 10) {
            return hex"c606e72088a640ea1254b9afcbc8307f37bb2161121cb671dd1b9c4a46ca626b19bb9d46e2c1d1d1a1cc0656ed01bf29ff9536dbfe0d94c1e53bd8a1412c79cc473d2632cd7033c443413d73c8c25dfe7dc0d1d0181783583e0dc34e182148efdc4c90d3f7260d3efc0c546ad89135cd92d3b886a84fe7c01208aa1891dd7346";
        }
        if (kind == 11) {
            return hex"0c2a0adbe4435bacad29ef7a4bb4a6954272eb0456a527b4c291fac85a548be9eda9ad01134b85df13524f3bccf5202cad84f1b32518a3526454a31d1466c81c5dfffe96609b368e4418a904f2a84bba7879dd2f1639f2c72689374dffa1ad74b4a06cad58e9c67defafe8c86b9947b42e4995ed4d35d32830e9012c32e4e3630372bf25dc4c90d3521ddcf536013189398aad766eb335777b1039997c609cd054fd4d50a08d119d3fc8cef3";
        }
        if (kind == 12) {
            return hex"c6a5ed723845cb09bbde0b2013d282c240917e679ed9f8205f900316faa597c9e5496f688a537c47c22c7099312a52571211ada1e88e10fa78b51ad36eb33577a02b3ca0";
        }
        if (kind == 13) {
            return hex"8aff4f2a572be4b3e36bbed2d958ddf616c0e2fc081ab602111f6b9a505a9087a13b1ba3692a5351de261db09e801ab87c9b032a1c33e00744ff038f6523fc2da75178cbe2095c07c45a015581def29b55d742e4";
        }
        if (kind == 14) return hex"a2fbdad601339c21454b060891dd7346";
        if (kind == 15) return hex"af9b9da3769da4218129fc1ce2c49280ff73c9c5";
        if (kind == 16) {
            return hex"2d3bd87b6c709fe0e323c2f29a7ca393adf54cce5892f9bee137010478f94940d4a3bde187c8cca68e78ee8038e4389580fc249c7d21bd56a8a2370cbb9fcf72d845a4b35a69c50b0e5a4ff3fd56981ab4ef5dcb2b3fb3a9";
        }
        if (kind == 17) {
            return hex"f288246178f94940b4d1d79587c8cca6fe2cf9b238e43895a7dfd6c27d21bd56bb9fcf728462d661cbb411f8d845a4b35a69c50b0e5a4ff3fd56981a6dbf81082b3fb3a9";
        }
        revert("unknown kind");
    }

    function authorities(uint256 kind) internal pure returns (bytes memory) {
        if (kind == 0) {
            return hex"0000000000000000000000000000000002000000000000000000020000000000000000000000000000000000000300";
        }
        if (kind == 1) {
            return hex"00000000000000000000000000030000000000000000000000000000000000040100000100010000000000000000000000000000000300";
        }
        if (kind == 2) return hex"000000000001000000000001000100000000000000000000000003";
        if (kind == 3) {
            return hex"0000000000000a0000000a0000000000000000000000000000000000000100000000000a080000000000000000000a0a0000000000000000000003";
        }
        if (kind == 4) {
            return hex"0000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000a00";
        }
        if (kind == 5) {
            return hex"0000000000000005000000000000000000010000000000000000010500000000000000050000000000000000010000";
        }
        if (kind == 6) {
            return hex"000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 7) return hex"000000000000";
        if (kind == 8) return hex"0000000000000000000001000006040700000000000000000000000000";
        if (kind == 9) return hex"000000000000000000000000000000";
        if (kind == 10) return hex"0000000000000000000000000000000000000000000000000000000000000003";
        if (kind == 11) {
            return hex"00000000000000000000000000000000000000000000000000000900000000000000000000000000000000";
        }
        if (kind == 12) return hex"0000000000000000000000000000000000";
        if (kind == 13) return hex"000000000000000000000000000000000000000200";
        if (kind == 14) return hex"0a0a0a0a";
        if (kind == 15) return hex"0a000a0a0a";
        if (kind == 16) return hex"00000000000000000000000000000000000000000000";
        if (kind == 17) return hex"0000000000000000000000000000000000";
        revert("unknown kind");
    }

    function sample(uint256 kind, uint256 index) internal pure returns (bytes memory) {
        if (kind == 0 && index == 16) {
            return hex"8778df72000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 0 && index == 26) return hex"01339c21";
        if (kind == 0 && index == 45) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 1 && index == 13) {
            return hex"b47b2fb1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 1 && index == 31) return hex"4641257d";
        if (kind == 1 && index == 32) return hex"8129fc1c";
        if (kind == 1 && index == 35) return hex"01339c21";
        if (kind == 1 && index == 37) {
            return hex"454b06080000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 1 && index == 53) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 2 && index == 5) return hex"fb969b0a";
        if (kind == 2 && index == 11) {
            return hex"61916b9600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 2 && index == 13) return hex"8129fc1c";
        if (kind == 2 && index == 26) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 3 && index == 6) return hex"af9b9da3";
        if (kind == 3 && index == 10) {
            return hex"d65c7f300000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 3 && index == 29) return hex"8129fc1c";
        if (kind == 3 && index == 35) {
            return hex"9e1f3cea00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 3 && index == 36) {
            return hex"e2c4928000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 3 && index == 46) {
            return hex"ff73c9c50000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 3 && index == 47) return hex"76f0b237";
        if (kind == 3 && index == 58) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 4 && index == 20) return hex"8129fc1c";
        if (kind == 4 && index == 57) {
            return hex"4f6391ae0000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 5 && index == 7) {
            return hex"e0c4b94600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 5 && index == 17) return hex"8129fc1c";
        if (kind == 5 && index == 26) return hex"82dc7836";
        if (kind == 5 && index == 27) {
            return hex"1913064d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 5 && index == 35) {
            return hex"9929716f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 5 && index == 44) return hex"657be509";
        if (kind == 6 && index == 20) return hex"8129fc1c";
        if (kind == 8 && index == 10) return hex"8129fc1c";
        if (kind == 8 && index == 13) {
            return hex"f352bac5000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 8 && index == 14) {
            return hex"dc1ab9af0000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 8 && index == 15) {
            return hex"bf98a4a40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 10 && index == 31) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 11 && index == 26) {
            return hex"efafe8c80000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000003e000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000420000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000046000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 13 && index == 19) {
            return hex"81def29b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 14 && index == 0) {
            return hex"a2fbdad60000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 14 && index == 1) return hex"01339c21";
        if (kind == 14 && index == 2) {
            return hex"454b06080000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 14 && index == 3) {
            return hex"91dd734600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 15 && index == 0) return hex"af9b9da3";
        if (kind == 15 && index == 2) return hex"8129fc1c";
        if (kind == 15 && index == 3) {
            return hex"e2c4928000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        }
        if (kind == 15 && index == 4) {
            return hex"ff73c9c50000000000000000000000000000000000000000000000000000000000000000";
        }
        revert("not a caller-restricted selector");
    }
}
