import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { extname, join, relative, resolve } from "node:path";

export const CLANKERBEND_VERSION = "0.1";

export class ClankerBendHttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function httpError(status, code, message, detail) {
  return new ClankerBendHttpError(status, code, message, detail);
}

export function createMockTranscriptAdapter(options = {}) {
  const anchors = options.anchors || [
    mockAnchor("mock-1:user", 1, "user", "What changed in the current branch?"),
    mockAnchor("mock-2:assistant", 2, "assistant", "I inspected the diff and found two changed files."),
    mockAnchor("mock-3:user", 3, "user", "Jump to the latest assistant answer."),
    mockAnchor("mock-4:assistant", 4, "assistant", "Use G to jump to the last visible transcript item.")
  ];

  return {
    name: "mock",
    cdp: false,
    rendererInjection: false,
    providers: options.providers || undefined,
    async start(host) {
      host.setDesktopStatus({
        cdpStatus: "connected",
        target: { type: "mock", title: "Mock Codex Desktop", url: "app://-/index.html" },
        error: null
      });
      host.updateTranscript({
        anchors,
        visibleCount: anchors.filter((anchor) => anchor.visible).length,
        annotationCount: anchors.length,
        scroll: { top: 0, height: 1200, clientHeight: 700 },
        updatedAt: new Date().toISOString()
      }, { broadcast: false });
      host.acceptSelection({
        selectionId: "mock-selected",
        source: "adapter",
        appId: options.defaultAppId,
        anchorId: anchors[1]?.anchorId || anchors[0]?.anchorId,
        entryId: anchors[1] ? `nav:${anchors[1].anchorId}` : undefined,
        selectedAt: new Date().toISOString()
      }, { broadcast: false });
    },
    async openPanel() {
      return { ok: true, mode: "focused" };
    },
    async scrollToAnchor(anchorId) {
      return { ok: true, anchorId };
    },
    async highlightAnchor(anchorId) {
      return { ok: true, anchorId };
    },
    async highlightRange(range) {
      return { ok: true, anchorId: range?.anchorId, range };
    },
    async setComposerDraft(draft) {
      return { ok: true, draft };
    },
    async submitComposer(draft) {
      return { ok: true, draft, submitted: true };
    },
    async attachFiles(files) {
      return { ok: true, files, attached: true, mode: "mock" };
    },
    async stop() {}
  };
}

export function mockAnchor(anchorId, order, inferredRole, textPreview) {
  return {
    anchorId,
    kind: "content-search-unit",
    visible: true,
    top: order * 120,
    height: 96,
    textPreview,
    order,
    inferredRole
  };
}

export class ClankerBendHost {
  constructor(options = {}) {
    this.protocolVersion = options.protocolVersion || CLANKERBEND_VERSION;
    this.hostId = options.hostId || "onewill.clankerbend.host";
    this.hostName = options.hostName || "ClankerBend Host";
    this.localDevInsecure = options.localDevInsecure === true;
    this.token = this.localDevInsecure ? "" : (isNonEmptyString(options.token) ? options.token : createSessionToken());
    this.runDir = options.runDir || null;
    this.transcriptAdapter = options.transcriptAdapter || createMockTranscriptAdapter();
    this.accountRegistry = options.accountRegistry || null;
    this.apps = new Map();
    this.sseClients = new Set();
    this.actionResults = new Map();
    this.server = null;
    this.heartbeat = null;

    this.state = {
      sequence: 1,
      generatedAt: new Date().toISOString(),
      host: {
        status: "starting",
        hostId: this.hostId,
        url: null,
        launchedAt: new Date().toISOString(),
        error: null
      },
      desktop: {
        cdpStatus: "starting",
        cdpPort: null,
        desktopPid: null,
        target: null,
        error: null
      },
      panel: {
        status: "closed",
        activeAppId: null,
        url: null,
        preferredWidth: null,
        lastOpenedAt: null,
        error: null
      },
      transcript: {
        anchors: [],
        visibleCount: 0,
        annotationCount: 0,
        scroll: null,
        updatedAt: new Date().toISOString()
      },
      selection: null,
      overlay: null,
      composer: {
        contextItems: [],
        attachments: [],
        draft: {
          text: "",
          mode: "replace",
          contextItemIds: [],
          updatedAt: null
        },
        lastSubmittedAt: null
      },
      appServer: {
        status: "disabled",
        pid: null,
        version: null,
        error: "not started"
      },
      codexAccounts: this.accountRegistry
        ? {
            available: true,
            activeAccountId: null,
            maxRunningDesktopInstances: 1,
            switching: false,
            ...this.accountRegistry.list()
          }
        : null,
      lastAction: null
    };
  }

  registerApp(app) {
    if (!app?.appId) throw new Error("appId is required");
    if (this.apps.has(app.appId)) throw httpError(409, "conflict", `duplicate app id: ${app.appId}`);
    this.apps.set(app.appId, app);
    if (!this.state.panel.activeAppId) {
      this.state.panel.activeAppId = app.appId;
      this.state.panel.preferredWidth = app.panel?.preferredWidth || null;
    }
    return this;
  }

  setActivePanelApp(appId) {
    const app = this.requireApp(appId);
    this.state.panel.activeAppId = app.appId;
    this.state.panel.preferredWidth = app.panel?.preferredWidth || null;
    this.state.panel.url = this.appEntryUrl(app.appId);
    return this;
  }

  async start() {
    if (this.runDir) mkdirSync(this.runDir, { recursive: true });
    await this.listen();
    await this.transcriptAdapter.start?.(this);
    this.touchAndBroadcast();
    this.heartbeat = setInterval(() => {
      this.broadcast("heartbeat", {});
    }, 15000);
    this.heartbeat.unref();
    return this;
  }

