import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(__dirname, "run/desktop-real-validation");
const RESULT_PATH = join(RUN_DIR, "result.json");
const TEST_RUN_ID = `CLANKERBEND_VIM_NAV_E2E_${Date.now()}`;
const CODEX_TARGET_URL = "app://-/index.html";

const result = {
  ok: false,
  mode: "real-codex-desktop",
  chatTitle: `new chat ${TEST_RUN_ID}`,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: []
};

let server = null;

async function main() {
try {
  await rm(RUN_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const cdpPort = await waitForLauncher(server);
  result.cdpPort = cdpPort;
  result.checks.push({ name: "launcher", ok: true, cdpPort });

  const page = await waitForPage(cdpPort);
  result.checks.push({ name: "renderer-target", ok: true, url: page.url });

  const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
  try {
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable").catch(() => {});

    const seeded = await createSeededTranscript(cdp);
    const units = await cdp.eval(transcriptUnitCountExpression());
    if (units < 1) throw new Error(`fresh seeded chat has no transcript units after ${JSON.stringify(TEST_RUN_ID)}`);
    result.checks.push({ name: "open-transcript", ok: true, units, seedCount: seeded.length });

    const injectedSource = await readFile(join(__dirname, "../../host/src/codex-desktop-renderer-bridge.js"), "utf8");
    await cdp.eval(`
      (() => {
        const slot = window.__clankerbendRuntime?.apps?.["onewill.vim-nav"];
        if (slot) {
          slot.bridge = null;
          slot.injectedAt = null;
        }
        document.querySelectorAll(".codex-vim-nav-annotation,.codex-vim-nav-badge,.codex-vim-nav-panel")
          .forEach((node) => node.remove());
        return true;
      })();
      ${injectedSource}
    `);
    await waitForAppServerOrder(cdp);
    const injected = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot()`);
    result.checks.push({ name: "inject", ok: injected?.version >= 1, version: injected?.version, anchors: injected?.anchors?.length || 0 });
    const initialGlyphs = await waitForMarkerGlyphs(cdp, "initial displayed markers");
    if (!initialGlyphs.length || initialGlyphs.some((glyph) => !/^\d+$/.test(glyph))) {
      throw new Error(`initial displayed markers should already be numeric: ${JSON.stringify(initialGlyphs)}`);
    }
    result.checks.push({ name: "initial-marker-glyphs", ok: true, glyphs: initialGlyphs });
    assertIncreasingNumbers(initialGlyphs.map(Number), "initial mounted marker DOM order");
    const initialOrderAudit = await cdp.eval(`
      (() => {
        const bridgeAnchors = window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot().anchors || [];
        const eligible = bridgeAnchors
          .filter((anchor) => /:(user|assistant)$/.test(anchor.anchorId || ""))
          .map((anchor) => ({ anchorId: anchor.anchorId, expected: anchor.order }));
        const markers = [...document.querySelectorAll(".codex-vim-nav-annotation")]
          .map((marker) => ({
            anchorId: marker.dataset.anchorId,
            glyph: Number(marker.textContent.trim())
          }));
        const markerById = new Map(markers.map((marker) => [marker.anchorId, marker.glyph]));
        const missing = eligible.filter((item) => !markerById.has(item.anchorId));
        const wrongOrder = eligible.filter((item) => markerById.get(item.anchorId) !== item.expected);
        const extra = markers.filter((marker) => !eligible.some((item) => item.anchorId === marker.anchorId));
        return {
          eligibleCount: eligible.length,
          markerCount: markers.length,
          missing: missing.slice(0, 5),
          wrongOrder: wrongOrder.slice(0, 5),
          extra: extra.slice(0, 5)
        };
      })()
    `);
    if (initialOrderAudit.missing.length || initialOrderAudit.wrongOrder.length || initialOrderAudit.extra.length) {
      throw new Error(`initial numbering does not match Codex content-unit order: ${JSON.stringify(initialOrderAudit)}`);
    }
    result.checks.push({
      name: "initial-dom-order-numbering",
      ok: true,
      eligibleCount: initialOrderAudit.eligibleCount,
      markerCount: initialOrderAudit.markerCount
    });
    result.checks.push({ name: "initial-mounted-marker-order", ok: true, glyphs: initialGlyphs.map(Number) });
    await assertVisibleMarkerOrder(cdp, "initial-visible-marker-order");
    const statusMarkerCount = await cdp.eval(`
      [...document.querySelectorAll(".codex-vim-nav-annotation")]
        .filter((marker) => /^worked for\\b/i.test((marker.parentElement?.innerText || marker.parentElement?.textContent || "").trim()))
        .length
    `);
    if (statusMarkerCount !== 0) throw new Error(`status/fold rows should not be numbered; found ${statusMarkerCount}`);
    result.checks.push({ name: "status-rows-unnumbered", ok: true });
    await assertPrimeDoesNotScroll(cdp);
    await assertToggleDoesNotScroll(cdp);
    let baseline = await snapshot(cdp);
    if (!isViewportVisible(baseline)) {
      await press(cdp, "G", "KeyG", 71, 8);
      baseline = await waitForSnapshot(cdp, "G-establishes-visible-baseline", (snap) =>
        snap.order !== null && isViewportVisible(snap),
        15000
      );
      result.checks.push({ name: "G-establishes-visible-baseline", ok: true, order: baseline.order, markerTop: baseline.top });
    }
    const firstKBefore = await snapshot(cdp);
    await press(cdp, "k", "KeyK", 75);
    await wait(600);
    let current = await waitForSnapshot(cdp, "first-k-from-visible-bottom", (snap) => snap.order !== null, 12000);
    const firstKDelta = Math.abs(current.scrollTop - firstKBefore.scrollTop);
    const expectedFirstKOrder = previousMountedOrder(firstKBefore.mountedOrders, firstKBefore.order);
    if (current.order !== expectedFirstKOrder) {
      throw new Error(`first k should move to the previous transcript item: before=${JSON.stringify(firstKBefore)} after=${JSON.stringify(current)}`);
    }
    assertFastRelativePath(current, "first k");
    result.checks.push({ name: "first-k-from-visible-bottom", ok: true, beforeOrder: firstKBefore.order, order: current.order, markerTop: current.top, scrollDelta: firstKDelta });
    await assertVisibleMarkerOrder(cdp, "visible-marker-order-after-first-k");

    const firstJBefore = await snapshot(cdp);
    await press(cdp, "j", "KeyJ", 74);
    await wait(600);
    current = await waitForSnapshot(cdp, "first-j-from-visible-bottom", (snap) => snap.order !== null, 12000);
    const firstJDelta = Math.abs(current.scrollTop - firstJBefore.scrollTop);
    const expectedFirstJOrder = nextMountedOrder(firstJBefore.mountedOrders, firstJBefore.order);
    if (current.order !== expectedFirstJOrder) {
      throw new Error(`first j should move to the next transcript item: before=${JSON.stringify(firstJBefore)} after=${JSON.stringify(current)}`);
    }
    assertFastRelativePath(current, "first j");
    const firstJGlyphs = await waitForMarkerGlyphs(cdp, "first j displayed markers");
    if (!firstJGlyphs.length || firstJGlyphs.some((glyph) => !/^\d+$/.test(glyph))) {
      throw new Error(`first j did not compute stable numeric indexes: ${JSON.stringify(firstJGlyphs)}`);
    }
    assertIncreasingNumbers(firstJGlyphs.map(Number), "first-j mounted marker DOM order");
    result.checks.push({ name: "first-j-from-visible-bottom", ok: true, beforeOrder: firstJBefore.order, order: current.order, markerTop: current.top, scrollDelta: firstJDelta, glyphs: firstJGlyphs });
    await assertVisibleMarkerOrder(cdp, "visible-marker-order-after-first-j");
    await assertMountedGapNumberGStabilizes(cdp);

    await press(cdp, "G", "KeyG", 71, 8);
    const prime = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").primeAnchorOrder()`, { timeoutMs: 25000 });
    if (!prime?.ok || prime.count < 2) throw new Error(`primeAnchorOrder failed: ${JSON.stringify(prime)}`);
    current = await waitForSnapshot(cdp, "G-primes-index", (snap) =>
      snap.order === Math.max(...snap.mountedOrders) && isViewportVisible(snap),
      25000
    );
    const renderedBottomOrder = current.order;
    result.checks.push({ name: "G-primes-anchor-order", ok: true, count: prime.count, order: current.order, cached: Boolean(prime.cached), partial: Boolean(prime.partial) });
    const indexedGlyphs = await waitForMarkerGlyphs(cdp, "indexed displayed markers");
    if (!indexedGlyphs.length || indexedGlyphs.some((glyph) => !/^\d+$/.test(glyph))) {
      throw new Error(`navigation did not replace pending glyphs with numeric markers: ${JSON.stringify(indexedGlyphs)}`);
    }
    result.checks.push({ name: "indexed-marker-glyphs", ok: true, glyphs: indexedGlyphs });
    result.checks.push({ name: "G", ok: true, order: current.order, markerTop: current.top });
    const bottomMountedOrders = [...new Set(current.mountedOrders)]
      .filter((order) => Number.isSafeInteger(order))
      .sort((a, b) => a - b);
    const reachableTopOrder = bottomMountedOrders[0] || 1;

    if (prime.count >= 2) {
      const requestedFromBottom = 2;
      const expectedFromBottom = bottomMountedOrders.includes(requestedFromBottom)
        ? requestedFromBottom
        : reachableTopOrder;
      await pressDigits(cdp, String(requestedFromBottom));
      await press(cdp, "G", "KeyG", 71, 8);
      current = await waitForSnapshot(cdp, "2G-from-bottom", (snap) =>
        snap.order === expectedFromBottom && isViewportVisible(snap),
        20000
      );
      result.checks.push({
        name: "2G-from-bottom",
        ok: true,
        requested: requestedFromBottom,
        expected: expectedFromBottom,
        order: current.order,
        markerTop: current.top
      });
      await press(cdp, "G", "KeyG", 71, 8);
      current = await waitForSnapshot(cdp, "G-after-2G", (snap) =>
        snap.order === Math.max(...snap.mountedOrders) && isViewportVisible(snap),
        20000
      );
    }

    let previous = current.order;
    let steps = 0;
    if (reachableTopOrder === 1) {
      while (previous > reachableTopOrder) {
        await press(cdp, "k", "KeyK", 75);
        steps += 1;
        current = await waitForSnapshot(cdp, `k step ${steps}`, (snap) =>
          snap.order !== null && snap.order < previous && isViewportVisible(snap),
          15000
        );
        previous = current.order;
      }
    } else {
      result.checks.push({ name: "k-to-top", ok: true, skipped: true, reason: "historical rows are not mounted by Codex desktop", reachableTopOrder });
    }
    if (steps) result.checks.push({ name: "k-to-top", ok: true, steps });
    await assertVisibleMarkerOrder(cdp, "visible-marker-order-after-k-to-top");

    if (prime.count >= 12) {
      await pressDigits(cdp, "1");
      let badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer !== "1") throw new Error(`mode badge should show key buffer 1, got ${JSON.stringify(badgeBuffer)}`);
      await pressDigits(cdp, "2");
      badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer !== "12") throw new Error(`mode badge should show key buffer 12, got ${JSON.stringify(badgeBuffer)}`);
      const badgeLayout = await cdp.eval(`
        (() => {
          const badge = document.querySelector("#codex-vim-nav-mode-badge");
          const row = badge?.querySelector(".codex-vim-nav-key-buffer");
          const badgeStyle = badge ? getComputedStyle(badge) : null;
          return {
            direction: badgeStyle?.flexDirection || null,
            rowText: row?.textContent?.trim() || "",
            childTags: [...(badge?.children || [])].map((node) => ({
              tag: node.tagName,
              className: node.className || "",
              text: node.textContent?.trim() || ""
            }))
          };
        })()
      `);
      if (
        badgeLayout.direction !== "column" ||
        !badgeLayout.rowText.includes("12") ||
        !String(badgeLayout.childTags?.[0]?.className || "").includes("codex-vim-nav-title-row") ||
        !badgeLayout.childTags?.[0]?.text.includes("VimNav") ||
        !badgeLayout.childTags?.[0]?.text.includes("[ON]") ||
        !badgeLayout.childTags?.[1]?.text.includes("Cmd-Option toggles") ||
        !String(badgeLayout.childTags?.[2]?.className || "").includes("codex-vim-nav-key-buffer")
      ) {
        throw new Error(`mode badge should stack key buffer on its own row: ${JSON.stringify(badgeLayout)}`);
      }
      await press(cdp, "?", "Slash", 191, 8);
      const helpMenuText = await cdp.eval(`
        document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-help-menu")?.textContent || ""
      `);
      if (!helpMenuText.includes("67G") || helpMenuText.includes("19G") || !helpMenuText.includes("Backspace")) {
        throw new Error(`mode badge help menu should include extended commands: ${JSON.stringify(helpMenuText)}`);
      }
      await press(cdp, "?", "Slash", 191, 8);
      await press(cdp, "Backspace", "Backspace", 8);
      badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer !== "1") throw new Error(`Backspace should trim key buffer to 1, got ${JSON.stringify(badgeBuffer)}`);
      await pressDigits(cdp, "9");
      badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer !== "19") throw new Error(`mode badge should show key buffer 19, got ${JSON.stringify(badgeBuffer)}`);
      await press(cdp, "Backspace", "Backspace", 8);
      await pressDigits(cdp, "2");
      badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer !== "12") throw new Error(`mode badge should restore key buffer 12, got ${JSON.stringify(badgeBuffer)}`);
      await press(cdp, "G", "KeyG", 71, 8);
      badgeBuffer = await modeBadgeBuffer(cdp);
      if (badgeBuffer) throw new Error(`mode badge key buffer should clear after G, got ${JSON.stringify(badgeBuffer)}`);
      const canReach12Exactly = current.mountedOrders.includes(12);
      current = await waitForSnapshot(cdp, "12G", (snap) =>
        (canReach12Exactly ? snap.order === 12 : snap.order !== null && snap.order <= reachableTopOrder) &&
        isViewportVisible(snap)
      );
      const twelveGExpected = current.order;
      result.checks.push({ name: "12G", ok: true, requested: 12, expected: twelveGExpected, exact: canReach12Exactly, order: current.order, markerTop: current.top });
      let bracketExpected = twelveGExpected;
      let canCheckBracketAlignment = canAnchorFitSafeViewport(current);
      if (!canAnchorFitSafeViewport(current)) {
        const candidate = await normalMountedBracketTarget(cdp, twelveGExpected);
        if (!candidate) {
          result.checks.push({
            name: "bracket-target-normalized",
            ok: true,
            skipped: true,
            reason: "no mounted transcript row fits the safe viewport",
            order: current.order,
            anchorTop: current.anchorViewportTop,
            anchorBottom: current.anchorViewportBottom,
            safeTop: current.visibleTopInset,
            safeBottom: current.visibleBottom
          });
        } else {
          bracketExpected = candidate.order;
          await pressDigits(cdp, String(candidate.order));
          await press(cdp, "G", "KeyG", 71, 8);
          current = await waitForSnapshot(cdp, "bracket-target-normalized", (snap) =>
            snap.order === bracketExpected && canAnchorFitSafeViewport(snap) && isViewportVisible(snap),
            12000
          );
          result.checks.push({
            name: "bracket-target-normalized",
            ok: true,
            fromOrder: twelveGExpected,
            order: current.order,
            anchorHeight: Math.round((current.anchorViewportBottom || 0) - (current.anchorViewportTop || 0)),
            safeHeight: Math.round((current.visibleBottom || 0) - (current.visibleTopInset || 0))
          });
          canCheckBracketAlignment = true;
        }
      }
      if (canCheckBracketAlignment) {
        await press(cdp, "]", "BracketRight", 221);
        current = await waitForSnapshot(cdp, "bracket-end-safe", (snap) =>
          snap.order === bracketExpected && isAnchorEndSafe(snap),
          12000
        );
        result.checks.push({ name: "bracket-end-safe", ok: true, order: current.order, anchorBottom: current.anchorViewportBottom, safeBottom: current.visibleBottom });
        await press(cdp, "[", "BracketLeft", 219);
        current = await waitForSnapshot(cdp, "bracket-start-safe", (snap) =>
          snap.order === bracketExpected && (isTopAligned(snap) || isViewportVisible(snap)),
          12000
        );
        result.checks.push({ name: "bracket-start-safe", ok: true, order: current.order, markerTop: current.markerViewportTop });
      }
    }

    await press(cdp, "g", "KeyG", 71);
    await press(cdp, "g", "KeyG", 71);
    const ggExpected = current.mountedOrders.includes(1) ? 1 : Math.min(...current.mountedOrders);
    current = await waitForSnapshot(cdp, "gg", (snap) =>
      (snap.order === 1 || snap.order === ggExpected) && isTopAligned(snap)
    );
    const topGlyph = await waitForTopMarkerGlyph(cdp, "gg top marker");
    if (topGlyph !== String(current.order)) throw new Error(`gg should put selected transcript top ${current.order} at the visible top, got top marker ${JSON.stringify(topGlyph)}`);
    result.checks.push({ name: "gg", ok: true, expected: current.order, order: current.order, markerTop: current.top });
    await press(cdp, "}", "BracketRight", 221, 8);
    current = await waitForSnapshot(cdp, "next-user-prompt-safe", (snap) =>
      snap.order !== null && snap.order > 1 && (isTopAligned(snap) || isViewportVisible(snap)),
      12000
    );
    result.checks.push({ name: "next-user-prompt-safe", ok: true, order: current.order, markerTop: current.markerViewportTop });
    await press(cdp, "{", "BracketLeft", 219, 8);
    current = await waitForSnapshot(cdp, "previous-user-prompt-safe", (snap) =>
      snap.order !== null && snap.order < result.checks.at(-1).order && (isTopAligned(snap) || isViewportVisible(snap)),
      12000
    );
    result.checks.push({ name: "previous-user-prompt-safe", ok: true, order: current.order, markerTop: current.markerViewportTop });

    if (prime.count >= 200 && current.mountedOrders.includes(200)) {
      await pressDigits(cdp, "200");
      await press(cdp, "G", "KeyG", 71, 8);
      current = await waitForSnapshot(cdp, "200G-from-top", (snap) => snap.order === 200 && isViewportVisible(snap), 20000);
      result.checks.push({ name: "200G-from-top", ok: true, order: current.order, markerTop: current.top });
      await press(cdp, "g", "KeyG", 71);
      await press(cdp, "g", "KeyG", 71);
      current = await waitForSnapshot(cdp, "gg-after-200G", (snap) => snap.order === 1 && isTopAligned(snap), 20000);
    }

    previous = current.order;
    steps = 0;
    while (previous < renderedBottomOrder) {
      await press(cdp, "j", "KeyJ", 74);
      steps += 1;
      current = await waitForSnapshot(cdp, `j step ${steps}`, (snap) =>
        snap.order !== null && snap.order > previous,
        15000
      );
      previous = current.order;
    }
    result.checks.push({ name: "j-to-bottom", ok: true, steps });
    await assertVisibleMarkerOrder(cdp, "visible-marker-order-after-j-to-bottom");

    const bottomBeforeExtraJ = await snapshot(cdp);
    await press(cdp, "j", "KeyJ", 74);
    await wait(300);
    current = await snapshot(cdp);
    if (current.order !== bottomBeforeExtraJ.order) {
      throw new Error(`j at bottom should not change selection: before=${JSON.stringify(bottomBeforeExtraJ)} after=${JSON.stringify(current)}`);
    }
    const bottomExtraJScrollDelta = Math.abs(current.scrollTop - bottomBeforeExtraJ.scrollTop);
    if (bottomExtraJScrollDelta > 1) {
      throw new Error(`j at bottom should not scroll: before=${JSON.stringify(bottomBeforeExtraJ)} after=${JSON.stringify(current)}`);
    }
    if (current?.debug?.lastRelativeDebug?.path !== "edge" || current.debug.lastRelativeDebug.targetIndex <= current.debug.lastRelativeDebug.lastIndex) {
      throw new Error(`j at bottom should use edge no-op path: ${JSON.stringify(current?.debug?.lastRelativeDebug || null)}`);
    }
    result.checks.push({
      name: "j-at-bottom-noop",
      ok: true,
      order: current.order,
      scrollDelta: bottomExtraJScrollDelta
    });

    await pressDigits(cdp, String(prime.count + 10));
    await press(cdp, "G", "KeyG", 71, 8);
    current = await waitForSnapshot(cdp, "oversized-number-G", (snap) => snap.order >= renderedBottomOrder && isViewportVisible(snap));
    result.checks.push({ name: "oversized-number-G", ok: true, requested: prime.count + 10, expectedAtLeast: renderedBottomOrder, order: current.order, markerTop: current.top });

    const clickedMarker = await clickFirstVimMarker(cdp);
    await wait(300);
    const clickedSelection = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot().selection`);
    if (clickedSelection?.anchorId !== clickedMarker) {
      throw new Error(`marker click did not select anchor: clicked=${clickedMarker} selection=${JSON.stringify(clickedSelection)}`);
    }
    const panelSrc = await waitForPanelOpen(cdp);
    result.checks.push({ name: "marker-click-opens-panel", ok: true, anchorId: clickedMarker, panelSrc });

    const dismissed = await cdp.eval(`
      (() => {
        const button = document.querySelector("#codex-vim-nav-mode-badge .codex-vim-nav-dismiss");
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    if (!dismissed) throw new Error("VimNav badge dismiss button was not present");
    const hiddenDisplay = await cdp.eval(`getComputedStyle(document.querySelector("#codex-vim-nav-mode-badge")).display`);
    if (hiddenDisplay !== "none") throw new Error(`VimNav badge should hide after dismiss, display=${hiddenDisplay}`);
    await toggleVim(cdp);
    const restored = await cdp.eval(`
      (() => {
        const badge = document.querySelector("#codex-vim-nav-mode-badge");
        return {
          display: badge ? getComputedStyle(badge).display : null,
          text: badge?.textContent || ""
        };
      })()
    `);
    if (restored.display === "none" || !restored.text.includes("[ON]")) {
      throw new Error(`Cmd-Option should restore hidden VimNav badge: ${JSON.stringify(restored)}`);
    }
    result.checks.push({ name: "badge-dismiss-restore", ok: true });

    await finish(true);
  } finally {
    cdp.close();
  }
} catch (err) {
  result.errors.push(err.stack || err.message);
  await finish(false);
}
}

