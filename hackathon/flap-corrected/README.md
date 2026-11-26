# The corrected Flap contracts (26 November 2026)

This folder is the archive prepared for Flap's re-review after their pre-audit, unpacked, together with what the
test-network deployment added.

- `README.txt`: the archive's cover. What changed, by Flap's finding; where we differ from Flap's reference; how to
  build and test; the addresses of the corrected set on chain 97 and the four sales launched on it.
- `bounties/flap`, `bounties/core`: the sources, tests and scripts at commit `3272b398` of our contracts branch.
  The contracts the live site reads (the first deployment) are in `bounties/flap` and `bounties/core` at the top of
  this repository; the ones here are a second, corrected copy, and nothing in the site imports them.
- `deployments/`: the files the deployment wrote: the factories, the beacons and the four sales.
- `redeploy/`: the run file that deployed the set and ran the proof sale, with its README. Its paths are those of
  our contracts branch, where this folder's `bounties/` sat at the top and the run file at
  `hackathon/flap-redeploy/commands.txt`.

To build and test, follow `README.txt` from inside this folder.
