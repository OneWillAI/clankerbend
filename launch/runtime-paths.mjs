import { homedir, platform } from "node:os";
import { join } from "node:path";

export function clankerbendStateDir() {
  if (process.env.ONEWILL_CLANKERBEND_STATE_DIR) return process.env.ONEWILL_CLANKERBEND_STATE_DIR;
  if (platform() === "darwin") {
    return join(homedir(), "Library/Application Support/OneWill/ClankerBend");
  }
  return join(homedir(), ".local/state/onewill/clankerbend");
}

export function clankerbendRuntimePaths(options = {}) {
  const root = options.stateDir || clankerbendStateDir();
  return {
    root,
    runDir: join(root, "run"),
    registryConfigPath: join(root, "registry.json"),
    accountRegistryPath: join(root, "accounts.json"),
    accountProfilesDir: join(root, "accounts"),
    deletedAccountProfilesDir: join(root, "deleted-accounts"),
    appInstallDir: join(root, "apps"),
    codexProfileDir: join(root, "codex-profile")
  };
}
