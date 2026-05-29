#!/usr/bin/env node
// Cross-platform preinstall guard.
//
// Runs the local Hermes supply-chain guard when it is present (developer
// machines) and is otherwise a no-op — on CI, fresh installs, and Windows,
// where the previous inline `if [ -f ... ]` shell snippet failed under cmd.exe.

const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const guard = join(homedir(), ".hermes", "scripts", "supply-chain-guard.sh");
if (!existsSync(guard)) process.exit(0);

const result = spawnSync("bash", [guard], { stdio: "inherit" });
// If bash isn't available, skip rather than block the install.
if (result.error) process.exit(0);
process.exit(result.status ?? 0);
