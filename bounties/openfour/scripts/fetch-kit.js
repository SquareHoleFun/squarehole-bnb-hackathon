// Fetches the OpenFour developer kit (four-meme-community/openfour-docs) at a pinned commit into
// node_modules/openfour-kit (so Solidity can import it as `openfour-kit/...`, like any library).
// The kit has no package.json at its top and no licence file, so it cannot be an npm dependency and is not
// republished here: it is fetched at install time, read in place, and never committed.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = "https://github.com/four-meme-community/openfour-docs.git";
const COMMIT = "079a45e9c3358c9f357c84f336c7d915c9f0e9fc"; // 17 Nov 2026, the commit this project was built against
const dir = path.resolve(__dirname, "..", "node_modules", "openfour-kit");

function git(args, cwd, quiet = false) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"] }).toString().trim();
}

if (!fs.existsSync(path.join(dir, ".git"))) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", REPO], dir);
}
let head = "";
try {
  head = git(["rev-parse", "HEAD"], dir, true);
} catch {
  head = "";
}
if (head !== COMMIT) git(["fetch", "-q", "--depth", "1", "origin", COMMIT], dir);
// Always restore the pinned files: a copy tool or a prune may have removed some of them.
git(["checkout", "-q", "--force", "--detach", COMMIT], dir);
// A package.json of our own (untracked in the kit) so Hardhat resolves `openfour-kit/...` imports like a library.
fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "openfour-kit", "version": "0.0.0-${COMMIT.slice(0, 7)}", "private": true }\n`);
console.log(`openfour kit at ${COMMIT} in ${path.relative(process.cwd(), dir) || "."}`);