async function finish(ok) {
  result.ok = ok;
  result.completedAt = new Date().toISOString();
  await cleanup();
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

async function cleanup() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await wait(1200);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function waitForLauncher(child) {
  let output = "";
  const deadline = Date.now() + 30000;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  while (Date.now() < deadline) {
    const hostUrl = output.match(/^Host: (http:\/\/127\.0\.0\.1:\d+)/m)?.[1];
    const panelUrl = output.match(/^Panel: (http:\/\/127\.0\.0\.1:\d+\/\S+)/m)?.[1];
    const token = panelUrl ? new URL(panelUrl).hash.match(/clankerbend_token=([^&]+)/)?.[1] || "" : "";
    if (hostUrl && token) {
      const state = await fetchHostState(hostUrl, decodeURIComponent(token)).catch(() => null);
      const cdpPort = state?.desktop?.cdpPort;
      if (cdpPort) return Number(cdpPort);
    }
    if (child.exitCode !== null) throw new Error(`launcher exited early with ${child.exitCode}:\n${output}`);
    await wait(100);
  }
  throw new Error(`launcher did not report CDP port:\n${output}`);
}

async function fetchHostState(hostUrl, token) {
  const response = await fetch(`${hostUrl}/clankerbend/state`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) return null;
  const envelope = await response.json();
  return envelope.data || envelope;
}

async function waitForPage(cdpPort) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const page = targets.find((target) => target.type === "page" && target.url === CODEX_TARGET_URL) ||
        targets.find((target) => target.type === "page" && target.url?.startsWith("app://-")) ||
        targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await wait(250);
  }
  throw new Error("Codex renderer target did not become available");
}

