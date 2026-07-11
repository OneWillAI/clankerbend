# ClankerBend Protocol

Status: draft

Disclaimer: ClankerBend is an independent OneWill project compatible with OpenAI
Codex Desktop. It is not affiliated with or endorsed by OpenAI.

ClankerBend Protocol, short for the OneWill ClankerBend protocol, is a
standalone local protocol for building companion apps around Codex Desktop
without requiring changes to Codex Desktop itself. ClankerBend separates a shared
local host from individual apps: the host owns the risky integration work, and
apps consume stable transcript, annotation, navigation, and state primitives.

ClankerBend codifies the hack paths available today:

- a local host process bound to loopback
- a browser side panel loaded from that local host
- CDP attachment to the Codex Desktop Electron renderer
- renderer injection for transcript discovery, annotation, scroll, and highlight
- `codex app-server` awareness for thread, turn, item, approval, and rollback
  data

ClankerBend is not a proposal for a privileged built-in Codex plugin API. If Codex later
adds such an API, it should be able to replace the adapters underneath ClankerBend, but
the protocol here is designed to work now with external tools.

## Normative Language

The words **must**, **must not**, **should**, **should not**, and **may** are
normative when used in protocol sections. Examples and appendix material are
non-normative unless explicitly marked otherwise.

## Goals

ClankerBend should give any local app a small set of reusable primitives:

1. **View**: start a local browser UI and place it in Codex Desktop's existing
   side panel.
2. **Attach**: connect to a live Codex Desktop renderer through CDP.
3. **Observe**: read coarse Desktop context such as current URL, transcript
   anchors, visibility, scroll state, and selected app state.
4. **Annotate**: add lightweight clickable markers or labels near transcript
   anchors without taking over the transcript DOM.
5. **Navigate**: scroll to and highlight transcript anchors from the app panel.
6. **Select**: keep app-side and transcript-side selection in sync without
   stale state overwriting newer user intent.
7. **Correlate**: optionally map Desktop anchors to app-server threads, turns,
   and items when those identities are available.
8. **Act**: route app-specific commands through the host without granting apps
   direct CDP or app-server control.
9. **Compose**: run multiple apps against one shared Desktop adapter and
   transcript bridge.
10. **Extend**: optionally attach app-defined state to anchors, such as
   reviews, traces, bookmarks, diagnostics, provenance, or timeline events.

## Scope

ClankerBend `0.1` is transcript-adjacent. It covers side panels that observe, annotate,
navigate, and correlate Codex Desktop transcript content. Other Desktop
surfaces such as terminal panes, file trees, browser previews, command palette
commands, notifications, and settings are out of scope for this version.

## Non-Goals

- ClankerBend does not require Codex Desktop changes.
- ClankerBend does not replace `codex app-server`.
- ClankerBend does not define a security boundary.
- ClankerBend does not grant host filesystem, shell, network, or approval authority.
- ClankerBend does not assume exact item-to-DOM mapping is always possible.

## Architecture

ClankerBend describes a shared local host that can mount multiple apps.

```text
ClankerBend app panel(s) <-> ClankerBend host <-> Codex Desktop adapter <-> renderer bridge
                                    \
                                     -> app-server adapter
```

### ClankerBend Host

The ClankerBend host is the trusted local process for a session. It owns the
loopback HTTP/SSE server, app registry, app state fanout, Desktop CDP adapter,
renderer bridge injection, app-server adapter, lifecycle cleanup, and policy
checks. Apps do not talk directly to CDP or app-server unless the host grants a
specific capability.

One host should be enough to serve multiple apps, such as a state-diff viewer,
Vim-style transcript navigation, diagnostics, bookmarks, or review tools. Apps
share transcript anchors, selection, app-server correlation, and side-panel
placement through the host.

### ClankerBend App

A ClankerBend app is a UI and state contributor mounted by the host. It may provide
a side-panel route, annotations, commands, app state entries, and action
handlers. An app is identified by a stable `appId` and described by a manifest.

Apps should be replaceable. A panel should be able to render from host state and
app state without knowing whether Desktop integration is implemented through CDP,
a future built-in plugin API, or a mock adapter.

### Codex Desktop Adapter

The Codex Desktop adapter is the implementation-specific component that launches
or attaches to Codex Desktop with a loopback CDP port and evaluates the injected
renderer bridge. This adapter is not the protocol. It is the current way the
ClankerBend host realizes the protocol without Codex Desktop changes.

### Injected Renderer Bridge

The JavaScript object installed in the Codex Desktop renderer. It discovers DOM
anchors, adds annotations, opens the native side panel through existing UI, and
executes scroll/highlight requests. The bridge is owned by the host, not by any
single app.

### App-Server Adapter

Connection to `codex app-server --stdio` or another app-server transport when
available. It is used for task identity and lifecycle data, not for Desktop UI
control. A ClankerBend host may still run when app-server is unavailable, but it
must report that state explicitly.

## Transport

ClankerBend uses ordinary local web primitives:

- HTTP JSON endpoints for commands
- Server-Sent Events for state updates
- CDP `Runtime.evaluate` for renderer bridge calls
- App-server JSON-RPC or JSONL streams for Codex task data when available

All host HTTP ports must bind to loopback.

```text
127.0.0.1:<ephemeral>
```

External network exposure is out of scope.

## Wire Format

All HTTP request and response bodies must be UTF-8 JSON unless the endpoint is
explicitly defined as SSE. JSON endpoints must use `application/json`.

Successful JSON responses use this envelope:

```ts
type ClankerBendResponse<T> = {
  ok: true;
  data: T;
};
```

Failed JSON responses use this envelope:

```ts
type ClankerBendError = {
  ok: false;
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "stale_selection"
      | "capability_unavailable"
      | "adapter_unavailable"
      | "app_unavailable"
      | "action_failed"
      | "internal_error";
    message: string;
    detail?: unknown;
  };
};
```

HTTP status codes should match the envelope:

- `200`: successful read or completed command.
- `202`: accepted asynchronous action.
- `400`: invalid JSON or invalid request shape.
- `401`: missing or invalid session token.
- `403`: app lacks the requested permission.
- `404`: unknown endpoint, app, anchor, marker, or entry.
- `409`: stale selection, duplicate app id, or state conflict.
- `503`: required adapter or app-server capability is unavailable.
- `500`: unexpected host failure.

Hosts must not encode successful results as bare objects. A client can treat any
response without `ok: true` as failed.

### Request Validation

JSON command endpoints must reject malformed requests before dispatching to an
app or adapter:

1. Request bodies must parse as JSON objects. Arrays, strings, numbers, and
   invalid JSON return `400` with code `bad_request`.
2. Hosts should reject bodies larger than 1 MiB for ClankerBend `0.1` JSON
   endpoints.
3. `POST /clankerbend/apps/:appId/actions` requires an `action` object with
   non-empty string `appId`, `actionId`, and `type` fields.
