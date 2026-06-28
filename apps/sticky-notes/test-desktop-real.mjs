import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchClankerBendCodex } from "../../server.mjs";
import { STICKY_NOTES_APP_ID } from "./src/sticky-notes-app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(__dirname, "run/desktop-real-validation");
const RESULT_PATH = join(RUN_DIR, "sticky-result.json");
const TEST_RUN_ID = `CLANKERBEND_STICKY_DESKTOP_E2E_${Date.now()}`;

const result = {
  ok: false,
  mode: "real-codex-desktop-sticky-notes",
  chatTitle: `new chat ${TEST_RUN_ID}`,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: []
};

let host = null;

async function main() {
try {
  await rm(RUN_DIR, { recursive: true, force: true });
  await mkdir(RUN_DIR, { recursive: true });
  ({ host } = await launchClankerBendCodex({
    installSignalHandlers: false,
    runDir: RUN_DIR
  }));

  const cdpPort = host.state.desktop.cdpPort;
  if (!cdpPort) throw new Error("ClankerBend did not expose a Codex Desktop CDP port");
  result.checks.push({ name: "launch", ok: true, cdpPort, hostUrl: host.state.host.url });

  const page = await waitForPage(cdpPort);
  result.checks.push({ name: "renderer-target", ok: true, url: page.url });
  const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
  try {
    await cdp.call("Runtime.enable");
    await openNewChat(cdp);
    const units = await cdp.eval(transcriptUnitCountExpression());
    if (units !== 0) throw new Error(`fresh chat should start empty for ${JSON.stringify(TEST_RUN_ID)}; units=${units}`);
    result.checks.push({ name: "open-transcript", ok: true, units });

    const bridgeVersion = await cdp.eval(`window.__clankerbendRuntime?.getBridge?.("onewill.vim-nav")?.version || 0`);
    if (bridgeVersion < 110) throw new Error(`renderer bridge version is stale: ${bridgeVersion}`);
    result.checks.push({ name: "bridge-version", ok: true, bridgeVersion });

    const setupSelectionText = `Sticky selection target ${Date.now()}`;
    const beforeSetupUnits = await transcriptUnitsContaining(cdp, setupSelectionText);
    const beforeSetupKeys = new Set(beforeSetupUnits.map((unit) => unit.key));
    const setupSubmitted = await submitComposerPrompt(cdp, `Reply with exactly: ${setupSelectionText}`);
    const setupUnit = await waitForNewAssistantUnitContaining(cdp, setupSelectionText, beforeSetupKeys);
    result.checks.push({ name: "setup-clean-selection-text", ok: true, submitted: setupSubmitted, unit: setupUnit });
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").scrollToAnchor(${JSON.stringify(setupUnit.key)}, { block: "center", behavior: "auto" })`);
    await wait(500);

    const target = await cdp.eval(transcriptTextDragTargetExpression(setupSelectionText, setupUnit.key));
    if (!target?.ok) throw new Error(`could not find transcript text to select: ${JSON.stringify(target)}`);
    result.checks.push({ name: "selection-target", ok: true, text: target.text, start: target.start, end: target.end, anchorId: target.anchorId });
    await dragSelect(cdp, target.start, target.end);
    let selection = await waitForBrowserSelection(cdp);
    if (!selection?.ok || !selectionMatchesTarget(selection.text, target.text)) {
      const fallbackSelection = await cdp.eval(`window.__clankerbendStickyDesktopSelectTarget?.() || { ok: false, error: "selection fallback missing" }`);
      if (!fallbackSelection?.ok) throw new Error(`could not create transcript selection: ${JSON.stringify({ drag: selection, fallback: fallbackSelection })}`);
      selection = fallbackSelection;
      await wait(300);
    }
    if (!selection?.ok) throw new Error(`could not create transcript selection: ${JSON.stringify(selection)}`);
    result.checks.push({ name: "create-selection", ok: true, text: selection.text, anchorId: target.anchorId });

    const bridgedSelection = await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").__testUpdateTextSelectionFromDom()`);
    if (!bridgedSelection) throw new Error("renderer bridge did not accept the browser text selection");
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").applyHostState(${JSON.stringify(host.publicState())})`);
    const injected = await waitForNativeAddNote(cdp);
    if (!injected?.ok) throw new Error(`Add note was not injected into native toolbar: ${JSON.stringify(injected)}`);
    result.checks.push({ name: "native-toolbar", ok: true, text: injected.toolbarText, rect: injected.toolbarRect });
    result.checks.push({ name: "native-add-note-injected", ok: true, toolbarText: injected.toolbarText, buttonRect: injected.buttonRect, toolbarRect: injected.toolbarRect });

    await mouseClick(cdp, rectCenter(injected.buttonRect));
    const overlay = await waitForStickyOverlay(cdp);
    result.checks.push({ name: "native-add-note-opens-overlay", ok: true, rect: overlay.rect, buttons: overlay.buttons });
    const stableOverlay = await waitForOverlayStable(cdp, overlay.rect);
    result.checks.push({ name: "note-overlay-stays-pinned", ok: true, rect: stableOverlay.rect, delta: stableOverlay.delta });
    await mouseClick(cdp, rectCenter(overlay.cancelRect));
    const cancelClosed = await waitForStickyOverlayClosed(cdp);
    result.checks.push({ name: "note-overlay-cancel-closes", ok: true, visible: cancelClosed.visible });

    await dragSelect(cdp, target.start, target.end);
    selection = await waitForBrowserSelection(cdp);
    if (!selection?.ok || !selectionMatchesTarget(selection.text, target.text)) {
      const fallbackSelection = await cdp.eval(`window.__clankerbendStickyDesktopSelectTarget?.() || { ok: false, error: "selection fallback missing" }`);
      if (!fallbackSelection?.ok) throw new Error(`could not recreate transcript selection after cancel: ${JSON.stringify({ drag: selection, fallback: fallbackSelection })}`);
      selection = fallbackSelection;
      await wait(300);
    }
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").__testUpdateTextSelectionFromDom()`);
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").applyHostState(${JSON.stringify(host.publicState())})`);
    const reinjected = await waitForNativeAddNote(cdp);
    if (!reinjected?.ok) throw new Error(`Add note was not reinjected after cancel: ${JSON.stringify(reinjected)}`);
    await mouseClick(cdp, rectCenter(reinjected.buttonRect));
    const reopenedOverlay = await waitForStickyOverlay(cdp);
    result.checks.push({ name: "native-add-note-reopens-overlay", ok: true, rect: reopenedOverlay.rect, buttons: reopenedOverlay.buttons });

    const noteText = `CLANKERBEND_STICKY_E2E_${Date.now()}`;
    const saveResult = await cdp.eval(`
      (() => {
        const overlay = document.getElementById("clankerbend-anchored-overlay");
        const textarea = overlay?.querySelector("textarea");
        const save = [...(overlay?.querySelectorAll("button") || [])]
          .find((button) => /^Save$/i.test((button.innerText || button.textContent || "").trim()));
        const cancel = [...(overlay?.querySelectorAll("button") || [])]
          .find((button) => /^Cancel$/i.test((button.innerText || button.textContent || "").trim()));
        if (!textarea || !save || !cancel) {
          return { ok: false, hasTextarea: Boolean(textarea), hasSave: Boolean(save), hasCancel: Boolean(cancel) };
        }
        textarea.focus();
        textarea.value = ${JSON.stringify(noteText)};
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(noteText)} }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        save.click();
        return { ok: true };
      })()
    `);
    if (!saveResult?.ok) throw new Error(`sticky note save failed: ${JSON.stringify(saveResult)}`);
    const saved = await waitForSavedNoteFile(host, noteText);
    const filename = saved.file.path.split(/[\\/]/).pop();
    const expectedFilenameSlug = noteFilenameSlug(noteText);
    if (!filename.includes(expectedFilenameSlug)) {
      throw new Error(`saved note filename did not include note body slug ${JSON.stringify(expectedFilenameSlug)}: ${filename}`);
    }
    const attachment = await waitForAttachedNoteFile(host, saved.file.path);
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").applyHostState(${JSON.stringify(host.publicState())})`);
    const visibleAttachment = await waitForVisibleComposerAttachment(cdp, saved.file.path);
    await cdp.eval(`window.__clankerbendRuntime.getBridge("onewill.vim-nav").applyHostState(${JSON.stringify(host.publicState())})`);
    await wait(250);
    const beforeAnswerUnits = await transcriptUnitsContaining(cdp, noteText);
    const beforeAnswerKeys = new Set(beforeAnswerUnits.map((unit) => unit.key));
    const promptText = "What is the current ClankerBend sticky note body? Reply with only the exact note body.";
    const submitted = await submitComposerPrompt(cdp, promptText);
    result.checks.push({ name: "submitted-followup-prompt", ok: true, submitted });
    const visibleAnswer = await waitForNewTranscriptUnitContaining(cdp, noteText, beforeAnswerKeys);
    result.checks.push({ name: "save-note-writes-runtime-file", ok: true, file: saved.file, bytes: saved.content.length });
    result.checks.push({ name: "save-note-uses-readable-filename", ok: true, filename, expectedFilenameSlug });
    result.checks.push({ name: "save-note-attaches-runtime-file", ok: true, attachment });
    result.checks.push({ name: "save-note-visible-as-native-composer-chip", ok: true, visibleAttachment });
    result.checks.push({ name: "save-note-does-not-render-clankerbend-composer-chips", ok: true, clankerbendChipCount: visibleAttachment.clankerbendChipCount });
    result.checks.push({ name: "current-prompt-sees-attached-note", ok: true, submitted, answer: visibleAnswer });
  } finally {
    cdp.close();
  }
  await finish(true);
} catch (err) {
  result.errors.push(err.stack || err.message);
  await finish(false);
}
}

