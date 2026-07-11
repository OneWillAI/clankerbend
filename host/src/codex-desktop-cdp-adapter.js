import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join, resolve } from "node:path";

const CODEX_DESKTOP_EXECUTABLES = [
  "/Applications/Codex.app/Contents/MacOS/Codex",
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
];

export function createCodexDesktopCdpAdapter(options = {}) {
  return new CodexDesktopCdpAdapter(options);
}

export function resolveCodexDesktopPaths(options = {}) {
  const codexApp = options.codexApp || CODEX_DESKTOP_EXECUTABLES.find((candidate) => existsSync(candidate)) || CODEX_DESKTOP_EXECUTABLES[0];
  const bundledCli = join(dirname(dirname(codexApp)), "Resources/codex");
  const codexCli = options.codexCli || (existsSync(bundledCli)
    ? bundledCli
    : CODEX_DESKTOP_EXECUTABLES
        .map((candidate) => join(dirname(dirname(candidate)), "Resources/codex"))
        .find((candidate) => existsSync(candidate))) || bundledCli;
  return { codexApp, codexCli };
}

function normalizeRendererBridges(options = {}) {
  const bridges = options.rendererBridges?.length
    ? options.rendererBridges
    : [{
        appId: options.appId || null,
        injectedScriptPath: options.injectedScriptPath,
        openPanelMethod: options.openPanelMethod || "openPanel",
        scrollMethod: options.scrollMethod || "scrollToAnchor",
        highlightMethod: options.highlightMethod || "highlightAnchor",
        primary: true
      }];
  const hasPrimaryBridge = bridges.some((candidate) => candidate.primary);
  return bridges.map((bridge, index) => ({
    appId: bridge.appId || null,
    injectedScriptPath: bridge.injectedScriptPath,
    openPanelMethod: bridge.openPanelMethod || "openPanel",
    scrollMethod: bridge.scrollMethod || "scrollToAnchor",
    highlightMethod: bridge.highlightMethod || "highlightAnchor",
    primary: bridge.primary === true || (!hasPrimaryBridge && index === 0),
    injectedSource: null
  }));
}

function normalizeProviders(options = {}, rendererBridges = []) {
  const fallbackAppId = rendererBridges.find((bridge) => bridge.primary)?.appId ||
    rendererBridges[0]?.appId ||
    options.appId ||
    null;
  const providers = options.providers || {};
  return {
    transcriptSnapshot: providers.transcriptSnapshot || fallbackAppId,
    transcriptOrder: providers.transcriptOrder || providers.transcriptSnapshot || fallbackAppId,
    transcriptNavigation: providers.transcriptNavigation || providers.transcriptSnapshot || fallbackAppId,
    transcriptHighlight: providers.transcriptHighlight || providers.transcriptNavigation || providers.transcriptSnapshot || fallbackAppId,
    transcriptTextSelection: providers.transcriptTextSelection || providers.transcriptSnapshot || fallbackAppId,
    composerDraft: providers.composerDraft || fallbackAppId,
    composerContext: providers.composerContext || fallbackAppId
  };
}

function userPanelError(error) {
  if (/native Browser panel controls not found|panel app did not load|panel unavailable/i.test(String(error || ""))) {
    return "Waiting for Codex Desktop to expose the Browser side panel. Open a Codex thread, then ClankerBend will load the selected app automatically.";
  }
  return error || "Waiting for Codex Desktop to expose the Browser side panel.";
}

class CodexDesktopCdpAdapter {
  constructor(options = {}) {
    this.name = "codex-desktop-cdp";
    this.cdp = true;
    this.rendererInjection = true;
    this.rendererFetchToLoopback = false;
    const desktopPaths = resolveCodexDesktopPaths(options);
    this.codexApp = desktopPaths.codexApp;
    this.codexCli = desktopPaths.codexCli;
    this.runDir = options.runDir ? resolve(options.runDir) : null;
    this.profileDir = options.profileDir || (this.runDir ? join(this.runDir, "codex-profile") : null);
    this.codexHome = options.codexHome ? resolve(options.codexHome) : null;
    this.resetProfileDir = options.resetProfileDir === true;
    this.rendererBridges = normalizeRendererBridges(options);
    this.providers = normalizeProviders(options, this.rendererBridges);
    this.snapshotToTranscript = options.snapshotToTranscript || defaultSnapshotToTranscript;
    this.appServerOrder = options.appServerOrder !== false;
    this.pollIntervalMs = options.pollIntervalMs || 700;
    this.autoOpenPanel = options.autoOpenPanel !== false;
    this.child = null;
    this.host = null;
    this.cdpPort = null;
    this.browser = null;
    this.sessionId = null;
    this.pollTimer = null;
    this.appServerOrderPromise = null;
    this.lastAppServerOrderAt = 0;
    this.lastPanelSelectionId = null;
  }

