import { pathToFileURL } from "node:url";
import { ClankerBendHost, createMockTranscriptAdapter } from "./host/src/index.js";
import { createCodexDesktopMuxAdapter } from "./launch/codex-mux-adapter.mjs";
import { navigateProfile, printLaunchStatus } from "./launch/profiles.mjs";

export async function launchClankerBendCodex(options = {}) {
  const mockMode = Boolean(options.mock);
  const localDevInsecure = options.localDevInsecure === true || process.env.ONEWILL_CLANKERBEND_DISABLE_AUTH === "1";
  const profile = await navigateProfile({
    stateDir: options.stateDir,
    runDir: options.runDir,
    registryConfigPath: options.registryConfigPath,
    registryProfileId: options.registryProfileId,
    accountId: options.accountId,
    primaryCodexHome: options.primaryCodexHome
  });

  const host = new ClankerBendHost({
    hostId: profile.hostId,
    hostName: profile.hostName,
    token: options.token || process.env.ONEWILL_CLANKERBEND_TOKEN || undefined,
    localDevInsecure,
    runDir: profile.runDir,
    accountRegistry: profile.accountRegistry,
    transcriptAdapter: mockMode
      ? createMockTranscriptAdapter({ defaultAppId: profile.defaultPanelAppId, providers: profile.providers })
      : createCodexDesktopMuxAdapter({
          accountRegistry: profile.accountRegistry,
          startAccountId: profile.startAccountId,
          providers: profile.providers,
          adapterOptions: {
            runDir: profile.runDir,
            rendererBridges: profile.rendererBridges,
            providers: profile.providers
          }
        })
  });

  for (const app of profile.apps) host.registerApp(app);
  host.setActivePanelApp(profile.defaultPanelAppId);

  const cleanupAndExit = async (code = 0) => {
    await host.stop().catch(() => {});
    process.exit(code);
  };

  if (options.installSignalHandlers !== false) {
    process.once("SIGINT", () => cleanupAndExit(0));
    process.once("SIGTERM", () => cleanupAndExit(0));
    process.once("uncaughtException", (err) => {
      console.error(`ClankerBend could not start. Close any ClankerBend-launched Codex Desktop window, then run this command again. Details: ${err.message}`);
      cleanupAndExit(1);
    });
  }

  await host.start();
  printLaunchStatus(profile, host, { mockMode });
  return { host, profile, mockMode };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await launchClankerBendCodex({
    mock: process.argv.includes("--mock")
  });
}
