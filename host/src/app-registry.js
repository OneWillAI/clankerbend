import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLANKERBEND_APP_MANIFEST_VERSION = "0.1";

const VALID_DISTRIBUTION_KINDS = new Set(["local", "npm", "tarball", "binary"]);
const VALID_PLATFORM_OS = new Set(["darwin", "linux", "win32", "any"]);
const VALID_ENTRYPOINT_KINDS = new Set(["module", "binary", "static"]);
const VALID_CAPABILITIES = new Set([
  "panel",
  "annotations",
  "commands",
  "actions",
  "appState",
  "rendererBridge",
  "selectionActions",
  "overlays",
  "composerContext",
  "composerDraft"
]);
const VALID_PERMISSIONS = new Set([
  "transcriptRead",
  "transcriptAnnotate",
  "transcriptNavigate",
  "overlayWrite",
  "composerWrite",
  "appServerRead",
  "appServerApprove",
  "appServerRollback"
]);
const PROVIDER_NAMES = [
  "transcriptSnapshot",
  "transcriptOrder",
  "transcriptNavigation",
  "transcriptHighlight",
  "transcriptTextSelection",
  "composerDraft",
  "composerContext"
];

export function readAppManifest(manifestPath) {
  const absolutePath = resolve(manifestPath);
  return validateAppManifest(JSON.parse(readFileSync(absolutePath, "utf8")), {
    manifestPath: absolutePath
  });
}

export function validateAppManifest(manifest, options = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) errors.push("manifest must be a JSON object");
  if (errors.length) throwManifestError(errors, options);

  requireString(manifest, "clankerbendVersion", errors);
  if (manifest.clankerbendVersion !== CLANKERBEND_APP_MANIFEST_VERSION) {
    errors.push(`clankerbendVersion must be ${CLANKERBEND_APP_MANIFEST_VERSION}`);
  }
  requireString(manifest, "appId", errors);
  requireString(manifest, "version", errors);
  requireString(manifest, "name", errors);

  if (!isPlainObject(manifest.distribution)) {
    errors.push("distribution must be an object");
  } else {
    if (!VALID_DISTRIBUTION_KINDS.has(manifest.distribution.kind)) {
      errors.push(`distribution.kind must be one of ${[...VALID_DISTRIBUTION_KINDS].join(", ")}`);
    }
    if (manifest.distribution.source !== undefined && typeof manifest.distribution.source !== "string") {
      errors.push("distribution.source must be a string when present");
    }
    requireString(manifest.distribution, "integrity", errors, "distribution.integrity");
    if (manifest.distribution.update !== undefined && !isPlainObject(manifest.distribution.update)) {
      errors.push("distribution.update must be an object when present");
    }
  }

  if (!isPlainObject(manifest.entrypoint)) {
    errors.push("entrypoint must be an object");
  } else {
    if (!VALID_ENTRYPOINT_KINDS.has(manifest.entrypoint.kind)) {
      errors.push(`entrypoint.kind must be one of ${[...VALID_ENTRYPOINT_KINDS].join(", ")}`);
    }
    if (manifest.entrypoint.kind === "module") {
      requireString(manifest.entrypoint, "module", errors, "entrypoint.module");
      requireString(manifest.entrypoint, "factory", errors, "entrypoint.factory");
    }
    if (manifest.entrypoint.kind === "binary") {
      requireString(manifest.entrypoint, "command", errors, "entrypoint.command");
    }
    if (manifest.entrypoint.publicDir !== undefined && typeof manifest.entrypoint.publicDir !== "string") {
      errors.push("entrypoint.publicDir must be a string when present");
    }
  }

  if (!isPlainObject(manifest.platform)) {
    errors.push("platform must be an object");
  } else {
    const os = manifest.platform.os || ["any"];
    if (!Array.isArray(os) || !os.length || os.some((value) => !VALID_PLATFORM_OS.has(value))) {
      errors.push(`platform.os must contain ${[...VALID_PLATFORM_OS].join(", ")}`);
    }
  }

  validateBooleanMap(manifest.capabilities, "capabilities", VALID_CAPABILITIES, errors);
  validateBooleanMap(manifest.permissions, "permissions", VALID_PERMISSIONS, errors);

  if (manifest.panel !== undefined && !isPlainObject(manifest.panel)) {
    errors.push("panel must be an object when present");
  }
  if (manifest.rendererBridge !== undefined) validateRendererBridgeManifest(manifest.rendererBridge, errors);
  if (manifest.lifecycle !== undefined) validateLifecycleManifest(manifest.lifecycle, errors);

  if (errors.length) throwManifestError(errors, options);
  return manifest;
}