async function finish(ok) {
  result.ok = ok;
  result.completedAt = new Date().toISOString();
  await host?.stop?.().catch(() => {});
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
}

async function waitForPage(cdpPort) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const page = targets.find((target) => target.type === "page" && target.url === "app://-/index.html") ||
        targets.find((target) => target.type === "page" && target.url?.startsWith("app://-")) ||
        targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await wait(250);
  }
  throw new Error("Codex renderer target did not become available");
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

function transcriptTextDragTargetExpression(preferredText = "", preferredAnchorId = "") {
  return `
    (() => {
      const preferredText = ${JSON.stringify(preferredText)};
      const preferredAnchorId = ${JSON.stringify(preferredAnchorId)};
      const selector = [
        "[data-content-search-unit-key]",
        "[data-turn-key]",
        "[data-content-search-turn-key]",
        "[data-thread-user-message-navigation-item-id]"
      ].join(",");
      const anchors = [...document.querySelectorAll(selector)]
        .filter((el) => (el.innerText || el.textContent || "").trim().length > (preferredText ? 8 : 40));
      const findTarget = (strict) => {
      for (const anchor of anchors) {
        const currentAnchorId = anchor.getAttribute("data-content-search-unit-key") || anchor.getAttribute("data-turn-key") || anchor.getAttribute("data-content-search-turn-key") || anchor.getAttribute("data-thread-user-message-navigation-item-id");
        if (preferredAnchorId && currentAnchorId !== preferredAnchorId) continue;
        if (preferredAnchorId) anchor.scrollIntoView({ block: "center", behavior: "auto" });
        const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
        let node = null;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest?.("a,button,[role='button']")) continue;
          const text = String(node.nodeValue || "").replace(/\\s+/g, " ");
          const trimmed = text.trim();
          if (trimmed.length < (preferredAnchorId ? 8 : 30) || /^Worked for\\b/i.test(trimmed)) continue;
          if (preferredText && !preferredAnchorId && !trimmed.includes(preferredText)) continue;
          if (/^(\\/|[A-Za-z]:\\\\)/.test(trimmed) || /\\/Users\\//.test(trimmed)) continue;
          if (strict && /(?:note_[a-z0-9_-]+\\.md|CLANKERBEND_STICKY|You highlighted|Attached file)/i.test(trimmed)) continue;
          if (node.parentElement?.closest?.("pre,code,[data-testid*='attachment'],[class*='attachment'],[class*='file']")) continue;
          const start = Math.max(0, node.nodeValue.indexOf(text.trim().split(/\\s+/)[0]));
          const end = Math.min(node.nodeValue.length, start + Math.min(42, trimmed.length));
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const rect = range.getClientRects()[0] || range.getBoundingClientRect();
          if (!rect || rect.width < 12 || rect.height < 8) continue;
          if (rect.top < 80 || rect.bottom > window.innerHeight - 140) continue;
          const y = rect.top + Math.min(rect.height - 2, Math.max(2, rect.height / 2));
          window.__clankerbendStickyDesktopSelectTarget = () => {
            const selection = window.getSelection();
            if (!selection) return { ok: false, error: "selection unavailable" };
            selection.removeAllRanges();
            const nextRange = document.createRange();
            nextRange.setStart(node, start);
            nextRange.setEnd(node, end);
            selection.addRange(nextRange);
            document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
            return { ok: true, text: String(selection.toString() || "").trim() };
          };
          return {
            ok: true,
            text: trimmed.slice(0, 42),
            start: { x: rect.left + 2, y },
            end: { x: Math.max(rect.left + 10, rect.right - 2), y },
            anchorId: currentAnchorId
          };
        }
      }
      return null;
      };
      const target = findTarget(true) || (preferredText ? null : findTarget(false));
      if (target) return target;
      return { ok: false, error: "text node not found" };
    })()
  `;
}

