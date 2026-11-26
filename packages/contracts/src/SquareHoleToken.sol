// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// DN404 and DN404Mirror: Vectorized/dn404 @ 3397cb11558ac853912ee87871422b6a29c9d346, MIT (see DEPENDENCIES.md).
import {DN404} from "dn404/DN404.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {ISquareHoleToken} from "./interfaces/ISquareHoleToken.sol";
import {LaunchTokenCore} from "./base/LaunchTokenCore.sol";

/// @title SquareHoleToken
/// @notice T for one Square Hole NFT launch ("nft_collection"): a DN404 ERC-20/ERC-721 pair with automatic
/// fractionalization at an immutable ratio (ADR-0009 F10 addendum). Every collection has the same fixed supply of
/// exactly 1,000,000,000 tokens (1e27 raw, 18 decimals), whatever its size. The creator chooses only the number of
/// NFTs N; one NFT is `unit` = 1e27 / N raw units, which must be exact (1e27 % N == 0, i.e. N = 2^a × 5^b with
/// a, b ≤ 27), with 1 ≤ N ≤ 1e9 (at least one whole token per NFT). Examples: N = 10,000 → 100,000 tokens per NFT;
/// N = 1,000 → 1,000,000; N = 1,024 → 976,562.5. The launcher bounds N further by the template (10,000 on the
/// testnet templates, ADR-0011 §4).
/// @dev Changes to the pinned DN404 base, all by override (ADR-0010, ADR-0011):
/// - every balance write (initial supply, _mint, _mintNext, _burn, _transfer, _transferFromNFT) first calls the
///   reward ledger with the pre-change balances (`LaunchTokenCore._checkpoint`);
/// - Permit2 gets no default infinite allowance;
/// - EIP-7702-delegated EOAs receive NFTs by default like plain EOAs; other contracts keep skipNFT;
/// - the fee collector can burn only its own balance; nothing else can burn, and nothing can mint after launch;
/// - the fallback rejects ETH (the mirror forwards msg.value to it).
/// There is no owner, no transfer fee, no upgrade path and no metadata setter.
contract SquareHoleToken is DN404, LaunchTokenCore {
    /// @notice Immutable launch terms.
    struct LaunchTerms {
        string name;
        string symbol;
        // Optional cross-check: 0 (derive), or exactly 1e9 / N when N divides 1e9 (whole tokens per NFT).
        uint256 fractionsPerNft;
        uint256 collectionSize; // N whole NFTs: 1 ≤ N ≤ 1e9 and 1e27 % N == 0; the supply is always 1e27 raw
        address initialHolder; // receives the whole initial supply (the pool hook)
        address feeCollector;
        address rewardLedger;
        string baseURI; // tokenURI(id) = baseURI + decimal(id) + ".json"; empty means no URI (immutable)
        bytes32 metadataManifestHash; // commitment to the metadata manifest
    }

    event Launched(
        address indexed mirror,
        address indexed initialHolder,
        uint256 fractionsPerNft,
        uint256 collectionSize,
        address feeCollector,
        address rewardLedger,
        string baseURI,
        bytes32 metadataManifestHash
    );

    error InvalidFractionsPerNft(uint256 fractionsPerNft);
    error InvalidCollectionSize(uint256 collectionSize);
    error ValueNotAccepted();

    /// @notice Largest collection: 1e9 NFTs of one whole token each (far inside DN404's 2^32 − 2 NFT ids).
    uint256 public constant MAX_COLLECTION_SIZE = 1e9;

    /// @notice Whole tokens per NFT, 1e9 / N, when that is an integer (N divides 1e9); 0 otherwise (for example
    /// N = 1,024: 976,562.5 tokens per NFT). `unit` is always exact; readers should use it (or initialSupply / N).
    uint256 public immutable fractionsPerNft;
    /// @notice N: whole NFTs the supply represents at launch.
    uint256 public immutable collectionSize;
    /// @notice Raw units per whole NFT (DN404 `_unit()`): 1e27 / N, exact and constant.
    uint256 public immutable unit;

    string private _baseURI;

    constructor(LaunchTerms memory terms)
        LaunchTokenCore(
            terms.name,
            terms.symbol,
            _collectionWholeSupply(terms.fractionsPerNft, terms.collectionSize),
            terms.initialHolder,
            terms.feeCollector,
            terms.rewardLedger,
            terms.metadataManifestHash
        )
    {
        uint256 derivedFractions = _wholeTokensPerNft(terms.collectionSize);
        fractionsPerNft = derivedFractions;
        collectionSize = terms.collectionSize;
        unit = FIXED_SUPPLY / terms.collectionSize;
        _baseURI = terms.baseURI;

        // First CREATE of this contract (nonce 1); the ledger excludes that address.
        address mirror = address(new DN404Mirror(msg.sender));
        if (IRewardLedger(terms.rewardLedger).mirror() != mirror) revert WiringMismatch();
        _initializeDN404(initialSupply, terms.initialHolder, mirror);

        emit Launched(
            mirror,
            terms.initialHolder,
            derivedFractions,
            terms.collectionSize,
            terms.feeCollector,
            terms.rewardLedger,
            terms.baseURI,
            terms.metadataManifestHash
        );
    }

    /// @dev F10: validates N (1 ≤ N ≤ MAX_COLLECTION_SIZE, and 1e27 % N == 0 so every NFT is an exact unit) and the
    /// optional cross-check r (0, or exactly 1e9 / N when N divides 1e9); returns the fixed whole supply.
    function _collectionWholeSupply(uint256 r, uint256 n) private pure returns (uint256) {
        if (n == 0 || n > MAX_COLLECTION_SIZE || FIXED_SUPPLY % n != 0) revert InvalidCollectionSize(n);
        if (r != 0 && r != _wholeTokensPerNft(n)) revert InvalidFractionsPerNft(r);
        return FIXED_WHOLE_SUPPLY;
    }

    /// @dev 1e9 / N when N divides 1e9, else 0 (a unit that is not a whole number of tokens).
    function _wholeTokensPerNft(uint256 n) private pure returns (uint256) {
        return FIXED_WHOLE_SUPPLY % n == 0 ? FIXED_WHOLE_SUPPLY / n : 0;
    }

    /*//////////////////////////////////////////////////////////////
                               METADATA
    //////////////////////////////////////////////////////////////*/

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    /// @notice 18: one displayed token is one fraction; one NFT is `unit` / 1e18 tokens (1e9 / N).
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function baseURI() external view returns (string memory) {
        return _baseURI;
    }

    /// @notice NFT ids owned by `owner` at owner-array indices [begin, end) (off-chain helper).
    function ownedIds(address owner, uint256 begin, uint256 end) external view returns (uint256[] memory) {
        return _ownedIds(owner, begin, end);
    }

    /// @notice Total NFTs currently materialized (also `mirror.totalSupply()`).
    function totalNFTSupply() external view returns (uint256) {
        return _totalNFTSupply();
    }

    /// @inheritdoc ISquareHoleToken
    function balanceOf(address owner) public view override(DN404, ISquareHoleToken) returns (uint256) {
        return DN404.balanceOf(owner);
    }

    /// @inheritdoc ISquareHoleToken
    function totalSupply() public view override(DN404, ISquareHoleToken) returns (uint256) {
        return DN404.totalSupply();
    }

    /*//////////////////////////////////////////////////////////////
                          REWARD CHECKPOINTS
    //////////////////////////////////////////////////////////////*/

    function _initializeDN404(uint256 initialTokenSupply, address initialSupplyOwner, address mirror)
        internal
        override
    {
        _checkpoint(address(0), initialSupplyOwner, initialTokenSupply);
        super._initializeDN404(initialTokenSupply, initialSupplyOwner, mirror);
    }

    function _mint(address to, uint256 amount) internal override {
        _checkpoint(address(0), to, amount);
        super._mint(to, amount);
    }

    function _mintNext(address to, uint256 amount) internal override {
        _checkpoint(address(0), to, amount);
        super._mintNext(to, amount);
    }

    function _burn(address from, uint256 amount) internal override {
        _checkpoint(from, address(0), amount);
        super._burn(from, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        _checkpoint(from, to, amount);
        super._transfer(from, to, amount);
    }

    function _transferFromNFT(address from, address to, uint256 id, address msgSender) internal override {
        _checkpoint(from, to, unit);
        super._transferFromNFT(from, to, id, msgSender);
    }

    function _burnFeeInventory(uint256 amount) internal override {
        _burn(msg.sender, amount);
    }

    function _balanceForCheckpoint(address account) internal view override returns (uint256) {
        return DN404.balanceOf(account);
    }

    /*//////////////////////////////////////////////////////////////
                           DN404 CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @dev 1e27 / N, immutable (DN404: "MUST be kept constant after `_initializeDN404`"). ≤ 1e27 < 2^96.
    function _unit() internal view override returns (uint256) {
        return unit;
    }

    /// @dev AGENTS.md: no infinite allowance by default. Constant, so the Guardian L-07 caveat does not apply.
    function _givePermit2DefaultInfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    /// @dev Contracts skip NFTs by default. An EIP-7702-delegated EOA (code = 0xef0100 ‖ 20-byte delegate, 23 bytes)
    /// is treated as an EOA and receives NFTs, so "automatic fractionalization" (C06) reaches upgraded wallets.
    /// Any account can still opt out with `setSkipNFT(true)`. Since EIP-3541, no contract code starts with 0xef.
    function _skipNFTDefault(address owner) internal view override returns (bool result) {
        assembly ("memory-safe") {
            let size := extcodesize(owner)
            result := iszero(iszero(size))
            if eq(size, 23) {
                extcodecopy(owner, 0x00, 0x00, 0x03)
                if eq(shr(232, mload(0x00)), 0xef0100) { result := 0 }
            }
        }
    }

    /// @dev `baseURI + decimal(id) + ".json"` (static hosting serves `<id>.json` with a JSON content type; ADR-0011
    /// F10 addendum), or "" when the immutable baseURI is empty. Ids run from 1 to N.
    function _tokenURI(uint256 id) internal view override returns (string memory) {
        string memory base = _baseURI;
        if (bytes(base).length == 0) return "";
        return string.concat(base, _toDecimalString(id), ".json");
    }

    /// @dev Rejects ETH on every path, including mirror calls that forward msg.value; then dispatches DN404's
    /// mirror hooks unchanged.
    modifier rejectsValue() {
        if (msg.value != 0) revert ValueNotAccepted();
        _;
    }

    fallback() external payable override rejectsValue dn404Fallback {
        revert FnSelectorNotRecognized();
    }

    function _toDecimalString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits = 0;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                --digits;
                // casting to 'uint8' is safe because 48 + (value % 10) is at most 57
                // forge-lint: disable-next-line(unsafe-typecast)
                buffer[digits] = bytes1(uint8(48 + value % 10));
            }
            value /= 10;
        }
        return string(buffer);
    }
}
