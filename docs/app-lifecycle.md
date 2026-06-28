# ClankerBend App Lifecycle

ClankerBend separates app installation from profile activation.

## Install

Installing records a manifest in the runtime registry. The public `clankerbend`
CLI intentionally does not expose app-management commands; app installation is
a product configuration concern for the running ClankerBend experience.

The registry stores app id, version, manifest path, distribution metadata,
bundle kind, source path, and install time. The current host loads bundled
manifests and additional manifest paths from this registry; copying directories
or tarballs into a managed app store is reserved for installer tooling. The
runtime root defaults to:

- macOS: `~/Library/Application Support/OneWill/ClankerBend`
- Linux: `~/.local/state/onewill/clankerbend`

Set `ONEWILL_CLANKERBEND_STATE_DIR` to override the root location.

`distribution.integrity` is required. Local development installs can use
`integrity: "dev-local"`. Downloaded packages should be installed with a real
`--integrity sha256-...` value supplied by the package index.

## Enable And Disable

Profiles decide which installed apps are active.

Enablement is profile-scoped. A host can launch with the default profile or a
custom user profile while using the same app registry. The default registry
config path is `registry.json` under the runtime state directory, and launchers
may override it with `ONEWILL_CLANKERBEND_REGISTRY_CONFIG`.

## Start

At startup the launcher builds a profile from app manifests. The host loads app
factories, validates capabilities, injects configured renderer bridges, and
serves each panel under:

```text
/apps/:appId/
```

Apps receive only their declared context. For example, an app with
`transcriptRead: false` sees an empty transcript state.

## Update

Manifest `distribution.update` is metadata for update tools. An updater should
revalidate a replacement manifest and update the installed app record while
preserving profile enablement.

A future updater can replace the app bundle, validate the new manifest, compare
`clankerbendVersion`, and update the registry atomically.

## Remove

Removing an app deletes it from the installed app registry and disables it from
all profiles.

Remove does not delete arbitrary files from disk unless a future package manager
owns those files and the manifest lifecycle explicitly allows that behavior.
