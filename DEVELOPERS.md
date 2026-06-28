# ClankerBend Developers

## Local Commands

For protocol-only local testing without Codex Desktop:

```sh
npx clankerbend --mock
```

For local development:

```sh
npm start
npm run start:mock
npm test
```

`npm test` runs the fast behavior e2e suite through the host and app APIs. To
exercise the real Codex Desktop surface:

```sh
npm run test:desktop-real:integration
```

The real desktop tests create fresh chats, seed deterministic content, verify
VimNav against the real transcript DOM, and verify Sticky Notes through native
toolbar injection, pinned overlay save, runtime file attachment, and prompt
context visibility.

## Useful Docs

- `docs/protocol.md`: ClankerBend protocol
- `docs/app-manifest.md`: app manifest format
- `docs/author-guide.md`: writing ClankerBend apps
- `docs/launcher-profiles.md`: launcher profiles
- `docs/app-lifecycle.md`: app installation and lifecycle model

## Release

ClankerBend publishes the same package payload under two npm names:

- `@onewillai/clankerbend`: scoped canonical package
- `clankerbend`: short launcher name for `npx clankerbend`

```sh
npm test
npm run test:desktop-real:integration
npm run release:pack
npm run release:publish -- --yes
```

`release:pack` creates:

- `dist/npm/clankerbend-<version>.tgz`
- `dist/npm/onewillai-clankerbend-<version>.tgz`

`release:publish` is guarded by `--yes`. It publishes the scoped package first
with `--access public`, then publishes the unscoped package. The publish steps
run interactively so npm can prompt for the configured 2FA method. Pass
`--otp=<code>` only for accounts that use authenticator-app TOTP codes.
Provenance is enabled automatically in supported CI providers, or explicitly
with `--provenance`.
