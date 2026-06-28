export const VIM_NAV_APP_ID = "onewill.vim-nav";

export function createVimNavApp(options = {}) {
  return {
    appId: VIM_NAV_APP_ID,
    name: "VimNav",
    publicDir: options.publicDir,
    contributes: {
      panel: true,
      annotations: true,
      commands: true,
      actions: true,
      appState: true
    },
    permissions: {
      transcriptRead: true,
      transcriptAnnotate: true,
      transcriptNavigate: true,
      appServerRead: false,
      appServerApprove: false,
      appServerRollback: false
    },
    panel: {
      title: "VimNav",
      reloadPolicy: "preserve",
      preferredWidth: 360
    },

    getManifest(context) {
      return {
        clankerbendVersion: context.protocolVersion,
        appId: VIM_NAV_APP_ID,
        name: "VimNav",
        entry: context.entry,
        contributes: this.contributes,
        permissions: this.permissions,
        panel: this.panel
      };
    },

    getState(context) {
      const anchors = context.transcript.anchors || [];
      return {
        appId: VIM_NAV_APP_ID,
        status: context.desktop.cdpStatus === "connected" ? "ready" : "degraded",
        source: context.desktop.target?.type === "mock" ? "mock" : "dom",
        connected: context.desktop.cdpStatus === "connected",
        entries: anchors.slice(0, 300).map((anchor) => ({
          entryId: entryId(anchor.anchorId),
          appId: VIM_NAV_APP_ID,
          anchorId: anchor.anchorId,
          markerId: markerId(anchor.anchorId),
          correlationId: anchor.appServer?.itemId || undefined,
          title: `${anchorLabel(anchor)} ${anchor.inferredRole || anchor.kind}`,
          summary: anchor.textPreview,
          category: "navigation",
          tone: anchor.anchorId === context.selection?.anchorId ? "accent" : anchor.visible ? "success" : "muted",
          status: anchor.visible ? "visible" : "offscreen",
          detail: {
            order: anchor.order,
            indexed: anchor.indexed !== false,
            role: anchor.inferredRole || "unknown"
          },
          occurredAt: context.transcript.updatedAt
        })),
        annotations: anchors.slice(0, 300).map((anchor) => ({
          appId: VIM_NAV_APP_ID,
          anchorId: anchor.anchorId,
          placement: "leading-rail",
          priority: 50,
          markers: [{
            markerId: markerId(anchor.anchorId),
            glyph: anchorLabel(anchor),
            label: anchor.indexed === false ? "Transcript index pending" : `Jump to transcript item ${anchor.order}`,
            tone: anchor.anchorId === context.selection?.anchorId ? "accent" : "muted",
            shape: "circle",
            entryId: entryId(anchor.anchorId),
            action: {
              type: "vim.jump",
              payload: { anchorId: anchor.anchorId }
            }
          }]
        })),
        commands: [
          command("vim.prev", "Previous transcript item", "vim.jumpRelative", "k", { delta: -1 }),
          command("vim.next", "Next transcript item", "vim.jumpRelative", "j", { delta: 1 }),
          command("vim.first", "First transcript item", "vim.jumpIndex", "gg", { index: 0 }),
          command("vim.last", "Last transcript item", "vim.jumpIndex", "G", { index: -1 }),
          command("vim.prevUser", "Previous user message", "vim.jumpRole", "{", { role: "user", direction: -1 }),
          command("vim.nextUser", "Next user message", "vim.jumpRole", "}", { role: "user", direction: 1 }),
          command("vim.latestAssistant", "Latest assistant message", "vim.latestRole", ":latest assistant", { role: "assistant" }),
          command("vim.latestUser", "Latest user message", "vim.latestRole", ":latest user", { role: "user" }),
          command("vim.search", "Search transcript text", "vim.search", "/term", { query: "" })
        ],
        updatedAt: context.state.generatedAt
      };
    },

    async handleAction(action, context) {
      if (action.type === "vim.jump") {
        const anchorId = action.anchorId || action.payload?.anchorId;
        return jump(action, context, anchorId);
      }

      if (action.type === "vim.jumpRelative") {
        const current = context.selection?.anchorId ||
          context.transcript.anchors.find((anchor) => anchor.visible)?.anchorId ||
          context.transcript.anchors[0]?.anchorId;
        const index = Math.max(0, context.anchorIndex(current));
        const delta = Number(action.payload?.delta || 0);
        const target = context.transcript.anchors[Math.max(0, Math.min(context.transcript.anchors.length - 1, index + delta))];
        return jump(action, context, target?.anchorId);
      }

      if (action.type === "vim.jumpIndex") {
        const rawIndex = Number(action.payload?.index || 0);
        const index = rawIndex < 0 ? context.transcript.anchors.length - 1 : rawIndex;
        return jump(action, context, context.transcript.anchors[index]?.anchorId);
      }

      if (action.type === "vim.jumpRole") {
        const role = String(action.payload?.role || "");
        const direction = Number(action.payload?.direction || 1) < 0 ? -1 : 1;
        return jump(action, context, findRoleAnchor(context, role, direction)?.anchorId);
      }

      if (action.type === "vim.latestRole") {
        const role = String(action.payload?.role || "");
        return jump(action, context, latestRoleAnchor(context, role)?.anchorId);
      }

      if (action.type === "vim.search") {
        const query = String(action.payload?.query || "").trim().toLowerCase();
        const direction = Number(action.payload?.direction || 1) < 0 ? -1 : 1;
        if (!query) throw context.httpError(400, "bad_request", "search query is required");
        return jump(action, context, searchAnchor(context, query, direction)?.anchorId);
      }

      throw context.httpError(404, "not_found", `unknown action: ${action.type}`);
    }
  };
}