  async stop() {
    this.heartbeat?.[Symbol.dispose]?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.transcriptAdapter.stop?.();
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {}
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise((resolvePromise) => this.server.close(resolvePromise));
      this.server = null;
    }
    this.state.host.status = "exited";
  }

  listen() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.fail(res, err.status || 500, err.code || "internal_error", err.message, err.detail);
      });
    });

    return new Promise((resolvePromise) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        this.state.host.url = `http://127.0.0.1:${address.port}`;
        this.state.host.status = "running";
        this.state.panel.url = this.appEntryUrl(this.state.panel.activeAppId);
        if (this.runDir) writeFileSync(resolve(this.runDir, "host-url"), `${this.state.host.url}\n`);
        resolvePromise();
      });
    });
  }

  capabilities() {
    return {
      protocolVersion: this.protocolVersion,
      host: {
        apps: true,
        actions: true,
        appState: true,
        sidePanel: true
      },
      transcript: {
        read: true,
        annotate: true,
        navigate: true,
        select: true,
        rangeSelect: true,
        rangeHighlight: true
      },
      overlay: {
        anchored: true,
        forms: true
      },
      composer: {
        contextItems: true,
        draft: true,
        submit: Boolean(this.transcriptAdapter.submitComposer)
      },
      adapter: {
        name: this.transcriptAdapter.name || "unknown",
        cdp: Boolean(this.transcriptAdapter.cdp),
        rendererInjection: Boolean(this.transcriptAdapter.rendererInjection),
        rendererFetchToLoopback: Boolean(this.transcriptAdapter.rendererFetchToLoopback),
        providers: this.transcriptAdapter.providers || undefined
      },
      appServer: {
        available: this.state.appServer.status === "connected",
        correlateItems: false,
        approvals: false,
        rollback: false
      },
      codexAccounts: {
        available: Boolean(this.accountRegistry),
        switch: Boolean(this.transcriptAdapter.switchTo),
        adoptPrimary: Boolean(this.transcriptAdapter.adoptAsPrimary)
      }
    };
  }

  appEntryUrl(appId) {
    const app = this.apps.get(appId);
    if (!app || !this.state.host.url) return null;
    const base = `${this.state.host.url.replace(/\/$/, "")}/apps/${encodeURIComponent(app.appId)}/`;
    return this.token ? `${base}#clankerbend_token=${encodeURIComponent(this.token)}` : base;
  }

  hostManifest() {
    return {
      clankerbendVersion: this.protocolVersion,
      hostId: this.hostId,
      hostName: this.hostName,
      capabilities: this.capabilities(),
      security: {
        auth: this.token ? "bearer" : "none",
        localDevInsecure: this.localDevInsecure
      },
      apps: [...this.apps.values()].map((app) => this.appManifest(app.appId))
    };
  }

  appManifest(appId) {
    const app = this.requireApp(appId);
    const loadedManifest = app.manifest || {};
    if (typeof app.getManifest === "function") {
      return cleanObject({
        ...loadedManifest,
        ...app.getManifest(this.appContext(app)),
        version: app.version || loadedManifest.version,
        distribution: loadedManifest.distribution,
        entrypoint: loadedManifest.entrypoint,
        rendererBridge: loadedManifest.rendererBridge,
        lifecycle: loadedManifest.lifecycle
      });
    }
    return cleanObject({
      ...loadedManifest,
      clankerbendVersion: this.protocolVersion,
      appId: app.appId,
      name: app.name || app.appId,
      version: app.version || loadedManifest.version,
      entry: this.appEntryUrl(app.appId),
      contributes: app.contributes || {},
      permissions: app.permissions || {},
      panel: app.panel,
      distribution: loadedManifest.distribution,
      entrypoint: loadedManifest.entrypoint,
      rendererBridge: loadedManifest.rendererBridge,
      lifecycle: loadedManifest.lifecycle
    });
  }

  publicState() {
    if (this.accountRegistry) this.state.codexAccounts = this.accountState();
    return {
      protocolName: "clankerbend",
      protocolVersion: this.protocolVersion,
      sequence: this.state.sequence,
      generatedAt: this.state.generatedAt,
      capabilities: this.capabilities(),
      host: cleanObject({
        status: this.state.host.status,
        hostId: this.state.host.hostId,
        url: this.state.host.url,
        launchedAt: this.state.host.launchedAt,
        error: this.state.host.error || undefined
      }),
      desktop: cleanObject({
        cdpStatus: this.state.desktop.cdpStatus,
        cdpPort: this.state.desktop.cdpPort || undefined,
        desktopPid: this.state.desktop.desktopPid || undefined,
        target: this.state.desktop.target || undefined,
        error: this.state.desktop.error || undefined
      }),
      panel: cleanObject({
        status: this.state.panel.status,
        activeAppId: this.state.panel.activeAppId,
        url: this.state.panel.url,
        preferredWidth: this.state.panel.preferredWidth || undefined,
        lastOpenedAt: this.state.panel.lastOpenedAt || undefined,
        error: this.state.panel.error || undefined
      }),
      transcript: this.state.transcript,
      selection: this.state.selection,
      selectionActions: this.selectionActions(),
      overlay: this.state.overlay,
      composer: this.state.composer,
      apps: [...this.apps.values()].map((app) => ({
        entry: this.appEntryUrl(app.appId),
        ...this.appState(app.appId)
      })),
      appServer: this.state.appServer,
      codexAccounts: this.state.codexAccounts || undefined,
      lastAction: this.state.lastAction || undefined
    };
  }

  appState(appId) {
    const app = this.requireApp(appId);
    if (typeof app.getState !== "function") {
      return {
        appId: app.appId,
        status: "ready",
        source: "static",
        connected: true,
        entries: [],
        updatedAt: this.state.generatedAt
      };
    }
    return this.sanitizeAppState(app, app.getState(this.appContext(app)));
  }

  sanitizeAppState(app, appState) {
    const permissions = app.permissions || {};
    if (!appState || typeof appState !== "object") return appState;
    return cleanObject({
      ...appState,
      annotations: permissions.transcriptAnnotate === false ? undefined : appState.annotations
    });
  }

  appContext(app) {
    const permissions = app.permissions || {};
    const transcript = permissions.transcriptRead === false
      ? {
          anchors: [],
          visibleCount: 0,
          annotationCount: 0,
          scroll: null,
          updatedAt: this.state.transcript.updatedAt
        }
      : this.state.transcript;
    const appServer = permissions.appServerRead === false ? { status: "disabled", error: "permission denied" } : this.state.appServer;
    const scopedState = {
      ...this.state,
      transcript,
      appServer
    };
    return {
      protocolVersion: this.protocolVersion,
      appId: app.appId,
      entry: this.appEntryUrl(app.appId),
      state: scopedState,
      transcript,
      selection: this.state.selection,
      desktop: this.state.desktop,
      appServer,
      findAnchor: (anchorId) => {
        requirePermission(app, "transcriptRead");
        return this.findAnchor(anchorId);
      },
      anchorIndex: (anchorId) => {
        requirePermission(app, "transcriptRead");
        return this.anchorIndex(anchorId);
      },
      anchorExists: (anchorId) => {
        requirePermission(app, "transcriptRead");
        return this.anchorExists(anchorId);
      },
      scrollToAnchor: (anchorId, options) => {
        requirePermission(app, "transcriptNavigate");
        return this.scrollToAnchor(anchorId, options);
      },
      highlightAnchor: (anchorId, options) => {
        requirePermission(app, "transcriptNavigate");
        return this.highlightAnchor(anchorId, options);
      },
      highlightRange: (range, options) => {
        requirePermission(app, "transcriptNavigate");
        return this.highlightRange(range, options);
      },
      acceptSelection: (selection, options) => this.acceptSelection(selection, options),
      openOverlay: (overlay, options) => {
        requirePermission(app, "overlayWrite");
        return this.openOverlay({ ...overlay, appId: overlay?.appId || app.appId }, options);
      },
      closeOverlay: (overlayId, options) => {
        requirePermission(app, "overlayWrite");
        return this.closeOverlay(overlayId, options);
      },
      addComposerContext: (item, options) => {
        requirePermission(app, "composerWrite");
        return this.addComposerContext({ ...item, appId: item?.appId || app.appId }, options);
      },
      removeComposerContext: (itemId, options) => {
        requirePermission(app, "composerWrite");
        return this.removeComposerContext(itemId, options);
      },
      setComposerDraft: (draft, options) => {
        requirePermission(app, "composerWrite");
        return this.setComposerDraft(draft, options);
      },
      submitComposer: (draft, options) => {
        requirePermission(app, "composerWrite");
        return this.submitComposer(draft, options);
      },
      writeRuntimeFile: (file) => this.writeRuntimeFile(app, file),
      attachRuntimeFiles: (files, options) => {
        requirePermission(app, "composerWrite");
        return this.attachRuntimeFiles(app, files, options);
      },
      requestStateBroadcast: () => this.touchAndBroadcast(),
      httpError
    };
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    this.applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/clankerbend/") && !this.authorized(req)) {
      this.fail(res, 401, "unauthorized", "missing or invalid ClankerBend token");
      return;
    }

    if (url.pathname === "/clankerbend/manifest" && req.method === "GET") return this.ok(res, this.hostManifest());
    if (url.pathname === "/clankerbend/state" && req.method === "GET") return this.ok(res, this.publicState());
    if (url.pathname === "/clankerbend/events" && req.method === "GET") return this.handleEvents(req, res);
    if (url.pathname === "/clankerbend/apps" && req.method === "GET") return this.ok(res, { apps: this.appSummaries() });
    if (url.pathname === "/clankerbend/panel/open" && req.method === "POST") return this.openPanelEndpoint(req, res);
    if (url.pathname === "/clankerbend/transcript/scroll" && req.method === "POST") return this.scrollEndpoint(req, res);
    if (url.pathname === "/clankerbend/transcript/highlight" && req.method === "POST") return this.highlightEndpoint(req, res);
    if (url.pathname === "/clankerbend/transcript/highlight-range" && req.method === "POST") return this.highlightRangeEndpoint(req, res);
    if (url.pathname === "/clankerbend/selection" && req.method === "POST") return this.selectionEndpoint(req, res);
    if (url.pathname === "/clankerbend/overlay/open" && req.method === "POST") return this.overlayOpenEndpoint(req, res);
    if (url.pathname === "/clankerbend/overlay/close" && req.method === "POST") return this.overlayCloseEndpoint(req, res);
    if (url.pathname === "/clankerbend/composer/context" && req.method === "POST") return this.composerContextEndpoint(req, res);
    if (url.pathname === "/clankerbend/composer/context/remove" && req.method === "POST") return this.composerContextRemoveEndpoint(req, res);
    if (url.pathname === "/clankerbend/composer/draft" && req.method === "POST") return this.composerDraftEndpoint(req, res);
    if (url.pathname === "/clankerbend/composer/submit" && req.method === "POST") return this.composerSubmitEndpoint(req, res);
    if (url.pathname === "/clankerbend/codex/accounts" && req.method === "GET") return this.codexAccountsListEndpoint(res);
    if (url.pathname === "/clankerbend/codex/accounts" && req.method === "POST") return this.codexAccountsCreateEndpoint(req, res);
    if (url.pathname === "/clankerbend/codex/accounts/default" && req.method === "POST") return this.codexAccountsDefaultEndpoint(req, res);
    if (url.pathname === "/clankerbend/codex/accounts/switch" && req.method === "POST") return this.codexAccountsSwitchEndpoint(req, res);
    if (url.pathname === "/clankerbend/codex/primary/rollback" && req.method === "POST") return this.codexPrimaryRollbackEndpoint(req, res);
    const accountRoute = this.parseCodexAccountRoute(url.pathname);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/switch") return this.codexAccountSwitchEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/start") return this.codexAccountSwitchEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/focus") return this.codexAccountSwitchEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/set-default") return this.codexAccountSetDefaultEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/adopt-as-primary") return this.codexAccountAdoptEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "DELETE") return this.codexAccountDeleteEndpoint(accountRoute.accountId, res);
    if (accountRoute && req.method === "POST" && accountRoute.tail === "/delete") return this.codexAccountDeleteEndpoint(accountRoute.accountId, res);

    const appRoute = this.parseAppRoute(url.pathname);
    if (appRoute && req.method === "GET" && appRoute.tail === "/manifest") return this.ok(res, this.appManifest(appRoute.appId));
    if (appRoute && req.method === "GET" && appRoute.tail === "/state") return this.ok(res, this.appState(appRoute.appId));
    if (appRoute && req.method === "POST" && appRoute.tail === "/actions") return this.actionEndpoint(appRoute.appId, req, res);
    if (appRoute && req.method === "GET" && appRoute.tail.startsWith("/actions/")) return this.actionResultEndpoint(appRoute.appId, appRoute.tail, res);

    return this.serveStatic(url, res);
  }

  appSummaries() {
    return [...this.apps.values()].map((app) => {
      const appState = this.appState(app.appId);
      return {
        appId: app.appId,
        name: app.name || app.appId,
        status: appState.status,
        entry: this.appEntryUrl(app.appId)
      };
    });
  }

  parseAppRoute(pathname) {
    if (!pathname.startsWith("/clankerbend/apps/")) return null;
    const parts = pathname.split("/");
    const appId = decodeURIComponent(parts[3] || "");
    if (!appId) return null;
    this.requireApp(appId);
    return { appId, tail: `/${parts.slice(4).join("/")}` };
  }

  parseCodexAccountRoute(pathname) {
    if (!pathname.startsWith("/clankerbend/codex/accounts/")) return null;
    const parts = pathname.split("/");
    const accountId = decodeURIComponent(parts[4] || "");
    if (!accountId) return null;
    return { accountId, tail: `/${parts.slice(5).join("/")}` };
  }

  requireAccountRegistry() {
    if (!this.accountRegistry) throw httpError(404, "not_found", "Codex account registry is unavailable");
    return this.accountRegistry;
  }

  accountState() {
    if (typeof this.transcriptAdapter.accountState === "function") return this.transcriptAdapter.accountState();
    return this.accountRegistry ? {
      available: true,
      activeAccountId: null,
      maxRunningDesktopInstances: 1,
      switching: false,
      ...this.accountRegistry.list()
    } : null;
  }

  codexAccountsListEndpoint(res) {
    this.requireAccountRegistry();
    this.state.codexAccounts = this.accountState();
    return this.ok(res, this.state.codexAccounts);
  }

  async codexAccountsCreateEndpoint(req, res) {
    this.requireAccountRegistry();
    const body = await readJsonObject(req, "account create request body");
    const result = typeof this.transcriptAdapter.createAccount === "function"
      ? await this.transcriptAdapter.createAccount(body)
      : this.accountRegistry.createManaged(body);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result, 201);
  }

  async codexAccountsDefaultEndpoint(req, res) {
    const body = await readJsonObject(req, "account default request body");
    if (!isNonEmptyString(body.accountId)) throw httpError(400, "bad_request", "accountId is required");
    return this.codexAccountSetDefaultEndpoint(body.accountId, res);
  }

  async codexAccountsSwitchEndpoint(req, res) {
    const body = await readJsonObject(req, "account switch request body");
    if (!isNonEmptyString(body.accountId)) throw httpError(400, "bad_request", "accountId is required");
    return this.codexAccountSwitchEndpoint(body.accountId, res);
  }

  async codexAccountSwitchEndpoint(accountId, res) {
    this.requireAccountRegistry();
    if (typeof this.transcriptAdapter.switchTo !== "function") {
      throw httpError(409, "unsupported", "active adapter does not support Codex account switching");
    }
    const result = await this.transcriptAdapter.switchTo(accountId);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result);
  }

  async codexAccountSetDefaultEndpoint(accountId, res) {
    this.requireAccountRegistry();
    const result = typeof this.transcriptAdapter.setDefault === "function"
      ? await this.transcriptAdapter.setDefault(accountId)
      : this.accountRegistry.setDefault(accountId);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result);
  }

  async codexAccountAdoptEndpoint(accountId, res) {
    this.requireAccountRegistry();
    if (typeof this.transcriptAdapter.adoptAsPrimary !== "function") {
      throw httpError(409, "unsupported", "active adapter does not support primary adoption");
    }
    const result = await this.transcriptAdapter.adoptAsPrimary(accountId);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result);
  }

  async codexPrimaryRollbackEndpoint(req, res) {
    this.requireAccountRegistry();
    const body = await readJsonObject(req, "primary rollback request body");
    if (typeof this.transcriptAdapter.rollbackPrimary !== "function") {
      throw httpError(409, "unsupported", "active adapter does not support primary rollback");
    }
    const result = await this.transcriptAdapter.rollbackPrimary(body);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result);
  }

  async codexAccountDeleteEndpoint(accountId, res) {
    this.requireAccountRegistry();
    const result = typeof this.transcriptAdapter.deleteAccount === "function"
      ? await this.transcriptAdapter.deleteAccount(accountId)
      : this.accountRegistry.deleteManaged(accountId);
    this.state.codexAccounts = this.accountState();
    return this.ok(res, result);
  }

  async actionEndpoint(appId, req, res) {
    const app = this.requireApp(appId);
    const body = await readJsonObject(req, "action request body");
    if (!isPlainObject(body.action)) throw httpError(400, "bad_request", "action object is required");
    const result = await this.handleAction(app, body.action);
    return this.ok(res, result);
  }

  actionResultEndpoint(appId, tail, res) {
    this.requireApp(appId);
    const actionId = decodeURIComponent(tail.slice("/actions/".length));
    const result = this.actionResults.get(`${appId}:${actionId}`);
    if (!result) return this.fail(res, 404, "not_found", "unknown action result");
    return this.ok(res, result);
  }

  async handleAction(app, action) {
    if (!isNonEmptyString(action.appId)) throw httpError(400, "bad_request", "action.appId is required");
    if (action.appId !== app.appId) throw httpError(400, "bad_request", "action.appId must match route appId");
    if (!isNonEmptyString(action.actionId)) throw httpError(400, "bad_request", "action.actionId is required");
    if (!isNonEmptyString(action.type)) throw httpError(400, "bad_request", "action.type is required");
    if (action.requestedAt !== undefined && !Number.isFinite(Date.parse(action.requestedAt))) {
      throw httpError(400, "bad_request", "action.requestedAt must be an ISO timestamp");
    }
    const resultKey = `${action.appId}:${action.actionId}`;
    if (this.actionResults.has(resultKey)) return this.actionResults.get(resultKey);
    if (typeof app.handleAction !== "function") throw httpError(404, "not_found", `unknown action: ${action.type}`);

    const result = await app.handleAction(action, this.appContext(app));
    if (!result || typeof result.ok !== "boolean") {
      throw httpError(500, "action_failed", `action handler returned an invalid result: ${action.type}`);
    }
    const normalized = {
      actionId: action.actionId,
      appId: app.appId,
      ok: Boolean(result?.ok),
      status: result?.status || (result?.ok ? "applied" : "failed"),
      ...(result?.error ? { error: result.error } : {}),
      ...(result?.data === undefined ? {} : { data: result.data }),
      completedAt: result?.completedAt || new Date().toISOString()
    };
    this.actionResults.set(resultKey, normalized);
    this.state.lastAction = normalized;
    this.touchAndBroadcast("action", normalized);
    return normalized;
  }

  async openPanelEndpoint(req, res) {
    try {
      const body = await readJsonObject(req, "panel open request body");
      if (body.appId !== undefined) {
        if (!isNonEmptyString(body.appId)) throw httpError(400, "bad_request", "appId must be a non-empty string");
        this.setActivePanelApp(body.appId);
      }
      this.state.panel.status = "opening";
      const result = await this.transcriptAdapter.openPanel?.(this);
      if (result?.ok) {
        this.state.panel.status = result.mode === "focused" ? "focused" : "open";
        this.state.panel.lastOpenedAt = new Date().toISOString();
        this.state.panel.error = null;
      } else {
        this.state.panel.status = "waiting";
        this.state.panel.error = result?.error || "Open a Codex thread, then try opening the ClankerBend panel again.";
      }
      this.touchAndBroadcast();
      return this.ok(res, result || { ok: false, error: "panel unavailable" });
    } catch (err) {
      this.state.panel.status = "error";
      this.state.panel.error = err.message;
      this.touchAndBroadcast();
      throw err;
    }
  }

  async scrollEndpoint(req, res) {
    const body = await readJsonObject(req, "scroll request body");
    validateAnchorRequest(body);
    if (body.behavior !== undefined && !["auto", "smooth"].includes(body.behavior)) {
      throw httpError(400, "bad_request", "behavior must be auto or smooth");
    }
    if (body.block !== undefined && !["start", "center", "end", "nearest"].includes(body.block)) {
      throw httpError(400, "bad_request", "block must be start, center, end, or nearest");
    }
    const result = await this.scrollToAnchor(body.anchorId, body);
    if (!result?.ok) return this.fail(res, 404, "not_found", result?.error || "anchor not found", { anchorId: body.anchorId });
    return this.ok(res, result);
  }

  async highlightEndpoint(req, res) {
    const body = await readJsonObject(req, "highlight request body");
    validateAnchorRequest(body);
    if (body.durationMs !== undefined && (!Number.isFinite(Number(body.durationMs)) || Number(body.durationMs) < 0)) {
      throw httpError(400, "bad_request", "durationMs must be a non-negative number");
    }
    const result = await this.highlightAnchor(body.anchorId, body);
    if (!result?.ok) return this.fail(res, 404, "not_found", result?.error || "anchor not found", { anchorId: body.anchorId });
    return this.ok(res, result);
  }

  async highlightRangeEndpoint(req, res) {
    const body = await readJsonObject(req, "range highlight request body");
    validateRangeRequest(body.range || body);
    if (body.durationMs !== undefined && (!Number.isFinite(Number(body.durationMs)) || Number(body.durationMs) < 0)) {
      throw httpError(400, "bad_request", "durationMs must be a non-negative number");
    }
    const result = await this.highlightRange(body.range || body, body);
    if (!result?.ok) return this.fail(res, 404, "not_found", result?.error || "range not found", { anchorId: (body.range || body).anchorId });
    return this.ok(res, result);
  }

  async selectionEndpoint(req, res) {
    const body = await readJsonObject(req, "selection request body");
    if (body.selection !== undefined && !isPlainObject(body.selection)) {
      throw httpError(400, "bad_request", "selection must be an object");
    }
    if (body.selection?.source !== undefined && !["panel", "transcript", "adapter"].includes(body.selection.source)) {
      throw httpError(400, "bad_request", "selection.source is invalid");
    }
    if (body.selection?.range !== undefined) validateRangeRequest({ ...body.selection.range, anchorId: body.selection.anchorId || body.selection.range.anchorId });
    if (body.selection?.selectedAt !== undefined && !Number.isFinite(Date.parse(body.selection.selectedAt))) {
      throw httpError(400, "bad_request", "selection.selectedAt must be an ISO timestamp");
    }
    return this.ok(res, this.setSelection(body.selection));
  }

  async overlayOpenEndpoint(req, res) {
    const body = await readJsonObject(req, "overlay open request body");
    const overlay = body.overlay || body;
    return this.ok(res, this.openOverlay(overlay));
  }

  async overlayCloseEndpoint(req, res) {
    const body = await readJsonObject(req, "overlay close request body");
    if (body.overlayId !== undefined && !isNonEmptyString(body.overlayId)) {
      throw httpError(400, "bad_request", "overlayId must be a non-empty string when present");
    }
    return this.ok(res, this.closeOverlay(body.overlayId));
  }

  async composerContextEndpoint(req, res) {
    const body = await readJsonObject(req, "composer context request body");
    return this.ok(res, this.addComposerContext(body.item || body));
  }

  async composerContextRemoveEndpoint(req, res) {
    const body = await readJsonObject(req, "composer context remove request body");
    if (!isNonEmptyString(body.itemId)) throw httpError(400, "bad_request", "itemId is required");
    return this.ok(res, this.removeComposerContext(body.itemId));
  }

  async composerDraftEndpoint(req, res) {
    const body = await readJsonObject(req, "composer draft request body");
    return this.ok(res, await this.setComposerDraft(body.draft || body));
  }

  async composerSubmitEndpoint(req, res) {
    const body = await readJsonObject(req, "composer submit request body");
    return this.ok(res, await this.submitComposer(body.draft || body));
  }

  async scrollToAnchor(anchorId, options = {}) {
    if (!this.anchorExists(anchorId)) return { ok: false, error: "anchor not found", anchorId };
    const result = await this.transcriptAdapter.scrollToAnchor?.(anchorId, options, this);
    return result || { ok: true, anchorId };
  }

  async highlightAnchor(anchorId, options = {}) {
    if (!this.anchorExists(anchorId)) return { ok: false, error: "anchor not found", anchorId };
    const result = await this.transcriptAdapter.highlightAnchor?.(anchorId, options, this);
    return result || { ok: true, anchorId };
  }

  async highlightRange(range, options = {}) {
    validateRangeRequest(range);
    if (!this.anchorExists(range.anchorId)) return { ok: false, error: "anchor not found", anchorId: range.anchorId };
    const normalized = normalizeRange(range);
    const result = await this.transcriptAdapter.highlightRange?.(normalized, options, this);
    if (result) return result;
    const fallback = await this.highlightAnchor(normalized.anchorId, options);
    return fallback?.ok ? { ...fallback, range: normalized } : fallback;
  }

  setSelection(selection) {
    if (!selection?.anchorId && !selection?.entryId) return { stale: false, selection: this.state.selection };
    if (!this.isCandidateSelectionNewer(selection, this.state.selection)) {
      return { stale: true, selection: this.state.selection };
    }
    return { stale: false, selection: this.acceptSelection(selection) };
  }

  acceptSelection(selection, options = {}) {
    this.touch();
    this.state.selection = {
      selectionId: selection.selectionId || `sel_${this.state.sequence}`,
      sequence: this.state.sequence,
      source: selection.source || "adapter",
      appId: selection.appId || this.state.panel.activeAppId || undefined,
      anchorId: selection.anchorId || null,
      quote: selection.quote || selection.range?.text || null,
      range: selection.range ? normalizeRange({ ...selection.range, anchorId: selection.anchorId || selection.range.anchorId }) : null,
      rect: selection.rect ? normalizeRect(selection.rect) : null,
      markerId: selection.markerId || null,
      entryId: selection.entryId || (selection.anchorId ? `nav:${selection.anchorId}` : null),
      appServer: selection.appServer || null,
      correlationId: selection.correlationId || null,
      selectedAt: selection.selectedAt || new Date().toISOString(),
      acceptedAt: this.state.generatedAt
    };
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return this.state.selection;
  }

  openOverlay(overlay, options = {}) {
    validateOverlay(overlay);
    this.touch();
    this.state.overlay = cleanObject({
      overlayId: overlay.overlayId || `overlay_${this.state.sequence}`,
      appId: overlay.appId,
      kind: overlay.kind || "form",
      title: overlay.title || null,
      anchorId: overlay.anchorId || overlay.range?.anchorId || this.state.selection?.anchorId || null,
      range: overlay.range ? normalizeRange(overlay.range) : this.state.selection?.range || null,
      anchorRect: overlay.anchorRect ? normalizeRect(overlay.anchorRect) : this.state.selection?.rect || null,
      fields: overlay.fields || [],
      actions: overlay.actions || [],
      openedAt: this.state.generatedAt
    });
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, overlay: this.state.overlay };
  }

  closeOverlay(overlayId, options = {}) {
    if (overlayId && this.state.overlay?.overlayId !== overlayId) {
      return { ok: false, error: "overlay not found", overlayId };
    }
    this.touch();
    const closed = this.state.overlay;
    this.state.overlay = null;
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, overlay: closed };
  }

  writeRuntimeFile(app, file) {
    if (!this.runDir) throw httpError(500, "runtime_unavailable", "runtime directory is unavailable");
    if (!isPlainObject(file)) throw httpError(400, "bad_request", "runtime file must be an object");
    const content = String(file.content || "");
    const directory = safePathSegment(file.directory || "files");
    const filename = safeFilename(file.filename || `file-${this.state.sequence}.txt`);
    const root = resolve(this.runDir, "apps", safePathSegment(app.appId), directory);
    const filePath = resolve(root, filename);
    if (filePath !== root && !filePath.startsWith(`${root}/`)) {
      throw httpError(400, "bad_request", "runtime file path escapes app directory");
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(filePath, content);
    return cleanObject({
      fileId: file.fileId || `${app.appId}:${directory}/${filename}`,
      appId: app.appId,
      path: filePath,
      relativePath: relative(this.runDir, filePath),
      mimeType: file.mimeType || mimeType(filePath),
      bytes: Buffer.byteLength(content),
      createdAt: this.state.generatedAt
    });
  }

  async attachRuntimeFiles(app, files = [], options = {}) {
    if (!this.runDir) throw httpError(500, "runtime_unavailable", "runtime directory is unavailable");
    if (!Array.isArray(files)) throw httpError(400, "bad_request", "files must be an array");
    const appRoot = resolve(this.runDir, "apps", safePathSegment(app.appId));
    const normalized = files.map((file) => {
      const path = resolve(typeof file === "string" ? file : file?.path || "");
      if (!path || (path !== appRoot && !path.startsWith(`${appRoot}/`))) {
        throw httpError(403, "forbidden", "apps may only attach their own runtime files");
      }
      if (!existsSync(path)) throw httpError(404, "not_found", `attachment file not found: ${path}`);
      return cleanObject({
        fileId: typeof file === "object" ? file.fileId : undefined,
        appId: app.appId,
        path,
        relativePath: relative(this.runDir, path),
        name: typeof file === "object" && file.name ? file.name : path.split("/").pop(),
        mimeType: typeof file === "object" ? file.mimeType : mimeType(path),
        body: readFileSync(path, "utf8"),
        status: "queued"
      });
    });
    const adapterResult = await this.transcriptAdapter.attachFiles?.(normalized, options, this);
    if (!adapterResult || adapterResult.ok === false) {
      return adapterResult || { ok: false, error: "file attachment unavailable" };
    }
    this.touch();
    if (shouldTrackHostComposerAttachment(adapterResult)) {
      const attachedAt = this.state.generatedAt;
      this.state.composer.attachments = [
        ...this.state.composer.attachments,
        ...normalized.map((file) => ({ ...file, attachedAt }))
      ];
    }
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, files: normalized, adapter: adapterResult };
  }

  addComposerContext(item, options = {}) {
    validateComposerContextItem(item);
    this.touch();
    const normalized = cleanObject({
      itemId: item.itemId || `ctx_${this.state.sequence}`,
      appId: item.appId,
      label: item.label,
      body: item.body || item.quote || "",
      anchorId: item.anchorId || item.range?.anchorId || null,
      range: item.range ? normalizeRange(item.range) : null,
      status: item.status || "queued",
      createdAt: item.createdAt || this.state.generatedAt,
      updatedAt: this.state.generatedAt
    });
    const index = this.state.composer.contextItems.findIndex((candidate) => candidate.itemId === normalized.itemId);
    if (index >= 0) this.state.composer.contextItems[index] = normalized;
    else this.state.composer.contextItems.push(normalized);
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, item: normalized, contextItems: this.state.composer.contextItems };
  }

  removeComposerContext(itemId, options = {}) {
    this.touch();
    const before = this.state.composer.contextItems.length;
    this.state.composer.contextItems = this.state.composer.contextItems.filter((item) => item.itemId !== itemId);
    const removed = before !== this.state.composer.contextItems.length;
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, removed, itemId, contextItems: this.state.composer.contextItems };
  }

  removeComposerAttachment(path, options = {}) {
    this.touch();
    const targetPath = resolve(String(path || ""));
    const before = this.state.composer.attachments.length;
    this.state.composer.attachments = this.state.composer.attachments.filter((item) => resolve(item.path) !== targetPath);
    const removed = before !== this.state.composer.attachments.length;
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return { ok: true, removed, path: targetPath, attachments: this.state.composer.attachments };
  }

  async setComposerDraft(draft, options = {}) {
    validateComposerDraft(draft);
    this.touch();
    const mode = draft.mode || "replace";
    const nextText = mergeComposerDraftText(this.state.composer.draft.text, draft.text || "", mode);
    this.state.composer.draft = {
      text: nextText,
      mode,
      contextItemIds: draft.contextItemIds || this.state.composer.contextItems.map((item) => item.itemId),
      updatedAt: this.state.generatedAt
    };
    const adapterResult = await this.transcriptAdapter.setComposerDraft?.(this.state.composer.draft, options, this);
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return adapterResult || { ok: true, draft: this.state.composer.draft };
  }

  async submitComposer(draft = {}, options = {}) {
    const nextDraft = draft.text !== undefined ? await this.setComposerDraft(draft, { ...options, broadcast: false }) : { ok: true };
    if (!nextDraft?.ok) return nextDraft;
    this.touch();
    const adapterResult = await this.transcriptAdapter.submitComposer?.(this.state.composer.draft, options, this);
    if (adapterResult?.ok !== false) this.state.composer.lastSubmittedAt = this.state.generatedAt;
    if (options.broadcast !== false) this.broadcast("state", this.publicState());
    return adapterResult || { ok: false, error: "composer submit unavailable", draft: this.state.composer.draft };
  }

  selectionActions() {
    return [...this.apps.values()].flatMap((app) => {
      const state = this.appState(app.appId);
      return (state.selectionActions || []).map((action) => ({
        ...action,
        appId: action.appId || app.appId
      }));
    });
  }

  isCandidateSelectionNewer(candidate, current) {
    if (!candidate?.anchorId && !candidate?.entryId) return false;
    const candidateTime = Date.parse(candidate.selectedAt || "");
    const currentTime = Date.parse(current?.selectedAt || "");
    return (Number.isFinite(candidateTime) ? candidateTime : 0) >= (Number.isFinite(currentTime) ? currentTime : 0);
  }

  setDesktopStatus(next) {
    this.state.desktop = cleanObject({ ...this.state.desktop, ...next });
  }

  updateTranscript(transcript, options = {}) {
    this.state.transcript = {
      anchors: transcript.anchors || [],
      visibleCount: transcript.visibleCount || 0,
      annotationCount: transcript.annotationCount || 0,
      scroll: transcript.scroll || null,
      updatedAt: transcript.updatedAt || new Date().toISOString()
    };
    if (options.broadcast !== false) this.touchAndBroadcast();
  }

  findAnchor(anchorId) {
    return this.state.transcript.anchors.find((anchor) => anchor.anchorId === anchorId) || null;
  }

  anchorExists(anchorId) {
    return Boolean(this.findAnchor(anchorId));
  }

  anchorIndex(anchorId) {
    return this.state.transcript.anchors.findIndex((anchor) => anchor.anchorId === anchorId);
  }

  requireApp(appId) {
    const app = this.apps.get(appId);
    if (!app) throw httpError(404, "not_found", "unknown app");
    return app;
  }

  serveStatic(url, res) {
    let pathname = url.pathname;
    if (pathname === "/") pathname = `/apps/${this.state.panel.activeAppId || ""}/`;
    if (!pathname.startsWith("/apps/")) {
      res.writeHead(404).end("not found");
      return;
    }
    const parts = pathname.split("/");
    const appId = decodeURIComponent(parts[2] || "");
    const app = this.apps.get(appId);
    if (!app?.publicDir) {
      res.writeHead(404).end("not found");
      return;
    }
    let relativePath = parts.slice(3).join("/");
    if (!relativePath) relativePath = "index.html";
    const rootPath = resolve(app.publicDir);
    const filePath = resolve(rootPath, `./${relativePath}`);
    if ((filePath !== rootPath && !filePath.startsWith(`${rootPath}/`)) || !existsSync(filePath)) {
      res.writeHead(404).end("not found");
      return;
    }
    const contentType = mimeType(filePath);
    const headers = {
      "content-type": contentType,
      "cache-control": "no-store"
    };
    if (this.token && contentType.startsWith("text/html")) {
      res.writeHead(200, headers);
      res.end(injectAppToken(readFileSync(filePath, "utf8"), this.token));
      return;
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  }

  handleEvents(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    this.sseClients.add(res);
    res.write(`event: state\nid: ${this.state.sequence}\ndata: ${JSON.stringify(this.publicState())}\n\n`);
    req.on("close", () => this.sseClients.delete(res));
  }

  touch() {
    this.state.sequence += 1;
    this.state.generatedAt = new Date().toISOString();
  }

  touchAndBroadcast(event = "state", data = this.publicState()) {
    this.touch();
    this.broadcast(event, typeof data === "function" ? data() : data);
  }

  broadcast(event = "state", data = this.publicState()) {
    const payload = `event: ${event}\nid: ${this.state.sequence}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) res.write(payload);
  }

  authorized(req) {
    if (this.localDevInsecure) return true;
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  ok(res, data, status = 200) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, data }));
  }

  fail(res, status, code, message, detail) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } }));
  }

  applyCors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
  }
}

async function readJsonObject(req, label) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw httpError(400, "bad_request", "request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "bad_request", "invalid JSON request body");
  }
  if (!isPlainObject(parsed)) throw httpError(400, "bad_request", `${label} must be a JSON object`);
  return parsed;
}

function validateAnchorRequest(body) {
  if (!isNonEmptyString(body.anchorId)) throw httpError(400, "bad_request", "anchorId is required");
}

function validateRangeRequest(range) {
  if (!isPlainObject(range)) throw httpError(400, "bad_request", "range must be an object");
  if (!isNonEmptyString(range.anchorId)) throw httpError(400, "bad_request", "range.anchorId is required");
  if (range.text !== undefined && typeof range.text !== "string") throw httpError(400, "bad_request", "range.text must be a string");
  if (range.quote !== undefined && typeof range.quote !== "string") throw httpError(400, "bad_request", "range.quote must be a string");
  for (const key of ["prefix", "suffix"]) {
    if (range[key] !== undefined && typeof range[key] !== "string") throw httpError(400, "bad_request", `range.${key} must be a string`);
  }
  for (const key of ["startOffset", "endOffset"]) {
    if (range[key] !== undefined && (!Number.isInteger(Number(range[key])) || Number(range[key]) < 0)) {
      throw httpError(400, "bad_request", `range.${key} must be a non-negative integer`);
    }
  }
}

function normalizeRange(range) {
  validateRangeRequest(range);
  return cleanObject({
    anchorId: range.anchorId,
    text: range.text || range.quote || "",
    quote: range.quote || range.text || "",
    prefix: range.prefix || "",
    suffix: range.suffix || "",
    startOffset: range.startOffset === undefined ? undefined : Number(range.startOffset),
    endOffset: range.endOffset === undefined ? undefined : Number(range.endOffset),
    fingerprint: range.fingerprint || range.text || range.quote || ""
  });
}

function normalizeRect(rect) {
  if (!isPlainObject(rect)) return null;
  const normalized = {};
  for (const key of ["left", "top", "right", "bottom", "width", "height"]) {
    if (rect[key] !== undefined && Number.isFinite(Number(rect[key]))) normalized[key] = Number(rect[key]);
  }
  return Object.keys(normalized).length ? normalized : null;
}

function validateOverlay(overlay) {
  if (!isPlainObject(overlay)) throw httpError(400, "bad_request", "overlay must be an object");
  if (!isNonEmptyString(overlay.appId)) throw httpError(400, "bad_request", "overlay.appId is required");
  if (overlay.overlayId !== undefined && !isNonEmptyString(overlay.overlayId)) throw httpError(400, "bad_request", "overlay.overlayId must be a non-empty string");
  if (overlay.kind !== undefined && !["form", "menu", "notice"].includes(overlay.kind)) throw httpError(400, "bad_request", "overlay.kind is invalid");
  if (overlay.anchorId !== undefined && !isNonEmptyString(overlay.anchorId)) throw httpError(400, "bad_request", "overlay.anchorId must be a non-empty string");
  if (overlay.range !== undefined) validateRangeRequest(overlay.range);
  if (overlay.fields !== undefined && !Array.isArray(overlay.fields)) throw httpError(400, "bad_request", "overlay.fields must be an array");
  if (overlay.actions !== undefined && !Array.isArray(overlay.actions)) throw httpError(400, "bad_request", "overlay.actions must be an array");
}

function validateComposerContextItem(item) {
  if (!isPlainObject(item)) throw httpError(400, "bad_request", "composer context item must be an object");
  if (!isNonEmptyString(item.appId)) throw httpError(400, "bad_request", "item.appId is required");
  if (item.itemId !== undefined && !isNonEmptyString(item.itemId)) throw httpError(400, "bad_request", "item.itemId must be a non-empty string");
  if (!isNonEmptyString(item.label)) throw httpError(400, "bad_request", "item.label is required");
  if (item.body !== undefined && typeof item.body !== "string") throw httpError(400, "bad_request", "item.body must be a string");
  if (item.quote !== undefined && typeof item.quote !== "string") throw httpError(400, "bad_request", "item.quote must be a string");
  if (item.anchorId !== undefined && !isNonEmptyString(item.anchorId)) throw httpError(400, "bad_request", "item.anchorId must be a non-empty string");
  if (item.range !== undefined) validateRangeRequest(item.range);
  if (item.status !== undefined && !["queued", "sent", "resolved"].includes(item.status)) throw httpError(400, "bad_request", "item.status is invalid");
}

function validateComposerDraft(draft) {
  if (!isPlainObject(draft)) throw httpError(400, "bad_request", "composer draft must be an object");
  if (draft.text !== undefined && typeof draft.text !== "string") throw httpError(400, "bad_request", "draft.text must be a string");
  if (draft.mode !== undefined && !["replace", "append", "prepend"].includes(draft.mode)) throw httpError(400, "bad_request", "draft.mode is invalid");
  if (draft.contextItemIds !== undefined && (!Array.isArray(draft.contextItemIds) || draft.contextItemIds.some((id) => !isNonEmptyString(id)))) {
    throw httpError(400, "bad_request", "draft.contextItemIds must be an array of non-empty strings");
  }
}

function mergeComposerDraftText(current, next, mode) {
  if (mode === "append") return current ? `${current}\n${next}` : next;
  if (mode === "prepend") return current ? `${next}\n${current}` : next;
  return next;
}

function shouldTrackHostComposerAttachment(adapterResult) {
  return adapterResult?.mode === "mock" || adapterResult?.trackHostComposerAttachment === true;
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

function injectAppToken(html, token) {
  const script = `<meta name="clankerbend-token" content="${escapeHtmlAttribute(token)}">\n    <script>window.__CLANKERBEND_TOKEN=${JSON.stringify(token)};</script>`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${script}`)
    : `${script}\n${html}`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function requirePermission(app, permission) {
  if (app.permissions?.[permission] === false) {
    throw httpError(403, "forbidden", `${app.appId} lacks ${permission}`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safePathSegment(value) {
  return String(value || "files")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "files";
}

function safeFilename(value) {
  const filename = safePathSegment(value);
  return filename.includes(".") ? filename : `${filename}.txt`;
}

function mimeType(filePath) {
  switch (extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