  async start(host) {
    this.host = host;
    if (!existsSync(this.codexApp)) {
      throw new Error(`Codex Desktop executable not found. Looked for: ${CODEX_DESKTOP_EXECUTABLES.join(", ")}`);
    }
    if (!existsSync(this.codexCli)) {
      throw new Error(`Codex CLI not found in the Codex Desktop bundle: ${this.codexCli}`);
    }
    if (!this.rendererBridges.length) throw new Error("at least one renderer bridge is required");
    for (const bridge of this.rendererBridges) {
      if (!bridge.injectedScriptPath) throw new Error(`injectedScriptPath is required for ${bridge.appId || "renderer bridge"}`);
      bridge.injectedSource = readFileSync(bridge.injectedScriptPath, "utf8");
    }
    if (this.runDir) mkdirSync(this.runDir, { recursive: true });
    if (this.profileDir) {
      if (this.resetProfileDir) rmSync(this.profileDir, { recursive: true, force: true });
      mkdirSync(this.profileDir, { recursive: true });
    }
    if (this.codexHome) mkdirSync(this.codexHome, { recursive: true });

    this.cdpPort = await freePort();
    this.child = spawn(this.codexApp, [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${this.cdpPort}`,
      ...(this.profileDir ? [`--user-data-dir=${this.profileDir}`] : [])
    ], {
      env: {
        ...process.env,
        ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
        ...(this.profileDir ? { CODEX_ELECTRON_USER_DATA_PATH: this.profileDir } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.appendLog(chunk));
    this.child.stderr.on("data", (chunk) => this.appendLog(chunk));

    host.setDesktopStatus({
      cdpStatus: "waiting-for-renderer",
      cdpPort: this.cdpPort,
      desktopPid: this.child.pid,
      error: null
    });

    const version = await pollJson(`http://127.0.0.1:${this.cdpPort}/json/version`, 15000);
    if (!version?.webSocketDebuggerUrl) throw new Error("CDP browser websocket did not become available");
    this.browser = await CdpConnection.connect(version.webSocketDebuggerUrl);
    const target = await this.discoverRendererTarget();
    this.sessionId = await this.attachToTarget(target.targetId);
    host.setDesktopStatus({
      cdpStatus: "connected",
      target: summarizeTarget(target),
      error: null
    });

    await this.inject();
    const firstSnapshot = await this.refreshSnapshot();
    if (this.appServerOrder && firstSnapshot?.anchors?.length) {
      await this.applyAppServerTranscriptOrder(firstSnapshot).catch((err) => {
        host.state.appServer = {
          status: "error",
          pid: null,
          version: null,
          error: err.message
        };
        host.touchAndBroadcast();
      });
      await this.refreshSnapshot();
    }
    if (this.autoOpenPanel) {
      const panelResult = await this.openPanel();
      this.applyPanelOpenResult(panelResult);
    }
    this.pollTimer = setInterval(() => {
      this.refreshSnapshot().catch((err) => {
        host.setDesktopStatus({ cdpStatus: "disconnected", error: err.message });
        host.touchAndBroadcast();
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.browser) {
      try {
        if (this.sessionId) {
          await Promise.race([
            this.browser.call("Target.detachFromTarget", { sessionId: this.sessionId }),
            wait(1000)
          ]);
        }
      } catch {}
      this.browser.close();
    }
    this.browser = null;
    this.sessionId = null;
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await wait(800);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
  }

  async openPanel() {
    const bridge = this.bridgeForApp(this.host.state.panel.activeAppId) || this.primaryBridge();
    const bridgeResult = await this.evalBridge(`${bridge.openPanelMethod}()`, bridge).catch((err) => ({
      ok: false,
      error: err.message
    }));
    const loaded = await this.ensurePanelAppLoaded().catch((err) => ({
      ok: false,
      error: err.message
    }));
    return loaded?.ok ? loaded : bridgeResult;
  }

  applyPanelOpenResult(result) {
    if (result?.ok) {
      this.host.state.panel.status = result.mode === "focused" ? "focused" : "open";
      this.host.state.panel.lastOpenedAt = new Date().toISOString();
      this.host.state.panel.error = null;
    } else {
      this.host.state.panel.status = "waiting";
      this.host.state.panel.error = userPanelError(result?.error);
    }
    this.host.touchAndBroadcast();
  }

  async scrollToAnchor(anchorId, options = {}) {
    const bridge = this.bridgeForProvider("transcriptNavigation");
    return this.evalBridge(`${bridge.scrollMethod}(${JSON.stringify(anchorId)}, ${JSON.stringify(options)})`, bridge);
  }

  async highlightAnchor(anchorId, options = {}) {
    const bridge = this.bridgeForProvider("transcriptHighlight");
    return this.evalBridge(`${bridge.highlightMethod}(${JSON.stringify(anchorId)}, ${JSON.stringify(options)})`, bridge);
  }

  async highlightRange(range, options = {}) {
    const bridge = this.bridgeForProvider("transcriptHighlight");
    const appId = this.bridgeAppId(bridge);
    return this.evaluate(`(() => {
      const runtime = window.__clankerbendRuntime;
      const bridge = runtime?.getBridge?.(${JSON.stringify(appId)});
      if (bridge?.highlightRange) return bridge.highlightRange(${JSON.stringify(range)}, ${JSON.stringify(options)});
      if (runtime?.highlightRange) return runtime.highlightRange(${JSON.stringify(range)}, ${JSON.stringify(options)});
      if (bridge?.${bridge.highlightMethod}) return bridge.${bridge.highlightMethod}(${JSON.stringify(range.anchorId)}, ${JSON.stringify(options)});
      return { ok: false, error: "range highlight unavailable" };
    })()`);
  }

  async setComposerDraft(draft, options = {}) {
    return this.evaluate(`(() => {
      const runtime = window.__clankerbendRuntime;
      if (!runtime?.setComposerDraft) return { ok: false, error: "composer draft unavailable" };
      return runtime.setComposerDraft(${JSON.stringify(draft)}, ${JSON.stringify(options)});
    })()`);
  }

  async submitComposer(draft, options = {}) {
    return this.evaluate(`(() => {
      const runtime = window.__clankerbendRuntime;
      if (!runtime?.submitComposer) return { ok: false, error: "composer submit unavailable" };
      return runtime.submitComposer(${JSON.stringify(draft)}, ${JSON.stringify(options)});
    })()`);
  }

  async attachFiles(files = [], options = {}) {
    const normalized = files.map((file) => {
      const filePath = resolve(typeof file === "string" ? file : file?.path || "");
      return {
        ...(typeof file === "object" && file ? file : {}),
        path: filePath,
        name: typeof file === "object" && file?.name ? file.name : basename(filePath)
      };
    }).filter((file) => file.path);
    const paths = normalized.map((file) => file.path);
    if (!normalized.length) return { ok: false, error: "no files to attach" };
    for (const filePath of paths) {
      if (!existsSync(filePath)) return { ok: false, error: `attachment file does not exist: ${filePath}` };
    }

    const nativeResult = await this.attachFilesThroughNativeComposer(normalized, options).catch((err) => ({
      ok: false,
      error: err.message,
      mode: "codex-native-composer"
    }));
    if (nativeResult?.ok || options.nativeOnly) return nativeResult;

    const appServerResult = await this.attachFilesThroughAppServer(normalized, options).catch((err) => ({
      ok: false,
      error: err.message,
      mode: "app-server-inject-items",
      nativeComposerError: nativeResult
    }));
    if (appServerResult?.ok || options.appServerOnly) return appServerResult;

    if (options.tryNativeComposerAttachment) {
      const dropResult = await this.attachFilesThroughComposerDrop(normalized, options).catch((err) => ({
        ok: false,
        error: err.message,
        mode: "composer-drop"
      }));
      if (dropResult?.ok) return dropResult;

      const composerResult = await this.attachFilesThroughComposerFilePicker(normalized, options, dropResult).catch((err) => ({
        ok: false,
        error: err.message,
        mode: "composer-file-picker"
      }));
      if (composerResult?.ok) return composerResult;
      return { ...appServerResult, diagnostic: { ...(appServerResult?.diagnostic || {}), nativeComposerError: nativeResult, composerDropError: dropResult, composerFilePickerError: composerResult } };
    }

    return { ...appServerResult, diagnostic: { ...(appServerResult?.diagnostic || {}), nativeComposerError: nativeResult } };
  }

  async attachFilesThroughNativeComposer(files = [], options = {}) {
    const attached = [];
    for (const file of files) {
      const result = await this.evaluate(nativeAddContextFileExpression({
        label: file.name || basename(file.path),
        path: file.path,
        fsPath: file.path
      }));
      if (!result?.ok) {
        return {
          ok: false,
          mode: "codex-native-composer",
          files: files.map((candidate) => candidate.path),
          attached,
          diagnostic: result
        };
      }
      attached.push(result.file);
      await wait(80);
    }
    const paths = files.map((file) => file.path);
    const diagnostic = await waitForEvaluate(this, nativeAttachmentDiagnosticExpression(paths), options.timeoutMs || 8000);
    if (!diagnostic?.ok) {
      return {
        ok: false,
        mode: "codex-native-composer",
        files: paths,
        attached,
        diagnostic
      };
    }
    return {
      ok: true,
      mode: "codex-native-composer",
      files: paths,
      attached,
      diagnostic
    };
  }

  async attachFilesThroughAppServer(files = [], options = {}) {
    const client = await AppServerClient.start(this.codexCli, { cwd: process.cwd() });
    const diagnostics = {
      composerDropError: options.composerDropError || null,
      composerFilePickerError: options.composerFilePickerError || null
    };
    try {
      const init = await client.initialize();
      const thread = await this.resolveAppServerThreadForCurrentDesktop(client, diagnostics);
      if (!thread?.threadId) {
        return { ok: false, error: "app-server active thread is unknown", mode: "app-server-inject-items", diagnostic: diagnostics };
      }
      const items = buildAttachmentResponseItems(files, {
        appName: options.appName || "ClankerBend",
        createdAt: new Date().toISOString()
      });
      const response = await client.threadInjectItems(thread.threadId, items);
      return {
        ok: true,
        mode: "app-server-inject-items",
        threadId: thread.threadId,
        files: files.map((file) => file.path),
        itemCount: items.length,
        version: init?.userAgent || null,
        diagnostic: diagnostics,
        response
      };
    } finally {
      await client.stop();
    }
  }

  async resolveAppServerThreadForCurrentDesktop(client, diagnostics = {}) {
    const cachedThreadId = this.host?.state?.appServer?.threadId;
    if (cachedThreadId) {
      try {
        await client.threadResume(cachedThreadId);
        diagnostics.resume = { ok: true, threadId: cachedThreadId, source: "cached" };
        return { threadId: cachedThreadId, source: "cached" };
      } catch (err) {
        diagnostics.resume = { ok: false, threadId: cachedThreadId, error: err.message };
      }
    }

    const snapshot = await this.evalBridge("snapshot()", this.bridgeForProvider("transcriptSnapshot"));
    const match = await this.findMatchingAppServerThread(client, snapshot);
    diagnostics.match = match;
    if (!match?.threadId) return null;
    await client.threadResume(match.threadId);
    diagnostics.resume = { ok: true, threadId: match.threadId, source: "matched" };
    this.host.state.appServer = {
      ...this.host.state.appServer,
      status: "connected",
      pid: client.pid,
      threadId: match.threadId,
      threadName: match.threadName || null,
      error: null
    };
    this.host.touchAndBroadcast();
    return { threadId: match.threadId, source: "matched" };
  }

  async attachFilesThroughComposerDrop(files = [], options = {}) {
    await this.applyHostStateToRenderer().catch(() => {});
    await wait(150);
    const payload = files.map((file) => ({
      name: file.name || basename(file.path),
      mimeType: file.mimeType || "text/markdown",
      body: typeof file.body === "string" ? file.body : readFileSync(file.path, "utf8")
    }));
    const dropped = await this.evaluate(composerFileDropExpression(payload));
    if (!dropped?.ok) return { ok: false, error: "composer drop target not found", mode: "composer-drop", diagnostic: dropped };
    const paths = files.map((file) => file.path);
    const attached = await waitForEvaluate(this, attachmentDiagnosticExpression(paths), options.timeoutMs || 8000);
    return { ok: attached?.ok !== false, mode: "composer-drop", files: paths, diagnostic: { dropped, attached } };
  }

  async attachFilesThroughComposerFilePicker(files = [], options = {}, priorError = null) {
    const paths = files.map((file) => file.path);
    await this.applyHostStateToRenderer().catch(() => {});
    await wait(150);
    await this.browser.call("Page.enable", {}, this.sessionId).catch(() => {});
    await this.browser.call("DOM.enable", {}, this.sessionId).catch(() => {});
    await this.browser.call("Page.setInterceptFileChooserDialog", { enabled: true }, this.sessionId);
    const diagnostics = { priorError };
    try {
      const plus = await this.evaluate(findComposerAddButtonExpression());
      if (!plus?.ok) return { ok: false, error: "composer add button not found", diagnostic: plus };
      diagnostics.plus = plus;
      await this.dispatchMouseClick(center(plus.rect));
      await wait(250);

      const item = await waitForEvaluate(this, findFilesAndFoldersItemExpression(), 2500);
      if (!item?.ok) return { ok: false, error: "Files and folders menu item not found", diagnostic: item };
      diagnostics.item = item;

      const chooserPromise = this.browser.waitForEvent("Page.fileChooserOpened", {
        timeoutMs: options.timeoutMs || 8000
      });
      await this.dispatchMouseClick(center(item.rect));
      const chooser = await chooserPromise;
      diagnostics.chooser = chooser;
      if (!chooser?.backendNodeId) return { ok: false, error: "file chooser opened without backendNodeId", diagnostic: chooser };
      await this.browser.call("DOM.setFileInputFiles", {
        files: paths,
        backendNodeId: chooser.backendNodeId
      }, this.sessionId);
      await wait(600);
      const attached = await this.evaluate(attachmentDiagnosticExpression(paths));
      return { ok: attached?.ok !== false, mode: "composer-file-picker", files: paths, diagnostic: { ...diagnostics, attached } };
    } catch (err) {
      return { ok: false, error: err.message, mode: "composer-file-picker", files: paths, diagnostic: diagnostics };
    } finally {
      await this.browser.call("Page.setInterceptFileChooserDialog", { enabled: false }, this.sessionId).catch(() => {});
    }
  }

  async discoverRendererTarget() {
    await this.browser.call("Target.setDiscoverTargets", { discover: true });
    const deadline = Date.now() + 20000;
    let lastTargets = [];
    while (Date.now() < deadline) {
      const result = await this.browser.call("Target.getTargets");
      lastTargets = result.targetInfos || [];
      const target = lastTargets.find((candidate) =>
        candidate.type === "page" && candidate.url?.startsWith("app://-/index.html")
      ) || lastTargets.find((candidate) =>
        candidate.type === "page" && candidate.url?.startsWith("app://-")
      ) || lastTargets.find((candidate) => candidate.type === "page");
      if (target) return target;
      await wait(300);
    }
    throw new Error(`No attachable renderer target found: ${JSON.stringify(lastTargets.map(summarizeTarget))}`);
  }

  async attachToTarget(targetId) {
    const attached = await this.browser.call("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    await this.browser.call("Runtime.enable", {}, attached.sessionId);
    return attached.sessionId;
  }

  async inject() {
    const apps = {};
    for (const app of this.host.apps.values()) {
      apps[app.appId] = {
        appId: app.appId,
        entryUrl: this.host.appEntryUrl(app.appId),
        capabilities: app.contributes || {}
      };
    }
    await this.evaluate(`(() => {
      const protocolVersion = ${JSON.stringify(this.host.protocolVersion)};
      const hostUrl = ${JSON.stringify(this.host.state.host.url)};
      const seededApps = ${JSON.stringify(apps)};
      const previous = window.__clankerbendRuntime;
      const slots = previous && typeof previous.apps === "object" ? previous.apps : {};
      const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\\\]/g, "\\\\$&");
      const ensureAnnotationLayoutStyle = () => {
        const styleId = "clankerbend-annotation-layout-style";
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = \`
          .clankerbend-transcript-anchor {
            position: relative !important;
            overflow: visible !important;
          }
          .clankerbend-transcript-annotations {
            position: absolute !important;
            left: -62px !important;
            top: 4px !important;
            z-index: 2147483002 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            gap: 6px !important;
            pointer-events: none !important;
          }
          .clankerbend-transcript-annotation-slot {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            pointer-events: auto !important;
          }
          @media (max-width: 900px) {
            .clankerbend-transcript-annotations {
              position: absolute !important;
              left: -44px !important;
              top: 4px !important;
            }
          }
        \`;
        document.head.appendChild(style);
      };
      const annotationHost = (anchor, anchorId) => {
        if (!(anchor instanceof HTMLElement)) throw new Error("ClankerBend annotation anchor must be an HTMLElement");
        ensureAnnotationLayoutStyle();
        anchor.classList.add("clankerbend-transcript-anchor");
        let host = Array.from(anchor.children).find((child) =>
          child instanceof HTMLElement &&
          child.classList.contains("clankerbend-transcript-annotations") &&
          child.dataset.clankerbendAnchorId === anchorId
        );
        if (!host) {
          host = document.createElement("div");
          host.className = "clankerbend-transcript-annotations";
          host.dataset.clankerbendAnchorId = anchorId;
          anchor.insertAdjacentElement("afterbegin", host);
        }
        return host;
      };
      const positionAnnotationHost = (host, anchor) => {
        if (!(host instanceof HTMLElement) || !(anchor instanceof HTMLElement)) return;
        const rect = anchor.getBoundingClientRect();
        const hostWidth = Math.max(host.getBoundingClientRect().width || 0, 32);
        const desiredLeft = -hostWidth - 12;
        const clippingLeft = (() => {
          let left = 8;
          for (let node = anchor.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (!/(hidden|auto|scroll|clip)/.test([style.overflow, style.overflowX, style.overflowY].join(" "))) continue;
            const nodeRect = node.getBoundingClientRect();
            if (nodeRect.width > 0 && nodeRect.height > 0) left = Math.max(left, nodeRect.left + 8);
          }
          return left;
        })();
        host.style.setProperty("left", desiredLeft + "px", "important");
        host.style.setProperty("visibility", rect.left + desiredLeft < clippingLeft ? "hidden" : "visible", "important");
      };
      const sortAnnotationSlots = (host) => {
        [...host.children]
          .sort((a, b) =>
            Number(a.dataset.clankerbendPriority || 100) - Number(b.dataset.clankerbendPriority || 100) ||
            String(a.dataset.clankerbendAppId || "").localeCompare(String(b.dataset.clankerbendAppId || "")) ||
            String(a.dataset.clankerbendMarkerId || "").localeCompare(String(b.dataset.clankerbendMarkerId || ""))
          )
          .forEach((child) => host.appendChild(child));
      };
      const transcriptAnchorSelector = (anchorId) => {
        const escaped = cssEscape(anchorId);
        return [
          '[data-content-search-unit-key="' + escaped + '"]',
          '[data-turn-key="' + escaped + '"]',
          '[data-content-search-turn-key="' + escaped + '"]',
          '[data-thread-user-message-navigation-item-id="' + escaped + '"]'
        ].join(",");
      };
      const findAnchorElement = (anchorId) => document.querySelector(transcriptAnchorSelector(anchorId));
      const isHostUiElement = (el) => {
        for (let node = el; node; node = node.parentElement) {
          if (node.classList?.contains?.("clankerbend-host-ui")) return true;
          if (/^clankerbend-/.test(String(node.id || ""))) return true;
        }
        return false;
      };
      const composerAnchorForInput = (input) => {
        const inputRect = input.getBoundingClientRect();
        let anchor = input;
        for (let node = input.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          const rect = node.getBoundingClientRect();
          if (rect.width < inputRect.width || rect.height < inputRect.height) continue;
          if (rect.bottom < inputRect.bottom - 4 || rect.top > inputRect.top + 4) continue;
          anchor = node;
          if (node.matches?.("form")) break;
        }
        return anchor;
      };
      const findComposer = () => {
        const selectors = [
          "textarea",
          '[contenteditable="true"]',
          '[role="textbox"]'
        ];
        const candidates = selectors.map((selector) => [...document.querySelectorAll(selector)])
          .flat()
          .filter((el) => el instanceof HTMLElement && !isHostUiElement(el))
          .map((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 180 || rect.height < 18) return null;
            if (rect.bottom < window.innerHeight * 0.45) return null;
            if (rect.top > window.innerHeight || rect.bottom < 0) return null;
            if (rect.right < window.innerWidth * 0.35) return null;
            const anchor = composerAnchorForInput(el);
            const anchorRect = anchor.getBoundingClientRect();
            return { el, rect, anchorRect };
          })
          .filter(Boolean)
          .sort((a, b) =>
            b.rect.bottom - a.rect.bottom ||
            b.rect.width - a.rect.width ||
            (b.anchorRect.width * b.anchorRect.height) - (a.anchorRect.width * a.anchorRect.height)
          );
        return candidates[0]?.el || null;
      };
      const CLANKERBEND_CONTEXT_START = "--- ClankerBend context ---";
      const CLANKERBEND_CONTEXT_END = "--- End ClankerBend context ---";
      const stripContextBlock = (text) => {
        let output = String(text || "");
        while (true) {
          const start = output.indexOf(CLANKERBEND_CONTEXT_START);
          if (start < 0) return output.trimStart();
          const end = output.indexOf(CLANKERBEND_CONTEXT_END, start + CLANKERBEND_CONTEXT_START.length);
          if (end < 0) return output.slice(0, start).trimEnd();
          output = output.slice(0, start) + output.slice(end + CLANKERBEND_CONTEXT_END.length);
        }
      };
      const setComposerValue = (el, value) => {
        if (!el) return false;
        try {
          el.focus({ preventScroll: true });
        } catch {
          el.focus();
        }
        if ("value" in el) {
          const setter = Object.getOwnPropertyDescriptor(el.constructor?.prototype || HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        return true;
      };
      const composerText = (el) => {
        if (!el) return "";
        return "value" in el ? String(el.value || "") : String(el.innerText || el.textContent || "");
      };
      const mergeDraftText = (current, next, mode) => {
        if (mode === "append") return current ? current + "\\n" + next : next;
        if (mode === "prepend") return current ? next + "\\n" + current : next;
        return next;
      };
      const runtime = {
        protocolVersion,
        hostUrl,
        apps: slots,
        registerApp(app) {
          if (!app || !app.appId) throw new Error("ClankerBend appId is required");
          const seeded = seededApps[app.appId] || {};
          const current = this.apps[app.appId] || {};
          const currentVersion = Number(current.bridge?.version);
          const nextVersion = Number(app.bridge?.version);
          if (
            current.bridge &&
            app.bridge &&
            Number.isFinite(currentVersion) &&
            Number.isFinite(nextVersion) &&
            nextVersion < currentVersion
          ) {
            throw new Error("ClankerBend app bridge version regressed for " + app.appId);
          }
          const slot = {
            ...current,
            ...app,
            appId: app.appId,
            entryUrl: app.entryUrl || current.entryUrl || seeded.entryUrl || null,
            capabilities: app.capabilities || current.capabilities || seeded.capabilities || {},
            injectedAt: app.injectedAt || current.injectedAt || new Date().toISOString()
          };
          this.apps[app.appId] = slot;
          return slot;
        },
        getApp(appId) {
          return this.apps[appId] || null;
        },
        getBridge(appId) {
          return this.getApp(appId)?.bridge || null;
        },
        getEntryUrl(appId) {
          return this.getApp(appId)?.entryUrl || null;
        },
        placeAnnotation(anchor, annotation) {
          if (!annotation?.appId) throw new Error("ClankerBend annotation appId is required");
          if (!annotation?.anchorId) throw new Error("ClankerBend annotation anchorId is required");
          if (!(annotation.element instanceof HTMLElement)) throw new Error("ClankerBend annotation element is required");
          const markerId = annotation.markerId || annotation.anchorId;
          const host = annotationHost(anchor, annotation.anchorId);
          const selector = '.clankerbend-transcript-annotation-slot[data-clankerbend-app-id="' + cssEscape(annotation.appId) + '"][data-clankerbend-marker-id="' + cssEscape(markerId) + '"]';
          let slot = host.querySelector(selector);
          if (!slot) {
            slot = document.createElement("div");
            slot.className = "clankerbend-transcript-annotation-slot";
            slot.dataset.clankerbendAppId = annotation.appId;
            slot.dataset.clankerbendMarkerId = markerId;
            host.appendChild(slot);
          }
          slot.dataset.clankerbendAnchorId = annotation.anchorId;
          slot.dataset.clankerbendPriority = String(annotation.priority ?? 100);
          if (slot.firstElementChild !== annotation.element) slot.replaceChildren(annotation.element);
          sortAnnotationSlots(host);
          positionAnnotationHost(host, anchor);
          return slot;
        },
        removeAnnotations(appId, liveAnchorIds = null) {
          const live = liveAnchorIds ? new Set([...liveAnchorIds].map(String)) : null;
          document.querySelectorAll('.clankerbend-transcript-annotation-slot[data-clankerbend-app-id="' + cssEscape(appId) + '"]').forEach((slot) => {
            if (!live || !live.has(slot.dataset.clankerbendAnchorId || "")) slot.remove();
          });
          document.querySelectorAll(".clankerbend-transcript-annotations").forEach((host) => {
            if (!host.children.length) host.remove();
          });
        },
        highlightRange(range, options = {}) {
          if (!range?.anchorId) return { ok: false, error: "range.anchorId is required" };
          const anchor = findAnchorElement(range.anchorId);
          if (!anchor) return { ok: false, error: "anchor not found", anchorId: range.anchorId };
          anchor.classList.add("clankerbend-range-highlight");
          const previousOutline = anchor.style.outline;
          const previousOffset = anchor.style.outlineOffset;
          anchor.style.outline = "3px solid #f6c945";
          anchor.style.outlineOffset = "3px";
          anchor.scrollIntoView({ block: options.block || "center", behavior: options.behavior || "smooth" });
          setTimeout(() => {
            anchor.classList.remove("clankerbend-range-highlight");
            anchor.style.outline = previousOutline;
            anchor.style.outlineOffset = previousOffset;
          }, Number(options.durationMs || 1200));
          return { ok: true, anchorId: range.anchorId, range };
        },
        setComposerDraft(draft = {}) {
          const el = findComposer();
          if (!el) return { ok: false, error: "composer not found" };
          const currentText = composerText(el);
          const text = draft.clankerbendContext
            ? (draft.text ? mergeDraftText(stripContextBlock(currentText), String(draft.text || ""), "prepend") : stripContextBlock(currentText))
            : mergeDraftText(currentText, String(draft.text || ""), draft.mode || "replace");
          if (!setComposerValue(el, text)) return { ok: false, error: "composer cannot be updated" };
          return { ok: true, draft: { ...draft, text } };
        },
        submitComposer(draft = {}) {
          const setResult = draft.text !== undefined ? this.setComposerDraft(draft) : { ok: true };
          if (!setResult.ok) return setResult;
          const composer = findComposer();
          const button = [...document.querySelectorAll("button")]
            .filter((el) => el instanceof HTMLButtonElement && !el.disabled)
            .find((el) => /send|submit|arrow/i.test([el.ariaLabel, el.title, el.textContent].join(" ")));
          if (!button) return { ok: false, error: "composer submit button not found" };
          button.click();
          return { ok: true, submitted: true, draft: setResult.draft || draft };
        }
      };
      for (const [appId, seeded] of Object.entries(seededApps)) {
        runtime.apps[appId] = {
          ...(runtime.apps[appId] || {}),
          ...seeded,
          bridge: runtime.apps[appId]?.bridge || null,
          injectedAt: runtime.apps[appId]?.injectedAt || null
        };
      }
      window.__clankerbendRuntime = runtime;
    })()`);
    for (const bridge of this.rendererBridges) {
      await this.evaluate(bridge.injectedSource);
    }
  }

  async refreshSnapshot() {
    const primary = this.bridgeForProvider("transcriptSnapshot");
    const snapshot = await this.evalBridge("snapshot()", primary);
    const hostEvents = await this.evalBridge("drainHostEvents()", primary).catch(() => []);
    const secondarySnapshots = [];
    for (const bridge of this.rendererBridges) {
      if (bridge === primary) continue;
      const secondary = await this.evalBridge("snapshot()", bridge).catch((err) => ({
        ok: false,
        error: err.message,
        appId: this.bridgeAppId(bridge)
      }));
      secondarySnapshots.push(secondary);
    }
    const transcript = this.snapshotToTranscript(snapshot);
    this.host.updateTranscript(transcript, { broadcast: false });
    const selectionSnapshot = [snapshot, ...secondarySnapshots].find((candidate) => candidate?.selection);
    if (selectionSnapshot?.selection) {
      const selection = this.host.setSelection(selectionSnapshot.selection);
      if (
        this.autoOpenPanel &&
        selection?.selectionId &&
        selection.selectionId !== this.lastPanelSelectionId
      ) {
        this.lastPanelSelectionId = selection.selectionId;
        this.openPanel()
          .then((result) => this.applyPanelOpenResult(result))
          .catch((err) => {
            this.host.state.panel.status = "error";
            this.host.state.panel.error = err.message;
            this.host.touchAndBroadcast();
          });
      }
    } else {
      this.host.touchAndBroadcast();
    }
    if (Array.isArray(hostEvents) && hostEvents.length) {
      await this.processRendererHostEvents(hostEvents);
    }
    const needsAppServerOrder = this.appServerOrder &&
      snapshot?.anchors?.length &&
      !this.appServerOrderPromise &&
      (
        snapshot.transcriptOrderSource !== "app-server" ||
        (
          snapshot.unknownMountedAnchorCount > 0 &&
          Date.now() - this.lastAppServerOrderAt > 2500
        )
      );
    if (needsAppServerOrder) {
      this.appServerOrderPromise = this.applyAppServerTranscriptOrder(snapshot)
        .then(() => this.refreshSnapshot())
        .catch((err) => {
          this.host.state.appServer = {
            status: "error",
            pid: null,
            version: null,
            error: err.message
          };
          this.host.touchAndBroadcast();
        })
        .finally(() => {
          this.appServerOrderPromise = null;
        });
    }
    await this.applyHostStateToRenderer().catch(() => {});
    return snapshot;
  }

  async processRendererHostEvents(events) {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.kind === "selection" && event.selection) {
        this.host.setSelection(event.selection);
      } else if (event.kind === "appAction") {
        await this.processRendererAppAction(event);
      } else if (event.kind === "overlayClose") {
        this.host.closeOverlay(event.overlayId);
      } else if (event.kind === "composerContextRemove") {
        this.host.removeComposerContext(event.itemId);
      } else if (event.kind === "composerAttachmentRemove") {
        this.host.removeComposerAttachment(event.path);
      } else if (event.kind === "composerContextSubmitted") {
        this.markComposerContextSubmitted(event.itemIds || []);
      } else if (event.kind === "composerAttachmentsSubmitted") {
        this.markComposerAttachmentsSubmitted(event.paths || []);
      } else if (event.kind === "highlightRange" && event.range) {
        await this.host.highlightRange(event.range, { durationMs: 1200 });
      } else if (event.kind === "highlightAnchor" && event.anchorId) {
        await this.host.highlightAnchor(event.anchorId, { durationMs: 1200 });
      } else if (event.kind === "codexAccountSwitch" && event.accountId) {
        if (typeof this.host.transcriptAdapter.switchTo !== "function") throw new Error("Codex account switching is unavailable");
        await this.host.transcriptAdapter.switchTo(String(event.accountId));
      } else if (event.kind === "codexAccountCreateAndSwitch") {
        if (typeof this.host.transcriptAdapter.createAccount !== "function" || typeof this.host.transcriptAdapter.switchTo !== "function") {
          throw new Error("Codex account creation is unavailable");
        }
        const account = await this.host.transcriptAdapter.createAccount({ label: String(event.label || "Account") });
        await this.host.transcriptAdapter.switchTo(account.id);
      } else if (event.kind === "codexAccountSetDefault" && event.accountId) {
        if (typeof this.host.transcriptAdapter.setDefault !== "function") throw new Error("Codex account defaults are unavailable");
        await this.host.transcriptAdapter.setDefault(String(event.accountId));
      } else if (event.kind === "codexAccountAdoptAsPrimary" && event.accountId) {
        if (typeof this.host.transcriptAdapter.adoptAsPrimary !== "function") throw new Error("Codex primary adoption is unavailable");
        await this.host.transcriptAdapter.adoptAsPrimary(String(event.accountId));
      } else if (event.kind === "codexAccountDelete" && event.accountId) {
        if (typeof this.host.transcriptAdapter.deleteAccount !== "function") throw new Error("Codex account removal is unavailable");
        await this.host.transcriptAdapter.deleteAccount(String(event.accountId));
      }
    }
  }

  async processRendererAppAction(event) {
    const app = this.host.requireApp(event.appId);
    const action = {
      actionId: event.actionId || `${event.type}:${event.eventId || Date.now()}`,
      appId: event.appId,
      type: event.type,
      payload: event.payload || {},
      requestedAt: event.requestedAt || new Date().toISOString()
    };
    await this.host.handleAction(app, action);
  }

  markComposerContextSubmitted(itemIds) {
    const ids = new Set((Array.isArray(itemIds) ? itemIds : []).map(String));
    if (!ids.size) return { ok: true, updated: 0 };
    let updated = 0;
    for (const item of this.host.state.composer.contextItems) {
      if (!ids.has(item.itemId)) continue;
      item.status = "sent";
      item.updatedAt = new Date().toISOString();
      updated += 1;
    }
    if (updated) this.host.touchAndBroadcast();
    return { ok: true, updated };
  }

  markComposerAttachmentsSubmitted(paths) {
    const ids = new Set((Array.isArray(paths) ? paths : []).map(String));
    if (!ids.size) return { ok: true, updated: 0 };
    let updated = 0;
    for (const item of this.host.state.composer.attachments) {
      if (!ids.has(item.path)) continue;
      item.status = "sent";
      item.updatedAt = new Date().toISOString();
      updated += 1;
    }
    if (updated) this.host.touchAndBroadcast();
    return { ok: true, updated };
  }

  async applyHostStateToRenderer() {
    const primary = this.bridgeForProvider("transcriptSnapshot");
    const state = this.host.publicState();
    await this.evalBridge(`applyHostState(${JSON.stringify(state)})`, primary);
  }

  async applyAppServerTranscriptOrder(snapshot) {
    this.lastAppServerOrderAt = Date.now();
    const mountedTurnSearchKeys = mountedTurnSearchKeysFromSnapshot(snapshot);
    const mountedContentAnchorIds = mountedContentAnchorIdsFromSnapshot(snapshot);
    if (!mountedTurnSearchKeys.size) return null;

    const client = await AppServerClient.start(this.codexCli, { cwd: process.cwd() });
    this.host.state.appServer = {
      status: "starting",
      pid: client.pid,
      version: null,
      error: null
    };
    this.host.touchAndBroadcast();
    try {
      const init = await client.initialize();
      const threads = await client.threadList({ limit: 100 });
      const bestMatch = await this.findMatchingAppServerThread(client, snapshot, threads);
      if (bestMatch) {
        const result = await this.evalBridge(`setTranscriptOrder(${JSON.stringify(bestMatch.projected.anchorIds)}, ${JSON.stringify({
          source: "app-server",
          threadId: bestMatch.threadId,
          threadName: bestMatch.threadName
        })})`, this.bridgeForProvider("transcriptOrder"));
        this.host.state.appServer = {
          status: "connected",
          pid: client.pid,
          version: init?.userAgent || null,
          error: null,
          threadId: bestMatch.threadId,
          threadName: bestMatch.threadName,
          mountedContentHits: bestMatch.mountedContentHits,
          mountedContentCount: mountedContentAnchorIds.size
        };
        this.host.touchAndBroadcast();
        this.lastAppServerOrderAt = Date.now();
        return { threadId: bestMatch.threadId, count: bestMatch.projected.anchorIds.length, result };
      }
      throw new Error("No app-server thread matched mounted Desktop turn search keys");
    } finally {
      await client.stop();
    }
  }

  async findMatchingAppServerThread(client, snapshot, threadSummaries = null) {
    const mountedTurnSearchKeys = mountedTurnSearchKeysFromSnapshot(snapshot);
    const mountedContentAnchorIds = mountedContentAnchorIdsFromSnapshot(snapshot);
    if (!mountedTurnSearchKeys.size) return null;

    const threads = threadSummaries || await client.threadList({ limit: 100 });
    let bestMatch = null;
    for (const threadSummary of threads) {
      const threadId = threadSummary?.id;
      if (!threadId) continue;
      const turns = await client.threadTurnsListAll(threadId, {
        sortDirection: "asc",
        itemsView: "full",
        limit: 100
      }).catch(() => []);
      if (!turns.length) continue;
      const projected = projectDesktopTranscriptAnchors(turns);
      if (!projected.anchorIds.length) continue;
      const projectedIds = new Set(projected.anchorIds);
      const mountedContentHits = [...mountedContentAnchorIds].filter((id) => projectedIds.has(id)).length;
      const mountedTurnHits = projected.turnSearchKeys.filter((key) => mountedTurnSearchKeys.has(key)).length;
      if (!mountedContentHits && !mountedTurnHits) continue;
      const candidate = {
        threadId,
        threadName: threadSummary.name || null,
        projected,
        mountedContentHits,
        mountedTurnHits,
        score: mountedContentHits * 1000 + mountedTurnHits
      };
      if (!bestMatch || candidate.score > bestMatch.score) bestMatch = candidate;
      if (mountedContentAnchorIds.size && mountedContentHits === mountedContentAnchorIds.size) break;
    }
    return bestMatch;
  }

  primaryBridge() {
    return this.bridgeForProvider("transcriptSnapshot");
  }

  bridgeForProvider(name) {
    const appId = this.providers[name];
    const bridge = this.bridgeForApp(appId);
    if (bridge) return bridge;
    return this.rendererBridges.find((candidate) => candidate.primary) || this.rendererBridges[0];
  }

  bridgeForApp(appId) {
    if (!appId) return null;
    return this.rendererBridges.find((bridge) => this.bridgeAppId(bridge) === appId) || null;
  }

  bridgeAppId(bridge) {
    if (bridge?.appId) return bridge.appId;
    if (this.host.apps.size === 1) return this.host.apps.keys().next().value;
    return this.host.state.panel.activeAppId;
  }

  async evalBridge(expression, bridge = this.primaryBridge()) {
    const appId = this.bridgeAppId(bridge);
    return this.evaluate(`(() => {
      const runtime = window.__clankerbendRuntime;
      const bridge = runtime?.getBridge?.(${JSON.stringify(appId)});
      if (!bridge) return { ok: false, error: "ClankerBend bridge is not installed for " + ${JSON.stringify(appId)} };
      return bridge.${expression};
    })()`);
  }

  async evaluate(expression) {
    const output = await this.browser.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, this.sessionId);
    if (output.exceptionDetails) {
      throw new Error(output.exceptionDetails.exception?.description || output.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return output.result?.value;
  }

  async ensurePanelAppLoaded() {
    const appUrl = this.host.appEntryUrl(this.host.state.panel.activeAppId);
    if (!appUrl) return { ok: false, error: "panel app URL missing" };

    let last = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = await this.evaluate(panelDiagnosticExpression(appUrl));
      if (last?.frame) return { ok: true, mode: attempt ? "cdp-repaired" : "focused", frame: last.frame };

      if (last?.localRect) {
        await this.dispatchMouseClick(center(last.localRect));
        await wait(900);
        continue;
      }

      if (last?.inputRect) {
        await this.dispatchMouseClick(center(last.inputRect));
        await this.evaluate(setBrowserUrlInputExpression(appUrl));
        await this.dispatchEnter();
        await wait(900);
        continue;
      }

      await wait(300);
    }
    return { ok: false, error: "panel app did not load", diagnostic: last };
  }

  async dispatchMouseClick(point) {
    await this.browser.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y
    }, this.sessionId);
    await this.browser.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    }, this.sessionId);
    await this.browser.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    }, this.sessionId);
  }

  async dispatchEnter() {
    await this.browser.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    }, this.sessionId);
    await this.browser.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    }, this.sessionId);
  }

  appendLog(chunk) {
    if (!this.runDir) return;
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(join(this.runDir, "codex-desktop.log"), chunk, { flag: "a" });
  }
}