async function jump(action, context, anchorId) {
  if (!context.anchorExists(anchorId)) throw context.httpError(404, "not_found", "anchor not found");
  context.acceptSelection({
    selectionId: `sel_${action.actionId}`,
    source: "panel",
    appId: VIM_NAV_APP_ID,
    anchorId,
    entryId: entryId(anchorId),
    selectedAt: action.requestedAt || new Date().toISOString()
  }, { broadcast: false });

  const scroll = await context.scrollToAnchor(anchorId, action.payload || {});
  if (!scroll?.ok) throw context.httpError(503, "adapter_unavailable", scroll?.error || "scroll failed");
  await context.highlightAnchor(anchorId, { durationMs: action.payload?.durationMs || 1200 });
  return applied(action, { anchorId });
}

function findRoleAnchor(context, role, direction) {
  if (!isRole(role)) throw context.httpError(400, "bad_request", "role must be user, assistant, system, or tool");
  const anchors = context.transcript.anchors || [];
  const current = context.selection?.anchorId || anchors.find((anchor) => anchor.visible)?.anchorId || anchors[0]?.anchorId;
  const start = Math.max(0, context.anchorIndex(current));
  for (let index = start + direction; index >= 0 && index < anchors.length; index += direction) {
    if (anchors[index].inferredRole === role) return anchors[index];
  }
  return null;
}

function latestRoleAnchor(context, role) {
  if (!isRole(role)) throw context.httpError(400, "bad_request", "role must be user, assistant, system, or tool");
  const anchors = context.transcript.anchors || [];
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    if (anchors[index].inferredRole === role) return anchors[index];
  }
  return null;
}

function searchAnchor(context, query, direction) {
  const anchors = context.transcript.anchors || [];
  const current = context.selection?.anchorId || anchors.find((anchor) => anchor.visible)?.anchorId || anchors[0]?.anchorId;
  const start = Math.max(0, context.anchorIndex(current));
  for (let offset = 1; offset <= anchors.length; offset += 1) {
    const index = (start + direction * offset + anchors.length) % anchors.length;
    if ((anchors[index].textPreview || "").toLowerCase().includes(query)) return anchors[index];
  }
  return null;
}

function anchorLabel(anchor) {
  return anchor.indexed === false ? "?" : String(anchor.order).padStart(2, "0");
}

function isRole(role) {
  return ["user", "assistant", "system", "tool"].includes(role);
}

function applied(action, data) {
  return {
    actionId: action.actionId,
    appId: VIM_NAV_APP_ID,
    ok: true,
    status: "applied",
    data,
    completedAt: new Date().toISOString()
  };
}

function command(commandId, label, type, shortcut, payload = {}) {
  return { commandId, appId: VIM_NAV_APP_ID, label, type, shortcut, enabled: true, payload };
}

function entryId(anchorId) {
  return `nav:${anchorId}`;
}

function markerId(anchorId) {
  return `ruler:${anchorId}`;
}
