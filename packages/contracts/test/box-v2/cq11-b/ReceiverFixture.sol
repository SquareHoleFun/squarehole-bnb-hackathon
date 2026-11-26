// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeChoice} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

contract ReceiverCoordinator {
    bool public graduated;
    bool public failed;

    // Optional part lookup used inside the bounded tip payout. Real wiring is covered by Fable's real fixture.
    function roleAddress(uint256) external pure returns (address) { return address(0); }

    function setGraduated() external {
        graduated = true;
    }

    function setFailed() external {
        failed = true;
    }

    function initialize(BoxReceiverV2 r) external {
        r.initialize();
    }

    function graduation(BoxReceiverV2 r) external {
        graduated = true;
        r.onGraduation();
    }

    function failure(BoxReceiverV2 r) external {
        failed = true;
        r.enterFailure();
    }
}

// The fixture supplies only the CQ11-A boundary. Swaps and claims use real v4-core.
contract ReceiverHook {
    uint256 public buyers;
    uint256 public sellers;
    uint256 public reserve;
    uint256 public lastProtocolBlock;
    address public receiver;

    function wire(address r) external {
        receiver = r;
    }

    function script(uint256 b, uint256 s, uint256 d) external {
        buyers = b;
        sellers = s;
        reserve = d;
    }

    function mark() external {
        lastProtocolBlock = block.number;
    }

    function harvest() external returns (uint256, uint256, uint256) {
        require(msg.sender == receiver);
        (uint256 b, uint256 s, uint256 d) = (buyers, sellers, reserve);
        buyers = 0;
        sellers = 0;
        reserve = 0;
        return (b, s, d);
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata p, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == receiver) {
            require(p.zeroForOne && lastProtocolBlock != block.number, "step");
            lastProtocolBlock = block.number;
        }
        return (this.beforeSwap.selector, BeforeSwapDelta.wrap(0), uint24(10_000 | 0x400000));
    }
}

contract ReceiverBurnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint8 public burnMode;

    function mode(uint8 m) external {
        burnMode = m;
    }

    function mint(address to, uint256 n) external {
        balanceOf[to] += n;
        totalSupply += n;
    }

    function approve(address s, uint256 n) external returns (bool) {
        allowance[msg.sender][s] = n;
        return true;
    }

    function transfer(address to, uint256 n) external returns (bool) {
        balanceOf[msg.sender] -= n;
        balanceOf[to] += n;
        return true;
    }

    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n;
        balanceOf[from] -= n;
        balanceOf[to] += n;
        return true;
    }

    function burn(uint256 n) external {
        require(burnMode != 1, "floor");
        if (burnMode == 2) return;
        if (burnMode == 3) {
            assembly { for {} 1 {} {} }
        }
        balanceOf[msg.sender] -= n;
        totalSupply -= n;
    }
}

contract ReceiverSafe {
    receive() external payable {}
}

contract ReceiverRefuser {
    receive() external payable {
        revert("no");
    }
}

contract ReceiverGasSink {
    receive() external payable {
        assembly { for {} 1 {} {} }
    }
}

contract ReceiverForeignUnlock is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager p) {
        pm = p;
    }

    function attempt(address r, bytes calldata data) external {
        pm.unlock(abi.encode(r, data));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address r, bytes memory callData) = abi.decode(data, (address, bytes));
        (bool ok, bytes memory result) = r.call(callData);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        return "";
    }
}

