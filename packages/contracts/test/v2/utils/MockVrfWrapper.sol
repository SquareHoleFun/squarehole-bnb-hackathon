// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST ONLY. A local stand-in for Chainlink's "VRFV2PlusWrapper 1.0.0" (mainnet 0x02aa…D910c), written from its
/// verified source: the same native price formula and mainnet configuration (wrapper overhead 13,400; coordinator
/// overhead 90,000 native + 435 per word; premium 24%; flat fee 0; at most 10 words; read on chain 2026-09-30), the same
/// request checks (configured and not disabled, ExtraArgsV1 with nativePayment, msg.value ≥ price, numWords ≤ max), the
/// same callback record, and a fulfilment that calls the requester's `rawFulfillRandomWords` with exactly the recorded
/// callback gas limit and ignores its failure (`_callWithExactGas`, `WrapperFulfillmentFailed`). Failure modes model
/// what a vendor change or a broken coordinator can do. `s_vrfCoordinator` is the coordinator its owner set
/// (`VRFConsumerBaseV2Plus`); when it has code, a request runs that coordinator's own checks first (`MockVrfCoordinator`:
/// its reentrancy lock and minimum confirmations), as the real wrapper's call to `requestRandomWords` does. The fork
/// suites run the real wrapper.
contract MockVrfWrapper {
    enum RequestMode {
        Normal,
        Revert,
        BurnGas,
        ShortReturn,
        HugeReturn
    }

    enum PriceMode {
        Normal,
        Revert,
        BurnGas,
        ShortReturn
    }

    struct Callback {
        address callbackAddress;
        uint32 callbackGasLimit;
        uint64 requestGasPrice;
    }

    struct LastRequest {
        address requester;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        uint32 numWords;
        bytes extraArgs;
        uint256 value;
    }

    event WrapperFulfillmentFailed(uint256 indexed requestId, address indexed consumer);

    bytes4 internal constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    uint32 public wrapperGasOverhead = 13_400;
    uint32 public coordinatorGasOverheadNative = 90_000;
    uint16 public coordinatorGasOverheadPerWord = 435;
    uint8 public nativePremiumPercentage = 24;
    uint32 public fulfillmentFlatFeeNativePPM;
    uint8 public maxNumWords = 10;
    bool public disabled;
    RequestMode public requestMode;
    PriceMode public priceMode;

    /// @notice VRFConsumerBaseV2Plus: the coordinator requests go to and answers come from (its owner can change it).
    address public s_vrfCoordinator;
    uint256 public lastRequestId;
    uint256 public requestCount;
    /// @notice Gas the last callback used (measured around the exact-gas call, as the real wrapper runs it).
    uint256 public lastCallbackGasUsed;
    LastRequest public lastRequest;
    mapping(uint256 => Callback) public callbacks;

    // --------------------------------------------------------------------------------------------------------------
    // Test controls (the real wrapper's owner can disable it and change the fee configuration)

    function setDisabled(bool on) external {
        disabled = on;
    }

    function setRequestMode(RequestMode mode) external {
        requestMode = mode;
    }

    function setPriceMode(PriceMode mode) external {
        priceMode = mode;
    }

    function setFees(uint8 premiumPercentage, uint32 flatFeeNativePPM, uint32 coordinatorOverhead) external {
        nativePremiumPercentage = premiumPercentage;
        fulfillmentFlatFeeNativePPM = flatFeeNativePPM;
        coordinatorGasOverheadNative = coordinatorOverhead;
    }

    function setMaxNumWords(uint8 max) external {
        maxNumWords = max;
    }

    /// @notice The owner's `setCoordinator` (or a subscription migration).
    function setCoordinator(address coordinator) external {
        s_vrfCoordinator = coordinator;
    }

    /// @notice The mainnet configuration, for a copy of this code etched at a real wrapper's address (etching copies
    /// code, not the storage the constructor wrote).
    function setDefaults() external {
        wrapperGasOverhead = 13_400;
        coordinatorGasOverheadNative = 90_000;
        coordinatorGasOverheadPerWord = 435;
        nativePremiumPercentage = 24;
        maxNumWords = 10;
    }

    // --------------------------------------------------------------------------------------------------------------
    // The wrapper's surface

    function calculateRequestPriceNative(uint32 callbackGasLimit, uint32 numWords) external view returns (uint256) {
        require(!disabled, "wrapper is disabled");
        if (priceMode == PriceMode.Revert) revert("price feed down");
        if (priceMode == PriceMode.BurnGas) {
            while (true) {}
        }
        if (priceMode == PriceMode.ShortReturn) {
            assembly ("memory-safe") {
                return(0, 16)
            }
        }
        return _price(callbackGasLimit, numWords, tx.gasprice);
    }

    function estimateRequestPriceNative(uint32 callbackGasLimit, uint32 numWords, uint256 gasPrice)
        external
        view
        returns (uint256)
    {
        require(!disabled, "wrapper is disabled");
        return _price(callbackGasLimit, numWords, gasPrice);
    }

    function requestRandomWordsInNative(
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        uint32 numWords,
        bytes calldata extraArgs
    ) external payable returns (uint256 requestId) {
        require(!disabled, "wrapper is disabled");
        if (requestMode == RequestMode.Revert) revert("coordinator: invalid subscription");
        if (requestMode == RequestMode.BurnGas) {
            while (true) {}
        }
        require(extraArgs.length >= 36 && bytes4(extraArgs[0:4]) == EXTRA_ARGS_V1_TAG, "extra args");
        require(extraArgs[35] == hex"01", "LINKPaymentInRequestRandomWordsInNative");
        require(msg.value >= _price(callbackGasLimit, numWords, tx.gasprice), "fee too low");
        require(numWords <= maxNumWords, "numWords too high");
        address coordinator = s_vrfCoordinator;
        if (coordinator.code.length != 0) {
            (bool ok, bytes memory reason) =
                coordinator.staticcall(abi.encodeWithSignature("checkRequest(uint16)", requestConfirmations));
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
        requestId = uint256(keccak256(abi.encode(address(this), ++requestCount)));
        lastRequestId = requestId;
        lastRequest = LastRequest({
            requester: msg.sender,
            callbackGasLimit: callbackGasLimit,
            requestConfirmations: requestConfirmations,
            numWords: numWords,
            extraArgs: extraArgs,
            value: msg.value
        });
        callbacks[requestId] = Callback({
            callbackAddress: msg.sender,
            callbackGasLimit: callbackGasLimit,
            // casting to 'uint64' is safe because test gas prices stay far below 2^64 wei
            // forge-lint: disable-next-line(unsafe-typecast)
            requestGasPrice: uint64(tx.gasprice)
        });
        if (requestMode == RequestMode.ShortReturn) {
            assembly ("memory-safe") {
                return(0, 8)
            }
        }
        if (requestMode == RequestMode.HugeReturn) {
            assembly ("memory-safe") {
                return(0, 100000)
            }
        }
    }

    /// @notice The coordinator's fulfilment, as the wrapper forwards it: exactly the callback gas limit, failure
    /// ignored. Returns whether the requester's callback succeeded.
    function fulfill(uint256 requestId, uint256[] memory words) public returns (bool success) {
        Callback memory c = callbacks[requestId];
        delete callbacks[requestId];
        require(c.callbackAddress != address(0), "request not found");
        bytes memory data = abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, words);
        uint256 g = gasleft();
        success = _callWithExactGas(c.callbackGasLimit, c.callbackAddress, data);
        lastCallbackGasUsed = g - gasleft();
        if (!success) emit WrapperFulfillmentFailed(requestId, c.callbackAddress);
    }

    function fulfillOne(uint256 requestId, uint256 word) external returns (bool) {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        return fulfill(requestId, words);
    }

    function _price(uint256 gas, uint32 numWords, uint256 gasPrice) internal view returns (uint256) {
        uint256 wrapperCost = gasPrice * wrapperGasOverhead;
        uint256 coordinatorCost =
            gasPrice * (gas + coordinatorGasOverheadNative + uint256(numWords) * coordinatorGasOverheadPerWord);
        return wrapperCost + (coordinatorCost * (uint256(nativePremiumPercentage) + 100)) / 100 + 1e12
            * uint256(fulfillmentFlatFeeNativePPM);
    }

    function _callWithExactGas(uint256 gasAmount, address target, bytes memory data) private returns (bool success) {
        assembly ("memory-safe") {
            let g := gas()
            if lt(g, 5000) { revert(0, 0) }
            g := sub(g, 5000)
            if iszero(gt(sub(g, div(g, 64)), gasAmount)) { revert(0, 0) }
            if iszero(extcodesize(target)) { revert(0, 0) }
            success := call(gasAmount, target, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }
}