async function dragSelect(cdp, start, end) {
  await cdp.call("Page.bringToFront").catch(() => {});
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, pointerType: "mouse" });
  await wait(100);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  const steps = 14;
  for (let i = 1; i <= steps; i += 1) {
    const ratio = i / steps;
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
      button: "left",
      buttons: 1,
      pointerType: "mouse"
    });
    await wait(45);
  }
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  await wait(500);
}

async function mouseClick(cdp, point) {
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse" });
  await wait(80);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await wait(80);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
}

function rectCenter(rect) {
  if (!rect) throw new Error("cannot click missing rect");
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

async function waitForBrowserSelection(cdp) {
  const deadline = Date.now() + 4000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const text = String(window.getSelection()?.toString() || "").trim();
        return { ok: text.length > 0, text };
      })()
    `);
    if (last?.ok) return last;
    await wait(100);
  }
  return last;
}

function selectionMatchesTarget(selectionText, targetText) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const selection = normalize(selectionText);
  const target = normalize(targetText);
  return selection.length > 0 && target.length > 0 && (
    target.includes(selection) ||
    selection.includes(target.slice(0, Math.min(24, target.length)))
  );
}

function noteFilenameSlug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
}

async function waitForNativeAddNote(cdp) {
  const deadline = Date.now() + 4000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const toolbar = (${nativeToolbarExpression()});
        const toolbarEl = (${nativeToolbarElementExpression()});
        const markedButtons = [...document.querySelectorAll("[data-clankerbend-native-selection-action='true']")];
        const markedButton = markedButtons.find((el) => /\\bAdd note\\b/i.test((el.innerText || el.textContent || "").trim())) ||
          markedButtons.at(-1) ||
          null;
        const visibleButton = /\\bAdd note\\b/i.test((markedButton?.innerText || markedButton?.textContent || "").trim())
          ? markedButton
          : [...(toolbarEl?.querySelectorAll("button,[role='button']") || [])]
            .find((el) => /\\bAdd note\\b/i.test((el.innerText || el.textContent || "").trim()));
        const referenceButton = [...document.querySelectorAll("button,[role='button']")]
          .filter((el) => toolbarEl?.contains(el))
          .filter((el) => /\\bAdd to chat\\b/i.test(el.textContent || "") || /\\bAsk in side chat\\b/i.test(el.textContent || ""))
          .at(-1);
        const fallbackVisible = document.querySelector("#clankerbend-selection-menu.is-visible") != null;
        const toolbarRect = toolbarEl?.getBoundingClientRect();
        const buttonRect = visibleButton?.getBoundingClientRect();
        const buttonStyle = visibleButton ? getComputedStyle(visibleButton) : null;
        const referenceStyle = referenceButton ? getComputedStyle(referenceButton) : null;
        const typographyMatches = Boolean(buttonStyle && referenceStyle &&
          buttonStyle.fontFamily === referenceStyle.fontFamily &&
          buttonStyle.fontSize === referenceStyle.fontSize);
        const insideToolbar = Boolean(toolbarRect && buttonRect &&
          buttonRect.left >= toolbarRect.left - 1 &&
          buttonRect.right <= toolbarRect.right + 1 &&
          buttonRect.top >= toolbarRect.top - 1 &&
          buttonRect.bottom <= toolbarRect.bottom + 1);
        return {
          ok: Boolean(toolbar.ok && visibleButton && insideToolbar && typographyMatches && !fallbackVisible),
          toolbarText: toolbar.text || null,
          buttonText: visibleButton?.textContent || null,
          hasMarkedButton: Boolean(markedButton),
          markedButtons: markedButtons.map((el) => ({
            text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
            rect: (() => {
              const rect = el.getBoundingClientRect();
              return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
            })()
          })),
          fallbackVisible,
          insideToolbar,
          typographyMatches,
          buttonStyle: buttonStyle ? { fontFamily: buttonStyle.fontFamily, fontSize: buttonStyle.fontSize, lineHeight: buttonStyle.lineHeight, fontWeight: buttonStyle.fontWeight } : null,
          referenceStyle: referenceStyle ? { fontFamily: referenceStyle.fontFamily, fontSize: referenceStyle.fontSize, lineHeight: referenceStyle.lineHeight, fontWeight: referenceStyle.fontWeight } : null,
          toolbarRect: toolbarRect ? { left: toolbarRect.left, top: toolbarRect.top, right: toolbarRect.right, bottom: toolbarRect.bottom, width: toolbarRect.width, height: toolbarRect.height } : null,
          buttonRect: buttonRect ? { left: buttonRect.left, top: buttonRect.top, right: buttonRect.right, bottom: buttonRect.bottom, width: buttonRect.width, height: buttonRect.height } : null
        };
      })()
    `);
    if (last?.ok) return last;
    await wait(150);
  }
  return last;
}