4. `action.appId` must match the route `:appId`. A mismatch returns `400` with
   code `bad_request`.
5. `requestedAt` and `selectedAt`, when provided, must be parseable timestamps.
6. Transcript scroll and highlight requests require a non-empty `anchorId`.
7. Enum-like option fields such as scroll `behavior`, scroll `block`, and
   selection `source` must reject unknown values with `400`.

These checks are host responsibilities. App action handlers may perform
additional validation for app-specific payloads.

### Session Token

A production ClankerBend host must protect JSON and SSE endpoints with an
unguessable session token. The token is passed as:

```text
Authorization: Bearer <token>
```

Local development hosts may omit authentication only when the host manifest sets:

```json
{
  "security": {
    "localDevInsecure": true
  }
}
```

An app must not bypass the host token by calling CDP or app-server directly.

### Bootstrap

ClankerBend `0.1` defines two token bootstrap paths:

1. **Hosted panel apps**: the host serves the app entry URL and may append the
   token in the URL fragment as `#clankerbend_token=<token>`. For served HTML,
   the host may also inject a token bootstrap such as
   `window.__CLANKERBEND_TOKEN` or `<meta name="clankerbend-token">` so URL
   rewriting does not strand the app without a token. App JavaScript stores the
   token in memory, may keep it in `sessionStorage` for hash-less reloads,
   immediately removes any fragment with `history.replaceState`, and sends the
   token in the `Authorization` header for JSON and SSE requests.
2. **External clients**: the token is provided out of band by the launcher, such
   as the `Token:` startup line, an environment variable, config file, local IPC
   channel, or command output.

Hosts must not require a token in the query string. Query strings are more
likely to be logged or copied than URL fragments. Clients must support the
bearer-token header.

## State Model

The host maintains one public state object and streams snapshots to the panel.

```ts
type ClankerBendPublicState = {
  protocolName: "clankerbend";
  protocolVersion: "0.1";
  sequence: number;
  generatedAt: string;
  capabilities: ClankerBendCapabilities;
  host: HostStatus;
  desktop: DesktopStatus;
  panel: PanelStatus;
  transcript: TranscriptState;
  selection: ClankerBendSelection | null;
  selectionActions?: ClankerBendSelectionAction[];
  overlay?: ClankerBendOverlay | null;
  composer?: ClankerBendComposerState;
  apps: ClankerBendAppState[];
  appServer: AppServerStatus;
  lastAction?: ClankerBendActionResult;
};
```

```ts
type HostStatus = {
  status: "starting" | "running" | "degraded" | "stopping" | "exited";
  hostId: string;
  url: string;
  launchedAt?: string;
  error?: string;
};

type PanelStatus = {
  status: "closed" | "opening" | "waiting" | "open" | "focused" | "unavailable" | "error";
  activeAppId?: string;
  url?: string;
  preferredWidth?: number;
  lastOpenedAt?: string;
  error?: string;
};

type TranscriptState = {
  anchors: TranscriptAnchor[];
  visibleCount: number;
  annotationCount: number;
  scroll?: TranscriptScrollState;
  updatedAt?: string;
};

type TranscriptScrollState = {
  top: number;
  height: number;
  clientHeight: number;
};
```

The state object is intentionally denormalized so the panel can render from a
single event payload.

### `GET /clankerbend/state`

Returns the latest public state.

```ts
type GetStateResponse = ClankerBendResponse<ClankerBendPublicState>;
```

### `GET /clankerbend/events`

Streams host events as SSE. The host must send a full state snapshot
immediately after a client connects.

```text
event: state
id: 42
data: {"protocolName":"clankerbend","protocolVersion":"0.1","sequence":42,...}
```

SSE rules:

1. `id` is the decimal string form of `ClankerBendPublicState.sequence`.
2. `state` events contain a complete `ClankerBendPublicState`.
3. `app-state` events may contain one `ClankerBendAppState`; clients must still be
   able to recover from `state`.
4. `action` events contain `ClankerBendActionResult`.
5. `heartbeat` events have empty JSON object data and should be sent at least
   every 15 seconds.
6. `error` events contain `ClankerBendError["error"]`.
7. Hosts should avoid emitting `state` when nothing semantically changed.
8. Clients may reconnect with `Last-Event-ID`; hosts may replay missed events
   but must send a fresh `state` event even if replay is unavailable.
9. Clients must preserve active text selection and expanded rows while applying
   updates.

### Capabilities

The host exposes negotiated capabilities in every state snapshot so apps can
degrade cleanly.

```ts
type ClankerBendCapabilities = {
  protocolVersion: "0.1";
  host: {
    apps: boolean;
    actions: boolean;
    appState: boolean;
    sidePanel: boolean;
  };
  transcript: {
    read: boolean;
    annotate: boolean;
    navigate: boolean;
    select: boolean;
    rangeSelect?: boolean;
    rangeHighlight?: boolean;
  };
  overlay?: {
    anchored: boolean;
    forms: boolean;
  };
  composer?: {
    contextItems: boolean;
    draft: boolean;
    submit?: boolean;
  };
  adapter: {
    name: "codex-desktop-cdp" | string;
    cdp: boolean;
    rendererInjection: boolean;
    rendererFetchToLoopback?: boolean;
    providers?: {
      transcriptSnapshot: string;
      transcriptOrder: string;
      transcriptNavigation: string;
      transcriptHighlight: string;
      transcriptTextSelection?: string;
      composerDraft?: string;
      composerContext?: string;
    };
  };
  appServer: {
    available: boolean;
    correlateItems: boolean;
    approvals: boolean;
    rollback: boolean;
  };
};
```

`adapter.providers` is launch-time configuration. It names which registered app
bridge supplies shared transcript behavior. Multiple apps may still contribute
annotations and app state, but only the configured provider handles each shared
transcript operation until a future protocol version adds dynamic arbitration.

### Forward Compatibility

ClankerBend clients must treat minor-version protocol changes as additive.
Unknown object fields, unknown capability keys, unknown app state entry fields,
and unknown action result data must be ignored by default. Apps must gate
optional behavior on the capabilities they read from `GET /clankerbend/manifest`
or `GET /clankerbend/state`; they must not infer availability from the host name,
adapter name, or Codex Desktop version alone.

Hosts must keep the `ok` envelope, error envelope, endpoint names, and required
fields stable within a major protocol version. A host may add endpoints,
capabilities, app manifest fields, app state fields, action types, SSE event
types, or error `detail` content without breaking compatible clients. A client
that receives an unknown SSE event type should ignore it and recover from the
next `state` event.

Breaking changes require a major version bump. A host that implements a newer
major protocol may continue to expose a compatible older route set, but if it
does not, it must report the newer `protocolVersion` before app-specific
actions are required.

## Host API

The host API is the stable surface apps use. Codex Desktop adapter details are
behind the host.