class CdpConnection {
  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    const connection = new CdpConnection(socket);
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener("open", resolvePromise, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
    });
    socket.addEventListener("message", (event) => connection.handleMessage(event));
    return connection;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method) {
      const index = this.eventWaiters.findIndex((waiter) =>
        waiter.method === message.method &&
        (!waiter.sessionId || waiter.sessionId === message.sessionId) &&
        (!waiter.predicate || waiter.predicate(message.params || {}))
      );
      if (index >= 0) {
        const [waiter] = this.eventWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message.params || {});
      }
    }
    const slot = this.pending.get(message.id);
    if (!slot) return;
    this.pending.delete(message.id);
    if (message.error) slot.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else slot.resolve(message.result);
  }

  waitForEvent(method, options = {}) {
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        method,
        sessionId: options.sessionId,
        predicate: options.predicate,
        resolve: resolvePromise,
        reject,
        timer: setTimeout(() => {
          const index = this.eventWaiters.indexOf(waiter);
          if (index >= 0) this.eventWaiters.splice(index, 1);
          reject(new Error(`${method} timed out`));
        }, options.timeoutMs || 10000)
      };
      this.eventWaiters.push(waiter);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

class AppServerClient {
  static async start(codexCli, options = {}) {
    const child = spawn(codexCli, ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new AppServerClient(child);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => client.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      client.stderr += chunk.toString();
    });
    return client;
  }

  constructor(child) {
    this.child = child;
    this.pid = child.pid;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }

  async initialize() {
    const response = await this.call("initialize", {
      clientInfo: {
        name: "clankerbend-host",
        title: "ClankerBend Host",
        version: "0.1"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
    this.notify("initialized", {});
    return response;
  }

  async threadList(params = {}) {
    const response = await this.call("thread/list", params);
    return response?.data || response?.threads || [];
  }

  async threadRead(threadId, params = {}) {
    const response = await this.call("thread/read", { threadId, ...params });
    return response?.thread || null;
  }

  async threadResume(threadId, params = {}) {
    return this.call("thread/resume", { threadId, ...params });
  }

  async threadTurnsList(threadId, params = {}) {
    const response = await this.call("thread/turns/list", { threadId, ...params });
    return {
      data: response?.data || [],
      nextCursor: response?.nextCursor ?? response?.next_cursor ?? null,
      backwardsCursor: response?.backwardsCursor ?? response?.backwards_cursor ?? null
    };
  }

  async threadTurnsListAll(threadId, params = {}) {
    const turns = [];
    let cursor = params.cursor ?? null;
    for (let page = 0; page < 200; page += 1) {
      const response = await this.threadTurnsList(threadId, { ...params, cursor });
      turns.push(...response.data);
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return turns;
  }

  async threadInjectItems(threadId, items = []) {
    return this.call("thread/inject_items", { threadId, items });
  }

  call(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out: ${this.stderr.slice(-1200)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) {
            reject(new Error(message.error.message || JSON.stringify(message.error)));
            return;
          }
          resolvePromise(message.result);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || !this.pending.has(message.id)) continue;
      const slot = this.pending.get(message.id);
      this.pending.delete(message.id);
      slot.resolve(message);
    }
  }

  async stop() {
    try {
      this.child.stdin.end();
    } catch {}
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await wait(500);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
  }
}

function mountedTurnSearchKeysFromSnapshot(snapshot = {}) {
  const keys = new Set(snapshot.mountedTurnSearchKeys || []);
  for (const anchor of snapshot.anchors || []) {
    const id = String(anchor?.anchorId || "");
    const parsed = parseLocalContentSearchUnitKey(id);
    if (parsed) keys.add(parsed.turnSearchKey);
    if (anchor?.kind === "turn" || anchor?.kind === "content-search-turn") {
      keys.add(id);
    }
  }
  return keys;
}

function mountedContentAnchorIdsFromSnapshot(snapshot = {}) {
  const ids = new Set(snapshot.mountedContentAnchorIds || []);
  for (const anchor of snapshot.anchors || []) {
    const id = String(anchor?.anchorId || "");
    if (parseLocalContentSearchUnitKey(id)) ids.add(id);
  }
  return ids;
}

function parseLocalContentSearchUnitKey(id) {
  const match = String(id || "").match(/^(.*):(\d+):(user|assistant)$/);
  if (!match) return null;
  return {
    turnSearchKey: match[1],
    itemIndex: Number(match[2]),
    role: match[3]
  };
}

function projectDesktopTranscriptAnchors(turns) {
  const anchorIds = [];
  const turnSearchKeys = [];
  turns.forEach((turn, turnIndex) => {
    const turnSearchKey = turn?.id || `turn-index-${turnIndex}`;
    if (!isRenderableDesktopTurn(turn)) return;
    turnSearchKeys.push(turnSearchKey);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const lastAssistantIndex = findLastIndex(items, (item) => isItemType(item, "agentMessage", "assistant-message"));
    items.forEach((item, itemIndex) => {
      if (isItemType(item, "userMessage", "user-message")) {
        const text = userMessageText(item).trim();
        if (text) anchorIds.push(`${turnSearchKey}:${itemIndex}:user`);
      } else if (itemIndex === lastAssistantIndex && isItemType(item, "agentMessage", "assistant-message")) {
        const text = agentMessageText(item).trim();
        if (text) anchorIds.push(`${turnSearchKey}:${itemIndex}:assistant`);
      }
    });
  });
  return { anchorIds, turnSearchKeys };
}

function isRenderableDesktopTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return items.some((item) =>
    isItemType(item, "userMessage", "user-message") ||
    isItemType(item, "agentMessage", "assistant-message")
  );
}