async function waitForStickyOverlay(cdp) {
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const overlay = document.getElementById("clankerbend-anchored-overlay");
        const rect = overlay?.getBoundingClientRect();
        const textarea = overlay?.querySelector("textarea");
        const buttons = [...(overlay?.querySelectorAll("button") || [])]
          .map((button) => (button.innerText || button.textContent || "").trim());
        const save = [...(overlay?.querySelectorAll("button") || [])]
          .find((button) => /^Save$/i.test((button.innerText || button.textContent || "").trim()));
        const cancel = [...(overlay?.querySelectorAll("button") || [])]
          .find((button) => /^Cancel$/i.test((button.innerText || button.textContent || "").trim()));
        const cancelRect = cancel?.getBoundingClientRect();
        return {
          ok: Boolean(overlay?.classList.contains("is-visible") && textarea && save && cancel && rect.width > 120 && rect.height > 80 && rect.left > 24 && rect.top > 24),
          visible: Boolean(overlay?.classList.contains("is-visible")),
          hasTextarea: Boolean(textarea),
          hasSave: Boolean(save),
          hasCancel: Boolean(cancel),
          buttons,
          cancelRect: cancelRect ? { left: cancelRect.left, top: cancelRect.top, right: cancelRect.right, bottom: cancelRect.bottom, width: cancelRect.width, height: cancelRect.height } : null,
          rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null
        };
      })()
    `);
    if (last?.ok) return last;
    await wait(150);
  }
  throw new Error(`sticky overlay did not open correctly: ${JSON.stringify(last)}`);
}

async function waitForStickyOverlayClosed(cdp) {
  const deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const overlay = document.getElementById("clankerbend-anchored-overlay");
        return {
          visible: Boolean(overlay?.classList.contains("is-visible")),
          buttonText: [...(overlay?.querySelectorAll("button") || [])].map((button) => (button.innerText || button.textContent || "").trim())
        };
      })()
    `);
    if (!last?.visible) return last;
    await wait(150);
  }
  throw new Error(`sticky overlay did not close after cancel: ${JSON.stringify(last)}`);
}

