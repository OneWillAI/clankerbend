# ClankerBend VimNav

ClankerBend is an independent OneWill project compatible with OpenAI Codex
Desktop. It is not affiliated with or endorsed by OpenAI.

VimNav is the public reference app for ClankerBend `0.1`. It demonstrates
how an app registers with a central ClankerBend host and uses transcript anchors,
annotations, selection, and app-scoped actions without owning CDP directly.

## Run

```sh
cd clankerbend
npm start
```

The command starts a loopback ClankerBend host on an ephemeral `127.0.0.1` port,
launches Codex Desktop with CDP, injects transcript markers, and serves the Vim
VimNav panel at `/apps/onewill.vim-nav/`.

For protocol-only mock mode:

```sh
npm run start:mock
```

## Test

```sh
npm test
```

The test suite runs without Codex Desktop. It verifies the host manifest, public
state, app registry, app manifest/state, initial SSE state event, action
execution, duplicate action idempotency, action result lookup, stale selection
rejection, scroll/highlight behavior, request validation, unknown app/anchor
errors, HTTP status/envelope alignment, and bearer-token behavior.

## Commands

Codex Desktop routes normal typing into the prompt composer, so enter transcript
navigation mode first:

- `Cmd+Option`: toggle Vim transcript mode
- `Escape` or `i`: exit Vim transcript mode

While Vim transcript mode is active, plain Vim keys are captured for transcript
navigation:

- `j` / `k`: next or previous transcript anchor, aligned so the transcript number is visible at the top
- `gg` / `G`: transcript item `1` or the last known transcript number
- `42G`: jump to transcript item `42`; oversized numbers clamp to the last known transcript number
- `[` / `]`: align the current transcript item to the top or bottom
- `{` / `}`: previous or next user message

The injected mode badge appears in the bottom-right corner while the mode is
active.

The focus-safe chords remain available as a fallback:

- `Cmd+Option+j` or `Cmd+Option+Down`: next transcript anchor
- `Cmd+Option+k` or `Cmd+Option+Up`: previous transcript anchor
- `Cmd+Option+g` or `Cmd+Option+Home`: first transcript anchor
- `Cmd+Option+G` or `Cmd+Option+End`: last transcript anchor
- `Cmd+Option+{` or `Cmd+Option+PageUp`: previous user message
- `Cmd+Option+}` or `Cmd+Option+PageDown`: next user message

Panel commands support:

- `/term`: search visible transcript text
- `n` / `N`: next or previous search match
- `:42` or `42`: jump by visible ruler number
- `:latest assistant` / `:latest user`: jump by role

These commands are implemented as ClankerBend app actions, not only as panel-local
keyboard parsing. External clients can call the same actions through
`POST /clankerbend/apps/onewill.vim-nav/actions`.

## Writing Another App

Create an object with:

- `appId`
- `name`
- `publicDir`
- `getManifest(context)`
- `getState(context)`
- `handleAction(action, context)`

Then register it with one host:

```js
import { ClankerBendHost, createMockTranscriptAdapter } from "../../host/src/index.js";

const host = new ClankerBendHost({
  transcriptAdapter: createMockTranscriptAdapter({ defaultAppId: "example.app" })
});

host.registerApp(exampleApp);
await host.start();
```

The host serves all mounted apps through one central server and routes commands
through `/clankerbend/apps/:appId/actions`.

## Real Desktop Validation

The default `npm test` path is mock/protocol-only and does not launch Codex
Desktop. To run the real Desktop regression harness:

```sh
cd clankerbend
npm run test:vim-nav:desktop-real
```

The harness starts the VimNav host, launches Codex Desktop with CDP,
creates a fresh chat, seeds deterministic transcript turns, injects the host
renderer bridge, and verifies:

- `Cmd+Option` toggles Vim transcript mode without moving scroll
- `G` lands on the last known transcript item
- repeated `k` walks to transcript item `1` without skipping or renumbering
- `12G`, `gg`, and oversized `number+G` land on the expected anchors

It writes diagnostics to `apps/vim-nav/run/desktop-real-validation/result.json`
and cleans up the launched Codex/Desktop process before exiting.