function isItemType(item, ...types) {
  return types.includes(item?.type);
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

function userMessageText(item) {
  if (typeof item?.message === "string") return item.message;
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) {
    return item.content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

function agentMessageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.message === "string") return item.message;
  return "";
}

function buildAttachmentResponseItems(files = [], options = {}) {
  const createdAt = options.createdAt || new Date().toISOString();
  return files.map((file, index) => {
    const text = [
      "ClankerBend attached runtime file context.",
      "",
      `Attached at: ${createdAt}`,
      `File ${index + 1}: ${file.name || basename(file.path)}`,
      `Path: ${file.path}`,
      file.relativePath ? `Runtime path: ${file.relativePath}` : null,
      file.mimeType ? `MIME type: ${file.mimeType}` : null,
      "",
      "The following file was created by a ClankerBend app and should be treated as attached context for the user's next prompt.",
      "",
      "```markdown",
      readFileSync(file.path, "utf8"),
      "```"
    ].filter((line) => line !== null && line !== undefined).join("\n");
    return {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text
      }]
    };
  });
}

export const __testHooks = {
  mountedContentAnchorIdsFromSnapshot,
  mountedTurnSearchKeysFromSnapshot,
  projectDesktopTranscriptAnchors,
  buildAttachmentResponseItems
};