abstract contract ReceiverFixture is Test {
    IPoolManager internal pm;
    PoolDriver internal driver;
    HostileToken internal p;
    ReceiverBurnToken internal t;
    ReceiverCoordinator internal coord;
    address internal coordinatorCode;
    ReceiverHook internal hook;
    BoxReceiverV2 internal implementation;
    BoxReceiverV2 internal r;
    address internal constant FIT = address(0xF17);
    address internal constant PLATFORM = address(0xF18);
    address internal constant CONVERSION = address(0xF19);
    address internal constant PAYEE = address(0xC1);
    address internal constant TIP = address(0xC2);

    function setUp() public virtual {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        driver = new PoolDriver(pm);
        p = new HostileToken("P", "P", 6);
        // Sorted pricing coin and T, including the real swap case.
        ReceiverBurnToken tCode = new ReceiverBurnToken();
        address ta = address(uint160(address(p)) + 1);
        vm.etch(ta, address(tCode).code);
        t = ReceiverBurnToken(ta);
        coordinatorCode = address(new ReceiverCoordinator());
        coord = _newCoordinator();
        ReceiverHook code = new ReceiverHook();
        vm.etch(address(0x100080), address(code).code); // BEFORE_SWAP, no unrelated callbacks
        hook = ReceiverHook(address(0x100080));
        // Deploy the default production artifact, not a receiver recompiled in PoolManager's upstream profile.
        implementation = BoxReceiverV2(
            deployCode("BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, coordinatorCode, FIT, PLATFORM))
        );
        ReceiverSafe safe = new ReceiverSafe();
        vm.etch(FIT, address(safe).code);
        vm.etch(PLATFORM, address(safe).code);
        vm.etch(CONVERSION, address(safe).code);
        // An established keeper; the separate fresh-recipient test permits a stipend failure.
        p.mint(TIP, 1);
        vm.deal(TIP, 1);
        p.mint(address(driver), 1e30);
        t.mint(address(driver), 1e30);
        vm.deal(address(driver), 1e30);
        vm.deal(address(this), 1e30);
        r = _receiver(1, 1, 1, address(p), true);
    }
    receive() external payable {}

    function _newCoordinator() internal returns (ReceiverCoordinator) {
        return ReceiverCoordinator(BoxClones.create(BoxClones.initCode(coordinatorCode, "")));
    }

    function _args(uint8 b, uint8 s, uint8 royalty, address price) internal view returns (ReceiverArgs memory a) {
        a = ReceiverArgs(
            address(coord),
            address(hook),
            price,
            address(t),
            address(0xA1),
            address(0xA2),
            PAYEE,
            42,
            1000,
            100,
            100,
            b,
            s,
            royalty,
            address(0),
            address(0)
        );
    }

    function _clone(ReceiverArgs memory a) internal returns (BoxReceiverV2 receiver) {
        receiver =
            BoxReceiverV2(BoxClones.create(BoxClones.initCode(address(implementation), BoxReceiverV2Args.encode(a))));
        hook.wire(address(receiver));
    }

    function _receiver(uint8 b, uint8 s, uint8 royalty, address price, bool init)
        internal
        returns (BoxReceiverV2 receiver)
    {
        receiver = _clone(_args(b, s, royalty, price));
        if (init) coord.initialize(receiver);
    }

    function _fees(uint256 buyers, uint256 sellers) internal {
        driver.mintClaims(Currency.wrap(r.q()), address(r), buyers + sellers);
        hook.script(buyers, sellers, 0);
    }

    function _balance(address account) internal view returns (uint256) {
        return pm.balanceOf(account, uint160(r.q()));
    }

    function _sum() internal view returns (uint256) {
        return r.fitOwed() + r.platformOwed() + r.creatorP() + r.buyBackP() + r.poolHeldP() + r.growHeldP()
            + r.itemsHeldP() + r.royaltyHeldP();
    }

    function _booked() internal view {
        assertLe(r.booked(r.q()), _balance(address(r)));
        assertLe(_sum(), r.booked(r.q()));
        assertLt(r.booked(r.q()) - _sum(), 30); // two side carries
    }

    function _royalty(address asset, uint256 amount) internal {
        if (asset == address(0)) {
            r.fundRoyalty{value: amount}(asset, amount);
        } else {
            HostileToken(asset).mint(address(this), amount);
            HostileToken(asset).approve(address(r), amount);
            r.fundRoyalty(asset, amount);
        }
    }

    function _pool() internal returns (PoolKey memory key) {
        return _poolAt(uint160(1 << 96));
    }

    function _poolAt(uint160 spot) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(r.q()), Currency.wrap(address(t)), 10_000, 60, IHooks(address(hook)));
        pm.initialize(key, spot);
        driver.modify(key, -887220, 887220, 1e12);
    }
}