export async function loadRegisteredApp(manifestPath) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = readAppManifest(absoluteManifestPath);
  const baseDir = dirname(absoluteManifestPath);
  const app = manifest.entrypoint.kind === "module"
    ? await loadModuleApp(manifest, baseDir)
    : createPackagedApp(manifest, baseDir);
  return {
    manifest,
    app: normalizeAppFromManifest(app, manifest),
    rendererBridge: manifest.rendererBridge ? rendererBridgeFromManifest(manifest, absoluteManifestPath) : null
  };
}

export async function loadProfileFromManifests(options) {
  const loadedApps = [];
  for (const manifestPath of uniqueStrings(options.manifestPaths || [])) {
    loadedApps.push(await loadRegisteredApp(manifestPath));
  }
  const apps = loadedApps.map((loaded) => loaded.app);
  const rendererBridges = loadedApps.map((loaded) => loaded.rendererBridge).filter(Boolean);
  const providers = providersFromRendererBridges(rendererBridges);
  const defaultPanelAppId = options.defaultPanelAppId || apps.find((app) => app.contributes?.panel)?.appId || apps[0]?.appId || null;
  return {
    profileId: options.profileId,
    name: options.name,
    description: options.description,
    hostId: options.hostId,
    hostName: options.hostName,
    runDir: options.runDir,
    defaultPanelAppId,
    apps,
    manifests: loadedApps.map((loaded) => loaded.manifest),
    rendererBridges,
    providers
  };
}

export function enabledManifestPathsFromConfig(config, profileId = "default") {
  const enabledAppIds = config.profiles?.[profileId]?.enabledAppIds || [];
  return enabledAppIds
    .map((appId) => config.installedApps?.[appId]?.manifestPath)
    .filter(Boolean);
}

export function mergeManifestPaths(...groups) {
  return uniqueStrings(groups.flat().filter(Boolean).map((value) => resolve(value)));
}

export function providersFromRendererBridges(rendererBridges) {
  const providers = {};
  const primary = rendererBridges.find((bridge) => bridge.primary) || rendererBridges[0] || null;
  for (const name of PROVIDER_NAMES) {
    providers[name] = rendererBridges.find((bridge) => bridge.provides?.includes(name))?.appId || primary?.appId || null;
  }
  return providers;
}

export function rendererBridgeFromManifest(manifest, manifestPath) {
  const baseDir = dirname(resolve(manifestPath));
  const bridge = manifest.rendererBridge;
  return {
    appId: manifest.appId,
    injectedScriptPath: resolve(baseDir, bridge.script),
    openPanelMethod: bridge.methods?.openPanel || "openPanel",
    scrollMethod: bridge.methods?.scroll || "scrollToAnchor",
    highlightMethod: bridge.methods?.highlight || "highlightAnchor",
    primary: bridge.primary === true,
    provides: bridge.provides || []
  };
}

export function normalizeAppFromManifest(app, manifest) {
  if (!app || typeof app !== "object") throw new Error(`${manifest.appId} factory did not return an app object`);
  if (app.appId !== manifest.appId) throw new Error(`${manifest.appId} factory returned mismatched appId: ${app.appId}`);
  return {
    ...app,
    name: app.name || manifest.name,
    version: app.version || manifest.version,
    contributes: app.contributes || manifest.capabilities || {},
    permissions: app.permissions || manifest.permissions || {},
    panel: app.panel || manifest.panel || undefined,
    manifest
  };
}