function defaultSnapshotToTranscript(snapshot = {}) {
  const anchors = (snapshot.anchors || snapshot.markers || []).map((item, index) => ({
    anchorId: item.anchorId || item.key,
    kind: item.kind || "unknown",
    visible: Boolean(item.visible),
    top: item.top,
    height: item.height,
    textPreview: item.textPreview || item.text || "",
    order: item.order || index + 1,
    inferredRole: item.inferredRole
  })).filter((anchor) => anchor.anchorId);
  return {
    anchors,
    visibleCount: snapshot.visibleCount ?? anchors.filter((anchor) => anchor.visible).length,
    annotationCount: snapshot.annotationCount ?? snapshot.annotationRails ?? 0,
    scroll: snapshot.scroll || null,
    updatedAt: new Date().toISOString()
  };
}

function summarizeTarget(target) {
  return {
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url
  };
}

function center(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function panelDiagnosticExpression(appUrl) {
  return `
    (() => {
      const appUrl = ${JSON.stringify(appUrl)};
      const appId = (() => {
        try {
          const match = new URL(appUrl).pathname.match(/\\/apps\\/([^/]+)\\/?/);
          return match ? decodeURIComponent(match[1]) : "";
        } catch {
          return "";
        }
      })();
      const normalize = (value) => String(value || "").replace("localhost", "127.0.0.1").replace(/\\/(?=#|$)/, "");
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const appPath = appId ? "/apps/" + appId + "/" : "";
      const encodedAppPath = appId ? "/apps/" + encodeURIComponent(appId) + "/" : "";
      const frame = [...document.querySelectorAll("webview, iframe")]
        .map((el) => String(el.getAttribute("src") || ""))
        .find((src) => normalize(src) === normalize(appUrl) || (appPath && (src.includes(appPath) || src.includes(encodedAppPath))));
      const buttons = [...document.querySelectorAll("button, [role='button'], a")]
        .map((el) => {
          const haystack = [
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
            el.innerText || el.textContent || ""
          ].join(" ").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          const match = normalize(haystack).includes(normalize(appUrl)) ||
            (appId && haystack.includes(appId)) ||
            (appPath && (haystack.includes(appPath) || haystack.includes(encodedAppPath)));
          const score = (/\\b127\\.0\\.0\\.1:\\d+\\b/.test(haystack) ? 4 : 0) +
            ((appPath && (haystack.includes(appPath) || haystack.includes(encodedAppPath))) ? 4 : 0) +
            (rect.top > 80 ? 2 : -4);
          return { el, match, score, rect, haystack };
        })
        .filter((item) => item.match && item.rect.width > 0 && item.rect.height > 0)
        .sort((a, b) => b.score - a.score);
      const input = [...document.querySelectorAll("input")]
        .find((el) => /url/i.test(el.placeholder || "") && el.getBoundingClientRect().width > 0);
      return {
        frame: frame || null,
        frames: [...document.querySelectorAll("webview, iframe")].map((el) => String(el.getAttribute("src") || "")),
        localRect: buttons[0] ? rectOf(buttons[0].el) : null,
        localText: buttons[0]?.haystack || null,
        inputRect: input ? rectOf(input) : null,
        inputValue: input?.value || null
      };
    })()
  `;
}

function findComposerAddButtonExpression() {
  return `
    (() => {
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const composerCandidates = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 240 && item.rect.height > 24 && item.rect.top > window.innerHeight / 2)
        .sort((a, b) => b.rect.top - a.rect.top);
      const composer = composerCandidates[0];
      if (!composer) return { ok: false, error: "composer not found" };
      const composerRect = composer.rect;
      const buttons = [...document.querySelectorAll("button,[role='button']")]
        .map((el) => {
          const text = [el.getAttribute("aria-label") || "", el.getAttribute("title") || "", el.innerText || el.textContent || ""]
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
          const rect = el.getBoundingClientRect();
          const nearComposer = rect.top >= composerRect.top - 80 &&
            rect.bottom <= composerRect.bottom + 80 &&
            rect.left <= composerRect.left + 120;
          const score = (/^\\+$/.test(text) || /\\b(add|attach|files?|folders?)\\b/i.test(text) ? 8 : 0) +
            (nearComposer ? 8 : 0) +
            (rect.width >= 24 && rect.width <= 72 && rect.height >= 24 && rect.height <= 72 ? 4 : 0);
          return { el, text, rect, score };
        })
        .filter((item) => item.score >= 12 && item.rect.width > 0 && item.rect.height > 0)
        .sort((a, b) => b.score - a.score || a.rect.left - b.rect.left);
      const item = buttons[0];
      return item ? { ok: true, text: item.text, rect: rectOf(item.el), composerRect: rectOf(composer.el) } : { ok: false, error: "add button not found" };
    })()
  `;
}

function composerFileDropExpression(files) {
  return `
    (async () => {
      const files = ${JSON.stringify(files)};
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const composerCandidates = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")]
        .map((input) => {
          const inputRect = input.getBoundingClientRect();
          if (inputRect.width < 240 || inputRect.height < 24 || inputRect.top < window.innerHeight / 2) return null;
          let anchor = input;
          for (let node = input.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            if (rect.width < inputRect.width || rect.height < inputRect.height) continue;
            if (rect.bottom < inputRect.bottom - 4 || rect.top > inputRect.top + 4) continue;
            if (rect.height > Math.max(260, inputRect.height + 180)) break;
            anchor = node;
            if (node.matches?.("form")) break;
          }
          return { input, anchor, inputRect, anchorRect: anchor.getBoundingClientRect() };
        })
        .filter(Boolean)
        .sort((a, b) => b.inputRect.bottom - a.inputRect.bottom || b.inputRect.width - a.inputRect.width);
      const composer = composerCandidates[0];
      if (!composer) return { ok: false, error: "composer not found" };
      const dt = new DataTransfer();
      for (const file of files) {
        dt.items.add(new File([file.body || ""], file.name, { type: file.mimeType || "text/plain" }));
      }
      const targets = [composer.input, composer.anchor].filter(Boolean);
      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
        clientX: composer.inputRect.left + Math.min(40, composer.inputRect.width / 2),
        clientY: composer.inputRect.top + Math.min(20, composer.inputRect.height / 2)
      };
      const dispatched = [];
      for (const target of targets) {
        try { target.focus?.({ preventScroll: true }); } catch { target.focus?.(); }
        for (const type of ["dragenter", "dragover", "drop"]) {
          const event = new DragEvent(type, eventInit);
          dispatched.push({ type, target: target.tagName, defaultPrevented: !target.dispatchEvent(event) || event.defaultPrevented });
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      return {
        ok: true,
        files: files.map((file) => file.name),
        inputRect: rectOf(composer.input),
        anchorRect: rectOf(composer.anchor),
        dispatched
      };
    })()
  `;
}

function findFilesAndFoldersItemExpression() {
  return `
    (() => {
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const candidates = [...document.querySelectorAll("button,[role='button'],[role='menuitem'],li,div")]
        .map((el) => {
          const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          const compact = rect.width > 160 && rect.height >= 28 && rect.height <= 72;
          const exactish = /^Files and folders\\b/i.test(text);
          const score = (exactish ? 30 : 0) +
            (/\\bFiles and folders\\b/i.test(text) ? 20 : 0) +
            (/\\bFiles?\\b/i.test(text) && /\\bFolders?\\b/i.test(text) ? 8 : 0) +
            (compact ? 8 : -20);
          return { el, text, rect, score, compact };
        })
        .filter((item) => item.compact && item.score >= 20 && item.rect.width > 0 && item.rect.height > 0 && item.rect.top > window.innerHeight / 3)
        .sort((a, b) => b.score - a.score || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const item = candidates[0];
      return item ? { ok: true, text: item.text, rect: rectOf(item.el) } : { ok: false, error: "Files and folders not found" };
    })()
  `;
}

function attachmentDiagnosticExpression(paths) {
  return `
    (() => {
      const paths = ${JSON.stringify(paths)};
      const text = document.body?.innerText || "";
      const basenames = paths.map((path) => path.split(/[\\\\/]/).pop());
      const matched = basenames.filter((name) => text.includes(name));
      return { ok: matched.length > 0, matched, basenames };
    })()
  `;
}

function nativeAddContextFileExpression(file) {
  return `
    (() => {
      const file = ${JSON.stringify(file)};
      if (!file?.path) return { ok: false, error: "file path missing" };
      const label = file.label || file.path.split(/[\\\\/]/).pop();
      const payload = {
        type: "add-context-file",
        file: {
          label,
          path: file.path,
          fsPath: file.fsPath || file.path
        }
      };
      window.dispatchEvent(new MessageEvent("message", { data: payload }));
      return { ok: true, file: payload.file };
    })()
  `;
}

function nativeAttachmentDiagnosticExpression(paths) {
  return `
    (() => {
      const paths = ${JSON.stringify(paths)};
      const basenames = paths.map((path) => String(path).split(/[\\\\/]/).pop()).filter(Boolean);
      const clankerbendChipCount = document.querySelectorAll("#clankerbend-composer-chips .clankerbend-context-chip").length;
      const composerInputs = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 180 && item.rect.height > 18 && item.rect.bottom > window.innerHeight * 0.45)
        .sort((a, b) => b.rect.bottom - a.rect.bottom);
      const composerRect = composerInputs[0]?.rect || null;
      const candidates = [...document.querySelectorAll("button,[role='button'],span,div")]
        .filter((el) => !el.closest("#clankerbend-composer-chips"))
        .map((el) => {
          const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          const nearComposer = !composerRect || (
            rect.bottom >= composerRect.top - 120 &&
            rect.top <= composerRect.bottom + 80 &&
            rect.right >= composerRect.left - 40 &&
            rect.left <= composerRect.right + 40
          );
          return { text, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, nearComposer };
        })
        .filter((item) =>
          item.nearComposer &&
          item.rect.width > 20 &&
          item.rect.width < 420 &&
          item.rect.height >= 12 &&
          item.rect.height < 80 &&
          basenames.some((name) => item.text.includes(name))
        );
      const matched = basenames.filter((name) => candidates.some((item) => item.text.includes(name)));
      return {
        ok: matched.length === basenames.length && clankerbendChipCount === 0,
        matched,
        basenames,
        clankerbendChipCount,
        candidates: candidates.slice(0, 12)
      };
    })()
  `;
}

function setBrowserUrlInputExpression(appUrl) {
  return `
    (() => {
      const input = [...document.querySelectorAll("input")]
        .find((el) => /url/i.test(el.placeholder || "") && el.getBoundingClientRect().width > 0);
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(appUrl)});
      else input.value = ${JSON.stringify(appUrl)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(appUrl)} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
  });
}

async function pollJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {}
    await wait(300);
  }
  return null;
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForEvaluate(adapter, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await adapter.evaluate(expression).catch((err) => ({ ok: false, error: err.message }));
    if (last?.ok) return last;
    await wait(150);
  }
  return last;
}
