# ClankerBend Launcher Profiles

A launcher profile is the host configuration for one Codex Desktop session. It
selects app manifests, chooses the default side-panel app, and decides which
renderer bridge provides transcript primitives.

## Commands

```sh
npx clankerbend
npx clankerbend --mock
```

`npx clankerbend codex` is equivalent to `npx clankerbend` while Codex is the
only supported surface.

In this repository, `npm start` runs `clankerbend` through the local package.
`npm run start:mock` runs the same profile without Codex Desktop.

## Profile Construction

Profiles are built from manifests with `loadProfileFromManifests`. Each loaded
app contributes:

- an app object for host state/actions
- an optional renderer bridge
- panel metadata
- capabilities and permissions

Provider selection comes from renderer bridge metadata. The first primary bridge
normally provides transcript snapshot, order, navigation, and highlight.

The built-in Navigate profile always includes VimNav and Sticky Notes.
Additional apps are product configuration owned by the running ClankerBend
experience and stored in the runtime registry.

The launcher also reads `ONEWILL_CLANKERBEND_REGISTRY_CONFIG`, defaulting to
`registry.json` under the runtime state directory, and merges enabled app
manifests from the selected registry profile. Set `ONEWILL_CLANKERBEND_PROFILE` to
override the selected registry profile when building a custom launcher.

Runtime state defaults to:

- macOS: `~/Library/Application Support/OneWill/ClankerBend`
- Linux: `~/.local/state/onewill/clankerbend`

Set `ONEWILL_CLANKERBEND_STATE_DIR` to override the root state directory.

## Codex Account Profiles

ClankerBend can remember up to 20 Codex account profiles. It still launches at
most one Codex Desktop instance at a time. Switching accounts stops the current
ClankerBend-launched Desktop process and starts the selected profile.

The `primary` profile always points at the normal Codex home:

- `CODEX_HOME` when set
- otherwise `~/.codex`

Managed profiles are created empty under the ClankerBend state directory. Each
managed profile gets its own `codex-home` and Electron user-data directory. No
auth, sessions, skills, plugins, or history are copied from the primary profile.
If the primary profile is file-auth based, the managed profile receives only a
minimal `config.toml` auth-store setting so Codex can use the same auth mode.

ClankerID exposes these operations:

- **Switch**: stop the current Desktop process and launch the selected profile.
- **Launch by default**: choose which profile ClankerBend starts next time. This
  does not change the primary Codex home.
- **Make primary**: promote a managed profile into the primary Codex home.
  ClankerBend first moves the old primary home to
  `<primary>.backup_<timestamp>` (normally `~/.codex.backup_<timestamp>`),
  preserves it as a managed account, then moves the selected managed home into
  the primary Codex home.
- **Rollback**: restore a previous primary backup and move the replaced primary
  to `<primary>.rollback_replaced_<timestamp>`.
- **Archive**: remove a managed profile from the active account list and move
  its directories into deleted-account storage.

## Ports And Cleanup

The host and CDP adapter bind to `127.0.0.1` and use ephemeral ports. Launchers
must stop the host, CDP adapter, and launched Codex Desktop child process on
`SIGINT` or `SIGTERM`.