Path parameters such as `:appId` and `:actionId` must be percent-encoded when
they contain characters outside unreserved URI characters. App ids should use
lowercase reverse-DNS-style names such as `onewill.vim-nav`.

### Version Negotiation

Apps must read host capabilities before assuming any optional feature exists.

```text
GET /clankerbend/manifest
GET /clankerbend/state
GET /clankerbend/events
```

`GET /clankerbend/manifest` returns host identity, protocol version, and mounted
app manifests.

```ts
type GetManifestResponse = ClankerBendResponse<ClankerBendHostManifest>;

type ClankerBendHostManifest = {
  clankerbendVersion: "0.1";
  hostId: string;
  hostName: string;
  capabilities: ClankerBendCapabilities;
  security?: {
    auth: "bearer" | "none";
    localDevInsecure?: boolean;
  };
  apps: ClankerBendAppManifest[];
};
```

If an app requires a capability that the host does not expose, the app must
render a degraded state rather than attempting direct CDP or app-server access.

### App Registry

The host exposes mounted apps through a registry.

```text
GET  /clankerbend/apps
GET  /clankerbend/apps/:appId/manifest
GET  /clankerbend/apps/:appId/state
GET  /clankerbend/apps/:appId/actions/:actionId
POST /clankerbend/apps/:appId/actions
```

The registry lets one host serve multiple apps without each app owning a
separate CDP adapter or injected bridge.

```ts
type GetAppsResponse = ClankerBendResponse<{
  apps: ClankerBendAppSummary[];
}>;

type ClankerBendAppSummary = {
  appId: string;
  name: string;
  status: ClankerBendAppStatus;
  entry?: string;
};

type GetAppManifestResponse = ClankerBendResponse<ClankerBendAppManifest>;
type GetAppStateResponse = ClankerBendResponse<ClankerBendAppState>;

type ClankerBendAppStatus =
  | "mounted"
  | "loading"
  | "ready"
  | "degraded"
  | "disabled"
  | "error";

type ClankerBendAppManifest = {
  clankerbendVersion: "0.1";
  appId: string;
  version: string;
  name: string;
  description?: string;
  entry: string;
  distribution?: ClankerBendAppDistribution;
  entrypoint?: ClankerBendAppEntrypoint;
  capabilities?: {
    panel?: boolean;
    annotations?: boolean;
    commands?: boolean;
    actions?: boolean;
    appState?: boolean;
    selectionActions?: boolean;
    overlays?: boolean;
    composerContext?: boolean;
    composerDraft?: boolean;
    rendererBridge?: boolean;
  };
  contributes?: {
    panel?: boolean;
    annotations?: boolean;
    commands?: boolean;
    actions?: boolean;
    appState?: boolean;
    selectionActions?: boolean;
    overlays?: boolean;
    composerContext?: boolean;
    composerDraft?: boolean;
  };
  permissions?: {
    transcriptRead?: boolean;
    transcriptAnnotate?: boolean;
    transcriptNavigate?: boolean;
    overlayWrite?: boolean;
    composerWrite?: boolean;
    appServerRead?: boolean;
    appServerApprove?: boolean;
    appServerRollback?: boolean;
  };
  panel?: {
    title: string;
    reloadPolicy: "preserve" | "reload";
    preferredWidth?: number;
  };
  rendererBridge?: ClankerBendRendererBridgeManifest;
  lifecycle?: ClankerBendAppLifecycleManifest;
};

type ClankerBendAppDistribution = {
  kind: "local" | "npm" | "tarball" | "binary";
  source?: string;
  integrity?: string;
  update?: {
    channel?: string;
    url?: string;
    packageName?: string;
  };
};

type ClankerBendAppEntrypoint = {
  kind: "module" | "binary" | "static";
  module?: string;
  factory?: string;
  command?: string;
  args?: string[];
  publicDir?: string;
};

type ClankerBendRendererBridgeManifest = {
  script: string;
  primary?: boolean;
  provides?: (
    | "transcriptSnapshot"
    | "transcriptOrder"
    | "transcriptNavigation"
    | "transcriptHighlight"
    | "transcriptTextSelection"
    | "composerDraft"
    | "composerContext"
  )[];
  methods?: {
    openPanel?: string;
    scroll?: string;
    highlight?: string;
  };
};

type ClankerBendAppLifecycleManifest = {
  install?: { kind: string };
  start?: { kind: string };
  stop?: { kind: string };
  update?: { kind: string };
  remove?: { kind: string };
};
```

### Actions

Apps send commands through the host so the host can enforce capability and
approval rules.

```ts
type PostAppActionRequest = {
  action: ClankerBendAction;
};

type PostAppActionResponse = ClankerBendResponse<
  ClankerBendActionResult | ClankerBendActionReceipt
>;

type ClankerBendAction = {
  actionId: string;
  appId: string;
  type: string;
  anchorId?: string;
  entryId?: string;
  markerId?: string;
  payload?: unknown;
  requestedAt: string;
};

type ClankerBendActionReceipt = {
  actionId: string;
  appId: string;
  accepted: true;
  status: "accepted";
  resultUrl?: string;
};

type ClankerBendActionResult = {
  actionId: string;
  appId: string;
  ok: boolean;
  status?: "accepted" | "rejected" | "applied" | "failed";
  error?: string;
  data?: unknown;
  completedAt?: string;
};
```

Action rules:

1. `actionId` must be unique per `appId`.
2. If the same `(appId, actionId)` is submitted again, the host must return the
   original receipt or result without executing the action twice.
3. Hosts should complete fast actions synchronously with `200`.
4. Hosts may accept long-running actions with `202`; the final result must be
   emitted as an `action` SSE event.
5. Unknown action `type` values must return `404` with code `not_found`.
6. Missing permissions must return `403` with code `forbidden`.
7. Unavailable adapters must return `503` with code `adapter_unavailable` or
   `capability_unavailable`.
8. When `resultUrl` is present, it must point to
   `/clankerbend/apps/:appId/actions/:actionId`.
9. App handlers must return an action result with boolean `ok`. Invalid handler
   returns must fail with `500` and code `action_failed`.

Public examples include `vim.jump`, `vim.search`, `bookmark.add`, and
`diagnostics.open`. App-specific action types do not need to be published in
this document, but they must follow the same action contract.

### Action Result Lookup

Hosts must retain completed action results for at least 60 seconds.

```text
GET /clankerbend/apps/:appId/actions/:actionId
```

```ts
type GetAppActionResponse = ClankerBendResponse<
  ClankerBendActionResult | ClankerBendActionReceipt
>;
```

This endpoint lets clients recover when they miss an SSE `action` event.

### App Lifecycle

ClankerBend `0.1` defines manifest-based app registration. A host may install apps
from local manifests, npm packages, tarballs, or binary-style bundles. Download
and update transports are implementation details, but every installed app must
resolve to a validated `ClankerBendAppManifest`.