async function createSeededTranscript(cdp) {
  await openNewChat(cdp);
  const seeded = [];
  for (let i = 1; i <= 4; i += 1) {
    const seedText = `${TEST_RUN_ID} seed ${i}`;
    const beforeUnits = await transcriptUnitsContaining(cdp, seedText);
    const beforeKeys = new Set(beforeUnits.map((unit) => unit.key));
    const submitted = await submitComposerPrompt(cdp, `Reply with exactly: ${seedText}`);
    const unit = await waitForNewAssistantUnitContaining(cdp, seedText, beforeKeys);
    seeded.push({ seedText, submitted, unit });
  }
  return seeded;
}

async function openNewChat(cdp) {
  await cdp.call("Page.bringToFront").catch(() => {});
  await keyChord(cdp, "n", "KeyN", 4);
  let ready = await waitForFreshComposer(cdp, 5000).catch(() => null);
  if (!ready?.ok) {
    const clicked = await clickNewChatButton(cdp);
    if (!clicked?.ok) throw new Error(`could not open new chat: ${JSON.stringify(clicked)}`);
    ready = await waitForFreshComposer(cdp, 12000);
  }
  result.checks.push({ name: "new-chat", ok: true, mode: ready.mode, transcriptUnits: ready.units });
}

async function clickNewChatButton(cdp) {
  return cdp.eval(`
    (() => {
      const candidates = [...document.querySelectorAll("button,a,[role='button'],[role='listitem'],div")]
        .map((el) => {
          const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
          const rect = el.getBoundingClientRect();
          return { el, text, rect, area: rect.width * rect.height };
        })
        .filter((item) =>
          /^New chat\\b/i.test(item.text) &&
          item.rect.width > 40 &&
          item.rect.height > 20 &&
          item.rect.width <= 320 &&
          item.rect.height <= 80 &&
          item.rect.left < 380 &&
          item.rect.top < 180
        )
        .sort((a, b) => a.area - b.area);
      const item = candidates[0];
      if (!item) return { ok: false, error: "new chat button not found" };
      const target = item.el.closest("button,a,[role='button'],[role='listitem']") || item.el;
      target.click();
      return { ok: true, text: item.text };
    })()
  `);
}