async function waitForOverlayStable(cdp, initialRect) {
  await wait(1200);
  const current = await cdp.eval(`
    (() => {
      const overlay = document.getElementById("clankerbend-anchored-overlay");
      const rect = overlay?.getBoundingClientRect();
      return {
        visible: Boolean(overlay?.classList.contains("is-visible")),
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null
      };
    })()
  `);
  const delta = current?.rect ? {
    left: Math.abs(current.rect.left - initialRect.left),
    top: Math.abs(current.rect.top - initialRect.top)
  } : null;
  if (!current?.visible || !current.rect || delta.left > 2 || delta.top > 2) {
    throw new Error(`sticky overlay moved after opening: ${JSON.stringify({ initialRect, current, delta })}`);
  }
  return { rect: current.rect, delta };
}

async function waitForSavedNoteFile(host, noteText) {
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    const state = host.appState(STICKY_NOTES_APP_ID);
    const entry = state.entries?.find((candidate) => candidate.detail?.file?.path);
    if (entry?.detail?.file?.path) {
      try {
        const content = await readFile(entry.detail.file.path, "utf8");
        last = { file: entry.detail.file, content };
        if (content.includes(noteText) && content.includes("## Highlighted text") && content.includes("## User notes")) {
          if (/Note ID:|## Range/.test(content)) throw new Error(`saved note contains legacy metadata: ${content}`);
          return last;
        }
      } catch (err) {
        last = { file: entry.detail.file, error: err.message };
      }
    }
    await wait(150);
  }
  throw new Error(`saved note file did not appear: ${JSON.stringify(last)}`);
}

