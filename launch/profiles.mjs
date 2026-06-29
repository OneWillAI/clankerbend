import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enabledManifestPathsFromConfig,
  loadProfileFromManifests,
  loadRegistryConfig,
  mergeManifestPaths,
  providersFromRendererBridges,
  readAppManifest
} from "../host/src/app-registry.js";
import { CodexAccountRegistry, primaryCodexHome } from "./accounts.mjs";
import { clankerbendRuntimePaths } from "./runtime-paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");

export const PROFILE_NAVIGATE = "navigate";
export const VIM_NAV_MANIFEST_PATH = join(ROOT_DIR, "apps/vim-nav/clankerbend.manifest.json");
export const STICKY_NOTES_MANIFEST_PATH = join(ROOT_DIR, "apps/sticky-notes/clankerbend.manifest.json");
export const CODEX_DESKTOP_RENDERER_BRIDGE_PATH = join(ROOT_DIR, "host/src/codex-desktop-renderer-bridge.js");
export const VIM_NAV_APP_ID = readAppManifest(VIM_NAV_MANIFEST_PATH).appId;
export const STICKY_NOTES_APP_ID = readAppManifest(STICKY_NOTES_MANIFEST_PATH).appId;

export async function navigateProfile(options = {}) {
  const runtimePaths = clankerbendRuntimePaths({ stateDir: options.stateDir });
  const runDir = options.runDir || runtimePaths.runDir;
  const registryProfileId = options.registryProfileId || process.env.ONEWILL_CLANKERBEND_PROFILE || "default";
  const primaryElectronProfile = options.runDir ? join(runDir, "codex-profile") : runtimePaths.codexProfileDir;
  const accountStateRoot = options.runDir && !options.stateDir ? runDir : runtimePaths.root;
  const accountRegistry = new CodexAccountRegistry({
    root: accountStateRoot,
    registryPath: join(accountStateRoot, "accounts.json"),
    accountsDir: join(accountStateRoot, "accounts"),
    deletedDir: join(accountStateRoot, "deleted-accounts"),
    primaryCodexHome: options.primaryCodexHome || primaryCodexHome(),
    primaryElectronProfile
  });
  const codexAccount = options.accountId ? accountRegistry.get(options.accountId) : accountRegistry.getDefault();
  const profile = await loadProfileFromManifests({
    profileId: PROFILE_NAVIGATE,
    name: "Navigate",
    description: "Codex Desktop with OneWill Navigate transcript controls.",
    hostId: "onewill.clankerbend.host",
    hostName: "ClankerBend Navigate",
    runDir,
    runtimePaths,
    accountRegistry,
    defaultPanelAppId: VIM_NAV_APP_ID,
    manifestPaths: configuredManifestPaths([VIM_NAV_MANIFEST_PATH, STICKY_NOTES_MANIFEST_PATH], {
      registryConfigPath: options.registryConfigPath || runtimePaths.registryConfigPath,
      registryProfileId
    })
  });
  profile.launchProfileId = registryProfileId;
  profile.launchProfileName = profileNameFromId(registryProfileId);
  profile.accountRegistry = accountRegistry;
  profile.codexAccount = codexAccount;
  profile.startAccountId = codexAccount.id;
  const bridge = codexDesktopRendererBridge();
  profile.rendererBridges = [bridge, ...profile.rendererBridges];
  profile.providers = providersFromRendererBridges(profile.rendererBridges);
  return profile;
}

export function configuredManifestPaths(baseManifestPaths, options = {}) {
  const runtimePaths = clankerbendRuntimePaths({ stateDir: options.stateDir });
  const configPath = options.registryConfigPath || process.env.ONEWILL_CLANKERBEND_REGISTRY_CONFIG || runtimePaths.registryConfigPath;
  const profileId = options.registryProfileId || process.env.ONEWILL_CLANKERBEND_PROFILE || "default";
  const config = loadRegistryConfig(configPath);
  return mergeManifestPaths(baseManifestPaths, enabledManifestPathsFromConfig(config, profileId));
}

export function navigateProviders() {
  return providersFromRendererBridges([codexDesktopRendererBridge(), {
    appId: STICKY_NOTES_APP_ID,
    provides: [
      "composerContext",
      "composerDraft"
    ]
  }]);
}

function codexDesktopRendererBridge() {
  return {
    appId: VIM_NAV_APP_ID,
    injectedScriptPath: CODEX_DESKTOP_RENDERER_BRIDGE_PATH,
    openPanelMethod: "openPanel",
    scrollMethod: "scrollToAnchor",
    highlightMethod: "highlightAnchor",
    primary: true,
    provides: [
      "transcriptSnapshot",
      "transcriptOrder",
      "transcriptNavigation",
      "transcriptHighlight"
    ]
  };
}

export function printLaunchStatus(profile, host, options = {}) {
  const mode = options.mockMode ? "Mock transcript" : "Codex Desktop";
  console.log("");
  console.log(`ClankerBend profile: ${profile.launchProfileName || profile.name || "Default"}`);
  console.log(`Status: ${mode} is running`);
  console.log(`Host: ${host.state.host.url}`);
  if (host.token) console.log(`Token: ${host.token}`);
  console.log("Press Ctrl+C to stop ClankerBend and the launched Codex Desktop process.");
  console.log("");
}

function profileNameFromId(profileId) {
  return String(profileId || "default")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Default";
}
