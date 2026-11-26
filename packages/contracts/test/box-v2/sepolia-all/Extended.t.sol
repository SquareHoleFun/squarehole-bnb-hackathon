// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SepoliaExtendedRehearsal} from "../../../script/sepolia-v2/SepoliaExtendedRehearsal.sol";

contract SepoliaAllExtendedTest is SepoliaExtendedRehearsal {
    function test_sixDecimalItemLifeContractAndDelegatedOwner() public {
        this.itemLife(6);
    }

    function test_eightDecimalItemLifeContractAndDelegatedOwner() public {
        this.itemLife(8);
    }

    function test_eighteenDecimalItemLifeContractAndDelegatedOwner() public {
        this.itemLife(18);
    }

    function test_sixDecimalPile() public {
        this.pileLife(6);
    }

    function test_eightDecimalPile() public {
        this.pileLife(8);
    }

    function test_eighteenDecimalPile() public {
        this.pileLife(18);
    }

    function test_foreignRoyaltyCorrectReceiverAndLatePot() public {
        this.royaltyLife();
    }
}