async function waitForAttachedNoteFile(host, filePath) {
  const deadline = Date.now() + 30000;
  let last = null;
  while (Date.now() < deadline) {
    const state = host.publicState();
    const appEntry = state.apps
      ?.find((app) => app.appId === STICKY_NOTES_APP_ID)
      ?.entries?.find((entry) => entry.detail?.file?.path === filePath);
    last = {
      appAttachment: appEntry?.detail?.attachment || null,
      attachmentCount: state.composer?.attachments?.length || 0
    };
    if (appEntry?.detail?.attachment?.ok) return last;
    await wait(150);
  }
  throw new Error(`saved note file was not attached to composer: ${JSON.stringify(last)}`);
}

async function waitForVisibleComposerAttachment(cdp, filePath) {
  const basename = filePath.split(/[\\/]/).pop();
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(`
      (() => {
        const basename = ${JSON.stringify(basename)};
        const rectOf = (el) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const clankerbendChips = [...document.querySelectorAll("#clankerbend-composer-chips .clankerbend-context-chip")];
        const composer = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox'],.ProseMirror")]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter((item) => item.rect.width > 180 && item.rect.height > 18 && item.rect.bottom > window.innerHeight * 0.45)
          .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
        const composerRect = composer?.rect || null;
        const matches = [...document.querySelectorAll("button,[role='button'],span,div")]
          .filter((el) => !el.closest("#clankerbend-composer-chips"))
          .map((el) => ({ el, text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(), rect: el.getBoundingClientRect() }))
          .filter((item) =>
            item.text.includes(basename) &&
            item.rect.width > 20 &&
            item.rect.width < 420 &&
            item.rect.height > 8 &&
            item.rect.height < 80 &&
            (!composerRect || (
              item.rect.bottom >= composerRect.top - 120 &&
              item.rect.top <= composerRect.bottom + 80 &&
              item.rect.right >= composerRect.left - 40 &&
              item.rect.left <= composerRect.right + 40
            ))
          )
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
        const item = matches[0];
        return item && clankerbendChips.length === 0
          ? { ok: true, basename, text: item.text.slice(0, 180), rect: rectOf(item.el), clankerbendChipCount: clankerbendChips.length }
          : {
              ok: false,
              basename,
              clankerbendChipCount: clankerbendChips.length,
              nativeChipCandidates: matches.slice(0, 8).map((match) => ({ text: match.text.slice(0, 180), rect: rectOf(match.el) })),
              clankerbendChipTexts: clankerbendChips.map((chip) => (chip.innerText || chip.textContent || "").trim())
            };
      })()
    `);
    if (last?.ok) return last;
    await wait(150);
  }
  throw new Error(`saved note file is not visible in current composer: ${JSON.stringify(last)}`);
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

  await mouseClick(cdp, rectCenter(composer.composerRect));
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
  await mouseClick(cdp, rectCenter(result.buttonRect));
  return result;
}