async function waitForFreshComposer(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const units = ${transcriptUnitCountExpression()};
        const composer = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox'],.ProseMirror")]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter((item) =>
            item.rect.width > 240 &&
            item.rect.height > 18 &&
            item.rect.top > 80 &&
            item.rect.bottom < window.innerHeight &&
            item.rect.right > window.innerWidth * 0.35 &&
            (item.el.isContentEditable || /^(TEXTAREA|INPUT)$/.test(item.el.tagName) || item.el.getAttribute("role") === "textbox")
          )
          .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]?.el;
        return { ok: Boolean(composer) && units === 0, mode: "new-chat", units, hasComposer: Boolean(composer) };
      })()
    `);
    if (last?.ok) return last;
    await wait(250);
  }
  throw new Error(`new chat composer did not become ready: ${JSON.stringify(last)}`);
}

async function assertToggleDoesNotScroll(cdp) {
  const before = await snapshot(cdp);
  if (before.vim) await toggleVim(cdp);
  await wait(250);
  const scrollBefore = (await snapshot(cdp)).scrollTop;
  await toggleVim(cdp);
  await wait(600);
  const after = await snapshot(cdp);
  if (!after.vim) throw new Error(`Cmd+Option did not enable Vim mode: ${JSON.stringify(after.debug)}`);
  if (after.order == null) throw new Error(`Cmd+Option did not select a transcript item: ${JSON.stringify(after)}`);
  const badgeTitle = await cdp.eval(`
    document.querySelector("#codex-vim-nav-mode-badge strong")?.textContent || ""
  `);
  if (badgeTitle !== "VimNav") throw new Error(`Unexpected mode badge title: ${JSON.stringify(badgeTitle)}`);
  const focusState = await cdp.eval(`
    (() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName || null,
        role: el?.getAttribute?.("role") || null,
        contentEditable: Boolean(el?.isContentEditable),
        anchorId: el?.matches?.("[data-content-search-unit-key],[data-turn-key],[data-content-search-turn-key],[data-thread-user-message-navigation-item-id]")
          ? (el.getAttribute("data-content-search-unit-key") || el.getAttribute("data-turn-key") || el.getAttribute("data-content-search-turn-key") || el.getAttribute("data-thread-user-message-navigation-item-id"))
          : null
      };
    })()
  `);
  if (["INPUT", "TEXTAREA"].includes(focusState.tag) || focusState.contentEditable || focusState.role === "textbox") {
    throw new Error(`Cmd+Option should move focus out of the composer: ${JSON.stringify(focusState)}`);
  }
  if (!focusState.anchorId) throw new Error(`Cmd+Option should focus a transcript anchor: ${JSON.stringify(focusState)}`);
  const delta = after.scrollTop - scrollBefore;
  if (Math.abs(delta) > 2) throw new Error(`Cmd+Option toggle moved scroll by ${delta}`);
  result.checks.push({ name: "toggle-no-scroll", ok: true, scrollDelta: delta, initialOrder: before.order || null, order: after.order, visible: isViewportVisible(after), focus: focusState });
}

async function assertPrimeDoesNotScroll(cdp) {
  const before = await snapshot(cdp);
  const prime = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").primeAnchorOrder()`, { timeoutMs: 12000 });
  await wait(250);
  const after = await snapshot(cdp);
  const delta = after.scrollTop - before.scrollTop;
  if (Math.abs(delta) > 2) {
    throw new Error(`primeAnchorOrder moved scroll by ${delta}: before=${JSON.stringify(before)} after=${JSON.stringify(after)} prime=${JSON.stringify(prime)}`);
  }
  result.checks.push({ name: "prime-does-not-scroll", ok: true, scrollDelta: delta, source: prime?.source || null, count: prime?.count || 0 });
}