export function defaultRegistryConfig() {
  return {
    clankerbendVersion: CLANKERBEND_APP_MANIFEST_VERSION,
    installedApps: {},
    profiles: {
      default: {
        enabledAppIds: []
      }
    }
  };
}

export function loadRegistryConfig(configPath) {
  if (!existsSync(configPath)) return defaultRegistryConfig();
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isPlainObject(config.installedApps)) config.installedApps = {};
  if (!isPlainObject(config.profiles)) config.profiles = defaultRegistryConfig().profiles;
  return config;
}

async function loadModuleApp(manifest, baseDir) {
  const modulePath = resolve(baseDir, manifest.entrypoint.module);
  const imported = await import(pathToFileURL(modulePath));
  const factory = imported[manifest.entrypoint.factory];
  if (typeof factory !== "function") throw new Error(`${manifest.appId} factory not found: ${manifest.entrypoint.factory}`);
  return factory({
    manifest,
    publicDir: manifest.entrypoint.publicDir ? resolve(baseDir, manifest.entrypoint.publicDir) : undefined
  });
}

function createPackagedApp(manifest, baseDir) {
  return {
    appId: manifest.appId,
    name: manifest.name,
    version: manifest.version,
    publicDir: manifest.entrypoint.publicDir ? resolve(baseDir, manifest.entrypoint.publicDir) : undefined,
    contributes: manifest.capabilities || {},
    permissions: manifest.permissions || {},
    panel: manifest.panel,
    getState(context) {
      return {
        appId: manifest.appId,
        status: manifest.entrypoint.kind === "binary" ? "degraded" : "ready",
        source: manifest.entrypoint.kind,
        connected: manifest.entrypoint.kind !== "binary",
        entries: manifest.entrypoint.kind === "binary"
          ? [{
              entryId: `${manifest.appId}:binary-not-started`,
              appId: manifest.appId,
              title: manifest.name,
              summary: "Binary app lifecycle is installed but not started by this in-process host.",
              category: "lifecycle"
            }]
          : [],
        updatedAt: context.state.generatedAt
      };
    }
  };
}

function validateRendererBridgeManifest(bridge, errors) {
  if (!isPlainObject(bridge)) {
    errors.push("rendererBridge must be an object when present");
    return;
  }
  requireString(bridge, "script", errors, "rendererBridge.script");
  if (bridge.methods !== undefined && !isPlainObject(bridge.methods)) errors.push("rendererBridge.methods must be an object when present");
  if (bridge.provides !== undefined) {
    if (!Array.isArray(bridge.provides) || bridge.provides.some((name) => !PROVIDER_NAMES.includes(name))) {
      errors.push(`rendererBridge.provides must contain ${PROVIDER_NAMES.join(", ")}`);
    }
  }
  if (bridge.primary !== undefined && typeof bridge.primary !== "boolean") errors.push("rendererBridge.primary must be boolean when present");
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function validateLifecycleManifest(lifecycle, errors) {
  if (!isPlainObject(lifecycle)) {
    errors.push("lifecycle must be an object when present");
    return;
  }
  for (const hook of ["install", "start", "stop", "update", "remove"]) {
    if (lifecycle[hook] !== undefined && !isPlainObject(lifecycle[hook])) errors.push(`lifecycle.${hook} must be an object when present`);
  }
}

function validateBooleanMap(value, label, validKeys, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!validKeys.has(key)) errors.push(`${label}.${key} is not supported`);
    if (typeof entry !== "boolean") errors.push(`${label}.${key} must be boolean`);
  }
}

function requireString(object, key, errors, label = key) {
  if (typeof object[key] !== "string" || object[key].trim().length === 0) errors.push(`${label} must be a non-empty string`);
}

function throwManifestError(errors, options = {}) {
  const prefix = options.manifestPath ? `${options.manifestPath}: ` : "";
  throw new Error(`${prefix}invalid ClankerBend app manifest:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