The public launcher command is intentionally small:

```text
clankerbend
```

App installation, enablement, update, and removal are product configuration
concerns owned by the running ClankerBend experience. The registry model remains
part of the host protocol, but apps should not depend on a public app-management
CLI being present.

Regardless of loading mechanism, a mounted app must appear in
`GET /clankerbend/apps`.

Lifecycle rules:

1. App ids must be unique within a host.
2. A manifest parse failure must produce an app summary with `status: "error"`
   when the host can identify the intended `appId`.
3. Disabled apps should remain visible with `status: "disabled"` and must not
   contribute annotations or actions.
4. A degraded app may contribute read-only state but must not perform actions
   that require unavailable capabilities.
5. Hosts must remove an app's annotations when that app is disabled, unmounted,
   or enters unrecoverable error.
6. Hosts should keep app state available after recoverable errors so panels can
   render the failure and any last-known entries.
7. Hosts must reject manifests with unknown capabilities or permissions unless
   the host advertises a newer compatible protocol version.
8. An app must not receive hidden APIs that are unavailable to another app
   declaring the same manifest.

### Panel Model

ClankerBend `0.1` assumes one Codex Desktop side panel controlled by the host. The
host may implement that side panel as:

- a shared shell that routes between mounted apps, or
- direct app entry pages loaded one at a time.

In either model:

1. `PanelStatus.activeAppId` identifies the app currently shown when known.
2. `POST /clankerbend/panel/open` opens or focuses the host panel and may switch
   the active panel app by `appId`.
3. `POST /clankerbend/apps/:appId/actions` may switch the active app when the
   action requires app UI.
4. Opening an already-loaded panel must not reload the page unless the app
   manifest uses `reloadPolicy: "reload"`.
5. Hosted app routes should live under `/apps/:appId/` on the host origin.

## Codex Desktop Adapter

### Launch

ClankerBend can launch Codex Desktop with CDP:

```sh
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=<free> \
  --user-data-dir=<test-or-clankerbend-profile>
```

Current Desktop releases use the `ChatGPT.app` path while retaining the Codex
bundle identity and bundled `Resources/codex` CLI. ClankerBend discovers that
layout and the legacy `/Applications/Codex.app` layout automatically.

When account profiles are enabled, the adapter also launches Desktop with the
selected profile's `CODEX_HOME` and isolated Electron user-data directory.
ClankerBend `0.1` runs one managed Codex Desktop instance at a time.

The host must not patch either application bundle.

### Attach

The CDP adapter attaches to the `app://-/index.html` renderer target. If
`/json/list` is unavailable or unstable, the adapter may attach via the browser
WebSocket and target discovery.

### `DesktopStatus`

```ts
type DesktopStatus = {
  cdpStatus: "starting" | "waiting-for-renderer" | "connected" | "disconnected" | "exited";
  cdpPort?: number;
  desktopPid?: number;
  target?: {
    type?: string;
    title?: string;
    url?: string;
  };
  error?: string;
};
```

## Renderer Runtime API

The CDP adapter initializes a single renderer runtime at:

```ts
window.__clankerbendRuntime
```

Apps register into runtime-owned app slots. The runtime is the only privileged
renderer global; individual apps must not require their own global bridge names.

```ts
type ClankerBendRendererRuntime = {
  protocolVersion: string;
  hostUrl: string;
  apps: Record<string, RendererAppSlot>;
  registerApp(app: RendererAppRegistration): RendererAppSlot;
  getApp(appId: string): RendererAppSlot | null;
  getBridge(appId: string): RendererBridge | null;
  getEntryUrl(appId: string): string | null;
  placeAnnotation(anchor: HTMLElement, annotation: RendererPlacedAnnotation): HTMLElement;
  removeAnnotations(appId: string, liveAnchorIds?: Iterable<string>): void;
};

type RendererAppSlot = {
  appId: string;
  entryUrl: string | null;
  capabilities: Record<string, unknown>;
  bridge: RendererBridge | null;
  injectedAt: string | null;
};

type RendererAppRegistration = {
  appId: string;
  entryUrl?: string;
  capabilities?: Record<string, unknown>;
  bridge: RendererBridge;
  injectedAt?: string;
};

type RendererPlacedAnnotation = {
  appId: string;
  anchorId: string;
  markerId?: string;
  priority?: number;
  placement?: "leading-rail" | "above";
  element: HTMLElement;
};
```

Each app bridge must be idempotent. Re-evaluating an app injection should update
styles and handlers without duplicating UI.

```ts
type RendererBridge = {
  version: number;
  snapshot(): RendererSnapshot;
  openPanel(): Promise<PanelOpenResult>;
  scrollToAnchor(anchorId: string, options?: ScrollOptions): ScrollResult;
  highlightAnchor(anchorId: string, options?: HighlightOptions): HighlightResult;
  setAnnotations(annotations: AnchorAnnotation[]): AnnotationResult;
};
```

`placeAnnotation()` is the renderer-side primitive for injected bridge code that
has already created a marker element. Apps ask the runtime to place an
annotation on a transcript anchor; the runtime, not the app, owns the host
container, slot ordering, offsets, stacking, cleanup, and collision avoidance.
Injected app bridges must not absolutely position transcript-adjacent markers
against Codex Desktop transcript rows themselves.

`removeAnnotations()` removes stale host-owned slots for one app without
touching markers owned by other apps. When `liveAnchorIds` is provided, the
runtime preserves that app's slots only for those anchors.

### `snapshot()`

Discovers the transcript state from the live DOM.

```ts
type RendererSnapshot = {
  href: string;
  title: string;
  version: number;
  scroll: {
    top: number;
    height: number;
    clientHeight: number;
  };
  anchors: TranscriptAnchor[];
  visibleCount: number;
  annotationCount: number;
  selection: ClankerBendSelection | null;
};
```

The current DOM anchor selectors are implementation details of the adapter, but
the current Codex Desktop adapter probes these selectors:

```text
[data-content-search-unit-key]
[data-turn-key]
[data-content-search-turn-key]
[data-thread-user-message-navigation-item-id]
```

### Transcript Anchor

```ts
type TranscriptAnchor = {
  anchorId: string;
  kind:
    | "content-search-unit"
    | "turn"
    | "content-search-turn"
    | "navigation-item"
    | "unknown";
  visible: boolean;
  top?: number;
  height?: number;
  textPreview: string;
  order: number;
  inferredRole?: "user" | "assistant" | "system" | "tool";
  appServer?: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
  };
};
```

`anchorId` is the DOM-derived navigation key. It is only guaranteed stable for
the current Desktop renderer session unless the adapter can map it to
app-server identity.

### Identity Tiers

ClankerBend uses separate identity tiers because exact app-server-to-DOM mapping is
not always available.