async function assertVisibleMarkerOrder(cdp, name) {
  const visible = await cdp.eval(`
    (() => {
      const topInset = (() => {
        const blockers = [...document.querySelectorAll("body *")]
          .map((el) => {
            if (!(el instanceof HTMLElement)) return null;
            const style = getComputedStyle(el);
            if (!/(fixed|sticky)/.test(style.position)) return null;
            const rect = el.getBoundingClientRect();
            if (rect.width < innerWidth * 0.25 || rect.height < 20 || rect.height > 140) return null;
            if (rect.top > 4 || rect.bottom < 24) return null;
            if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
            return rect.bottom;
          })
          .filter((bottom) => Number.isFinite(bottom));
        return Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(140, innerHeight * 0.2));
      })();
      return [...document.querySelectorAll(".codex-vim-nav-annotation")]
        .map((marker) => {
          const rect = marker.getBoundingClientRect();
          return {
            glyph: Number(marker.textContent.trim()),
            text: marker.textContent.trim(),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            anchorId: marker.dataset.anchorId || null
          };
        })
        .filter((item) => Number.isFinite(item.glyph) && item.bottom > topInset && item.top < innerHeight)
        .sort((a, b) => a.top - b.top);
    })()
  `);
  for (let i = 1; i < visible.length; i += 1) {
    if (visible[i].glyph <= visible[i - 1].glyph) {
      throw new Error(`${name} marker order is not top-to-bottom: ${JSON.stringify(visible)}`);
    }
  }
  result.checks.push({ name, ok: true, visible: visible.map((item) => item.glyph) });
}

function assertIncreasingNumbers(numbers, label) {
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] <= numbers[i - 1]) {
      throw new Error(`${label} is not monotonic: ${JSON.stringify(numbers)}`);
    }
  }
}

function previousMountedOrder(orders, current) {
  const sorted = [...new Set(orders)]
    .filter((order) => Number.isSafeInteger(order))
    .sort((a, b) => a - b);
  return [...sorted].reverse().find((order) => order < current) || current;
}

function nextMountedOrder(orders, current) {
  const sorted = [...new Set(orders)]
    .filter((order) => Number.isSafeInteger(order))
    .sort((a, b) => a - b);
  return sorted.find((order) => order > current) || current;
}

async function assertMountedGapNumberGStabilizes(cdp) {
  const gap = await cdp.eval(`
    (() => {
      const snapshot = window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot();
      const topInset = (() => {
        const blockers = [...document.querySelectorAll("body *")]
          .map((el) => {
            if (!(el instanceof HTMLElement)) return null;
            const style = getComputedStyle(el);
            if (!/(fixed|sticky)/.test(style.position)) return null;
            const rect = el.getBoundingClientRect();
            if (rect.width < innerWidth * 0.25 || rect.height < 20 || rect.height > 140) return null;
            if (rect.top > 4 || rect.bottom < 24) return null;
            if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
            return rect.bottom;
          })
          .filter((bottom) => Number.isFinite(bottom));
        return Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(140, innerHeight * 0.2));
      })();
      const visibleOrders = new Set([...document.querySelectorAll(".codex-vim-nav-annotation")]
        .map((marker) => {
          const rect = marker.getBoundingClientRect();
          return { order: Number(marker.textContent.trim()), top: rect.top, bottom: rect.bottom };
        })
        .filter((item) => Number.isFinite(item.order) && item.bottom >= topInset && item.top <= innerHeight)
        .map((item) => item.order));
      const orders = [...new Set((snapshot.anchors || []).map((anchor) => anchor.order))]
        .filter((order) => Number.isSafeInteger(order))
        .sort((a, b) => a - b);
      for (let i = 1; i < orders.length; i += 1) {
        const floor = orders[i - 1];
        const ceiling = orders[i];
        if (ceiling > floor + 1 && visibleOrders.has(floor)) {
          return { requested: floor + 1, expected: floor, mounted: orders, visible: [...visibleOrders].sort((a, b) => a - b) };
        }
      }
      return null;
    })()
  `);
  if (!gap) {
    result.checks.push({ name: "mounted-gap-number-G-stabilizes", ok: true, skipped: true });
    return;
  }

  const before = await snapshot(cdp);
  await pressDigits(cdp, String(gap.requested));
  await press(cdp, "G", "KeyG", 71, 8);
  await wait(600);
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push(await snapshot(cdp));
    await wait(150);
  }
  const after = samples[samples.length - 1];
  const scrollDelta = after.scrollTop - before.scrollTop;
  const maxScrollDelta = Math.max(...samples.map((sample) => Math.abs(sample.scrollTop - before.scrollTop)));
  if (after.order !== gap.expected) {
    throw new Error(`number+G mounted gap should select floor ${gap.expected}: gap=${JSON.stringify(gap)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} samples=${JSON.stringify(samples)}`);
  }
  if (Math.abs(scrollDelta) > 2 || maxScrollDelta > 2) {
    throw new Error(`number+G mounted gap should not scroll: gap=${JSON.stringify(gap)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} maxScrollDelta=${maxScrollDelta} samples=${JSON.stringify(samples)}`);
  }
  result.checks.push({
    name: "mounted-gap-number-G-stabilizes",
    ok: true,
    requested: gap.requested,
    expected: gap.expected,
    order: after.order,
    scrollDelta,
    maxScrollDelta
  });
}

