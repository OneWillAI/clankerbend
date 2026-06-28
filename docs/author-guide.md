# ClankerBend App Author Guide

The public reference apps are `apps/vim-nav` and `apps/sticky-notes`. VimNav
demonstrates transcript navigation and annotations. Sticky Notes demonstrates
text-range selection, host-rendered overlays, composer context, and draft
insertion using only documented host APIs.

## App Shape

A module app exports a factory:

```js
export function createExampleApp(options = {}) {
  return {
    appId: "onewill.example.app",
    name: "Example App",
    publicDir: options.publicDir,
    contributes: {
      panel: true,
      annotations: true,
      actions: true,
      appState: true,
      selectionActions: false,
      overlays: false,
      composerContext: false,
      composerDraft: false
    },
    permissions: {
      transcriptRead: true,
      transcriptAnnotate: true,
      transcriptNavigate: true,
      overlayWrite: false,
      composerWrite: false,
      appServerRead: false
    },
    getState(context) {
      return {
        appId: this.appId,
        status: "ready",
        source: "dom",
        connected: context.desktop.cdpStatus === "connected",
        entries: [],
        annotations: [],
        updatedAt: context.state.generatedAt
      };
    },
    async handleAction(action, context) {
      return {
        actionId: action.actionId,
        appId: this.appId,
        ok: true,
        status: "applied",
        completedAt: new Date().toISOString()
      };
    }
  };
}
```

The host wraps app state and actions in ClankerBend HTTP envelopes. The app should
throw `context.httpError(...)` for expected validation failures.

## Transcript Annotations

Apps return annotation requests from `getState`. The host and renderer bridge
own final placement, sorting, and collision avoidance:

```js
{
  appId: "onewill.example.app",
  anchorId: anchor.anchorId,
  placement: "leading-rail",
  priority: 80,
  markers: [{
    markerId: `example:${anchor.anchorId}`,
    glyph: "E",
    label: "Example marker",
    tone: "muted",
    shape: "circle",
    entryId: `example:${anchor.anchorId}`,
    action: {
      type: "example.select",
      payload: { anchorId: anchor.anchorId }
    }
  }]
}
```

Apps should not mutate Codex Desktop DOM directly for placement. Renderer
bridges register through `window.__clankerbendRuntime` and call host-owned
annotation APIs.

## Text Ranges And Composer Context

Apps that work with selected text should consume `context.selection.range` and
contribute `selectionActions` from app state. Apps request overlays through
`context.openOverlay(...)`, queue composer context through
`context.addComposerContext(...)`, and insert follow-up drafts through
`context.setComposerDraft(...)`.

Apps should not query Codex Desktop DOM, position floating menus, render
composer chips, or write into the composer directly. Those details belong in
the ClankerBend host adapter and renderer runtime.

## Actions

Actions are routed through:

```text
POST /clankerbend/apps/:appId/actions
```

An action must include non-empty `appId`, `actionId`, and `type`. Action IDs are
idempotency keys; repeated requests return the original result.

## E2E

Reference apps should run:

```sh
npm test
npm run test:desktop-real:integration
```

Desktop tests are explicit because they launch Codex Desktop with a disposable
profile and CDP port.