```ts
type ClankerBendIdentity = {
  anchorId?: string;
  entryId?: string;
  markerId?: string;
  appId?: string;
  appServer?: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
  };
  correlationId?: string;
};
```

- `anchorId` identifies a live transcript DOM anchor for the current renderer
  session.
- `entryId` identifies app-owned state, such as a timeline event, bookmark, or
  navigation target.
- `markerId` identifies a clickable annotation marker contributed by an app.
- `appServer.threadId`, `turnId`, and `itemId` identify Codex task objects when
  app-server correlation is available.
- `correlationId` is a best-effort host-generated link between two or more
  identity tiers.

Apps must not assume `anchorId` is durable across restarts. Durable state should
prefer app-owned `entryId` plus app-server identity when available.

### `openPanel()`

Uses existing Codex Desktop UI to open the Browser side panel and load the host
URL.

```ts
type PanelOpenResult = {
  ok: boolean;
  mode?:
    | "opened-url-input"
    | "opened-local-server-list"
    | "already-open"
    | "focused";
  error?: string;
};
```

Important rule: if the webview or iframe is already on the host URL,
`openPanel()` must return `already-open` and must not reload it. Reloading the
panel destroys selection and expansion state.

### `scrollToAnchor()`

Scrolls a transcript anchor into view.

```ts
type ScrollOptions = {
  behavior?: "auto" | "smooth";
  block?: "start" | "center" | "end" | "nearest";
};

type ScrollResult = {
  ok: boolean;
  anchorId?: string;
  error?: string;
};
```

### `highlightAnchor()`

Temporarily highlights a transcript anchor.

```ts
type HighlightOptions = {
  durationMs?: number;
};

type HighlightResult = {
  ok: boolean;
  anchorId?: string;
  error?: string;
};
```

### `setAnnotations()`

Adds or replaces transcript-adjacent annotations.

```ts
type AnchorAnnotation = {
  appId: string;
  anchorId: string;
  placement: "leading-rail" | "above";
  markers: AnchorAnnotationMarker[];
  priority?: number;
};

type AnchorAnnotationMarker = {
  markerId: string;
  glyph: string;
  label: string;
  tone?: "default" | "info" | "success" | "warning" | "danger" | "accent" | "muted";
  shape?: "circle" | "square" | "squircle" | "diamond" | "custom";
  category?: string;
  badge?: {
    glyph: string;
    label: string;
    tone?: "default" | "info" | "success" | "warning" | "danger" | "accent" | "muted";
  };
  entryId?: string;
  action?: {
    type: string;
    payload?: unknown;
  };
  data?: unknown;
};

type AnnotationResult = {
  ok: boolean;
  applied: number;
  error?: string;
};
```

The renderer bridge may infer annotations when no external data source is
available. Inferred markers must be marked as inferred in host state.

Annotation ownership rules:

1. Every app-owned annotation must include `appId`.
2. The host merges annotations from all apps for the same `anchorId`.
3. Lower `priority` values render earlier; omitted priority defaults to `100`.
   Ties sort by `appId`, then `markerId`, both lexicographically.
4. Marker clicks route to the contributing app through
   `POST /clankerbend/apps/:appId/actions`.
5. The renderer bridge must remove stale markers for an app without removing
   markers owned by other apps.
6. Marker identity is scoped by `(appId, markerId)`. Two apps may use the same
   `markerId` without collision.
7. If a placement cannot fit all markers, the host should preserve sorted order
   and may collapse overflow into a host-owned overflow marker.
8. Apps request placement; the host decides actual layout. Apps may style the
   marker contents, but must not rely on fixed offsets, negative margins, or
   transcript-row absolute positioning for placement.

## Panel API

The panel talks only to the host server. It does not need direct CDP access.

### `POST /clankerbend/panel/open`

Asks the host to open/focus the panel in Codex Desktop. The host calls
`window.__clankerbendRuntime.getBridge(activeAppId).openPanel()` or an equivalent
app-id-scoped bridge call via CDP.

```ts
type OpenPanelRequest = {
  appId?: string;
};
```

When `appId` is provided, the host must set `PanelStatus.activeAppId` to that
registered app before loading the panel URL. Unknown app ids return `404`.

```ts
type OpenPanelResponse = ClankerBendResponse<PanelOpenResult>;
```

### `POST /clankerbend/transcript/scroll`

```json
{
  "anchorId": "opaque-anchor",
  "behavior": "smooth",
  "block": "center"
}
```

```ts
type ScrollToAnchorRequest = {
  anchorId: string;
  behavior?: "auto" | "smooth";
  block?: "start" | "center" | "end" | "nearest";
};

type ScrollToAnchorResponse = ClankerBendResponse<ScrollResult>;
```

### `POST /clankerbend/transcript/highlight`

```json
{
  "anchorId": "opaque-anchor",
  "durationMs": 2200
}
```

```ts
type HighlightAnchorRequest = {
  anchorId: string;
  durationMs?: number;
};

type HighlightAnchorResponse = ClankerBendResponse<HighlightResult>;
```

### `POST /clankerbend/selection`

Updates global host selection.

```json
{
  "selection": {
    "selectionId": "sel_123",
    "source": "panel",
    "appId": "example.app",
    "anchorId": "opaque-anchor",
    "entryId": "app-entry-1",
    "selectedAt": "2026-06-17T19:21:00.000Z"
  }
}
```

```ts
type PostSelectionRequest = {
  selection: ClankerBendSelection;
};

type PostSelectionResponse = ClankerBendResponse<{
  selection: ClankerBendSelection;
  stale?: boolean;
}>;
```

The host must ignore stale selections. A selection is stale when its `selectedAt`
is older than the current accepted selection. If two selections have the same
`selectedAt`, host receive order wins. On every accepted selection, the host must
assign a monotonically increasing `sequence` and `acceptedAt` timestamp.

```ts
type ClankerBendSelection = {
  selectionId: string;
  sequence?: number;
  source: "panel" | "transcript" | "adapter";
  appId?: string;
  anchorId?: string;
  quote?: string;
  range?: ClankerBendTextRange;
  markerId?: string;
  entryId?: string;
  appServer?: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
  };
  correlationId?: string;
  selectedAt: string;
  acceptedAt?: string;
};
```

This monotonic rule prevents stale renderer polling from restoring an
older transcript click after the user selected a newer side-panel entry.

### Text Ranges

Apps must not inspect Codex Desktop DOM to interpret selected text. When the
adapter observes a transcript text selection, it normalizes that selection into
a `ClankerBendTextRange` and updates host `selection`.

```ts
type ClankerBendTextRange = {
  anchorId: string;
  text: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  fingerprint?: string;
};
```

`prefix`, `suffix`, offsets, and `fingerprint` are best-effort adapter hints.
Apps may store them for later source matching, but they must treat `anchorId`
plus selected `text` as the only required fields.

```text
POST /clankerbend/transcript/highlight-range
```

