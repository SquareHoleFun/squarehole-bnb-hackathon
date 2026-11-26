// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdCheatsSafe} from "forge-std/StdCheats.sol";
import {DefaultArtifacts} from "./DefaultArtifacts.sol";

import {ClaimsTest} from "../cq11-c/Claims.t.sol";
import {HatchTest} from "../cq11-c/Hatch.t.sol";
import {M130aCoordinatorTest} from "../m1-30a/CoordinatorV2.t.sol";
import {M130aBuiltTest} from "../m1-30a/M130aBuilt.t.sol";
import {M130aRound1Test} from "../m1-30a/M130aRound1.t.sol";
import {FailureReviewTest} from "../m1-31/FailureReview.t.sol";
import {FailureItemsTest} from "../m1-31/FailureReview2.t.sol";
import {PileVaultTest} from "../m3-30/PileVault.t.sol";
import {PileSurplusTest} from "../m3-30/Surplus.t.sol";
import {EveryItemBookingTest} from "../m3-23/Booking.t.sol";

// Existing coordinator, failure, receiver and pile assertions run through this owned path.
contract M340ClaimsRegression is ClaimsTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340HatchRegression is HatchTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340CoordinatorRegression is M130aCoordinatorTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340CreationRegression is M130aBuiltTest {}
contract M340BoundsRegression is M130aRound1Test, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340FailureRegression is FailureReviewTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340ItemsRegression is FailureItemsTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340PileRegression is PileVaultTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340SurplusRegression is PileSurplusTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract M340BookingRegression is EveryItemBookingTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
