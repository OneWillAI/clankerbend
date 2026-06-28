#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchClankerBendCodex } from "./server.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

async function main(argv) {
  const [command, ...args] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(PACKAGE_JSON.version);
    return;
  }

  if (!command || command.startsWith("-")) {
    const options = parseCodexArgs(argv);
    await launchClankerBendCodex(options);
    return;
  }

  if (command === "codex") {
    const options = parseCodexArgs(args);
    await launchClankerBendCodex(options);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

function parseCodexArgs(args) {
  const options = {
    mock: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mock") {
      options.mock = true;
    } else if (arg === "--state-dir") {
      options.stateDir = requiredArg(args[++index], "--state-dir value");
    } else if (arg === "--help" || arg === "-h") {
      printCodexHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown codex option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`ClankerBend

Usage:
  clankerbend [--mock] [--state-dir path]
  clankerbend codex [--mock] [--state-dir path]
  clankerbend help
  clankerbend --version

Environment:
  ONEWILL_CLANKERBEND_STATE_DIR       Override ClankerBend runtime state directory.
  ONEWILL_CLANKERBEND_TOKEN           Use a specific bearer token for host endpoints.
  ONEWILL_CLANKERBEND_DISABLE_AUTH=1  Disable bearer auth for local development only.
`);
}

function printCodexHelp() {
  console.log(`ClankerBend Codex launcher

Usage:
  clankerbend [--mock] [--state-dir path]
  clankerbend codex [--mock] [--state-dir path]

Options:
  --mock            Start against a mock transcript instead of Codex Desktop.
  --state-dir path  Override ClankerBend runtime state directory.
`);
}

function requiredArg(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