async function toggleVim(cdp) {
  await key(cdp, "keyDown", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91, modifiers: 4 });
  await key(cdp, "keyDown", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 5 });
  await key(cdp, "keyUp", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 4 });
  await key(cdp, "keyUp", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91, modifiers: 0 });
}

async function pressDigits(cdp, digits) {
  for (const digit of digits) {
    const keyCode = digit.charCodeAt(0);
    await key(cdp, "keyDown", { key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await key(cdp, "keyUp", { key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
}

async function press(cdp, keyName, code, keyCode, modifiers = 0) {
  await key(cdp, "rawKeyDown", { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await key(cdp, "keyUp", { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

async function modeBadgeBuffer(cdp) {
  return cdp.eval(`
    document.querySelector("#codex-vim-nav-mode-badge code")?.textContent || ""
  `);
}

async function key(cdp, type, params) {
  await cdp.call("Input.dispatchKeyEvent", { type, ...params }, { timeoutMs: 5000 });
}

async function mouseClick(cdp, x, y) {
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { timeoutMs: 5000 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, { timeoutMs: 5000 });
}

async function submitComposerPrompt(cdp, text) {
  const composer = await cdp.eval(`
    (() => {
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const composer = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox'],.ProseMirror")]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter((item) =>
          item.rect.width > 240 &&
          item.rect.height > 18 &&
          item.rect.top > 80 &&
          item.rect.bottom < window.innerHeight &&
          item.rect.right > window.innerWidth * 0.35 &&
          (item.el.isContentEditable || /^(TEXTAREA|INPUT)$/.test(item.el.tagName) || item.el.getAttribute("role") === "textbox")
        )
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]?.el;
      if (!composer) return { ok: false, error: "composer not found" };
      return { ok: true, composerRect: rectOf(composer) };
    })()
  `, { timeoutMs: 15000 });
  if (!composer?.ok) throw new Error(`could not find composer: ${JSON.stringify(composer)}`);

  const point = rectCenter(composer.composerRect);
  await mouseClick(cdp, point.x, point.y);
  await keyChord(cdp, "a", "KeyA", 4);
  await keyPress(cdp, "Backspace", "Backspace", 8);
  await cdp.call("Input.insertText", { text }, { timeoutMs: 10000 });
  await wait(350);

  const result = await cdp.eval(`
    (() => {
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const composer = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox'],.ProseMirror")]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter((item) =>
          item.rect.width > 240 &&
          item.rect.height > 18 &&
          item.rect.top > 80 &&
          item.rect.bottom < window.innerHeight &&
          item.rect.right > window.innerWidth * 0.35 &&
          (item.el.isContentEditable || /^(TEXTAREA|INPUT)$/.test(item.el.tagName) || item.el.getAttribute("role") === "textbox")
        )
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]?.el;
      if (!composer) return { ok: false, error: "composer not found after input" };
      const composerRect = composer.getBoundingClientRect();
      const button = [...document.querySelectorAll("button")]
        .map((el) => {
          const isHostUi = Boolean(el.closest("[id^='codex-vim-nav'],[id^='clankerbend-'],.clankerbend-host-ui"));
          const label = [el.getAttribute("aria-label") || "", el.getAttribute("title") || "", el.innerText || el.textContent || ""].join(" ");
          const rect = el.getBoundingClientRect();
          const nearComposer = rect.top >= composerRect.top - 40 && rect.bottom <= composerRect.bottom + 60 && rect.left >= composerRect.left;
          const composerSized = rect.width >= 24 && rect.width <= 72 && rect.height >= 24 && rect.height <= 72;
          const rightSide = rect.left > composerRect.right - 120;
          const score = (isHostUi ? -100 : 0) +
            (/send|submit|arrow/i.test(label) ? 10 : 0) +
            (nearComposer ? 8 : 0) +
            (composerSized ? 5 : -20) +
            (rightSide ? 4 : 0) +
            (!el.disabled ? 4 : -40);
          return { el, label, rect, score };
        })
        .filter((item) => item.score >= 16 && item.rect.width > 0 && item.rect.height > 0)
        .sort((a, b) => b.score - a.score || b.rect.left - a.rect.left)[0];
      const textValue = "value" in composer ? String(composer.value || "") : String(composer.innerText || composer.textContent || "");
      if (!button) return { ok: false, error: "submit button not found", textValue, composerRect: rectOf(composer) };
      return {
        ok: true,
        mode: "real-input-real-send-click",
        textValue,
        buttonLabel: button.label || null,
        buttonRect: rectOf(button.el)
      };
    })()
  `, { timeoutMs: 15000 });
  if (!result?.ok) throw new Error(`could not submit composer prompt: ${JSON.stringify(result)}`);
  const buttonPoint = rectCenter(result.buttonRect);
  await mouseClick(cdp, buttonPoint.x, buttonPoint.y);
  return result;
}

async function keyChord(cdp, keyName, code, modifiers) {
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Meta", code: "MetaLeft", modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
}

async function keyPress(cdp, keyName, code, windowsVirtualKeyCode) {
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
}

function rectCenter(rect) {
  if (!rect) throw new Error("cannot click missing rect");
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

async function transcriptUnitsContaining(cdp, needle) {
  return cdp.eval(`
    (() => {
      const needle = ${JSON.stringify(needle)};
      const selector = [
        "[data-content-search-unit-key]",
        "[data-turn-key]",
        "[data-content-search-turn-key]",
        "[data-thread-user-message-navigation-item-id]"
      ].join(",");
      return [...document.querySelectorAll(selector)]
        .map((el, index) => ({
          key: el.getAttribute("data-content-search-unit-key") ||
            el.getAttribute("data-turn-key") ||
            el.getAttribute("data-content-search-turn-key") ||
            el.getAttribute("data-thread-user-message-navigation-item-id") ||
            "unit-" + index,
          text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim()
        }))
        .filter((unit) => unit.text.includes(needle))
        .map((unit) => ({ ...unit, text: unit.text.slice(0, 600) }));
    })()
  `, { timeoutMs: 15000 });
}

async function waitForNewAssistantUnitContaining(cdp, needle, beforeKeys) {
  const deadline = Date.now() + 150000;
  let last = null;
  while (Date.now() < deadline) {
    const units = await transcriptUnitsContaining(cdp, needle);
    last = units;
    const fresh = units.find((unit) =>
      !beforeKeys.has(unit.key) &&
      !unit.text.includes("Reply with exactly:") &&
      !/\\bThinking\\b/i.test(unit.text)
    );
    if (fresh) return fresh;
    await wait(1000);
  }
  throw new Error(`Codex answer did not include VimNav seed text: ${JSON.stringify(last)}`);
}

async function waitForPanelOpen(cdp) {
  const deadline = Date.now() + 15000;
  let last = [];
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      [...document.querySelectorAll("webview, iframe")]
        .map((el) => String(el.getAttribute("src") || ""))
        .filter(Boolean)
    `);
    const match = last.find((src) => /apps\/onewill\.vim-nav\/?/.test(src));
    if (match) return match;
    await wait(250);
  }
  const diagnostic = await cdp.eval(`
    ({
      app: window.__clankerbendRuntime?.getApp?.("onewill.vim-nav") || null,
      panel: window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.snapshot?.().panel || null
    })
  `);
  throw new Error(`marker click did not open VimNav panel; webview/iframe srcs: ${JSON.stringify(last)} diagnostic=${JSON.stringify(diagnostic)}`);
}

async function waitForSnapshot(cdp, label, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshot(cdp);
    if (predicate(last)) return last;
    await wait(100);
  }
  throw new Error(`${label} timed out; last snapshot: ${JSON.stringify(last)}`);
}

async function waitForMarkerGlyphs(cdp, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let glyphs = [];
  while (Date.now() < deadline) {
    glyphs = await cdp.eval(`
      (() => {
        window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.snapshot?.();
        return [...document.querySelectorAll(".codex-vim-nav-annotation")]
          .map((node) => node.textContent.trim())
          .filter(Boolean);
      })()
    `);
    if (glyphs.length) return glyphs;
    await wait(100);
  }
  throw new Error(`${label} did not appear; last glyphs: ${JSON.stringify(glyphs)}`);
}

async function waitForTopMarkerGlyph(cdp, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let glyph = null;
  while (Date.now() < deadline) {
    glyph = await cdp.eval(`
      (() => {
        window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.snapshot?.();
        const markers = [...document.querySelectorAll(".codex-vim-nav-annotation")]
          .map((marker) => ({ text: marker.textContent.trim(), top: marker.getBoundingClientRect().top }))
          .filter((item) => item.top >= 0)
          .sort((a, b) => a.top - b.top);
        return markers[0]?.text || null;
      })()
    `);
    if (glyph) return glyph;
    await wait(120);
  }
  throw new Error(`${label} did not appear; last glyph ${JSON.stringify(glyph)}`);
}

async function clickFirstVimMarker(cdp, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.snapshot?.();
        const marker = document.querySelector(".codex-vim-nav-annotation");
        if (!marker) {
          return {
            clicked: false,
            markerCount: document.querySelectorAll(".codex-vim-nav-annotation").length,
            selected: window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.snapshot?.().selection || null
          };
        }
        const anchorId = marker.dataset.anchorId;
        marker.click();
        return { clicked: true, anchorId };
      })()
    `);
    if (last?.clicked && last.anchorId) return last.anchorId;
    await wait(120);
  }
  throw new Error(`No Vim marker available to click: ${JSON.stringify(last)}`);
}

async function waitForAppServerOrder(cdp) {
  const deadline = Date.now() + 30000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot()`);
    if (last?.transcriptOrderSource === "app-server") {
      result.checks.push({ name: "app-server-transcript-order", ok: true, anchors: last.anchors?.length || 0 });
      return last;
    }
    await wait(250);
  }
  throw new Error(`app-server transcript order did not become active; last=${JSON.stringify({
    source: last?.transcriptOrderSource || null,
    anchors: last?.anchors?.length || 0
  })}`);
}

async function snapshot(cdp) {
  return cdp.eval(`
    (() => {
      const snapshot = window.__clankerbendRuntime.getBridge("onewill.vim-nav").snapshot();
      const id = snapshot.selection?.anchorId || null;
      const selected = snapshot.anchors.find((anchor) => anchor.anchorId === id) || null;
      const marker = id
        ? document.querySelector(".codex-vim-nav-annotation[data-anchor-id='" + CSS.escape(id) + "']")
        : null;
      const scrollable = (el) => {
        if (!el) return false;
        if (el === document.scrollingElement || el === document.documentElement || el === document.body) return true;
        const style = getComputedStyle(el);
        return /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 8;
      };
      let root = marker?.parentElement || document.querySelector(".codex-vim-nav-annotation")?.parentElement || null;
      while (root && !scrollable(root)) root = root.parentElement;
      root ||= document.scrollingElement || document.documentElement;
      const rootRect = root.getBoundingClientRect();
      const markerRect = marker?.getBoundingClientRect();
      return {
        vim: snapshot.vimMode,
        order: selected?.order || null,
        top: markerRect ? Math.round(markerRect.top - rootRect.top) : null,
        viewportTop: markerRect ? Math.round(markerRect.top) : null,
        viewportBottom: markerRect ? Math.round(markerRect.bottom) : null,
        visibleTopInset: (() => {
          const blockers = [...document.querySelectorAll("body *")]
            .map((el) => {
              if (!(el instanceof HTMLElement)) return null;
              const style = getComputedStyle(el);
              if (!/(fixed|sticky)/.test(style.position)) return null;
              const rect = el.getBoundingClientRect();
              if (rect.width < innerWidth * 0.25 || rect.height < 20 || rect.height > 140) return null;
              if (rect.top > 4 || rect.bottom < 24) return null;
              if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
              return rect.bottom;
            })
            .filter((bottom) => Number.isFinite(bottom));
          return Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(140, innerHeight * 0.2));
        })(),
        visibleBottom: (() => {
          const blockers = [...document.querySelectorAll("body *")]
            .map((el) => {
              if (!(el instanceof HTMLElement)) return null;
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (rect.width < innerWidth * 0.25 || rect.height < 24 || rect.height > innerHeight * 0.45) return null;
              if (rect.bottom < innerHeight - 6 || rect.top > innerHeight - 24) return null;
              if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
              const isAnchored = /(fixed|sticky)/.test(style.position);
              const isComposer = Boolean(el.matches("form, textarea, input, [contenteditable='true'], [role='textbox']") ||
                el.querySelector?.("textarea, input, [contenteditable='true'], [role='textbox']"));
              if (!isAnchored && !isComposer) return null;
              return innerHeight - rect.top;
            })
            .filter((height) => Number.isFinite(height));
          const inset = Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(320, innerHeight * 0.45));
          return innerHeight - inset;
        })(),
        scrollTop: Math.round(root === document.scrollingElement ? scrollY : root.scrollTop),
        preview: selected?.textPreview?.slice(0, 80) || null,
        markerViewportTop: markerRect ? Math.round(markerRect.top) : null,
        markerViewportBottom: markerRect ? Math.round(markerRect.bottom) : null,
        anchorViewportTop: (() => {
          const anchor = id ? document.querySelector("[data-content-search-unit-key='" + CSS.escape(id) + "']") : null;
          return anchor ? Math.round(anchor.getBoundingClientRect().top) : null;
        })(),
        anchorViewportBottom: (() => {
          const anchor = id ? document.querySelector("[data-content-search-unit-key='" + CSS.escape(id) + "']") : null;
          return anchor ? Math.round(anchor.getBoundingClientRect().bottom) : null;
        })(),
        mountedOrders: snapshot.anchors.map((anchor) => anchor.order),
        debug: snapshot.debug || null
      };
    })()
  `);
}

function isTopAligned(snap) {
  return snap.order !== null &&
    typeof snap.viewportTop === "number" &&
    snap.viewportTop >= (snap.visibleTopInset || 0) - 8 &&
    snap.viewportTop <= (snap.visibleTopInset || 0) + 110;
}

function assertFastRelativePath(snap, label) {
  const path = snap?.debug?.lastRelativeDebug?.path || null;
  if (path !== "fast") {
    throw new Error(`${label} should use fast relative navigation; lastRelativeDebug=${JSON.stringify(snap?.debug?.lastRelativeDebug || null)}`);
  }
}

function isViewportVisible(snap) {
  return snap.order !== null &&
    typeof snap.viewportTop === "number" &&
    snap.viewportTop < (snap.visibleBottom ?? 900) &&
    snap.viewportBottom > (snap.visibleTopInset ?? 0);
}

function isAnchorEndSafe(snap) {
  return snap.order !== null &&
    typeof snap.anchorViewportBottom === "number" &&
    snap.anchorViewportBottom <= (snap.visibleBottom ?? 900) + 12 &&
    snap.anchorViewportBottom >= (snap.visibleTopInset ?? 0);
}

function canAnchorFitSafeViewport(snap) {
  if (
    typeof snap.anchorViewportTop !== "number" ||
    typeof snap.anchorViewportBottom !== "number" ||
    typeof snap.visibleTopInset !== "number" ||
    typeof snap.visibleBottom !== "number"
  ) {
    return false;
  }
  const anchorHeight = snap.anchorViewportBottom - snap.anchorViewportTop;
  const safeHeight = snap.visibleBottom - snap.visibleTopInset;
  return anchorHeight > 0 && safeHeight > 0 && anchorHeight <= safeHeight - 16;
}

async function normalMountedBracketTarget(cdp, referenceOrder) {
  return cdp.eval(`
    (() => {
      const topInset = (() => {
        const blockers = [...document.querySelectorAll("body *")]
          .map((el) => {
            if (!(el instanceof HTMLElement)) return null;
            const style = getComputedStyle(el);
            if (!/(fixed|sticky)/.test(style.position)) return null;
            const rect = el.getBoundingClientRect();
            if (rect.width < innerWidth * 0.25 || rect.height < 20 || rect.height > 140) return null;
            if (rect.top > 4 || rect.bottom < 24) return null;
            if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
            return rect.bottom;
          })
          .filter((bottom) => Number.isFinite(bottom));
        return Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(140, innerHeight * 0.2));
      })();
      const visibleBottom = (() => {
        const blockers = [...document.querySelectorAll("body *")]
          .map((el) => {
            if (!(el instanceof HTMLElement)) return null;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (rect.width < innerWidth * 0.25 || rect.height < 24 || rect.height > innerHeight * 0.45) return null;
            if (rect.bottom < innerHeight - 6 || rect.top > innerHeight - 24) return null;
            if (rect.right < innerWidth * 0.25 || rect.left > innerWidth * 0.75) return null;
            const isAnchored = /(fixed|sticky)/.test(style.position);
            const isComposer = Boolean(el.matches("form, textarea, input, [contenteditable='true'], [role='textbox']") ||
              el.querySelector?.("textarea, input, [contenteditable='true'], [role='textbox']"));
            if (!isAnchored && !isComposer) return null;
            return innerHeight - rect.top;
          })
          .filter((height) => Number.isFinite(height));
        const inset = Math.min(Math.max(blockers.length ? Math.max(...blockers) : 0, 0), Math.min(320, innerHeight * 0.45));
        return innerHeight - inset;
      })();
      const safeHeight = visibleBottom - topInset;
      const candidates = [...document.querySelectorAll(".codex-vim-nav-annotation")]
        .map((marker) => {
          const order = Number((marker.textContent || "").trim());
          const anchorId = marker.dataset.anchorId;
          const anchor = anchorId
            ? document.querySelector("[data-content-search-unit-key='" + CSS.escape(anchorId) + "']")
            : null;
          const rect = anchor?.getBoundingClientRect?.();
          return rect && Number.isFinite(order)
            ? { order, anchorId, height: rect.height, top: rect.top, bottom: rect.bottom }
            : null;
        })
        .filter(Boolean)
        .filter((item) => item.height > 0 && item.height <= safeHeight - 16)
        .sort((a, b) => Math.abs(a.order - ${JSON.stringify(referenceOrder)}) - Math.abs(b.order - ${JSON.stringify(referenceOrder)}));
      return candidates[0] || null;
    })()
  `);
}

function transcriptUnitCountExpression() {
  return `
    document.querySelectorAll([
      "[data-content-search-unit-key]",
      "[data-turn-key]",
      "[data-content-search-turn-key]",
      "[data-thread-user-message-navigation-item-id]"
    ].join(",")).length
  `;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const client = new CdpClient(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
    });
    ws.addEventListener("message", (event) => client.handleMessage(event));
    return client;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
  }

  call(method, params = {}, options = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, options.timeoutMs || 10000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async eval(expression, options = {}) {
    const output = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, { timeoutMs: options.timeoutMs || 10000 });
    if (output.exceptionDetails) {
      throw new Error(output.exceptionDetails.exception?.description || output.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return output.result?.value;
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    const slot = this.pending.get(message.id);
    if (!slot) return;
    this.pending.delete(message.id);
    if (message.error) slot.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else slot.resolve(message.result);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

await main();
