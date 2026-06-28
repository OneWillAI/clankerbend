# ClankerBend App Manifest

ClankerBend apps are installed and launched from a `clankerbend.manifest.json` file.
The manifest is the stable contract between the app bundle and the host. The
host loads local manifests through this schema. The schema also reserves npm
packages, tarballs, and binary-style bundles for installer tooling.

## Required Fields

```json
{
  "clankerbendVersion": "0.1",
  "appId": "onewill.example.app",
  "version": "0.1.0",
  "name": "Example App",
  "description": "Short human-readable description.",
  "distribution": {
    "kind": "local",
    "source": ".",
    "integrity": "dev-local",
    "update": {
      "channel": "local"
    }
  },
  "entrypoint": {
    "kind": "module",
    "module": "./src/example-app.js",
    "factory": "createExampleApp",
    "publicDir": "./public"
  },
  "platform": {
    "os": ["darwin", "linux", "win32"],
    "arch": ["any"]
  },
  "capabilities": {
    "panel": true,
    "annotations": true,
    "commands": true,
    "actions": true,
    "appState": true,
    "selectionActions": false,
    "overlays": false,
    "composerContext": false,
    "composerDraft": false,
    "rendererBridge": false
  },
  "permissions": {
    "transcriptRead": true,
    "transcriptAnnotate": true,
    "transcriptNavigate": true,
    "overlayWrite": false,
    "composerWrite": false,
    "appServerRead": false,
    "appServerApprove": false,
    "appServerRollback": false
  }
}
```

## Distribution Kinds

- `local`: a manifest on disk, usually during development.
- `npm`: reserved for a package that contains a manifest and app entrypoint.
- `tarball`: reserved for a downloaded archive verified by `integrity`.
- `binary`: reserved for a package that runs an external app process and
  registers through host lifecycle hooks.

Every app package must declare the same capabilities and permissions regardless
of distribution shape.

The current host accepts manifest paths. Future installers may accept an app
directory containing `clankerbend.manifest.json`, a `.tgz`/`.tar.gz` bundle, or an
`npm:<package>` spec. Packaged sources should be verified with an external
`sha256-...` integrity value before extraction. The manifest still carries
`distribution.integrity` so registries and update tools can reason about the
package they installed.

## Entrypoints

`module` entrypoints run in the host process and export the configured factory.
The factory receives `{ manifest, publicDir }` and returns an app object with
`getState` and optional `handleAction`.

`binary` entrypoints are for apps that run out of process. They must declare a
command and lifecycle hooks. The current host can register a binary app and show
its panel/static state, but it does not yet supervise a long-running binary
process.

`static` entrypoints are reserved for panel-only apps that render from public
host state and do not provide host-side action handlers.

## Renderer Bridge

Most apps should not declare a renderer bridge. Apps should prefer host
capabilities such as transcript navigation, text ranges, overlays, and composer
drafts. The Navigate profile uses a host-owned Codex Desktop renderer bridge so
public apps can stay focused on app state and actions.

Adapter packages that intentionally provide host-level renderer behavior may
declare a bridge:

```json
{
  "rendererBridge": {
    "script": "./adapter/renderer-bridge.js",
    "primary": true,
    "provides": [
      "transcriptSnapshot",
      "transcriptOrder",
      "transcriptNavigation",
      "transcriptHighlight"
    ],
    "methods": {
      "openPanel": "openPanel",
      "scroll": "scrollToAnchor",
      "highlight": "highlightAnchor"
    }
  }
}
```

Only one bridge normally provides transcript snapshot/order/navigation for a
profile. Other apps can still contribute annotations and panels without owning
the transcript bridge.

## Validation

Hosts should reject unknown capabilities and permissions so future protocol
growth is explicit: bump the protocol version or add a new host capability
before apps depend on new behavior.