```ts
type PostHighlightRangeRequest = {
  range: ClankerBendTextRange;
  durationMs?: number;
  behavior?: "auto" | "smooth";
  block?: "start" | "center" | "end" | "nearest";
};
```

The host delegates range mapping to the adapter. If precise text-range
highlighting is unavailable, the adapter may highlight the containing anchor.

### Selection Actions

Apps can contribute actions for host-rendered transcript selection menus through
app state. The host or renderer runtime owns menu placement and click routing.

```ts
type ClankerBendSelectionAction = {
  actionId: string;
  appId: string;
  type: string;
  label: string;
  icon?: string;
  appliesTo: "text-selection" | "anchor-selection";
  enabled?: boolean;
  payload?: unknown;
};
```

When the user chooses a selection action, the host sends a normal
`POST /clankerbend/apps/:appId/actions` request with the current selection in the
action payload or app context.

### Anchored Overlays

Apps can request a host-rendered overlay anchored to an anchor or text range.
Apps provide fields and actions; the host/adapter owns DOM placement.

```text
POST /clankerbend/overlay/open
POST /clankerbend/overlay/close
```

```ts
type ClankerBendOverlay = {
  overlayId: string;
  appId: string;
  kind: "form" | "menu" | "notice";
  title?: string;
  anchorId?: string;
  range?: ClankerBendTextRange;
  fields?: ClankerBendOverlayField[];
  actions?: ClankerBendOverlayAction[];
  openedAt?: string;
};

type ClankerBendOverlayField = {
  fieldId: string;
  kind: "text" | "textarea" | "hidden";
  label?: string;
  value?: string;
};

type ClankerBendOverlayAction = {
  label: string;
  type: string;
  payload?: unknown;
};
```

### Composer Context and Drafts

Composer context items are app-contributed chips or context blocks owned by the
host. Apps add/remove items and ask the host to serialize them into a draft; the
adapter owns Codex composer DOM details.

```ts
type ClankerBendComposerState = {
  contextItems: ClankerBendComposerContextItem[];
  draft: {
    text: string;
    mode: "replace" | "append" | "prepend";
    contextItemIds: string[];
    updatedAt?: string;
  };
  lastSubmittedAt?: string;
};

type ClankerBendComposerContextItem = {
  itemId: string;
  appId: string;
  label: string;
  body: string;
  anchorId?: string;
  range?: ClankerBendTextRange;
  status: "queued" | "sent" | "resolved";
  createdAt?: string;
  updatedAt?: string;
};
```

```text
POST /clankerbend/composer/context
POST /clankerbend/composer/context/remove
POST /clankerbend/composer/draft
POST /clankerbend/composer/submit
```

`/composer/draft` accepts `{ text, mode, contextItemIds }`. `/composer/submit`
is optional and must fail gracefully when the adapter cannot safely submit.

## Renderer Events

The injected bridge cannot rely on `fetch()` from `app://` to loopback because
renderer-to-localhost fetch may fail in this integration path. Therefore the
bridge must be able to communicate through CDP-polled renderer state.

The bridge records events in renderer globals:

```ts
type RendererEventBuffer = {
  selection?: ClankerBendSelection;
  panelOpen?: PanelOpenResult & { at: string };
  hostEvents?: ClankerBendRendererHostEvent[];
};
```

The CDP adapter polls `snapshot()` and accepts only newer renderer selections.
For host-rendered UI such as selection menus, overlays, and composer context
chips, the renderer queues typed host events. The CDP adapter drains those
events and invokes the same host APIs that app panels use.

```ts
type ClankerBendRendererHostEvent =
  | {
      kind: "selection";
      selection: ClankerBendSelection;
    }
  | {
      kind: "appAction";
      appId: string;
      type: string;
      payload?: unknown;
      requestedAt?: string;
    }
  | {
      kind: "overlayClose";
      overlayId?: string;
    }
  | {
      kind: "composerContextRemove";
      itemId: string;
    }
  | {
      kind: "highlightRange";
      range: ClankerBendTextRange;
    }
  | {
      kind: "highlightAnchor";
      anchorId: string;
    };
```

If renderer-to-loopback networking is available, the bridge may also call the
host HTTP endpoints directly as an optimization.

## App State

ClankerBend does not prescribe an app state provider. App state can come from
app-server, a local audit system, an MCP server, a test runner, a diagnostics
collector, a bookmark store, an editor-navigation model, or simple DOM
inference.

```ts
type ClankerBendAppState = {
  appId: string;
  status: ClankerBendAppStatus;
  source: string;
  connected: boolean;
  entries: ClankerBendAppEntry[];
  annotations?: AnchorAnnotation[];
  commands?: ClankerBendCommand[];
  selectionActions?: ClankerBendSelectionAction[];
  updatedAt?: string;
};

type ClankerBendAppEntry = {
  entryId: string;
  appId: string;
  anchorId?: string;
  markerId?: string;
  correlationId?: string;
  title: string;
  summary?: string;
  category?: string;
  tone?: AnchorAnnotationMarker["tone"];
  status?: string;
  target?: {
    path?: string;
    url?: string;
    label?: string;
  };
  detail?: unknown;
  occurredAt?: string;
};

type ClankerBendCommand = {
  commandId: string;
  appId: string;
  label: string;
  type: string;
  shortcut?: string;
  enabled?: boolean;
  payload?: unknown;
};
```

Panel UIs should render `ClankerBendAppEntry[]` without knowing the provider. A
timeline, review list, trace viewer, bookmark list, or diagnostics stream can
all be represented as entries bound optionally to transcript anchors.

## App-Server Adapter

The app-server adapter is separate from Desktop control. ClankerBend hosts are
app-server-aware and report app-server status even when they cannot connect.

Useful app-server methods include:

- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/read`
- `thread/turns/items/list`
- approval request/response methods
- `thread/rollback`

ClankerBend should expose app-server data as correlation metadata, not as a replacement
transport.

```ts
type AppServerStatus = {
  status: "disabled" | "starting" | "connected" | "error" | "exited";
  pid?: number;
  version?: string;
  error?: string;
};
```

If an app sends approval responses through app-server, that path must be
explicit and user-driven. ClankerBend must not auto-approve or auto-deny actions.

## Minimal Endpoint Set

A ClankerBend host must implement these endpoints:

```text
GET  /clankerbend/manifest
GET  /clankerbend/state
GET  /clankerbend/events
GET  /clankerbend/apps
GET  /clankerbend/apps/:appId/manifest
GET  /clankerbend/apps/:appId/state
GET  /clankerbend/apps/:appId/actions/:actionId
POST /clankerbend/apps/:appId/actions
POST /clankerbend/panel/open
POST /clankerbend/transcript/scroll
POST /clankerbend/transcript/highlight
POST /clankerbend/selection
```

## Manifest

ClankerBend hosts and apps describe themselves with manifests. Manifests are
normative for the host launcher, app registry, and panel UI; Codex Desktop does
not need to understand them. A packaged app should keep its manifest on disk,
and a running host must expose resolved manifests through the host API.

```json
{
  "clankerbendVersion": "0.1",
  "hostId": "onewill.clankerbend.local",
  "hostName": "ClankerBend Host",
  "security": {
    "auth": "bearer",
    "localDevInsecure": false
  },
  "capabilities": {
    "host": {
      "apps": true,
      "actions": true,
      "appState": true,
      "sidePanel": true
    },
    "transcript": {
      "read": true,
      "annotate": true,
      "navigate": true,
      "select": true
    },
    "adapter": {
      "name": "codex-desktop-cdp",
      "cdp": true,
      "rendererInjection": true,
      "providers": {
        "transcriptSnapshot": "onewill.vim-nav",
        "transcriptOrder": "onewill.vim-nav",
        "transcriptNavigation": "onewill.vim-nav",
        "transcriptHighlight": "onewill.vim-nav"
      }
    },
    "appServer": {
      "available": true,
      "correlateItems": true,
      "approvals": false,
      "rollback": false
    }
  },
  "apps": [
    {
      "clankerbendVersion": "0.1",
      "appId": "example.app",
      "version": "0.1.0",
      "name": "Example App",
      "entry": "http://127.0.0.1:0/apps/example/",
      "distribution": {
        "kind": "local",
        "source": ".",
        "integrity": "dev-local"
      },
      "entrypoint": {
        "kind": "module",
        "module": "./src/example-app.js",
        "factory": "createExampleApp",
        "publicDir": "./public"
      },
      "capabilities": {
        "panel": true,
        "annotations": true,
        "commands": true,
        "actions": true,
        "appState": true,
        "rendererBridge": false
      },
      "contributes": {
        "panel": true,
        "annotations": true,
        "commands": true,
        "actions": true,
        "appState": true
      },
      "permissions": {
        "transcriptRead": true,
        "transcriptAnnotate": true,
        "transcriptNavigate": true,
        "appServerRead": true,
        "appServerApprove": false,
        "appServerRollback": false
      },
      "panel": {
        "title": "Example",
        "reloadPolicy": "preserve",
        "preferredWidth": 420
      }
    }
  ]
}
```

## Public Example: VimNav App

The public reference app for ClankerBend `0.1` is VimNav, a Vim-style transcript navigator.
Other apps should use the same host/app contract and document any app-specific
state or action vocabulary they expose.

### App Manifest

```json
{
  "clankerbendVersion": "0.1",
  "appId": "onewill.vim-nav",
  "version": "0.1.0",
  "name": "VimNav",
  "entry": "http://127.0.0.1:49152/apps/onewill.vim-nav/",
  "distribution": {
    "kind": "local",
    "source": ".",
    "integrity": "dev-local"
  },
  "entrypoint": {
    "kind": "module",
    "module": "./src/vim-nav-app.js",
    "factory": "createVimNavApp",
    "publicDir": "./public"
  },
  "capabilities": {
    "panel": true,
    "annotations": true,
    "commands": true,
    "actions": true,
    "appState": true,
    "rendererBridge": false
  },
  "contributes": {
    "panel": true,
    "annotations": true,
    "commands": true,
    "actions": true,
    "appState": true
  },
  "permissions": {
    "transcriptRead": true,
    "transcriptAnnotate": true,
    "transcriptNavigate": true,
    "appServerRead": false,
    "appServerApprove": false,
    "appServerRollback": false
  },
  "panel": {
    "title": "VimNav",
    "reloadPolicy": "preserve",
    "preferredWidth": 360
  }
}
```

### App State

```json
{
  "ok": true,
  "data": {
    "appId": "onewill.vim-nav",
    "status": "ready",
    "source": "dom",
    "connected": true,
    "entries": [
      {
        "entryId": "nav:anchor-2",
        "appId": "onewill.vim-nav",
        "anchorId": "anchor-2",
        "title": "02 assistant",
        "summary": "Latest assistant response",
        "category": "navigation",
        "status": "visible"
      }
    ],
    "annotations": [
      {
        "appId": "onewill.vim-nav",
        "anchorId": "anchor-2",
        "placement": "leading-rail",
        "priority": 50,
        "markers": [
          {
            "markerId": "ruler-2",
            "glyph": "02",
            "label": "Jump to transcript item 2",
            "tone": "accent",
            "shape": "circle",
            "entryId": "nav:anchor-2",
            "action": {
              "type": "vim.jump",
              "payload": {
                "anchorId": "anchor-2"
              }
            }
          }
        ]
      }
    ],
    "commands": [
      {
        "commandId": "vim.next",
        "appId": "onewill.vim-nav",
        "label": "Next transcript item",
        "type": "vim.jumpRelative",
        "shortcut": "j",
        "enabled": true,
        "payload": {
          "delta": 1
        }
      }
    ],
    "updatedAt": "2026-06-17T19:21:00.000Z"
  }
}
```

### Action Request

```json
{
  "action": {
    "actionId": "act_001",
    "appId": "onewill.vim-nav",
    "type": "vim.jump",
    "anchorId": "anchor-2",
    "entryId": "nav:anchor-2",
    "payload": {
      "behavior": "smooth",
      "block": "center"
    },
    "requestedAt": "2026-06-17T19:21:01.000Z"
  }
}
```

### Action Result

```json
{
  "ok": true,
  "data": {
    "actionId": "act_001",
    "appId": "onewill.vim-nav",
    "ok": true,
    "status": "applied",
    "completedAt": "2026-06-17T19:21:01.050Z"
  }
}
```

## Security And Lifecycle

ClankerBend is local integration glue, not a sandbox or security boundary. The
host still needs explicit safety rules because it can reach CDP, app-server,
and user-visible UI.

### Loopback And Session Access

- Bind host HTTP servers to loopback only.
- Prefer ephemeral ports.
- Use an unguessable session token for panel requests once multiple apps or
  long-lived hosts are supported.
- Do not expose the host server on external interfaces.

### App Permissions

App manifests declare requested permissions. The host must enforce them.

```ts
type ClankerBendAppPermissions = {
  transcriptRead?: boolean;
  transcriptAnnotate?: boolean;
  transcriptNavigate?: boolean;
  appServerRead?: boolean;
  appServerApprove?: boolean;
  appServerRollback?: boolean;
};
```

For ClankerBend `0.1`, an explicit `false` means the host must deny that
capability. Omitted permissions are interpreted by host policy, but reference
hosts should treat omitted transcript permissions as allowed for local
development apps. A host that denies `transcriptRead` must provide an empty
transcript view to that app. A host that denies `transcriptAnnotate` must ignore
or remove that app's annotations. A host that denies `transcriptNavigate` must
return `403` for action paths that try to scroll or highlight transcript
anchors through host context helpers.

No app receives approval, rollback, filesystem, shell, or network authority just
because it is mounted. Approval and rollback actions must be explicit,
user-driven, and visible in app state.

### Desktop Lifecycle

- Do not patch the Codex app bundle.
- Prefer launching through the host so CDP is enabled at process startup.
- Attach to an already-running Desktop session only when CDP is already
  available.
- Use a test or ClankerBend profile when launching Desktop unless the user
  explicitly requests their normal profile.
- Clean up host-launched Codex and Node processes on exit.

### UI Lifecycle

- Do not reload an already-open side panel as part of open/focus.
- Do not replace panel DOM while the user has active text selection.
- Do not remove annotations owned by another app.
- Treat DOM selectors as adapter configuration, not protocol fields.

## Appendix: Non-Normative Reference Mapping

The public VimNav example maps implementation files to ClankerBend terms as
follows:

| VimNav implementation | ClankerBend term |
| --- | --- |
| `clankerbend/host/src/index.js` | Reusable ClankerBend Host |
| `clankerbend/apps/vim-nav/server.mjs` | Host launcher registering one app |
| `clankerbend/apps/vim-nav/src/vim-nav-app.js` | VimNav app manifest, state, and actions |
| `clankerbend/apps/vim-nav/public/index.html` | Hosted app panel |
| `clankerbend/apps/vim-nav/public/app.js` | App client |
| `clankerbend/apps/vim-nav/public/styles.css` | App panel styling |
| `clankerbend/host/src/codex-desktop-renderer-bridge.js` | Host-owned injected renderer bridge |
| CDP `Runtime.evaluate` | Desktop CDP Adapter call, not used by mock tests |
| `window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot()` | `RendererBridge.snapshot()` |
| `window.__clankerbendRuntime.getBridge("onewill.vim-nav").openPanel()` | `RendererBridge.openPanel()` |
| `window.__clankerbendRuntime.getBridge("onewill.vim-nav").scrollToAnchor(anchorId)` | `scrollToAnchor(anchorId)` |
| `window.__clankerbendRuntime.getBridge("onewill.vim-nav").highlightAnchor(anchorId)` | `highlightAnchor(anchorId)` |
| numbered transcript ruler pills | `AnchorAnnotation.markers` |
| `/clankerbend/apps/onewill.vim-nav/state` | App state endpoint |
| `/clankerbend/apps/onewill.vim-nav/actions` | App action endpoint |
| `clankerbend/apps/vim-nav/test-clankerbend.mjs` | Fast host/app behavior e2e |

## Operational Rules

1. A host may mount multiple apps, but only one renderer bridge should own
   transcript discovery and annotation placement.
2. Apps must go through the host for transcript navigation, annotation updates,
   action execution, and app-server correlation.
3. Treat exact app-server item mapping as optional unless proven.
4. Preserve user selection and expanded panel state during host event updates.
5. Prefer degraded, read-only behavior when CDP, app-server, or requested app
   permissions are unavailable.

## Behavior Profiles

ClankerBend `0.1` describes behavior in four profiles. Implementations should state
which profiles they support and cover those behaviors with e2e tests.

### Core Host

A Core Host must implement:

- JSON envelope and error model.
- Session token behavior or explicit `localDevInsecure`.
- `GET /clankerbend/manifest`.
- `GET /clankerbend/state`.
- `GET /clankerbend/events`.
- `GET /clankerbend/apps`.
- `GET /clankerbend/apps/:appId/manifest`.
- `GET /clankerbend/apps/:appId/state`.
- `GET /clankerbend/apps/:appId/actions/:actionId`.
- `POST /clankerbend/apps/:appId/actions`.
- App lifecycle states and permission enforcement.

### Transcript Host

A Transcript Host is a Core Host that also implements:

- Transcript anchors in `ClankerBendPublicState`.
- `POST /clankerbend/panel/open`.
- `POST /clankerbend/transcript/scroll`.
- `POST /clankerbend/transcript/highlight`.
- `POST /clankerbend/selection`.
- Annotation ownership and merge rules.

### Codex Desktop Adapter

A Codex Desktop Adapter is a Transcript Host implementation that realizes the
transcript surface through Codex Desktop CDP and renderer injection. It must
follow the lifecycle rules for CDP launch/attach, idempotent injection, and
process cleanup.

### App Client

An App Client must:

- Read `GET /clankerbend/manifest` and verify required capabilities.
- Use `GET /clankerbend/apps/:appId/state` or `GET /clankerbend/state` as its source
  of truth.
- Use `POST /clankerbend/apps/:appId/actions` for app commands.
- Use `GET /clankerbend/apps/:appId/actions/:actionId` to recover action results
  when needed.
- Treat `ClankerBendError` as the only failure contract.
- Degrade cleanly when capabilities or permissions are unavailable.

## Required E2E Coverage

A ClankerBend `0.1` implementation should include fast e2e coverage for these
observable behaviors:

1. `GET /clankerbend/manifest` returns `ok: true`, `clankerbendVersion: "0.1"`,
   host capabilities, security posture, and app manifests.
2. `GET /clankerbend/state` returns `ok: true` with `protocolName: "clankerbend"`,
   `protocolVersion: "0.1"`, numeric `sequence`, ISO `generatedAt`, host
   status, transcript state, app states, and app-server status.
3. `GET /clankerbend/events` emits an initial `state` event, monotonically
   increasing event ids, and `heartbeat` events.
4. Unknown apps return `404` with `ClankerBendError.error.code: "not_found"`.
5. Missing or invalid bearer tokens return `401` unless `localDevInsecure` is
   explicitly enabled.
6. Duplicate `(appId, actionId)` submissions return the same receipt or result
   without executing twice.
7. Async action completion is observable through both SSE `action` events and
   `GET /clankerbend/apps/:appId/actions/:actionId`.
8. Stale selections return the current accepted selection with `stale: true`
   and do not change host `selection`.
9. Annotation merge order is stable by `priority`, then `appId`, then
   `markerId`.
10. Disabling or unmounting an app removes only that app's annotations.
11. `POST /clankerbend/transcript/scroll` and
   `POST /clankerbend/transcript/highlight` return `404` for unknown anchors and do
   not mutate selection.
12. Opening an already-loaded panel does not reload it when
   `reloadPolicy: "preserve"`.

## Versioning

ClankerBend version `0.1` is the minimal hack-path protocol:

- local host state/event endpoints
- host/app manifest negotiation
- app registry and app-scoped state
- app action routing
- CDP renderer bridge
- transcript anchor discovery
- transcript annotation
- panel open/focus
- selection synchronization
- app-server correlation

Future versions may add alternate adapters, but they should preserve the same
host-facing concepts. Minor versions should add optional capabilities or fields
behind capability checks. Major versions may change required fields or endpoint
semantics, but a host must make that visible through `protocolVersion`,
`clankerbendVersion`, and `capabilities.protocolVersion` before app actions are
required.