async function keyChord(cdp, key, code, modifiers) {
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Meta", code: "MetaLeft", modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
}

async function keyPress(cdp, key, code, windowsVirtualKeyCode) {
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
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

async function waitForNewTranscriptUnitContaining(cdp, needle, beforeKeys) {
  const deadline = Date.now() + 150000;
  let last = null;
  while (Date.now() < deadline) {
    const units = await transcriptUnitsContaining(cdp, needle);
    last = units;
    const fresh = units.find((unit) => !beforeKeys.has(unit.key));
    if (fresh) return fresh;
    await wait(1000);
  }
  throw new Error(`Codex answer did not include attached sticky note text: ${JSON.stringify(last)}`);
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
      !/\bThinking\b/i.test(unit.text)
    );
    if (fresh) return fresh;
    await wait(1000);
  }
  throw new Error(`Codex setup answer did not include clean selection text: ${JSON.stringify(last)}`);
}

function nativeToolbarExpression() {
  return `
    (() => {
      const candidates = [...document.querySelectorAll("div,section,nav,menu,[role='toolbar'],[role='menu']")]
        .filter((el) => !el.closest("#clankerbend-selection-menu,#clankerbend-overlay,#clankerbend-composer-chips"))
        .map((el) => {
          const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          const buttons = [...el.querySelectorAll("button,[role='button']")];
          const hasNativeSelectionAction = buttons.some((button) => /\\bAdd to chat\\b/i.test(button.textContent || "")) ||
            buttons.some((button) => /\\bAsk in side chat\\b/i.test(button.textContent || "")) ||
            /\\bAdd to chat\\b/i.test(text) ||
            /\\bAsk in side chat\\b/i.test(text);
          const score = (/\\bAdd to chat\\b/i.test(text) ? 10 : 0) +
            (/\\bAsk in side chat\\b/i.test(text) ? 10 : 0) +
            (rect.width > 160 && rect.height > 28 ? 2 : 0);
          return { text, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, score, hasNativeSelectionAction };
        })
        .filter((item) =>
          item.hasNativeSelectionAction &&
          item.score >= 10 &&
          item.rect.width > 0 &&
          item.rect.height > 0 &&
          item.rect.width <= 640 &&
          item.rect.height <= 120 &&
          item.rect.top >= 0 &&
          item.rect.bottom <= window.innerHeight
        )
        .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);
      const item = candidates[0];
      return item ? { ok: true, ...item } : { ok: false, candidates: candidates.slice(0, 3) };
    })()
  `;
}

function nativeToolbarElementExpression() {
  return `
    (() => {
      const candidates = [...document.querySelectorAll("div,section,nav,menu,[role='toolbar'],[role='menu']")]
        .filter((el) => !el.closest("#clankerbend-selection-menu,#clankerbend-overlay,#clankerbend-composer-chips"))
        .map((el) => {
          const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          const rect = el.getBoundingClientRect();
          const buttons = [...el.querySelectorAll("button,[role='button']")];
          const hasNativeSelectionAction = buttons.some((button) => /\\bAdd to chat\\b/i.test(button.textContent || "")) ||
            buttons.some((button) => /\\bAsk in side chat\\b/i.test(button.textContent || "")) ||
            /\\bAdd to chat\\b/i.test(text) ||
            /\\bAsk in side chat\\b/i.test(text);
          const score = (/\\bAdd to chat\\b/i.test(text) ? 10 : 0) +
            (/\\bAsk in side chat\\b/i.test(text) ? 10 : 0) +
            (rect.width > 160 && rect.height > 28 ? 2 : 0);
          return { el, rect, score, hasNativeSelectionAction };
        })
        .filter((item) =>
          item.hasNativeSelectionAction &&
          item.score >= 10 &&
          item.rect.width > 0 &&
          item.rect.height > 0 &&
          item.rect.width <= 640 &&
          item.rect.height <= 120 &&
          item.rect.top >= 0 &&
          item.rect.bottom <= window.innerHeight
        )
        .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);
      return candidates[0]?.el || null;
    })()
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
